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
	const created: { histogram?: Record<string, unknown> } = {};
	const m: OtelMeter = {
		createCounter: () => ({ add }),
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
			.createCounter({ name: "orders_total", help: "Orders." })
			.increment(3, { region: "eu" });
		expect(add).toHaveBeenCalledWith(3, { region: "eu" });
	});

	it("declares seconds as the histogram unit, so an exporter can rename it", () => {
		const { meter: m, created } = meter();
		new OtelDriver({ meter: m }).createHistogram({
			name: "d_seconds",
			help: "d",
			buckets: [1, 2],
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
		});
		gauge.set(10, { a: "1" });
		gauge.set(100, { a: "2" });
		gauge.increment(1, { a: "1" });
		expect(gaugeRecord).toHaveBeenLastCalledWith(11, { a: "1" });
	});

	it("builds an instrument once per name, as the Prometheus driver does", () => {
		const createCounter = vi.fn(() => ({ add: vi.fn() }));
		const { meter: m } = meter();
		const driver = new OtelDriver({ meter: { ...m, createCounter } });
		driver.createCounter({ name: "c_total", help: "c" });
		driver.createCounter({ name: "c_total", help: "c" });
		expect(createCounter).toHaveBeenCalledTimes(1);
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
			.createHistogram({ name: "d_seconds", help: "d" })
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
});
