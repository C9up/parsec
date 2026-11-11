/**
 * The process and runtime baseline — CPU, memory, event-loop lag, file
 * descriptors, GC, version — under the names prom-client's
 * `collectDefaultMetrics()` uses, so existing dashboards and alerts read it
 * unchanged.
 *
 *   import { collectDefaultMetrics } from "@c9up/parsec"
 *   const stop = collectDefaultMetrics(metrics)
 *
 * Opt-in, zero-dependency (node:perf_hooks, node:fs, `process`), and read
 * when it is scraped or collected through each instrument's `collect`, so a
 * process nobody scrapes does no work for it. Every label value is bounded by
 * the runtime, never by a request.
 */

import { readdirSync, readFileSync } from "node:fs";
import {
	type IntervalHistogram,
	monitorEventLoopDelay,
	PerformanceObserver,
	constants as perf,
} from "node:perf_hooks";
import type {
	Counter,
	CounterOptions,
	Gauge,
	GaugeOptions,
	Histogram,
	HistogramOptions,
} from "./types.js";

/** What the baseline is declared on: a MetricsManager or one of its recorders. */
export interface InstrumentFactory {
	counter(options: CounterOptions): Counter;
	gauge(options: GaugeOptions): Gauge;
	histogram(options: HistogramOptions): Histogram;
}

export interface DefaultMetricsOptions {
	/** Prepended to every name, e.g. `app_`. */
	prefix?: string;
	/** Sampling resolution of the event-loop delay monitor, in MILLISECONDS. Default 10. */
	eventLoopMonitoringPrecision?: number;
	/** Buckets of `nodejs_gc_duration_seconds`. */
	gcDurationBuckets?: readonly number[];
}

const GC_KINDS = new Map<number, string>([
	[perf.NODE_PERFORMANCE_GC_MAJOR, "major"],
	[perf.NODE_PERFORMANCE_GC_MINOR, "minor"],
	[perf.NODE_PERFORMANCE_GC_INCREMENTAL, "incremental"],
	[perf.NODE_PERFORMANCE_GC_WEAKCB, "weakcb"],
]);

/**
 * One declared baseline: its instruments live as long as the target, the
 * monitors only while it runs.
 */
interface Baseline {
	/** The stop of the run in progress, undefined while stopped. */
	stop: (() => void) | undefined;
	/** The event-loop delay monitor of the run in progress. */
	delay: IntervalHistogram | undefined;
}

/**
 * Baselines by target, then by prefix. Kept after a stop, so a restart reuses
 * the instruments and their `collect` callbacks instead of declaring new ones
 * the registry would refuse, and the callbacks read the new run's monitor.
 */
const baselines = new WeakMap<InstrumentFactory, Map<string, Baseline>>();

/** The CPU time `process.cpuUsage()` reports, in seconds, as a running total. */
function cpuCounter(
	metrics: InstrumentFactory,
	name: string,
	help: string,
	read: (usage: NodeJS.CpuUsage) => number,
): void {
	// From zero, so the total is the process's CPU time since it started
	// (what the name says), not since this call.
	let last = 0;
	metrics.counter({
		name,
		help,
		unit: "s",
		collect: (counter) => {
			const now = read(process.cpuUsage());
			// cpuUsage() is monotonic; the guard only keeps a clock oddity from
			// becoming a negative increment, which the counter would refuse.
			if (now > last) counter.increment((now - last) / 1e6);
			last = now;
		},
	});
}

/** The soft `Max open files` limit, from /proc on Linux. */
function maxFileDescriptors(): number | undefined {
	try {
		const limits = readFileSync("/proc/self/limits", "utf8");
		const match = /^Max open files\s+(\d+)/m.exec(limits);
		return match?.[1] === undefined ? undefined : Number(match[1]);
	} catch {
		return undefined;
	}
}

/**
 * Declare the baseline on `metrics` and start the two monitors it needs
 * (event-loop delay, GC). Returns the stop; calling it again for the same
 * target while running returns the same stop. One target is collected once:
 * a second monitor and GC observer would double-count. After a stop it starts
 * again on the instruments it declared the first time.
 */
export function collectDefaultMetrics(
	metrics: InstrumentFactory,
	options: DefaultMetricsOptions = {},
): () => void {
	const byPrefix = baselines.get(metrics) ?? new Map<string, Baseline>();
	for (const baseline of byPrefix.values()) {
		if (baseline.stop) return baseline.stop;
	}
	const prefix = options.prefix ?? "";
	const baseline = byPrefix.get(prefix) ?? declareBaseline(metrics, prefix);
	const stop = startBaseline(metrics, baseline, prefix, options);
	byPrefix.set(prefix, baseline);
	baselines.set(metrics, byPrefix);
	return stop;
}

/** Declare every instrument whose value is read at collection or set once. */
function declareBaseline(metrics: InstrumentFactory, prefix: string): Baseline {
	const baseline: Baseline = { stop: undefined, delay: undefined };
	const named = (name: string): string => `${prefix}${name}`;

	cpuCounter(
		metrics,
		named("process_cpu_user_seconds_total"),
		"Total user CPU time spent in seconds.",
		(usage) => usage.user,
	);
	cpuCounter(
		metrics,
		named("process_cpu_system_seconds_total"),
		"Total system CPU time spent in seconds.",
		(usage) => usage.system,
	);
	cpuCounter(
		metrics,
		named("process_cpu_seconds_total"),
		"Total user and system CPU time spent in seconds.",
		(usage) => usage.user + usage.system,
	);

	metrics
		.gauge({
			name: named("process_start_time_seconds"),
			help: "Start time of the process since unix epoch in seconds.",
			unit: "s",
		})
		.set(Math.round(Date.now() / 1000 - process.uptime()));

	metrics.gauge({
		name: named("process_resident_memory_bytes"),
		help: "Resident memory size in bytes.",
		unit: "By",
		collect: (gauge) => gauge.set(process.memoryUsage.rss()),
	});

	const heapUsed = metrics.gauge({
		name: named("nodejs_heap_size_used_bytes"),
		help: "Process heap size used from Node.js in bytes.",
		unit: "By",
	});
	const external = metrics.gauge({
		name: named("nodejs_external_memory_bytes"),
		help: "Node.js external memory size in bytes.",
		unit: "By",
	});
	metrics.gauge({
		name: named("nodejs_heap_size_total_bytes"),
		help: "Process heap size from Node.js in bytes.",
		unit: "By",
		// One memoryUsage() read sets all three.
		collect: (gauge) => {
			const usage = process.memoryUsage();
			gauge.set(usage.heapTotal);
			heapUsed.set(usage.heapUsed);
			external.set(usage.external);
		},
	});

	// The delay statistics come from the run's monitor, sampling all along;
	// each read reports the window since the previous one, then starts a new
	// window.
	const stats: Array<
		[string, string, (histogram: IntervalHistogram) => number]
	> = [
		["min", "The minimum recorded event loop delay.", (h) => h.min],
		["max", "The maximum recorded event loop delay.", (h) => h.max],
		["mean", "The mean of the recorded event loop delays.", (h) => h.mean],
		[
			"stddev",
			"The standard deviation of the recorded event loop delays.",
			(h) => h.stddev,
		],
		[
			"p50",
			"The 50th percentile of the recorded event loop delays.",
			(h) => h.percentile(50),
		],
		[
			"p90",
			"The 90th percentile of the recorded event loop delays.",
			(h) => h.percentile(90),
		],
		[
			"p99",
			"The 99th percentile of the recorded event loop delays.",
			(h) => h.percentile(99),
		],
	];
	const delayGauges = stats.map(
		([stat, help, read]): [Gauge, (histogram: IntervalHistogram) => number] => [
			metrics.gauge({
				name: named(`nodejs_eventloop_lag_${stat}_seconds`),
				help,
				unit: "s",
			}),
			read,
		],
	);
	metrics.gauge({
		name: named("nodejs_eventloop_lag_seconds"),
		help: "Lag of event loop in seconds.",
		unit: "s",
		collect: async (gauge) => {
			const started = process.hrtime.bigint();
			await new Promise<void>((resolve) => setImmediate(resolve));
			gauge.set(Number(process.hrtime.bigint() - started) / 1e9);
			const delay = baseline.delay;
			if (!delay) return;
			for (const [target, read] of delayGauges) {
				const nanoseconds = read(delay);
				// A window with no sample reports NaN or a sentinel; skip it
				// rather than export a meaningless number.
				if (
					Number.isFinite(nanoseconds) &&
					nanoseconds < Number.MAX_SAFE_INTEGER
				) {
					target.set(nanoseconds / 1e9);
				}
			}
			delay.reset();
		},
	});

	const activeResources = metrics.gauge({
		name: named("nodejs_active_resources"),
		help: "Number of active resources that are currently keeping the event loop alive, grouped by async resource type.",
		labelNames: ["type"],
	});
	metrics.gauge({
		name: named("nodejs_active_resources_total"),
		help: "Total number of active resources.",
		collect: (gauge) => {
			const types = process.getActiveResourcesInfo();
			const counts = new Map<string, number>();
			for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1);
			// Reset first, so a resource type that went away does not stay at
			// its last count forever.
			activeResources.reset();
			for (const [type, count] of counts) activeResources.set(count, { type });
			gauge.set(types.length);
		},
	});

	if (process.platform === "linux") {
		metrics.gauge({
			name: named("process_open_fds"),
			help: "Number of open file descriptors.",
			collect: (gauge) => {
				// Minus the descriptor readdir itself opened.
				gauge.set(readdirSync("/proc/self/fd").length - 1);
			},
		});
		const max = maxFileDescriptors();
		if (max !== undefined) {
			metrics
				.gauge({
					name: named("process_max_fds"),
					help: "Maximum number of open file descriptors.",
				})
				.set(max);
		}
	}

	const [major = "", minor = "", patch = ""] = process.versions.node.split(".");
	metrics
		.gauge({
			name: named("nodejs_version_info"),
			help: "Node.js version info.",
			labelNames: ["version", "major", "minor", "patch"],
		})
		.set(1, { version: process.version, major, minor, patch });

	return baseline;
}

/** Start the two monitors of one run and return its stop. */
function startBaseline(
	metrics: InstrumentFactory,
	baseline: Baseline,
	prefix: string,
	options: DefaultMetricsOptions,
): () => void {
	// Declared per run, before any monitor starts: a restart asking for other
	// buckets is refused by the registry and leaves nothing running.
	const gcDuration = metrics.histogram({
		name: `${prefix}nodejs_gc_duration_seconds`,
		help: "Garbage collection duration by kind, one of major, minor, incremental or weakcb.",
		labelNames: ["kind"],
		buckets: options.gcDurationBuckets ?? [0.001, 0.01, 0.1, 1, 2, 5],
		unit: "s",
	});
	const gc = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) {
			// `detail` holds the kind on current Node; read structurally, since
			// not every @types/node version declares it.
			const detail: unknown = Reflect.get(entry, "detail");
			const kind =
				typeof detail === "object" && detail !== null
					? Reflect.get(detail, "kind")
					: undefined;
			const label = typeof kind === "number" ? GC_KINDS.get(kind) : undefined;
			// Milliseconds from perf_hooks, seconds in the metric.
			if (label) gcDuration.observe(entry.duration / 1000, { kind: label });
		}
	});
	gc.observe({ entryTypes: ["gc"] });

	const delay = monitorEventLoopDelay({
		resolution: options.eventLoopMonitoringPrecision ?? 10,
	});
	delay.enable();
	baseline.delay = delay;

	const stop = (): void => {
		if (baseline.stop !== stop) return;
		baseline.stop = undefined;
		baseline.delay = undefined;
		delay.disable();
		gc.disconnect();
	};
	baseline.stop = stop;
	return stop;
}
