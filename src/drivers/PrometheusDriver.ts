/**
 * Prometheus driver — zero dependencies.
 *
 * Holds every series in memory and renders them on scrape. That is the whole
 * model: Prometheus pulls, so there is no client, no socket and nothing to
 * shut down.
 */

import { formatMetadata, formatSample, formatValue } from "../exposition.js";
import {
	assertMeasurement,
	DEFAULT_MAX_SERIES,
	type Declaration,
	DROPPED_HELP,
	DROPPED_METRIC,
	declareInstrument,
	histogramBuckets,
	InstrumentRegistry,
	normaliseLabels,
	seriesKey,
	timed,
} from "../instrument.js";
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

abstract class Instrument {
	readonly name: string;
	readonly help: string;
	readonly labelNames: readonly string[];
	readonly #maxSeries: number;
	readonly #onDropped: (metric: string) => void;

	constructor(
		declaration: Declaration,
		maxSeries: number,
		onDropped: (metric: string) => void,
	) {
		this.name = declaration.name;
		this.help = declaration.help;
		this.labelNames = declaration.labelNames;
		this.#maxSeries = maxSeries;
		this.#onDropped = onDropped;
	}

	/** Every declared label present, each value a string; see {@link normaliseLabels}. */
	protected normalise(labels: Labels | undefined): Record<string, string> {
		return normaliseLabels(this.name, this.labelNames, labels);
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
		assertMeasurement(this.name, value, true);
		const normalised = this.normalise(labels);
		const key = seriesKey(this.labelNames, normalised);
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
		const key = seriesKey(this.labelNames, normalised);
		const existing = this.#series.get(key);
		if (existing) return existing;
		if (!this.admits(this.#series.size)) return undefined;
		const created = { labels: normalised, value: 0 };
		this.#series.set(key, created);
		return created;
	}

	set(value: number, labels?: Labels): void {
		assertMeasurement(this.name, value, false);
		const series = this.#at(labels);
		if (series) series.value = value;
	}

	increment(value = 1, labels?: Labels): void {
		assertMeasurement(this.name, value, false);
		const series = this.#at(labels);
		if (series) series.value += value;
	}

	decrement(value = 1, labels?: Labels): void {
		assertMeasurement(this.name, value, false);
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
		declaration: Declaration,
		buckets: readonly number[],
		maxSeries: number,
		onDropped: (metric: string) => void,
	) {
		super(declaration, maxSeries, onDropped);
		this.#buckets = buckets;
	}

	observe(value: number, labels?: Labels): void {
		assertMeasurement(this.name, value, true);
		const normalised = this.normalise(labels);
		const key = seriesKey(this.labelNames, normalised);
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

	time<T>(work: () => Promise<T>, labels?: Labels): Promise<T> {
		return timed(work, (seconds) => this.observe(seconds, labels));
	}

	render(): string[] {
		if (this.#series.size === 0) return [];
		const lines = [formatMetadata(this.name, "histogram", this.help)];
		for (const series of this.#series.values()) {
			let cumulative = 0;
			this.#buckets.forEach((bound, i) => {
				cumulative += series.counts[i] ?? 0;
				lines.push(
					formatSample(
						`${this.name}_bucket`,
						{ ...series.labels, le: formatValue(bound) },
						cumulative,
					),
				);
			});
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
	readonly #instruments = new InstrumentRegistry<
		PromCounter,
		PromGauge,
		PromHistogram
	>();
	readonly #maxSeries: number;
	readonly #dropped: PromCounter;

	constructor(options: DriverOptions = {}) {
		this.#maxSeries = options.maxSeries ?? DEFAULT_MAX_SERIES;
		// Built eagerly and labelled by metric NAME — a bounded, non-request
		// value. A counter that reported the dropped LABEL VALUE would
		// reintroduce exactly the unbounded set it exists to report.
		const declaration = declareInstrument({
			name: DROPPED_METRIC,
			help: DROPPED_HELP,
			labelNames: ["metric"],
		});
		this.#dropped = this.#instruments.counter(
			declaration,
			() =>
				// Bounded by the number of instruments, which is bounded by code.
				new PromCounter(declaration, Number.MAX_SAFE_INTEGER, () => {}),
		);
	}

	#onDropped = (metric: string): void => {
		this.#dropped.increment(1, { metric });
	};

	createCounter(options: InstrumentOptions): Counter {
		const declaration = declareInstrument(options);
		return this.#instruments.counter(
			declaration,
			() => new PromCounter(declaration, this.#maxSeries, this.#onDropped),
		);
	}

	createGauge(options: InstrumentOptions): Gauge {
		const declaration = declareInstrument(options);
		return this.#instruments.gauge(
			declaration,
			() => new PromGauge(declaration, this.#maxSeries, this.#onDropped),
		);
	}

	createHistogram(options: HistogramOptions): Histogram {
		const declaration = declareInstrument(options);
		const buckets = histogramBuckets(
			declaration.name,
			declaration.labelNames,
			options.buckets,
		);
		return this.#instruments.histogram(
			declaration,
			() =>
				new PromHistogram(
					declaration,
					buckets,
					this.#maxSeries,
					this.#onDropped,
				),
		);
	}

	/** The scrape body. Ends with a newline, which the format requires. */
	scrape(): string {
		const blocks: string[] = [];
		for (const instrument of this.#instruments.instruments()) {
			const lines = instrument.render();
			if (lines.length > 0) blocks.push(lines.join("\n"));
		}
		return blocks.length === 0 ? "" : `${blocks.join("\n")}\n`;
	}
}

/** The content type a Prometheus scraper expects. */
export const PROMETHEUS_CONTENT_TYPE =
	"text/plain; version=0.0.4; charset=utf-8";
