/**
 * Prometheus driver — zero dependencies.
 *
 * Holds every series in memory and renders them on scrape. That is the whole
 * model: Prometheus pulls, so there is no client, no socket and nothing to
 * shut down.
 */

import {
	InstrumentConflictError,
	InvalidMeasurementError,
	UndeclaredLabelError,
} from "../errors.js";
import {
	assertLabelName,
	assertMetricName,
	formatMetadata,
	formatSample,
} from "../exposition.js";
import type {
	Counter,
	DriverOptions,
	Gauge,
	Histogram,
	HistogramOptions,
	InstrumentOptions,
	Labels,
	MetricsDriver,
} from "../types.js";

/** The Prometheus convention: seconds, with a ladder that straddles a web request. */
const DEFAULT_BUCKETS = [
	0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

const DEFAULT_MAX_SERIES = 1_000;

/** Name of the built-in counter that reports the cap being hit. */
const DROPPED = "parsec_series_dropped_total";

interface Series {
	labels: Record<string, string>;
	value: number;
}

interface HistogramSeries {
	labels: Record<string, string>;
	/** Per-bucket counts, NOT cumulative; made cumulative at render time. */
	counts: number[];
	sum: number;
	count: number;
}

/**
 * A stable key for one label combination.
 *
 * Built from the DECLARED order, not from the caller's object, so the same
 * combination written `{a, b}` and `{b, a}` lands on one series rather than
 * two that silently split a chart in half.
 */
function keyOf(
	labelNames: readonly string[],
	labels: Record<string, string>,
): string {
	return labelNames.map((name) => labels[name] ?? "").join(" ");
}

abstract class Instrument {
	readonly name: string;
	readonly help: string;
	readonly labelNames: readonly string[];
	readonly #maxSeries: number;
	readonly #onDropped: (metric: string) => void;

	constructor(
		options: InstrumentOptions,
		maxSeries: number,
		onDropped: (metric: string) => void,
	) {
		assertMetricName(options.name);
		for (const label of options.labelNames ?? []) assertLabelName(label);
		this.name = options.name;
		this.help = options.help;
		this.labelNames = options.labelNames ?? [];
		this.#maxSeries = maxSeries;
		this.#onDropped = onDropped;
	}

	/**
	 * Normalise a caller's labels to the declared shape.
	 *
	 * An undeclared label RAISES rather than being dropped: it is almost
	 * always the request-derived value that would have made this instrument
	 * unbounded, and silently ignoring it hides the bug until the chart is
	 * missing a dimension nobody can explain.
	 */
	protected normalise(labels: Labels | undefined): Record<string, string> {
		const out: Record<string, string> = {};
		for (const name of this.labelNames) out[name] = "";
		if (labels) {
			for (const [key, value] of Object.entries(labels)) {
				if (!this.labelNames.includes(key)) {
					throw new UndeclaredLabelError(this.name, key, this.labelNames);
				}
				out[key] = value;
			}
		}
		return out;
	}

	protected assertFinite(value: number): void {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw new InvalidMeasurementError(this.name, value);
		}
	}

	/**
	 * Whether a NEW series may be created.
	 *
	 * The cap exists because a label fed from a request — a path carrying an
	 * id, a user agent, a tenant — turns this map into something nothing ever
	 * evicts. Refusing past the cap costs a dimension on a chart; not
	 * refusing costs the process. The refusal is itself counted, so it shows
	 * up on the dashboard instead of being invisible.
	 */
	protected admits(size: number): boolean {
		if (size < this.#maxSeries) return true;
		this.#onDropped(this.name);
		return false;
	}

	abstract render(): string[];
}

class PromCounter extends Instrument implements Counter {
	readonly #series = new Map<string, Series>();

	increment(value = 1, labels?: Labels): void {
		this.assertFinite(value);
		// A counter only goes up. A negative increment does not produce a wrong
		// number once — it makes every rate() over the window negative, and the
		// scraper reads the drop as a process restart.
		if (value < 0) throw new InvalidMeasurementError(this.name, value);
		const normalised = this.normalise(labels);
		const key = keyOf(this.labelNames, normalised);
		const existing = this.#series.get(key);
		if (existing) {
			existing.value += value;
			return;
		}
		if (!this.admits(this.#series.size)) return;
		this.#series.set(key, { labels: normalised, value });
	}

	render(): string[] {
		if (this.#series.size === 0) return [];
		const lines = [formatMetadata(this.name, "counter", this.help)];
		for (const series of this.#series.values()) {
			lines.push(formatSample(this.name, series.labels, series.value));
		}
		return lines;
	}
}

class PromGauge extends Instrument implements Gauge {
	readonly #series = new Map<string, Series>();

	#at(labels: Labels | undefined): Series | undefined {
		const normalised = this.normalise(labels);
		const key = keyOf(this.labelNames, normalised);
		const existing = this.#series.get(key);
		if (existing) return existing;
		if (!this.admits(this.#series.size)) return undefined;
		const created = { labels: normalised, value: 0 };
		this.#series.set(key, created);
		return created;
	}

	set(value: number, labels?: Labels): void {
		this.assertFinite(value);
		const series = this.#at(labels);
		if (series) series.value = value;
	}

	increment(value = 1, labels?: Labels): void {
		this.assertFinite(value);
		const series = this.#at(labels);
		if (series) series.value += value;
	}

	decrement(value = 1, labels?: Labels): void {
		this.assertFinite(value);
		const series = this.#at(labels);
		if (series) series.value -= value;
	}

	render(): string[] {
		if (this.#series.size === 0) return [];
		const lines = [formatMetadata(this.name, "gauge", this.help)];
		for (const series of this.#series.values()) {
			lines.push(formatSample(this.name, series.labels, series.value));
		}
		return lines;
	}
}

class PromHistogram extends Instrument implements Histogram {
	readonly #series = new Map<string, HistogramSeries>();
	readonly #buckets: readonly number[];

	constructor(
		options: HistogramOptions,
		maxSeries: number,
		onDropped: (metric: string) => void,
	) {
		super(options, maxSeries, onDropped);
		const sorted = [...(options.buckets ?? DEFAULT_BUCKETS)].sort(
			(a, b) => a - b,
		);
		// A duplicate bound renders two `le` lines with the same value, which
		// makes the histogram non-monotonic and every quantile derived from it
		// wrong.
		this.#buckets = [...new Set(sorted)];
	}

	observe(value: number, labels?: Labels): void {
		this.assertFinite(value);
		const normalised = this.normalise(labels);
		const key = keyOf(this.labelNames, normalised);
		let series = this.#series.get(key);
		if (!series) {
			if (!this.admits(this.#series.size)) return;
			series = {
				labels: normalised,
				counts: new Array(this.#buckets.length).fill(0),
				sum: 0,
				count: 0,
			};
			this.#series.set(key, series);
		}
		series.sum += value;
		series.count += 1;
		for (let i = 0; i < this.#buckets.length; i++) {
			const bound = this.#buckets[i];
			if (bound !== undefined && value <= bound) {
				// Counted in ONE bucket here and made cumulative at render time.
				// Incrementing every bucket at or above the value instead would
				// turn each observation into an O(buckets) write on the hot path.
				series.counts[i] = (series.counts[i] ?? 0) + 1;
				break;
			}
		}
	}

	async time<T>(work: () => Promise<T>, labels?: Labels): Promise<T> {
		const started = process.hrtime.bigint();
		try {
			return await work();
		} finally {
			// Recorded even when the work threw. Dropping failed calls is how a
			// latency chart stays flat through an incident.
			const seconds = Number(process.hrtime.bigint() - started) / 1e9;
			this.observe(seconds, labels);
		}
	}

	render(): string[] {
		if (this.#series.size === 0) return [];
		const lines = [formatMetadata(this.name, "histogram", this.help)];
		for (const series of this.#series.values()) {
			let cumulative = 0;
			for (let i = 0; i < this.#buckets.length; i++) {
				cumulative += series.counts[i] ?? 0;
				lines.push(
					formatSample(
						`${this.name}_bucket`,
						{ ...series.labels, le: String(this.#buckets[i]) },
						cumulative,
					),
				);
			}
			// The +Inf bucket is mandatory and equals the total count — an
			// observation above every bound lands only here.
			lines.push(
				formatSample(
					`${this.name}_bucket`,
					{ ...series.labels, le: "+Inf" },
					series.count,
				),
			);
			lines.push(formatSample(`${this.name}_sum`, series.labels, series.sum));
			lines.push(
				formatSample(`${this.name}_count`, series.labels, series.count),
			);
		}
		return lines;
	}
}

export class PrometheusDriver implements MetricsDriver {
	readonly #instruments = new Map<string, Instrument>();
	readonly #maxSeries: number;
	readonly #dropped: PromCounter;

	constructor(options: DriverOptions = {}) {
		this.#maxSeries = options.maxSeries ?? DEFAULT_MAX_SERIES;
		// Built eagerly and labelled by metric NAME — a bounded, non-request
		// value. A counter that reported the dropped LABEL VALUE would
		// reintroduce exactly the unbounded set it exists to report.
		this.#dropped = new PromCounter(
			{
				name: DROPPED,
				help: "Series refused because an instrument reached its cardinality cap.",
				labelNames: ["metric"],
			},
			// Bounded by the number of instruments, which is bounded by code.
			Number.MAX_SAFE_INTEGER,
			() => {},
		);
		this.#instruments.set(DROPPED, this.#dropped);
	}

	#onDropped = (metric: string): void => {
		this.#dropped.increment(1, { metric });
	};

	/**
	 * Return the existing instrument for a name, or `undefined`.
	 *
	 * Declaring the same name twice is normal — two modules instrumenting the
	 * same thing — but declaring it with a DIFFERENT shape is a bug that would
	 * otherwise render two incompatible series under one name.
	 */
	#reuse<T extends Instrument>(
		name: string,
		kind: abstract new (...args: never[]) => T,
		labelNames: readonly string[],
	): T | undefined {
		const existing = this.#instruments.get(name);
		if (!existing) return undefined;
		if (!(existing instanceof kind)) {
			throw new InstrumentConflictError(name, "type");
		}
		const same =
			existing.labelNames.length === labelNames.length &&
			existing.labelNames.every((label, i) => label === labelNames[i]);
		if (!same) throw new InstrumentConflictError(name, "label set");
		return existing;
	}

	createCounter(options: InstrumentOptions): Counter {
		const reused = this.#reuse(
			options.name,
			PromCounter,
			options.labelNames ?? [],
		);
		if (reused) return reused;
		const counter = new PromCounter(options, this.#maxSeries, this.#onDropped);
		this.#instruments.set(options.name, counter);
		return counter;
	}

	createGauge(options: InstrumentOptions): Gauge {
		const reused = this.#reuse(
			options.name,
			PromGauge,
			options.labelNames ?? [],
		);
		if (reused) return reused;
		const gauge = new PromGauge(options, this.#maxSeries, this.#onDropped);
		this.#instruments.set(options.name, gauge);
		return gauge;
	}

	createHistogram(options: HistogramOptions): Histogram {
		const reused = this.#reuse(
			options.name,
			PromHistogram,
			options.labelNames ?? [],
		);
		if (reused) return reused;
		const histogram = new PromHistogram(
			options,
			this.#maxSeries,
			this.#onDropped,
		);
		this.#instruments.set(options.name, histogram);
		return histogram;
	}

	/** The scrape body. Ends with a newline, which the format requires. */
	scrape(): string {
		const blocks: string[] = [];
		for (const instrument of this.#instruments.values()) {
			const lines = instrument.render();
			if (lines.length > 0) blocks.push(lines.join("\n"));
		}
		return blocks.length === 0 ? "" : `${blocks.join("\n")}\n`;
	}
}

/** The content type a Prometheus scraper expects. */
export const PROMETHEUS_CONTENT_TYPE =
	"text/plain; version=0.0.4; charset=utf-8";
