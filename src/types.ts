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
 * Strings or finite numbers, as in prom-client. A number is stringified once,
 * by the shared contract, before any driver sees it — so `{ status: 200 }`
 * and `{ status: "200" }` are one series on every backend. Anything else is
 * refused at the call.
 */
export type Labels = Readonly<Record<string, string | number>>;

/**
 * What every instrument can do to its own series.
 *
 * A finished job, a disconnected tenant: a series nothing will update again
 * would otherwise sit there until the process restarts, holding one of the
 * instrument's `maxSeries` slots until legitimate new series start being
 * dropped.
 */
export interface SeriesLifecycle {
	/** Forget one label set. Removing one never recorded is not an error. */
	remove(labels?: Labels): void;
	/** Forget every label set of this instrument. */
	reset(): void;
}

/**
 * Ends a timer: records the elapsed SECONDS, with the start labels merged
 * with these, and returns them.
 */
export type EndTimer = (labels?: Labels) => number;

/** A value that only ever goes up. Requests served, errors, bytes written. */
export interface Counter extends SeriesLifecycle {
	/** Add to the counter. `value` must be finite and non-negative. */
	increment(value?: number, labels?: Labels): void;
}

/** A value that moves in both directions. Connections open, queue depth. */
export interface Gauge extends SeriesLifecycle {
	set(value: number, labels?: Labels): void;
	increment(value?: number, labels?: Labels): void;
	decrement(value?: number, labels?: Labels): void;
	/** Start a timer whose end SETS the gauge to the elapsed seconds. */
	startTimer(labels?: Labels): EndTimer;
}

/** A distribution of observations. Request duration, payload size. */
export interface Histogram extends SeriesLifecycle {
	/** Record one observation. `value` must be finite and non-negative. */
	observe(value: number, labels?: Labels): void;
	/**
	 * Time `work`, record the elapsed SECONDS, and return its result.
	 *
	 * Records on the way out either way: a handler that throws still took
	 * time, and dropping those observations is how a latency chart comes out
	 * looking healthy during an incident.
	 */
	time<T>(work: () => Promise<T>, labels?: Labels): Promise<T>;
	/** Start a timer whose end observes the elapsed seconds. */
	startTimer(labels?: Labels): EndTimer;
}

/**
 * Computes an instrument's values when they are read rather than when they
 * change — a queue depth, a pool size, the process's CPU time.
 *
 * Runs before each scrape under Prometheus, and on each collection under
 * OpenTelemetry (through an observable instrument). It receives the
 * instrument and records through it as usual, labels included.
 */
export type Collect<T> = (instrument: T) => void | Promise<void>;

export interface InstrumentOptions {
	/** Metric name. Prometheus-shaped: `[a-zA-Z_:][a-zA-Z0-9_:]*`. */
	name: string;
	/** One line saying what it measures, rendered as HELP. Must be a string. */
	help: string;
	/**
	 * The label names this instrument may carry, declared up front.
	 *
	 * Declaring them is what makes an unbounded label set a startup error
	 * rather than a slow memory leak — see {@link DriverOptions.maxSeries}.
	 */
	labelNames?: readonly string[];
	/**
	 * The unit of the values, OpenTelemetry-style (`s`, `By`, `1`), exported
	 * by drivers that carry one. Histograms default to `s` when they also use
	 * the default latency buckets, which are seconds; anything else states its
	 * own unit or has none. The Prometheus text format has no unit line — put
	 * it in the name there (`_seconds`, `_bytes`).
	 */
	unit?: string;
}

export interface CounterOptions extends InstrumentOptions {
	/** Add what happened since the last read, when it is read. */
	collect?: Collect<Counter>;
}

export interface GaugeOptions extends InstrumentOptions {
	/** Set the current value when it is read. */
	collect?: Collect<Gauge>;
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
	/**
	 * How long one `collect` callback may take during a scrape, in
	 * MILLISECONDS (a timer, not a measurement). Past it the instrument keeps
	 * its previous values and the failure is counted in
	 * `parsec_collect_failures_total`, rather than one stuck callback hanging
	 * the whole scrape. Default 5000. Pushing drivers leave this to their SDK.
	 */
	collectTimeout?: number;
}

/**
 * A metrics backend.
 *
 * Instruments are created once and reused; a driver must return the SAME
 * instrument for the same name, because a caller that creates one per request
 * is the other half of the cardinality problem.
 */
export interface MetricsDriver {
	createCounter(options: CounterOptions): Counter;
	createGauge(options: GaugeOptions): Gauge;
	createHistogram(options: HistogramOptions): Histogram;
	/**
	 * Render the current state in whatever format this driver exposes, or
	 * `null` for a driver that pushes instead of being scraped.
	 */
	scrape?(): Promise<string> | string | null;
	/** Release what this driver owns. */
	shutdown?(): Promise<void>;
}
