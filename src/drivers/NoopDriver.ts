/**
 * The driver that measures nothing.
 *
 * The default, so that instrumentation can be written unconditionally and an
 * application that has not configured a backend pays a no-op call rather than
 * needing a `if (metrics)` around every measurement.
 */

import type { Counter, Gauge, Histogram, MetricsDriver } from "../types.js";

const counter: Counter = { increment: () => {} };
const gauge: Gauge = {
	set: () => {},
	increment: () => {},
	decrement: () => {},
};
const histogram: Histogram = {
	observe: () => {},
	// Still RUNS the work — the instrument is inert, the application is not.
	time: (work) => work(),
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
