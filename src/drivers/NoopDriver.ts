/**
 * The driver that measures nothing.
 *
 * The default, so that instrumentation can be written unconditionally and an
 * application that has not configured a backend pays a no-op call rather than
 * needing a `if (metrics)` around every measurement.
 */

import type {
	Counter,
	EndTimer,
	Gauge,
	Histogram,
	MetricsDriver,
} from "../types.js";

const nothing = (): void => {};
/** Still measures the time: the caller may use the returned seconds. */
const timer = (): EndTimer => {
	const started = process.hrtime.bigint();
	return () => Number(process.hrtime.bigint() - started) / 1e9;
};

const counter: Counter = {
	increment: nothing,
	remove: nothing,
	reset: nothing,
};
const gauge: Gauge = {
	set: nothing,
	increment: nothing,
	decrement: nothing,
	startTimer: timer,
	remove: nothing,
	reset: nothing,
};
const histogram: Histogram = {
	observe: nothing,
	// Still RUNS the work — the instrument is inert, the application is not.
	time: (work) => work(),
	startTimer: timer,
	remove: nothing,
	reset: nothing,
};

export class NoopDriver implements MetricsDriver {
	createCounter(): Counter {
		return counter;
	}
	createGauge(): Gauge {
		return gauge;
	}
	createHistogram(): Histogram {
		return histogram;
	}
	scrape(): null {
		return null;
	}
}
