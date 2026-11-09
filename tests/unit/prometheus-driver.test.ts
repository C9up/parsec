import { describe, expect, it } from "vitest";
import { PrometheusDriver } from "../../src/drivers/PrometheusDriver.js";
import {
	InstrumentConflictError,
	InvalidMeasurementError,
	ParsecError,
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

	it("renders a numeric label value as its string, like prom-client", () => {
		const driver = new PrometheusDriver();
		const counter = driver.createCounter({
			name: "responses_total",
			help: "r",
			labelNames: ["status"],
		});
		counter.increment(1, { status: 200 });
		counter.increment(1, { status: "200" });
		expect(driver.scrape()).toContain('responses_total{status="200"} 2');
	});

	it("refuses a label value that is not a string or a number at the call, and keeps the scrape alive", () => {
		// The failure used to surface at render time, on every later scrape,
		// taking every other metric of the process down with it.
		const driver = new PrometheusDriver();
		driver.createCounter({ name: "good_total", help: "g" }).increment();
		const bad = driver.createCounter({
			name: "bad_total",
			help: "b",
			labelNames: ["status"],
		});
		const values: unknown[] = [
			undefined,
			null,
			{},
			[],
			Symbol("s"),
			() => "x",
			Number.NaN,
			Number.POSITIVE_INFINITY,
			10n,
		];
		for (const value of values) {
			const labels: Record<string, unknown> = { status: value };
			expect(() => Reflect.apply(bad.increment, bad, [1, labels])).toThrow(
				expect.objectContaining({ code: "E_PARSEC_INVALID_LABEL_VALUE" }),
			);
		}
		const body = driver.scrape();
		expect(body).toContain("good_total 1");
		expect(body).not.toContain("bad_total{");
	});

	it("refuses the same bad label value on gauges and histograms", () => {
		const driver = new PrometheusDriver();
		const gauge = driver.createGauge({
			name: "g",
			help: "g",
			labelNames: ["k"],
		});
		const histogram = driver.createHistogram({
			name: "h",
			help: "h",
			labelNames: ["k"],
		});
		const labels: Record<string, unknown> = { k: undefined };
		expect(() => Reflect.apply(gauge.set, gauge, [1, labels])).toThrow(
			ParsecError,
		);
		expect(() =>
			Reflect.apply(histogram.observe, histogram, [1, labels]),
		).toThrow(ParsecError);
		expect(driver.scrape()).toBe("");
	});

	it("refuses an instrument declared without a string help at declaration", () => {
		const driver = new PrometheusDriver();
		for (const help of [undefined, 42, null]) {
			const options: Record<string, unknown> = { name: "x_total", help };
			expect(() =>
				Reflect.apply(driver.createCounter, driver, [options]),
			).toThrow(
				expect.objectContaining({ code: "E_PARSEC_INVALID_INSTRUMENT" }),
			);
		}
		// Nothing half-registered: the scrape still renders.
		driver.createCounter({ name: "ok_total", help: "o" }).increment();
		expect(driver.scrape()).toContain("ok_total 1");
	});

	it("keeps label sets apart whatever separator their values contain", () => {
		// The key used to join values with a space: {a:"x y",b:"z"} and
		// {a:"x",b:"y z"} landed on one series, the second credited to the first.
		const driver = new PrometheusDriver();
		const counter = driver.createCounter({
			name: "c_total",
			help: "c",
			labelNames: ["a", "b"],
		});
		const pairs: Array<[string, string]> = [
			["x y", "z"],
			["x", "y z"],
			["x,", "y"],
			["x", ",y"],
			["x:", "y"],
			["x", ":y"],
			["x\u0000", "y"],
			["x", "\u0000y"],
			['x"', "y"],
			["x", '"y'],
			["x\\", "y"],
		];
		pairs.forEach(([a, b], i) => {
			counter.increment(i + 1, { a, b });
		});
		const lines = driver
			.scrape()
			.split("\n")
			.filter((line) => line.startsWith("c_total{"));
		expect(lines).toHaveLength(pairs.length);
		expect(lines).toContain('c_total{a="x y",b="z"} 1');
		expect(lines).toContain('c_total{a="x",b="y z"} 2');
	});

	it("counts the cap per distinct label set, not per colliding key", () => {
		const driver = new PrometheusDriver({ maxSeries: 2 });
		const counter = driver.createCounter({
			name: "c_total",
			help: "c",
			labelNames: ["a", "b"],
		});
		counter.increment(1, { a: "x y", b: "z" });
		counter.increment(1, { a: "x", b: "y z" });
		counter.increment(1, { a: "q", b: "r" });
		expect(driver.scrape()).toContain(
			'parsec_series_dropped_total{metric="c_total"} 1',
		);
	});

	it("refuses a histogram label named le, which the bucket lines own", () => {
		// Accepted, it vanished from every bucket line and stayed on _sum and
		// _count: one series rendered with two different label sets.
		const driver = new PrometheusDriver();
		expect(() =>
			driver.createHistogram({ name: "h", help: "h", labelNames: ["le"] }),
		).toThrow(expect.objectContaining({ code: "E_PARSEC_INVALID_NAME" }));
		// le is only reserved where buckets are rendered.
		driver
			.createCounter({ name: "c_total", help: "c", labelNames: ["le"] })
			.increment(1, { le: "x" });
		expect(driver.scrape()).toContain('c_total{le="x"} 1');
	});

	it("refuses NaN and -Infinity bucket bounds at declaration", () => {
		const driver = new PrometheusDriver();
		for (const bound of [Number.NaN, Number.NEGATIVE_INFINITY]) {
			expect(() =>
				driver.createHistogram({ name: "h", help: "h", buckets: [1, bound] }),
			).toThrow(
				expect.objectContaining({ code: "E_PARSEC_INVALID_INSTRUMENT" }),
			);
		}
		const notNumbers: unknown[] = ["1", null, undefined];
		for (const bound of notNumbers) {
			const options: Record<string, unknown> = {
				name: "h",
				help: "h",
				buckets: [1, bound],
			};
			expect(() =>
				Reflect.apply(driver.createHistogram, driver, [options]),
			).toThrow(
				expect.objectContaining({ code: "E_PARSEC_INVALID_INSTRUMENT" }),
			);
		}
	});

	it("folds a +Infinity bound into the mandatory +Inf bucket instead of rendering it twice", () => {
		const driver = new PrometheusDriver();
		const histogram = driver.createHistogram({
			name: "h",
			help: "h",
			buckets: [1, Number.POSITIVE_INFINITY, 0.5],
		});
		histogram.observe(0.7);
		histogram.observe(3);
		const buckets = driver
			.scrape()
			.split("\n")
			.filter((line) => line.startsWith("h_bucket"));
		expect(buckets).toEqual([
			'h_bucket{le="0.5"} 0',
			'h_bucket{le="1"} 1',
			'h_bucket{le="+Inf"} 2',
		]);
	});
});
