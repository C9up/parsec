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
 */

import type {
	Counter,
	Gauge,
	Histogram,
	HistogramOptions,
	InstrumentOptions,
	Labels,
	MetricsDriver,
} from "../types.js";

/** The slice of an OTel instrument this uses. */
interface OtelAdder {
	add(value: number, attributes?: Labels): void;
}
interface OtelRecorder {
	record(value: number, attributes?: Labels): void;
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
	createCounter(name: string, options?: { description?: string }): OtelAdder;
	createGauge(name: string, options?: { description?: string }): OtelRecorder;
	createHistogram(
		name: string,
		options?: {
			description?: string;
			unit?: string;
			advice?: { explicitBucketBoundaries?: number[] };
		},
	): OtelRecorder;
}

export interface OtelDriverOptions {
	meter: OtelMeter;
}

class OtelCounter implements Counter {
	readonly #instrument: OtelAdder;
	constructor(instrument: OtelAdder) {
		this.#instrument = instrument;
	}
	increment(value = 1, labels?: Labels): void {
		this.#instrument.add(value, labels);
	}
}

class OtelGauge implements Gauge {
	readonly #gauge: OtelRecorder;
	/**
	 * The last value per label set.
	 *
	 * OTel's synchronous gauge only takes absolute values, while the contract
	 * also offers increment/decrement. Keeping the last value is the only way
	 * to express a relative change against an absolute-only instrument.
	 */
	readonly #last = new Map<string, number>();
	constructor(gauge: OtelRecorder) {
		this.#gauge = gauge;
	}
	#key(labels: Labels | undefined): string {
		if (!labels) return "";
		return Object.entries(labels)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${k}=${v}`)
			.join(",");
	}
	set(value: number, labels?: Labels): void {
		this.#last.set(this.#key(labels), value);
		this.#gauge.record(value, labels);
	}
	increment(value = 1, labels?: Labels): void {
		this.set((this.#last.get(this.#key(labels)) ?? 0) + value, labels);
	}
	decrement(value = 1, labels?: Labels): void {
		this.increment(-value, labels);
	}
}

class OtelHistogram implements Histogram {
	readonly #instrument: OtelRecorder;
	constructor(instrument: OtelRecorder) {
		this.#instrument = instrument;
	}
	observe(value: number, labels?: Labels): void {
		this.#instrument.record(value, labels);
	}
	async time<T>(work: () => Promise<T>, labels?: Labels): Promise<T> {
		const started = process.hrtime.bigint();
		try {
			return await work();
		} finally {
			this.observe(Number(process.hrtime.bigint() - started) / 1e9, labels);
		}
	}
}

export class OtelDriver implements MetricsDriver {
	readonly #meter: OtelMeter;
	/**
	 * One registry per instrument kind, rather than one keyed by name.
	 *
	 * Instruments are built once per name here as well as in the Prometheus
	 * driver — an application that creates one per request is the other half
	 * of the cardinality problem, and it must behave the same on both. Keeping
	 * them apart by kind is what lets the lookup return the right type without
	 * an unchecked cast asserting what a single shared map could not prove.
	 */
	readonly #counters = new Map<string, Counter>();
	readonly #gauges = new Map<string, Gauge>();
	readonly #histograms = new Map<string, Histogram>();

	constructor(options: OtelDriverOptions) {
		this.#meter = options.meter;
	}

	createCounter(options: InstrumentOptions): Counter {
		const existing = this.#counters.get(options.name);
		if (existing) return existing;
		const created = new OtelCounter(
			this.#meter.createCounter(options.name, { description: options.help }),
		);
		this.#counters.set(options.name, created);
		return created;
	}

	createGauge(options: InstrumentOptions): Gauge {
		const existing = this.#gauges.get(options.name);
		if (existing) return existing;
		const created = new OtelGauge(
			this.#meter.createGauge(options.name, { description: options.help }),
		);
		this.#gauges.set(options.name, created);
		return created;
	}

	createHistogram(options: HistogramOptions): Histogram {
		const existing = this.#histograms.get(options.name);
		if (existing) return existing;
		const created = new OtelHistogram(
			this.#meter.createHistogram(options.name, {
				description: options.help,
				// Seconds, matching the contract's own unit — an exporter that
				// renames the series relies on this being declared.
				unit: "s",
				...(options.buckets
					? { advice: { explicitBucketBoundaries: [...options.buckets] } }
					: {}),
			}),
		);
		this.#histograms.set(options.name, created);
		return created;
	}

	/** OTel pushes; there is nothing to scrape. */
	scrape(): null {
		return null;
	}
}
