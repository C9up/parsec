/**
 * Prometheus driver — zero dependencies.
 *
 * Holds every series in memory and renders them on scrape. That is the whole
 * model: Prometheus pulls, so there is no client, no socket and nothing to
 * shut down.
 */

import { formatMetadata, formatSample, formatValue } from "../exposition.js";
import {
	assertCollect,
	assertMeasurement,
	COLLECT_FAILURES_HELP,
	COLLECT_FAILURES_METRIC,
	DEFAULT_COLLECT_TIMEOUT,
	DEFAULT_MAX_SERIES,
	type Declaration,
	DROPPED_HELP,
	DROPPED_METRIC,
	declareInstrument,
	histogramBuckets,
	InstrumentRegistry,
	normaliseLabels,
	seriesKey,
	startTimer,
	timed,
} from "../instrument.js";
import type {
	Collect,
	Counter,
	CounterOptions,
	DriverOptions,
	EndTimer,
	Gauge,
	GaugeOptions,
	Histogram,
	HistogramOptions,
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

abstract class Instrument<S> {
	readonly name: string;
	readonly help: string;
	readonly labelNames: readonly string[];
	/** The series, keyed by {@link seriesKey}. */
	protected readonly series = new Map<string, S>();
	/** The `collect` option, bound to this instrument, run before each scrape. */
	collector: (() => void | Promise<void>) | undefined;
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
	protected admits(): boolean {
		if (this.series.size < this.#maxSeries) return true;
		this.#onDropped(this.name);
		return false;
	}

	/** The series for `labels`, normalised, and its key. */
	protected locate(labels: Labels | undefined): {
		key: string;
		labels: Record<string, string>;
		existing: S | undefined;
	} {
		const normalised = this.normalise(labels);
		const key = seriesKey(this.labelNames, normalised);
		return { key, labels: normalised, existing: this.series.get(key) };
	}

	remove(labels?: Labels): void {
		this.series.delete(this.locate(labels).key);
	}

	reset(): void {
		this.series.clear();
	}

	abstract render(): string[];
}

class PromCounter extends Instrument<Series> implements Counter {
	constructor(
		declaration: Declaration,
		maxSeries: number,
		onDropped: (metric: string) => void,
		collect?: Collect<Counter>,
	) {
		super(declaration, maxSeries, onDropped);
		this.collector = collect && (() => collect(this));
	}

	increment(value = 1, labels?: Labels): void {
		assertMeasurement(this.name, value, true);
		const found = this.locate(labels);
		if (found.existing) {
			found.existing.value += value;
			return;
		}
		if (!this.admits()) return;
		this.series.set(found.key, { labels: found.labels, value });
	}

	render(): string[] {
		if (this.series.size === 0) return [];
		const lines = [formatMetadata(this.name, "counter", this.help)];
		for (const series of this.series.values()) {
			lines.push(formatSample(this.name, series.labels, series.value));
		}
		return lines;
	}
}

class PromGauge extends Instrument<Series> implements Gauge {
	constructor(
		declaration: Declaration,
		maxSeries: number,
		onDropped: (metric: string) => void,
		collect?: Collect<Gauge>,
	) {
		super(declaration, maxSeries, onDropped);
		this.collector = collect && (() => collect(this));
	}

	#at(labels: Labels | undefined): Series | undefined {
		const found = this.locate(labels);
		if (found.existing) return found.existing;
		if (!this.admits()) return undefined;
		const created = { labels: found.labels, value: 0 };
		this.series.set(found.key, created);
		return created;
	}

	startTimer(labels?: Labels): EndTimer {
		return startTimer(labels, (seconds, merged) => this.set(seconds, merged));
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
		if (this.series.size === 0) return [];
		const lines = [formatMetadata(this.name, "gauge", this.help)];
		for (const series of this.series.values()) {
			lines.push(formatSample(this.name, series.labels, series.value));
		}
		return lines;
	}
}

class PromHistogram extends Instrument<HistogramSeries> implements Histogram {
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
		const found = this.locate(labels);
		let series = found.existing;
		if (!series) {
			if (!this.admits()) return;
			series = {
				labels: found.labels,
				counts: new Array(this.#buckets.length).fill(0),
				sum: 0,
				count: 0,
			};
			this.series.set(found.key, series);
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

	startTimer(labels?: Labels): EndTimer {
		return startTimer(labels, (seconds, merged) =>
			this.observe(seconds, merged),
		);
	}

	render(): string[] {
		if (this.series.size === 0) return [];
		const lines = [formatMetadata(this.name, "histogram", this.help)];
		for (const series of this.series.values()) {
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
	readonly #collectTimeout: number;
	readonly #dropped: PromCounter;
	readonly #collectFailures: PromCounter;

	constructor(options: DriverOptions = {}) {
		this.#maxSeries = options.maxSeries ?? DEFAULT_MAX_SERIES;
		this.#collectTimeout = options.collectTimeout ?? DEFAULT_COLLECT_TIMEOUT;
		// Built eagerly and labelled by metric NAME — a bounded, non-request
		// value. A counter that reported the dropped LABEL VALUE would
		// reintroduce exactly the unbounded set it exists to report. Bounded by
		// the number of instruments, which is bounded by code.
		this.#dropped = this.#internal(DROPPED_METRIC, DROPPED_HELP);
		this.#collectFailures = this.#internal(
			COLLECT_FAILURES_METRIC,
			COLLECT_FAILURES_HELP,
		);
	}

	#internal(name: string, help: string): PromCounter {
		const declaration = declareInstrument({
			name,
			help,
			labelNames: ["metric"],
		});
		return this.#instruments.counter(
			declaration,
			undefined,
			() => new PromCounter(declaration, Number.MAX_SAFE_INTEGER, () => {}),
		);
	}

	#onDropped = (metric: string): void => {
		this.#dropped.increment(1, { metric });
	};

	createCounter(options: CounterOptions): Counter {
		const declaration = declareInstrument(options);
		assertCollect(declaration.name, options.collect);
		return this.#instruments.counter(
			declaration,
			options.collect,
			() =>
				new PromCounter(
					declaration,
					this.#maxSeries,
					this.#onDropped,
					options.collect,
				),
		);
	}

	createGauge(options: GaugeOptions): Gauge {
		const declaration = declareInstrument(options);
		assertCollect(declaration.name, options.collect);
		return this.#instruments.gauge(
			declaration,
			options.collect,
			() =>
				new PromGauge(
					declaration,
					this.#maxSeries,
					this.#onDropped,
					options.collect,
				),
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
			buckets,
			() =>
				new PromHistogram(
					declaration,
					buckets,
					this.#maxSeries,
					this.#onDropped,
				),
		);
	}

	/**
	 * Run one `collect`, bounded in time.
	 *
	 * A callback that throws or hangs costs its own instrument a fresh value,
	 * never the scrape: the instrument renders what it last had, the failure
	 * is counted, and every other metric is served as usual.
	 */
	async #collect(
		name: string,
		collector: () => void | Promise<void>,
	): Promise<void> {
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				Promise.resolve().then(collector),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new Error("collect timed out")),
						this.#collectTimeout,
					);
				}),
			]);
		} catch {
			this.#collectFailures.increment(1, { metric: name });
		} finally {
			clearTimeout(timer);
		}
	}

	/** The scrape body. Ends with a newline, which the format requires. */
	async scrape(): Promise<string> {
		const instruments = [...this.#instruments.instruments()];
		await Promise.all(
			instruments.map((instrument) =>
				instrument.collector
					? this.#collect(instrument.name, instrument.collector)
					: undefined,
			),
		);
		const blocks: string[] = [];
		for (const instrument of instruments) {
			const lines = instrument.render();
			if (lines.length > 0) blocks.push(lines.join("\n"));
		}
		return blocks.length === 0 ? "" : `${blocks.join("\n")}\n`;
	}
}

/** The content type a Prometheus scraper expects. */
export const PROMETHEUS_CONTENT_TYPE =
	"text/plain; version=0.0.4; charset=utf-8";
