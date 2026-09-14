/**
 * Multi-exporter metrics manager — `{ default, exporters }` config plus
 * `metrics.use(name)`, the shape every pluggable module in the cohort takes
 * (echo's `CacheStoreManager`, eclipse's `LockManager`).
 *
 *   const metrics = new MetricsManager(defineConfig({
 *     default: "prometheus",
 *     exporters: {
 *       prometheus: drivers.prometheus(),
 *       otel: drivers.otel({ meter }),
 *     },
 *   }))
 *
 *   metrics.counter({ name: "orders_total", help: "Orders." }).increment()
 *   metrics.use("otel").counter({ name: "orders_total", help: "Orders." })
 *
 * The collection is named `exporters` rather than `drivers`, which is the
 * factory helper's name — the cohort names the collection after the domain
 * role (`stores`, `mailers`, `services`), and for metrics that role is the
 * exporter.
 */

import { NoopDriver } from "./drivers/NoopDriver.js";
import { OtelDriver, type OtelDriverOptions } from "./drivers/OtelDriver.js";
import { PrometheusDriver } from "./drivers/PrometheusDriver.js";
import { UnknownExporterError } from "./errors.js";
import type {
	Counter,
	DriverOptions,
	Gauge,
	Histogram,
	HistogramOptions,
	InstrumentOptions,
	MetricsDriver,
} from "./types.js";

/** A lazily-instantiated driver (built once per exporter, on first use). */
export type DriverFactory = () => MetricsDriver;

/** Driver factory helpers, named the way a config names them. */
export const drivers = {
	/** Scraped. Zero dependencies, holds series in memory. */
	prometheus(options?: DriverOptions): DriverFactory {
		return () => new PrometheusDriver(options);
	},
	/**
	 * Pushed through an OpenTelemetry meter the application already owns.
	 * Parsec never imports `@opentelemetry/api` — pass your own meter.
	 */
	otel(options: OtelDriverOptions): DriverFactory {
		return () => new OtelDriver(options);
	},
	/** Measures nothing. What an application with no config file gets. */
	noop(): DriverFactory {
		return () => new NoopDriver();
	},
};

export interface MetricsConfig {
	default: string;
	exporters: Record<string, DriverFactory>;
}

/**
 * Type-only helper so a config file is checked where it is written rather
 * than where it is consumed — the `defineConfig` every ream module exposes.
 */
export function defineConfig(config: MetricsConfig): MetricsConfig {
	return config;
}

/**
 * One exporter, and the instruments recorded through it.
 *
 * Thin on purpose. A metrics facade that buffers, renames or re-labels is a
 * layer that has to be reasoned about during an incident, which is exactly
 * when nobody wants to. It forwards, and it is the seam that lets the driver
 * be swapped without touching a single measurement.
 */
export class MetricsRecorder {
	readonly #driver: MetricsDriver;

	constructor(driver: MetricsDriver = new NoopDriver()) {
		this.#driver = driver;
	}

	/** The driver underneath, for anything this facade deliberately does not wrap. */
	getDriver(): MetricsDriver {
		return this.#driver;
	}

	counter(options: InstrumentOptions): Counter {
		return this.#driver.createCounter(options);
	}

	gauge(options: InstrumentOptions): Gauge {
		return this.#driver.createGauge(options);
	}

	histogram(options: HistogramOptions): Histogram {
		return this.#driver.createHistogram(options);
	}

	/**
	 * The scrape body, or `null` for an exporter that pushes.
	 *
	 * `null` is not an error — it is the honest answer for OpenTelemetry, and
	 * the endpoint turns it into a 404 rather than an empty 200 that would
	 * read to a scraper as "this target has no metrics".
	 */
	async scrape(): Promise<string | null> {
		return (await this.#driver.scrape?.()) ?? null;
	}

	async shutdown(): Promise<void> {
		await this.#driver.shutdown?.();
	}
}

export class MetricsManager {
	readonly #config: MetricsConfig;
	readonly #built = new Map<string, MetricsRecorder>();

	/**
	 * Built from a config, or from nothing at all.
	 *
	 * The no-argument form is what an application with no `config/metrics.ts`
	 * gets: a single noop exporter, so instrumentation can be written
	 * unconditionally and costs one empty call.
	 */
	constructor(config?: MetricsConfig) {
		this.#config = config ?? {
			default: "noop",
			exporters: { noop: drivers.noop() },
		};
		if (!this.#config.exporters[this.#config.default]) {
			throw new UnknownExporterError(
				this.#config.default,
				Object.keys(this.#config.exporters),
			);
		}
	}

	/** Resolve an exporter by name (or the default). Built once, then reused. */
	use(name?: string): MetricsRecorder {
		const exporter = name ?? this.#config.default;
		const existing = this.#built.get(exporter);
		if (existing) return existing;

		const factory = this.#config.exporters[exporter];
		if (!factory) {
			throw new UnknownExporterError(
				exporter,
				Object.keys(this.#config.exporters),
			);
		}
		const built = new MetricsRecorder(factory());
		this.#built.set(exporter, built);
		return built;
	}

	/** {@link MetricsRecorder.counter} on the default exporter. */
	counter(options: InstrumentOptions): Counter {
		return this.use().counter(options);
	}

	/** {@link MetricsRecorder.gauge} on the default exporter. */
	gauge(options: InstrumentOptions): Gauge {
		return this.use().gauge(options);
	}

	/** {@link MetricsRecorder.histogram} on the default exporter. */
	histogram(options: HistogramOptions): Histogram {
		return this.use().histogram(options);
	}

	/** {@link MetricsRecorder.scrape} on the default exporter. */
	scrape(): Promise<string | null> {
		return this.use().scrape();
	}

	/**
	 * Shut down every exporter that was actually built.
	 *
	 * Exporters are created on first use, so this reaches the ones the
	 * application asked for — naming an OTel exporter in an environment that
	 * only scrapes still builds nothing.
	 */
	async shutdown(): Promise<void> {
		await Promise.all(
			[...this.#built.values()].map((recorder) => recorder.shutdown()),
		);
	}
}
