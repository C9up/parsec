/**
 * OpenTelemetry driver.
 *
 * No import of `@opentelemetry/api`. The meter is taken structurally, the way
 * every Redis-backed driver in the cohort takes its client, so parsec neither
 * depends on the OTel SDK nor imposes its dependency tree on an application
 * that only wants a scrape endpoint. An app that DOES use OTel passes its own
 * meter, already configured with whatever exporter and resource attributes it
 * has set up:
 *
 *   import { metrics } from "@opentelemetry/api"
 *   drivers.otel({ meter: metrics.getMeter("my-app") })
 *
 * The instrument contract is the shared one: the same names, labels, values
 * and cardinality cap are refused here as under Prometheus, BEFORE the meter
 * sees them. Left to the SDK, an invalid name or a negative value is dropped
 * with a diagnostic warning, and switching METRICS_EXPORTER would change what
 * the application's own code is allowed to do.
 */

import { InvalidInstrumentError } from "../errors.js";
import {
	assertCollect,
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

/** The attributes handed to the meter: every declared label, as a string. */
type Attributes = Readonly<Record<string, string>>;

/** The slice of an OTel instrument this uses. */
interface OtelAdder {
	add(value: number, attributes?: Attributes): void;
}
interface OtelRecorder {
	record(value: number, attributes?: Attributes): void;
}
interface OtelObservableResult {
	observe(value: number, attributes?: Attributes): void;
}
interface OtelObservable {
	addCallback(
		callback: (result: OtelObservableResult) => void | Promise<void>,
	): void;
}

interface OtelInstrumentOptions {
	description?: string;
	unit?: string;
}

/**
 * The slice of `@opentelemetry/api`'s Meter this needs.
 *
 * `createGauge` is the synchronous gauge, added in API 1.9: the contract's
 * `set()` is synchronous and caller-driven. The observable instruments are
 * used only for an instrument declared with `collect`, whose values are read
 * when the SDK collects; they are optional here so a meter written for the
 * synchronous path alone still fits.
 */
export interface OtelMeter {
	createCounter(name: string, options?: OtelInstrumentOptions): OtelAdder;
	createGauge(name: string, options?: OtelInstrumentOptions): OtelRecorder;
	createHistogram(
		name: string,
		options?: OtelInstrumentOptions & {
			advice?: { explicitBucketBoundaries?: number[] };
		},
	): OtelRecorder;
	createObservableCounter?(
		name: string,
		options?: OtelInstrumentOptions,
	): OtelObservable;
	createObservableGauge?(
		name: string,
		options?: OtelInstrumentOptions,
	): OtelObservable;
}

export interface OtelDriverOptions extends DriverOptions {
	meter: OtelMeter;
}

/** One label set's value, kept for an instrument that reports on collection. */
interface Point {
	attributes: Attributes;
	value: number;
}

/**
 * The cardinality cap, on parsec's side of the meter.
 *
 * The SDK has its own limit, but a gauge keeps a value per label set in
 * parsec's memory, in front of it; and the contract promises the same cap —
 * and the same `parsec_series_dropped_total` — whichever driver is
 * configured. Only the keys are kept, never more than `maxSeries` of them.
 */
class SeriesGate {
	readonly #declaration: Declaration;
	readonly #keys = new Set<string>();
	readonly #maxSeries: number;
	readonly #onDropped: (metric: string) => void;

	constructor(
		declaration: Declaration,
		maxSeries: number,
		onDropped: (metric: string) => void,
	) {
		this.#declaration = declaration;
		this.#maxSeries = maxSeries;
		this.#onDropped = onDropped;
	}

	get name(): string {
		return this.#declaration.name;
	}

	/** The normalised attributes and their key, validated. */
	locate(labels: Labels | undefined): { key: string; attributes: Attributes } {
		const { name, labelNames } = this.#declaration;
		const attributes = normaliseLabels(name, labelNames, labels);
		return { key: seriesKey(labelNames, attributes), attributes };
	}

	/** {@link locate}, or `undefined` when the label set is refused by the cap. */
	admit(
		labels: Labels | undefined,
	): { key: string; attributes: Attributes } | undefined {
		const series = this.locate(labels);
		if (this.#keys.has(series.key)) return series;
		if (this.#keys.size >= this.#maxSeries) {
			this.#onDropped(this.#declaration.name);
			return undefined;
		}
		this.#keys.add(series.key);
		return series;
	}

	/** Release a label set's slot; returns its key. */
	forget(labels: Labels | undefined): string {
		const { key } = this.locate(labels);
		this.#keys.delete(key);
		return key;
	}

	clear(): void {
		this.#keys.clear();
	}
}

/** Report every point to an observable callback's result. */
function report(
	points: Map<string, Point>,
	result: OtelObservableResult,
): void {
	for (const point of points.values()) {
		result.observe(point.value, point.attributes);
	}
}

/**
 * On OpenTelemetry, `remove` and `reset` release parsec's own state — the
 * cap slot, a gauge's last value, a collected instrument's points. A
 * synchronous instrument's stream already aggregated by the SDK is the SDK's:
 * the API offers no way to delete it.
 */
class OtelCounter implements Counter {
	readonly #gate: SeriesGate;
	/** `undefined` for the observable form, which reports {@link #totals}. */
	readonly #sync: OtelAdder | undefined;
	/** Running totals per admitted label set, for the observable form. */
	readonly #totals = new Map<string, Point>();

	constructor(gate: SeriesGate, sync: OtelAdder | undefined) {
		this.#gate = gate;
		this.#sync = sync;
	}

	increment(value = 1, labels?: Labels): void {
		assertMeasurement(this.#gate.name, value, true);
		const series = this.#gate.admit(labels);
		if (!series) return;
		if (this.#sync) {
			this.#sync.add(value, series.attributes);
			return;
		}
		const point = this.#totals.get(series.key);
		if (point) point.value += value;
		else this.#totals.set(series.key, { attributes: series.attributes, value });
	}

	remove(labels?: Labels): void {
		this.#totals.delete(this.#gate.forget(labels));
	}

	reset(): void {
		this.#gate.clear();
		this.#totals.clear();
	}

	/** Observable form: what one collection reports. */
	report(result: OtelObservableResult): void {
		report(this.#totals, result);
	}
}

class OtelGauge implements Gauge {
	readonly #gate: SeriesGate;
	/** `undefined` for the observable form, which reports {@link #points}. */
	readonly #sync: OtelRecorder | undefined;
	/**
	 * The last value per ADMITTED label set, so bounded by the cap.
	 *
	 * OTel's synchronous gauge only takes absolute values, while the contract
	 * also offers increment/decrement. Keeping the last value is the only way
	 * to express a relative change against an absolute-only instrument.
	 */
	readonly #points = new Map<string, Point>();

	constructor(gate: SeriesGate, sync: OtelRecorder | undefined) {
		this.#gate = gate;
		this.#sync = sync;
	}

	#apply(labels: Labels | undefined, next: (last: number) => number): void {
		const series = this.#gate.admit(labels);
		if (!series) return;
		const value = next(this.#points.get(series.key)?.value ?? 0);
		this.#points.set(series.key, { attributes: series.attributes, value });
		this.#sync?.record(value, series.attributes);
	}

	set(value: number, labels?: Labels): void {
		assertMeasurement(this.#gate.name, value, false);
		this.#apply(labels, () => value);
	}

	increment(value = 1, labels?: Labels): void {
		assertMeasurement(this.#gate.name, value, false);
		this.#apply(labels, (last) => last + value);
	}

	decrement(value = 1, labels?: Labels): void {
		assertMeasurement(this.#gate.name, value, false);
		this.#apply(labels, (last) => last - value);
	}

	startTimer(labels?: Labels): EndTimer {
		return startTimer(labels, (seconds, merged) => this.set(seconds, merged));
	}

	remove(labels?: Labels): void {
		this.#points.delete(this.#gate.forget(labels));
	}

	reset(): void {
		this.#gate.clear();
		this.#points.clear();
	}

	/** Observable form: what one collection reports. */
	report(result: OtelObservableResult): void {
		report(this.#points, result);
	}
}

class OtelHistogram implements Histogram {
	readonly #gate: SeriesGate;
	readonly #instrument: OtelRecorder;

	constructor(gate: SeriesGate, instrument: OtelRecorder) {
		this.#gate = gate;
		this.#instrument = instrument;
	}

	observe(value: number, labels?: Labels): void {
		assertMeasurement(this.#gate.name, value, true);
		const series = this.#gate.admit(labels);
		if (series) this.#instrument.record(value, series.attributes);
	}

	time<T>(work: () => Promise<T>, labels?: Labels): Promise<T> {
		return timed(work, (seconds) => this.observe(seconds, labels));
	}

	startTimer(labels?: Labels): EndTimer {
		return startTimer(labels, (seconds, merged) =>
			this.observe(seconds, merged),
		);
	}

	remove(labels?: Labels): void {
		this.#gate.forget(labels);
	}

	reset(): void {
		this.#gate.clear();
	}
}

/**
 * Wire `collect` to an observable instrument: run it, then report what the
 * instrument holds. Reported even when it threw, so a failing callback costs
 * a fresh value rather than the series; the error still reaches the SDK,
 * which logs it.
 */
function observeWith<T extends { report(result: OtelObservableResult): void }>(
	observable: OtelObservable,
	instrument: T,
	collect: Collect<T>,
): void {
	observable.addCallback(async (result) => {
		try {
			await collect(instrument);
		} finally {
			instrument.report(result);
		}
	});
}

/**
 * The observable factory a `collect` needs, bound to its meter, or a
 * declaration-time error.
 */
function observableFactory(
	metric: string,
	meter: OtelMeter,
	factory:
		| ((name: string, options?: OtelInstrumentOptions) => OtelObservable)
		| undefined,
	method: string,
): (name: string, options?: OtelInstrumentOptions) => OtelObservable {
	if (typeof factory !== "function") {
		throw new InvalidInstrumentError(
			metric,
			`collect needs a meter with ${method}() (any @opentelemetry/api 1.x meter has it)`,
		);
	}
	return (name, options) => factory.call(meter, name, options);
}

/** `description` always, `unit` only when there is one. */
function instrumentOptions(declaration: Declaration): OtelInstrumentOptions {
	return declaration.unit === undefined
		? { description: declaration.help }
		: { description: declaration.help, unit: declaration.unit };
}

export class OtelDriver implements MetricsDriver {
	readonly #meter: OtelMeter;
	readonly #maxSeries: number;
	readonly #instruments = new InstrumentRegistry<
		OtelCounter,
		OtelGauge,
		OtelHistogram
	>();
	readonly #dropped: OtelCounter;

	constructor(options: OtelDriverOptions) {
		this.#meter = options.meter;
		this.#maxSeries = options.maxSeries ?? DEFAULT_MAX_SERIES;
		// The same counter the Prometheus driver renders, labelled by metric
		// NAME — bounded by code, never by a request.
		const declaration = declareInstrument({
			name: DROPPED_METRIC,
			help: DROPPED_HELP,
			labelNames: ["metric"],
		});
		this.#dropped = this.#instruments.counter(
			declaration,
			() =>
				new OtelCounter(
					new SeriesGate(declaration, Number.MAX_SAFE_INTEGER, () => {}),
					this.#meter.createCounter(
						declaration.name,
						instrumentOptions(declaration),
					),
				),
		);
	}

	#onDropped = (metric: string): void => {
		this.#dropped.increment(1, { metric });
	};

	#gate(declaration: Declaration): SeriesGate {
		return new SeriesGate(declaration, this.#maxSeries, this.#onDropped);
	}

	createCounter(options: CounterOptions): Counter {
		const declaration = declareInstrument(options);
		const collect = options.collect;
		assertCollect(declaration.name, collect);
		const create = collect
			? observableFactory(
					declaration.name,
					this.#meter,
					this.#meter.createObservableCounter,
					"createObservableCounter",
				)
			: undefined;
		return this.#instruments.counter(declaration, () => {
			const gate = this.#gate(declaration);
			if (!collect || !create) {
				return new OtelCounter(
					gate,
					this.#meter.createCounter(
						declaration.name,
						instrumentOptions(declaration),
					),
				);
			}
			const counter = new OtelCounter(gate, undefined);
			observeWith(
				create(declaration.name, instrumentOptions(declaration)),
				counter,
				collect,
			);
			return counter;
		});
	}

	createGauge(options: GaugeOptions): Gauge {
		const declaration = declareInstrument(options);
		const collect = options.collect;
		assertCollect(declaration.name, collect);
		const create = collect
			? observableFactory(
					declaration.name,
					this.#meter,
					this.#meter.createObservableGauge,
					"createObservableGauge",
				)
			: undefined;
		return this.#instruments.gauge(declaration, () => {
			const gate = this.#gate(declaration);
			if (!collect || !create) {
				return new OtelGauge(
					gate,
					this.#meter.createGauge(
						declaration.name,
						instrumentOptions(declaration),
					),
				);
			}
			const gauge = new OtelGauge(gate, undefined);
			observeWith(
				create(declaration.name, instrumentOptions(declaration)),
				gauge,
				collect,
			);
			return gauge;
		});
	}

	createHistogram(options: HistogramOptions): Histogram {
		const declaration = declareInstrument(options);
		const buckets = histogramBuckets(
			declaration.name,
			declaration.labelNames,
			options.buckets,
		);
		// Seconds only where the contract's own default applies: the default
		// buckets are a latency ladder. A histogram with its own buckets states
		// its own unit — `payload_bytes` exported as seconds would be renamed
		// `_seconds` by an OTel-to-Prometheus exporter.
		const unit =
			declaration.unit ?? (options.buckets === undefined ? "s" : undefined);
		return this.#instruments.histogram(
			declaration,
			() =>
				new OtelHistogram(
					this.#gate(declaration),
					this.#meter.createHistogram(declaration.name, {
						...instrumentOptions({ ...declaration, unit }),
						// No `advice` without declared buckets, so the collector's
						// configured view decides — imposing parsec's web-latency
						// ladder on an OTel pipeline would override a choice the
						// deployment already made.
						...(options.buckets === undefined
							? {}
							: { advice: { explicitBucketBoundaries: buckets } }),
					}),
				),
		);
	}

	/** OTel pushes; there is nothing to scrape. */
	scrape(): null {
		return null;
	}
}
