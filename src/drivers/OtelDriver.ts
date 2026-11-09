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

/** The attributes handed to the meter: every declared label, as a string. */
type Attributes = Readonly<Record<string, string>>;

/** The slice of an OTel instrument this uses. */
interface OtelAdder {
	add(value: number, attributes?: Attributes): void;
}
interface OtelRecorder {
	record(value: number, attributes?: Attributes): void;
}

interface OtelInstrumentOptions {
	description?: string;
	unit?: string;
}

/**
 * The slice of `@opentelemetry/api`'s Meter this needs.
 *
 * `createGauge` is the synchronous gauge, added in API 1.9. The observable
 * gauge is not usable here: the contract's `set()` is synchronous and
 * caller-driven, while an observable one is pulled by the SDK on its own
 * schedule.
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
}

export interface OtelDriverOptions extends DriverOptions {
	meter: OtelMeter;
}

/**
 * The cardinality cap, on parsec's side of the meter.
 *
 * The SDK has its own limit, but the gauge below keeps a value per label set
 * in parsec's memory, in front of it; and the contract promises the same cap
 * — and the same `parsec_series_dropped_total` — whichever driver is
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

	/** The normalised attributes and their key, or `undefined` when refused. */
	admit(
		labels: Labels | undefined,
	): { key: string; attributes: Attributes } | undefined {
		const { name, labelNames } = this.#declaration;
		const attributes = normaliseLabels(name, labelNames, labels);
		const key = seriesKey(labelNames, attributes);
		if (this.#keys.has(key)) return { key, attributes };
		if (this.#keys.size >= this.#maxSeries) {
			this.#onDropped(name);
			return undefined;
		}
		this.#keys.add(key);
		return { key, attributes };
	}
}

class OtelCounter implements Counter {
	readonly #name: string;
	readonly #instrument: OtelAdder;
	readonly #gate: SeriesGate;

	constructor(name: string, instrument: OtelAdder, gate: SeriesGate) {
		this.#name = name;
		this.#instrument = instrument;
		this.#gate = gate;
	}

	increment(value = 1, labels?: Labels): void {
		assertMeasurement(this.#name, value, true);
		const series = this.#gate.admit(labels);
		if (series) this.#instrument.add(value, series.attributes);
	}
}

class OtelGauge implements Gauge {
	readonly #name: string;
	readonly #gauge: OtelRecorder;
	readonly #gate: SeriesGate;
	/**
	 * The last value per ADMITTED label set, so bounded by the cap.
	 *
	 * OTel's synchronous gauge only takes absolute values, while the contract
	 * also offers increment/decrement. Keeping the last value is the only way
	 * to express a relative change against an absolute-only instrument.
	 */
	readonly #last = new Map<string, number>();

	constructor(name: string, gauge: OtelRecorder, gate: SeriesGate) {
		this.#name = name;
		this.#gauge = gauge;
		this.#gate = gate;
	}

	#apply(labels: Labels | undefined, next: (last: number) => number): void {
		const series = this.#gate.admit(labels);
		if (!series) return;
		const value = next(this.#last.get(series.key) ?? 0);
		this.#last.set(series.key, value);
		this.#gauge.record(value, series.attributes);
	}

	set(value: number, labels?: Labels): void {
		assertMeasurement(this.#name, value, false);
		this.#apply(labels, () => value);
	}

	increment(value = 1, labels?: Labels): void {
		assertMeasurement(this.#name, value, false);
		this.#apply(labels, (last) => last + value);
	}

	decrement(value = 1, labels?: Labels): void {
		assertMeasurement(this.#name, value, false);
		this.#apply(labels, (last) => last - value);
	}
}

class OtelHistogram implements Histogram {
	readonly #name: string;
	readonly #instrument: OtelRecorder;
	readonly #gate: SeriesGate;

	constructor(name: string, instrument: OtelRecorder, gate: SeriesGate) {
		this.#name = name;
		this.#instrument = instrument;
		this.#gate = gate;
	}

	observe(value: number, labels?: Labels): void {
		assertMeasurement(this.#name, value, true);
		const series = this.#gate.admit(labels);
		if (series) this.#instrument.record(value, series.attributes);
	}

	time<T>(work: () => Promise<T>, labels?: Labels): Promise<T> {
		return timed(work, (seconds) => this.observe(seconds, labels));
	}
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
					declaration.name,
					this.#meter.createCounter(
						declaration.name,
						instrumentOptions(declaration),
					),
					new SeriesGate(declaration, Number.MAX_SAFE_INTEGER, () => {}),
				),
		);
	}

	#onDropped = (metric: string): void => {
		this.#dropped.increment(1, { metric });
	};

	#gate(declaration: Declaration): SeriesGate {
		return new SeriesGate(declaration, this.#maxSeries, this.#onDropped);
	}

	createCounter(options: InstrumentOptions): Counter {
		const declaration = declareInstrument(options);
		return this.#instruments.counter(
			declaration,
			() =>
				new OtelCounter(
					declaration.name,
					this.#meter.createCounter(
						declaration.name,
						instrumentOptions(declaration),
					),
					this.#gate(declaration),
				),
		);
	}

	createGauge(options: InstrumentOptions): Gauge {
		const declaration = declareInstrument(options);
		return this.#instruments.gauge(
			declaration,
			() =>
				new OtelGauge(
					declaration.name,
					this.#meter.createGauge(
						declaration.name,
						instrumentOptions(declaration),
					),
					this.#gate(declaration),
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
					declaration.name,
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
					this.#gate(declaration),
				),
		);
	}

	/** OTel pushes; there is nothing to scrape. */
	scrape(): null {
		return null;
	}
}
