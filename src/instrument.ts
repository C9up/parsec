/**
 * The instrument contract every driver enforces, in one place.
 *
 * A check that lives in one driver only is a contract that changes when
 * METRICS_EXPORTER does, so declaration and call validation are shared here
 * and each driver only decides what to do with a value already known good.
 */

import {
	InvalidInstrumentError,
	InvalidLabelValueError,
	InvalidMetricNameError,
	UndeclaredLabelError,
} from "./errors.js";
import type { Labels } from "./types.js";

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
