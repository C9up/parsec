/**
 * Instrument contracts.
 *
 * There is no upstream to mirror: AdonisJS publishes no metrics or telemetry
 * package (verified against the org's published list — application, bouncer,
 * cache, config, core, cors, encryption, health, i18n, lock, logger, presets,
 * redis, repl, session, static, tsconfig, vite). So this is judged on its own
 * merits, and shaped like the rest of the cohort: a driver contract with
 * pluggable backends, the way echo, bay and eclipse are.
 *
 * The three instrument types are the Prometheus/OpenTelemetry intersection.
 * Anything either can express beyond them (summaries, exemplars, exponential
 * histograms) is deliberately absent: a contract that only ONE driver can
 * honour is not a contract.
 */

/**
 * Label values attached to a measurement.
 *
 * Values are strings because that is what both backends store. A number left
 * as a number would be stringified somewhere later, differently per driver.
 */
export type Labels = Readonly<Record<string, string>>;

/** A value that only ever goes up. Requests served, errors, bytes written. */
export interface Counter {
	/** Add to the counter. `value` must be finite and non-negative. */
	increment(value?: number, labels?: Labels): void;
}

/** A value that moves in both directions. Connections open, queue depth. */
export interface Gauge {
	set(value: number, labels?: Labels): void;
	increment(value?: number, labels?: Labels): void;
	decrement(value?: number, labels?: Labels): void;
}

/** A distribution of observations. Request duration, payload size. */
export interface Histogram {
	observe(value: number, labels?: Labels): void;
	/**
	 * Time `work`, record the elapsed SECONDS, and return its result.
	 *
	 * Records on the way out either way: a handler that throws still took
	 * time, and dropping those observations is how a latency chart comes out
	 * looking healthy during an incident.
	 */
	time<T>(work: () => Promise<T>, labels?: Labels): Promise<T>;
}

export interface InstrumentOptions {
	/** Metric name. Prometheus-shaped: `[a-zA-Z_:][a-zA-Z0-9_:]*`. */
	name: string;
	/** One line saying what it measures, rendered as HELP. */
	help: string;
	/**
	 * The label names this instrument may carry, declared up front.
	 *
	 * Declaring them is what makes an unbounded label set a startup error
	 * rather than a slow memory leak — see {@link DriverOptions.maxSeries}.
	 */
	labelNames?: readonly string[];
}

export interface HistogramOptions extends InstrumentOptions {
	/**
	 * Bucket upper bounds, ascending, in the instrument's own unit.
	 *
	 * Defaults to a latency ladder in SECONDS, which is the Prometheus
	 * convention — durations are seconds there, however unnatural that reads
	 * next to `@c9up/eclipse`, whose leases are milliseconds because Redis
	 * takes milliseconds. Each is native to its own layer.
	 */
	buckets?: readonly number[];
}

export interface DriverOptions {
	/**
	 * How many distinct label combinations ONE instrument may hold.
	 *
	 * This is the metric-system equivalent of an unbounded dedup key: a label
	 * whose value comes from a request — a path with an id in it, a user
	 * agent, a tenant — turns a counter into an unbounded map that nothing
	 * ever evicts. The cap makes that a dropped series and a visible counter
	 * instead of an outage. Default 1000.
	 */
	maxSeries?: number;
}

/**
 * A metrics backend.
 *
 * Instruments are created once and reused; a driver must return the SAME
 * instrument for the same name, because a caller that creates one per request
 * is the other half of the cardinality problem.
 */
export interface MetricsDriver {
	createCounter(options: InstrumentOptions): Counter;
	createGauge(options: InstrumentOptions): Gauge;
	createHistogram(options: HistogramOptions): Histogram;
	/**
	 * Render the current state in whatever format this driver exposes, or
	 * `null` for a driver that pushes instead of being scraped.
	 */
	scrape?(): Promise<string> | string | null;
	/** Release what this driver owns. */
	shutdown?(): Promise<void>;
}
