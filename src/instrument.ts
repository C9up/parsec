/**
 * The instrument contract every driver enforces, in one place.
 *
 * A check that lives in one driver only is a contract that changes when
 * METRICS_EXPORTER does, so declaration and call validation are shared here
 * and each driver only decides what to do with a value already known good.
 */

import {
	InstrumentConflictError,
	InvalidInstrumentError,
	InvalidLabelValueError,
	InvalidMeasurementError,
	InvalidMetricNameError,
	UndeclaredLabelError,
} from "./errors.js";
import { assertLabelName, assertMetricName } from "./exposition.js";
import type { EndTimer, InstrumentOptions, Labels } from "./types.js";

/** A declaration that passed {@link declareInstrument}. */
export interface Declaration {
	name: string;
	help: string;
	labelNames: readonly string[];
	unit: string | undefined;
}

/**
 * OpenTelemetry's unit syntax: printable ASCII, at most 63 characters. Checked
 * on every driver so a unit accepted under Prometheus is not refused once the
 * same code exports through OTel.
 */
const UNIT = /^[\x21-\x7e]{1,63}$/;

/**
 * Validate an instrument's declaration: name, help, label names, unit.
 *
 * At declaration, deliberately — an invalid name accepted here produces a
 * scrape body Prometheus rejects wholesale, or a series the OTel SDK drops
 * with a warning nobody reads.
 */
export function declareInstrument(options: InstrumentOptions): Declaration {
	assertMetricName(options.name);
	assertHelp(options.name, options.help);
	const labelNames = options.labelNames ?? [];
	if (!Array.isArray(labelNames)) {
		throw new InvalidInstrumentError(
			options.name,
			"labelNames must be an array",
		);
	}
	const seen = new Set<string>();
	for (const label of labelNames) {
		assertLabelName(label);
		// Declared twice, a label renders twice on one line, which the
		// scraper rejects along with everything else in the body.
		if (seen.has(label)) {
			throw new InvalidMetricNameError("label", label, "it is declared twice");
		}
		seen.add(label);
	}
	const unit = options.unit;
	if (unit !== undefined && (typeof unit !== "string" || !UNIT.test(unit))) {
		throw new InvalidInstrumentError(
			options.name,
			"its unit must be 1 to 63 printable ASCII characters",
		);
	}
	return {
		name: options.name,
		help: options.help,
		labelNames: [...labelNames],
		unit,
	};
}

/**
 * Validate a measurement.
 *
 * Non-finite values poison a sum forever. A negative counter increment makes
 * every rate() over the window negative and reads downstream as a restart; a
 * negative histogram observation is dropped by the OpenTelemetry SDK with
 * only a diagnostic warning, so it is refused on every driver rather than
 * accepted by one and silently lost by the other.
 */
export function assertMeasurement(
	metric: string,
	value: number,
	nonNegative: boolean,
): void {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new InvalidMeasurementError(metric, value);
	}
	if (nonNegative && value < 0) {
		throw new InvalidMeasurementError(metric, value);
	}
}

type Entry<C, G, H> =
	| { kind: "counter"; labelNames: readonly string[]; instrument: C }
	| { kind: "gauge"; labelNames: readonly string[]; instrument: G }
	| { kind: "histogram"; labelNames: readonly string[]; instrument: H };

/**
 * Instruments by name, built once.
 *
 * Declaring the same name twice is normal — two modules instrumenting the
 * same thing — and returns the existing instrument, because a caller that
 * creates one per request is the other half of the cardinality problem.
 * Declaring it with a DIFFERENT type or label set is a bug that would
 * otherwise export two incompatible series under one name.
 */
export class InstrumentRegistry<C, G, H> {
	readonly #entries = new Map<string, Entry<C, G, H>>();

	#existing(
		kind: Entry<C, G, H>["kind"],
		name: string,
		labelNames: readonly string[],
	): Entry<C, G, H> | undefined {
		const existing = this.#entries.get(name);
		if (!existing) return undefined;
		if (existing.kind !== kind) throw new InstrumentConflictError(name, "type");
		const same =
			existing.labelNames.length === labelNames.length &&
			existing.labelNames.every((label, i) => label === labelNames[i]);
		if (!same) throw new InstrumentConflictError(name, "label set");
		return existing;
	}

	counter(declaration: Declaration, build: () => C): C {
		const { name, labelNames } = declaration;
		const existing = this.#existing("counter", name, labelNames);
		if (existing?.kind === "counter") return existing.instrument;
		const instrument = build();
		this.#entries.set(name, { kind: "counter", labelNames, instrument });
		return instrument;
	}

	gauge(declaration: Declaration, build: () => G): G {
		const { name, labelNames } = declaration;
		const existing = this.#existing("gauge", name, labelNames);
		if (existing?.kind === "gauge") return existing.instrument;
		const instrument = build();
		this.#entries.set(name, { kind: "gauge", labelNames, instrument });
		return instrument;
	}

	histogram(declaration: Declaration, build: () => H): H {
		const { name, labelNames } = declaration;
		const existing = this.#existing("histogram", name, labelNames);
		if (existing?.kind === "histogram") return existing.instrument;
		const instrument = build();
		this.#entries.set(name, { kind: "histogram", labelNames, instrument });
		return instrument;
	}

	/** Every instrument, in declaration order. */
	*instruments(): IterableIterator<C | G | H> {
		for (const entry of this.#entries.values()) yield entry.instrument;
	}
}

/** Name of the built-in counter that reports the cap being hit. */
export const DROPPED_METRIC = "parsec_series_dropped_total";
export const DROPPED_HELP =
	"Series refused because an instrument reached its cardinality cap.";

/** Name of the built-in counter that reports a `collect` that threw or timed out. */
export const COLLECT_FAILURES_METRIC = "parsec_collect_failures_total";
export const COLLECT_FAILURES_HELP =
	"Collect callbacks that threw or timed out during a scrape.";

/** Milliseconds one `collect` may take during a scrape. */
export const DEFAULT_COLLECT_TIMEOUT = 5_000;

/** How many label combinations one instrument holds when nothing says otherwise. */
export const DEFAULT_MAX_SERIES = 1_000;

/** Validate a HELP text at declaration. */
export function assertHelp(name: string, help: unknown): void {
	if (typeof help !== "string") {
		throw new InvalidInstrumentError(name, "its help must be a string");
	}
}

/**
 * One label value, as the string both backends store.
 *
 * Numbers are accepted and stringified here, once, so `{ status: 200 }` and
 * `{ status: "200" }` are the same series on every driver. Anything else is
 * refused at the call: accepted, it would only fail when rendered, on every
 * later scrape, taking every other metric of the process down with it.
 */
function labelValue(metric: string, label: string, value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return String(value);
	throw new InvalidLabelValueError(metric, label, value);
}

/**
 * Normalise a caller's labels to the declared shape: every declared label
 * present (empty when not given), each value a string.
 *
 * An undeclared label RAISES rather than being dropped: it is almost always
 * the request-derived value that would have made the instrument unbounded,
 * and silently ignoring it hides the bug until the chart is missing a
 * dimension nobody can explain.
 */
export function normaliseLabels(
	metric: string,
	labelNames: readonly string[],
	labels: Labels | undefined,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of labelNames) out[name] = "";
	if (labels) {
		for (const [key, value] of Object.entries(labels)) {
			if (!labelNames.includes(key)) {
				throw new UndeclaredLabelError(metric, key, labelNames);
			}
			out[key] = labelValue(metric, key, value);
		}
	}
	return out;
}

/**
 * A key for one label combination, injective over the values.
 *
 * Built from the DECLARED order, not from the caller's object, so `{a, b}`
 * and `{b, a}` land on one series. JSON-encoded rather than joined with a
 * separator: any separator can appear inside a value, and then two distinct
 * label sets share one series — the second one's counts credited to the
 * first, and a request-derived value able to absorb another set's traffic.
 */
export function seriesKey(
	labelNames: readonly string[],
	labels: Readonly<Record<string, string>>,
): string {
	return JSON.stringify(labelNames.map((name) => labels[name] ?? ""));
}

/** The Prometheus convention: seconds, with a ladder that straddles a web request. */
export const DEFAULT_BUCKETS: readonly number[] = [
	0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/**
 * Validate a histogram's declaration and return its bucket bounds: finite,
 * ascending, without duplicates.
 *
 * `le` is the bucket label (prom-client refuses it the same way); a user
 * label of that name disappears from every bucket line and stays on _sum and
 * _count. A `+Infinity` bound is the mandatory +Inf bucket every histogram
 * already has, so it is folded into it rather than rendered twice. NaN and
 * `-Infinity` have no meaning as an upper bound and are refused.
 */
export function histogramBuckets(
	metric: string,
	labelNames: readonly string[],
	buckets: readonly number[] | undefined,
): number[] {
	if (labelNames.includes("le")) {
		throw new InvalidMetricNameError(
			"label",
			"le",
			"it is reserved for histogram buckets",
		);
	}
	const given = buckets ?? DEFAULT_BUCKETS;
	if (!Array.isArray(given)) {
		throw new InvalidInstrumentError(metric, "buckets must be an array");
	}
	const finite: number[] = [];
	for (const bound of given) {
		if (bound === Number.POSITIVE_INFINITY) continue;
		if (typeof bound !== "number" || !Number.isFinite(bound)) {
			throw new InvalidInstrumentError(
				metric,
				`bucket bound ${String(bound)} is not a finite number`,
			);
		}
		finite.push(bound);
	}
	// A duplicate bound renders two `le` lines with the same value, which
	// makes the histogram non-monotonic and every quantile derived from it
	// wrong.
	return [...new Set(finite)].sort((a, b) => a - b);
}

/**
 * Time `work`, hand the elapsed SECONDS to `record`, return its result.
 *
 * Records on the way out either way: dropping the calls that threw is how a
 * latency chart stays flat through an incident.
 */
export async function timed<T>(
	work: () => Promise<T>,
	record: (seconds: number) => void,
): Promise<T> {
	const started = process.hrtime.bigint();
	try {
		return await work();
	} finally {
		record(Number(process.hrtime.bigint() - started) / 1e9);
	}
}

/** Validate a `collect` option at declaration. */
export function assertCollect(metric: string, collect: unknown): void {
	if (collect !== undefined && typeof collect !== "function") {
		throw new InvalidInstrumentError(metric, "collect must be a function");
	}
}

/**
 * A timer that hands the elapsed SECONDS and the merged labels to `record`
 * when it ends, and returns the seconds.
 */
export function startTimer(
	labels: Labels | undefined,
	record: (seconds: number, labels: Labels) => void,
): EndTimer {
	const started = process.hrtime.bigint();
	return (endLabels) => {
		const seconds = Number(process.hrtime.bigint() - started) / 1e9;
		record(seconds, { ...labels, ...endLabels });
		return seconds;
	};
}
