import { describe, expect, it, vi } from "vitest";
import { NoopDriver } from "../../src/drivers/NoopDriver.js";
import { OtelDriver, type OtelMeter } from "../../src/drivers/OtelDriver.js";

describe("NoopDriver", () => {
	it("measures nothing but still runs the work it is given", async () => {
		// The instrument is inert, the application is not.
		const driver = new NoopDriver();
		const ran = vi.fn().mockResolvedValue("value");
		const result = await driver.createHistogram().time(ran);
		expect(result).toBe("value");
		expect(ran).toHaveBeenCalledOnce();
		expect(driver.scrape()).toBe(null);
	});

	it("accepts every instrument call without raising", () => {
		const driver = new NoopDriver();
		expect(() => driver.createCounter().increment(5)).not.toThrow();
		const gauge = driver.createGauge();
		expect(() => {
			gauge.set(1);
			gauge.increment();
			gauge.decrement();
		}).not.toThrow();
	});
});

function meter() {
	const add = vi.fn();
	const record = vi.fn();
	const gaugeRecord = vi.fn();
	const created: { histogram?: object; counter?: object } = {};
	const m: OtelMeter = {
		createCounter: (name, options) => {
			if (name !== "parsec_series_dropped_total")
				created.counter = options ?? {};
			return { add };
		},
		createGauge: () => ({ record: gaugeRecord }),
		createHistogram: (_name, options) => {
			created.histogram = options ?? {};
			return { record };
		},
	};
	return { meter: m, add, record, gaugeRecord, created };
}

describe("OtelDriver", () => {
	it("forwards a counter to the meter with its attributes", () => {
		const { meter: m, add } = meter();
		new OtelDriver({ meter: m })
			.createCounter({
				name: "orders_total",
				help: "Orders.",
				labelNames: ["region"],
			})
			.increment(3, { region: "eu" });
		expect(add).toHaveBeenCalledWith(3, { region: "eu" });
	});

	it("passes the declared unit, so an exporter can rename the series", () => {
		const { meter: m, created } = meter();
		new OtelDriver({ meter: m }).createHistogram({
			name: "d_seconds",
			help: "d",
			buckets: [1, 2],
			unit: "s",
		});
		expect(created.histogram).toMatchObject({
			unit: "s",
			advice: { explicitBucketBoundaries: [1, 2] },
		});
	});

	it("expresses increment against an absolute-only gauge by tracking the last value", () => {
		const { meter: m, gaugeRecord } = meter();
		const gauge = new OtelDriver({ meter: m }).createGauge({
			name: "g",
			help: "g",
			labelNames: ["a"],
		});
		gauge.set(10, { a: "1" });
		gauge.increment(5, { a: "1" });
		gauge.decrement(3, { a: "1" });
		expect(gaugeRecord).toHaveBeenLastCalledWith(12, { a: "1" });
	});

	it("keeps each label set's gauge value apart", () => {
		const { meter: m, gaugeRecord } = meter();
		const gauge = new OtelDriver({ meter: m }).createGauge({
			name: "g",
			help: "g",
			labelNames: ["a"],
		});
		gauge.set(10, { a: "1" });
		gauge.set(100, { a: "2" });
		gauge.increment(1, { a: "1" });
		expect(gaugeRecord).toHaveBeenLastCalledWith(11, { a: "1" });
	});

	it("builds an instrument once per name, as the Prometheus driver does", () => {
		const createCounter = vi.fn((_name: string) => ({ add: vi.fn() }));
		const { meter: m } = meter();
		const driver = new OtelDriver({ meter: { ...m, createCounter } });
		driver.createCounter({ name: "c_total", help: "c" });
		driver.createCounter({ name: "c_total", help: "c" });
		const forC = createCounter.mock.calls.filter(
			([name]) => name === "c_total",
		);
		expect(forC).toHaveLength(1);
	});

	it("has nothing to scrape — it pushes", () => {
		const { meter: m } = meter();
		expect(new OtelDriver({ meter: m }).scrape()).toBe(null);
	});

	it("uses the SDK's own default boundaries when none are declared", () => {
		const { meter: m, created } = meter();
		new OtelDriver({ meter: m }).createHistogram({
			name: "d_seconds",
			help: "d",
		});
		// No `advice`, so the collector's configured view decides — imposing
		// parsec's web-latency ladder on an OTel pipeline would override a
		// choice the deployment already made.
		expect(created.histogram).not.toHaveProperty("advice");
		expect(created.histogram).toMatchObject({ unit: "s" });
	});

	it("forwards a histogram observation to the meter", () => {
		const { meter: m, record } = meter();
		new OtelDriver({ meter: m })
			.createHistogram({ name: "d_seconds", help: "d", labelNames: ["route"] })
			.observe(1.5, { route: "/x" });
		expect(record).toHaveBeenCalledWith(1.5, { route: "/x" });
	});

	it("times work through the meter, recording even when it throws", async () => {
		const { meter: m, record } = meter();
		const histogram = new OtelDriver({ meter: m }).createHistogram({
			name: "d_seconds",
			help: "d",
		});
		await expect(
			histogram.time(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(record).toHaveBeenCalledOnce();
	});

	it("reuses a gauge and a histogram by name too", () => {
		const { meter: m } = meter();
		const driver = new OtelDriver({ meter: m });
		expect(driver.createGauge({ name: "g", help: "g" })).toBe(
			driver.createGauge({ name: "g", help: "g" }),
		);
		expect(driver.createHistogram({ name: "h", help: "h" })).toBe(
			driver.createHistogram({ name: "h", help: "h" }),
		);
	});

	it("validates histogram buckets and the reserved le label like the Prometheus driver", () => {
		const { meter: m, created } = meter();
		const driver = new OtelDriver({ meter: m });
		expect(() =>
			driver.createHistogram({ name: "h", help: "h", labelNames: ["le"] }),
		).toThrow(expect.objectContaining({ code: "E_PARSEC_INVALID_NAME" }));
		expect(() =>
			driver.createHistogram({ name: "h2", help: "h", buckets: [Number.NaN] }),
		).toThrow(expect.objectContaining({ code: "E_PARSEC_INVALID_INSTRUMENT" }));
		driver.createHistogram({
			name: "h3",
			help: "h",
			buckets: [2, Number.POSITIVE_INFINITY, 1, 2],
		});
		expect(created.histogram).toMatchObject({
			advice: { explicitBucketBoundaries: [1, 2] },
		});
	});

	it("states no unit for a histogram with its own buckets and no declared unit", () => {
		// payload_bytes exported as seconds would be renamed `_seconds` by an
		// OTel-to-Prometheus exporter.
		const { meter: m, created } = meter();
		new OtelDriver({ meter: m }).createHistogram({
			name: "payload_bytes",
			help: "p",
			buckets: [1024, 65536],
		});
		expect(created.histogram).not.toHaveProperty("unit");
		new OtelDriver({ meter: m }).createHistogram({
			name: "payload_bytes",
			help: "p",
			buckets: [1024, 65536],
			unit: "By",
		});
		expect(created.histogram).toMatchObject({ unit: "By" });
	});

	it("passes a counter's unit, and refuses one OpenTelemetry cannot carry", () => {
		const { meter: m, created } = meter();
		const driver = new OtelDriver({ meter: m });
		driver.createCounter({ name: "bytes_total", help: "b", unit: "By" });
		expect(created.counter).toEqual({ description: "b", unit: "By" });
		expect(() =>
			driver.createCounter({ name: "x_total", help: "x", unit: "has space" }),
		).toThrow(expect.objectContaining({ code: "E_PARSEC_INVALID_INSTRUMENT" }));
		expect(() =>
			driver.createCounter({
				name: "y_total",
				help: "y",
				unit: "u".repeat(64),
			}),
		).toThrow(expect.objectContaining({ code: "E_PARSEC_INVALID_INSTRUMENT" }));
	});
});
