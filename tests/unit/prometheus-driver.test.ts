import { describe, expect, it } from "vitest";
import { PrometheusDriver } from "../../src/drivers/PrometheusDriver.js";
import {
	InstrumentConflictError,
	InvalidMeasurementError,
	UndeclaredLabelError,
} from "../../src/errors.js";

describe("PrometheusDriver", () => {
	it("renders a counter with HELP and TYPE", () => {
		const driver = new PrometheusDriver();
		driver
			.createCounter({ name: "orders_total", help: "Orders placed." })
			.increment();
		const body = driver.scrape();
		expect(body).toContain("# HELP orders_total Orders placed.");
		expect(body).toContain("# TYPE orders_total counter");
		expect(body).toContain("orders_total 1");
	});

	it("refuses a negative increment — it reads downstream as a restart", () => {
		const counter = new PrometheusDriver().createCounter({
			name: "c_total",
			help: "c",
		});
		expect(() => counter.increment(-1)).toThrow(InvalidMeasurementError);
	});

	it("refuses a non-finite measurement, which would poison a sum forever", () => {
		const driver = new PrometheusDriver();
		expect(() =>
			driver.createGauge({ name: "g", help: "g" }).set(Number.NaN),
		).toThrow(InvalidMeasurementError);
		expect(() =>
			driver
				.createHistogram({ name: "h", help: "h" })
				.observe(Number.POSITIVE_INFINITY),
		).toThrow(InvalidMeasurementError);
	});

	it("raises on a label the instrument never declared", () => {
		// Almost always the request-derived value that would have made this
		// instrument unbounded.
		const counter = new PrometheusDriver().createCounter({
			name: "c_total",
			help: "c",
			labelNames: ["route"],
		});
		expect(() => counter.increment(1, { userId: "42" })).toThrow(
			UndeclaredLabelError,
		);
	});

	it("treats the same labels written in a different order as one series", () => {
		const driver = new PrometheusDriver();
		const counter = driver.createCounter({
			name: "c_total",
			help: "c",
			labelNames: ["a", "b"],
		});
		counter.increment(1, { a: "1", b: "2" });
		counter.increment(1, { b: "2", a: "1" });
		expect(driver.scrape()).toContain('c_total{a="1",b="2"} 2');
	});

	it("renders cumulative buckets, a mandatory +Inf, a sum and a count", () => {
		const driver = new PrometheusDriver();
		const histogram = driver.createHistogram({
			name: "d_seconds",
			help: "d",
			buckets: [1, 2],
		});
		histogram.observe(0.5);
		histogram.observe(1.5);
		histogram.observe(50);
		const body = driver.scrape();
		expect(body).toContain('d_seconds_bucket{le="1"} 1');
		// Cumulative: the 1.5 observation counts in le=2 as well as the 0.5.
		expect(body).toContain('d_seconds_bucket{le="2"} 2');
		// The 50 lands only in +Inf, which always equals the total count.
		expect(body).toContain('d_seconds_bucket{le="+Inf"} 3');
		expect(body).toContain("d_seconds_sum 52");
		expect(body).toContain("d_seconds_count 3");
	});

	it("drops duplicate bucket bounds, which make quantiles non-monotonic", () => {
		const driver = new PrometheusDriver();
		driver
			.createHistogram({ name: "d_seconds", help: "d", buckets: [1, 1, 2] })
			.observe(0.5);
		const buckets = (driver.scrape().match(/le="1"/g) ?? []).length;
		expect(buckets).toBe(1);
	});

	it("sorts unordered buckets rather than rendering a broken histogram", () => {
		const driver = new PrometheusDriver();
		driver
			.createHistogram({ name: "d_seconds", help: "d", buckets: [2, 0.5, 1] })
			.observe(0.75);
		const body = driver.scrape();
		const order = [...body.matchAll(/le="([^"]+)"/g)].map((m) => m[1]);
		expect(order).toEqual(["0.5", "1", "2", "+Inf"]);
	});

	it("caps cardinality and reports the refusal instead of growing forever", () => {
		const driver = new PrometheusDriver({ maxSeries: 2 });
		const counter = driver.createCounter({
			name: "c_total",
			help: "c",
			labelNames: ["route"],
		});
		counter.increment(1, { route: "/a" });
		counter.increment(1, { route: "/b" });
		counter.increment(1, { route: "/c" });
		const body = driver.scrape();
		expect(body).toContain('c_total{route="/a"} 1');
		expect(body).toContain('c_total{route="/b"} 1');
		expect(body).not.toContain('route="/c"');
		// Refused, and visible — not silently absent.
		expect(body).toContain('parsec_series_dropped_total{metric="c_total"} 1');
	});

	it("keeps counting an EXISTING series after the cap is reached", () => {
		const driver = new PrometheusDriver({ maxSeries: 1 });
		const counter = driver.createCounter({
			name: "c_total",
			help: "c",
			labelNames: ["route"],
		});
		counter.increment(1, { route: "/a" });
		counter.increment(1, { route: "/b" });
		counter.increment(1, { route: "/a" });
		expect(driver.scrape()).toContain('c_total{route="/a"} 2');
	});

	it("labels the dropped counter by metric name, never by the offending value", () => {
		// A counter reporting the dropped LABEL VALUE would reintroduce the
		// unbounded set it exists to report.
		const driver = new PrometheusDriver({ maxSeries: 1 });
		const counter = driver.createCounter({
			name: "c_total",
			help: "c",
			labelNames: ["route"],
		});
		counter.increment(1, { route: "/a" });
		for (const route of ["/x", "/y", "/z"]) counter.increment(1, { route });
		const body = driver.scrape();
		expect(body).toContain('parsec_series_dropped_total{metric="c_total"} 3');
		expect(body).not.toContain("/x");
	});

	it("returns the same instrument for the same name", () => {
		const driver = new PrometheusDriver();
		const a = driver.createCounter({ name: "c_total", help: "c" });
		const b = driver.createCounter({ name: "c_total", help: "c" });
		expect(a).toBe(b);
	});

	it("refuses the same name declared with a different type or label set", () => {
		const driver = new PrometheusDriver();
		driver.createCounter({ name: "x_total", help: "x", labelNames: ["a"] });
		expect(() => driver.createGauge({ name: "x_total", help: "x" })).toThrow(
			InstrumentConflictError,
		);
		expect(() =>
			driver.createCounter({ name: "x_total", help: "x", labelNames: ["b"] }),
		).toThrow(/label set/);
	});

	it("escapes a label value that would otherwise break the body", () => {
		const driver = new PrometheusDriver();
		driver
			.createCounter({ name: "c_total", help: "c", labelNames: ["ua"] })
			.increment(1, { ua: 'evil"\nvalue' });
		const body = driver.scrape();
		expect(body).toContain('c_total{ua="evil\\"\\nvalue"} 1');
		// One sample line, not two.
		expect(
			body.split("\n").filter((l) => l.startsWith("c_total")),
		).toHaveLength(1);
	});

	it("gauges move both ways", () => {
		const driver = new PrometheusDriver();
		const gauge = driver.createGauge({ name: "g", help: "g" });
		gauge.set(10);
		gauge.increment(5);
		gauge.decrement(3);
		expect(driver.scrape()).toContain("g 12");
	});

	it("renders nothing for an instrument that was never touched", () => {
		const driver = new PrometheusDriver();
		driver.createCounter({ name: "never_total", help: "n" });
		expect(driver.scrape()).toBe("");
	});

	it("times work in seconds and records even when it throws", async () => {
		const driver = new PrometheusDriver();
		const histogram = driver.createHistogram({ name: "d_seconds", help: "d" });
		await expect(
			histogram.time(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		// Dropping failed calls is how a latency chart stays flat through an
		// incident.
		expect(driver.scrape()).toContain("d_seconds_count 1");
	});
});
