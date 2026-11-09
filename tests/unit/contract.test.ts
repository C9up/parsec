import { describe, expect, it } from "vitest";
import { OtelDriver, type OtelMeter } from "../../src/drivers/OtelDriver.js";
import { PrometheusDriver } from "../../src/drivers/PrometheusDriver.js";
import {
	InstrumentConflictError,
	InvalidMeasurementError,
	InvalidMetricNameError,
	UndeclaredLabelError,
} from "../../src/errors.js";
import type { DriverOptions, MetricsDriver } from "../../src/types.js";

/**
 * The instrument contract, run against every driver.
 *
 * A check that only one driver makes is behaviour that changes with
 * METRICS_EXPORTER, so each case here must hold on both.
 */

interface Recorded {
	instrument: string;
	value: number;
	attributes: Record<string, unknown> | undefined;
}

function recordingMeter() {
	const calls: Recorded[] = [];
	const instrument = (name: string) => ({
		add: (value: number, attributes?: Record<string, unknown>) => {
			calls.push({ instrument: name, value, attributes });
		},
		record: (value: number, attributes?: Record<string, unknown>) => {
			calls.push({ instrument: name, value, attributes });
		},
	});
	const meter: OtelMeter = {
		createCounter: (name) => instrument(name),
		createGauge: (name) => instrument(name),
		createHistogram: (name) => instrument(name),
	};
	return { meter, calls };
}

interface Case {
	name: string;
	build(options?: DriverOptions): {
		driver: MetricsDriver;
		/** How many series of `metric` were refused by the cap. */
		dropped(metric: string): Promise<number>;
	};
}

const cases: Case[] = [
	{
		name: "PrometheusDriver",
		build(options) {
			const driver = new PrometheusDriver(options);
			return {
				driver,
				async dropped(metric) {
					const body = await driver.scrape();
					const match = new RegExp(
						`^parsec_series_dropped_total\\{metric="${metric}"\\} (\\d+)$`,
						"m",
					).exec(body);
					return Number(match?.[1] ?? 0);
				},
			};
		},
	},
	{
		name: "OtelDriver",
		build(options) {
			const { meter, calls } = recordingMeter();
			const driver = new OtelDriver({ ...options, meter });
			return {
				driver,
				async dropped(metric) {
					return calls
						.filter(
							(call) =>
								call.instrument === "parsec_series_dropped_total" &&
								call.attributes?.metric === metric,
						)
						.reduce((sum, call) => sum + call.value, 0);
				},
			};
		},
	},
];

describe.each(cases)("instrument contract: $name", (c) => {
	it("refuses a metric name the exposition format cannot carry", () => {
		const { driver } = c.build();
		expect(() =>
			driver.createCounter({ name: "bad name!", help: "h" }),
		).toThrow(InvalidMetricNameError);
		expect(() => driver.createGauge({ name: "1st", help: "h" })).toThrow(
			InvalidMetricNameError,
		);
		const options: Record<string, unknown> = { name: undefined, help: "h" };
		expect(() =>
			Reflect.apply(driver.createHistogram, driver, [options]),
		).toThrow(InvalidMetricNameError);
	});

	it("refuses an invalid, reserved or repeated label name", () => {
		const { driver } = c.build();
		expect(() =>
			driver.createCounter({ name: "a_total", help: "h", labelNames: ["a-b"] }),
		).toThrow(InvalidMetricNameError);
		expect(() =>
			driver.createCounter({
				name: "b_total",
				help: "h",
				labelNames: ["__name__"],
			}),
		).toThrow(InvalidMetricNameError);
		expect(() =>
			driver.createCounter({
				name: "c_total",
				help: "h",
				labelNames: ["route", "route"],
			}),
		).toThrow(InvalidMetricNameError);
	});

	it("refuses a missing help", () => {
		const { driver } = c.build();
		const options: Record<string, unknown> = { name: "x_total" };
		expect(() =>
			Reflect.apply(driver.createCounter, driver, [options]),
		).toThrow(expect.objectContaining({ code: "E_PARSEC_INVALID_INSTRUMENT" }));
	});

	it("refuses an undeclared label at the call", () => {
		const { driver } = c.build();
		const counter = driver.createCounter({
			name: "c_total",
			help: "h",
			labelNames: ["route"],
		});
		expect(() => counter.increment(1, { userId: "42" })).toThrow(
			UndeclaredLabelError,
		);
		const gauge = driver.createGauge({ name: "g", help: "h" });
		expect(() => gauge.set(1, { k: "v" })).toThrow(UndeclaredLabelError);
		const histogram = driver.createHistogram({ name: "h", help: "h" });
		expect(() => histogram.observe(1, { k: "v" })).toThrow(
			UndeclaredLabelError,
		);
	});

	it("refuses a label value that is neither a string nor a finite number", () => {
		const { driver } = c.build();
		const counter = driver.createCounter({
			name: "c_total",
			help: "h",
			labelNames: ["status"],
		});
		const labels: Record<string, unknown> = { status: undefined };
		expect(() =>
			Reflect.apply(counter.increment, counter, [1, labels]),
		).toThrow(
			expect.objectContaining({ code: "E_PARSEC_INVALID_LABEL_VALUE" }),
		);
	});

	it("refuses non-finite measurements on every instrument", () => {
		const { driver } = c.build();
		const counter = driver.createCounter({ name: "c_total", help: "h" });
		const gauge = driver.createGauge({ name: "g", help: "h" });
		const histogram = driver.createHistogram({ name: "h", help: "h" });
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => counter.increment(value)).toThrow(InvalidMeasurementError);
			expect(() => gauge.set(value)).toThrow(InvalidMeasurementError);
			expect(() => gauge.increment(value)).toThrow(InvalidMeasurementError);
			expect(() => histogram.observe(value)).toThrow(InvalidMeasurementError);
		}
	});

	it("refuses negative counter increments and histogram observations", () => {
		// OpenTelemetry drops both with a diagnostic warning; refusing them on
		// every driver is what keeps the contract the same on both.
		const { driver } = c.build();
		expect(() =>
			driver.createCounter({ name: "c_total", help: "h" }).increment(-5),
		).toThrow(InvalidMeasurementError);
		expect(() =>
			driver.createHistogram({ name: "h", help: "h" }).observe(-0.1),
		).toThrow(InvalidMeasurementError);
		// A gauge goes both ways.
		const gauge = driver.createGauge({ name: "g", help: "h" });
		expect(() => gauge.set(-3)).not.toThrow();
		expect(() => gauge.decrement(10)).not.toThrow();
	});

	it("returns the same instrument for the same declaration", () => {
		const { driver } = c.build();
		const options = { name: "c_total", help: "h", labelNames: ["a"] };
		expect(driver.createCounter(options)).toBe(driver.createCounter(options));
		expect(driver.createGauge({ name: "g", help: "h" })).toBe(
			driver.createGauge({ name: "g", help: "h" }),
		);
		expect(driver.createHistogram({ name: "h", help: "h" })).toBe(
			driver.createHistogram({ name: "h", help: "h" }),
		);
	});

	it("refuses one name declared with a different type or label set", () => {
		const { driver } = c.build();
		driver.createCounter({ name: "x", help: "h", labelNames: ["a"] });
		expect(() => driver.createHistogram({ name: "x", help: "h" })).toThrow(
			InstrumentConflictError,
		);
		expect(() => driver.createGauge({ name: "x", help: "h" })).toThrow(
			InstrumentConflictError,
		);
		expect(() =>
			driver.createCounter({ name: "x", help: "h", labelNames: ["b"] }),
		).toThrow(InstrumentConflictError);
	});

	it("caps the label sets of every instrument and counts the refusals", async () => {
		const { driver, dropped } = c.build({ maxSeries: 3 });
		const counter = driver.createCounter({
			name: "c_total",
			help: "h",
			labelNames: ["k"],
		});
		const gauge = driver.createGauge({
			name: "g",
			help: "h",
			labelNames: ["k"],
		});
		const histogram = driver.createHistogram({
			name: "h",
			help: "h",
			labelNames: ["k"],
		});
		for (let i = 0; i < 10; i++) {
			counter.increment(1, { k: `user-${i}` });
			gauge.increment(1, { k: `user-${i}` });
			histogram.observe(0.1, { k: `user-${i}` });
		}
		expect(await dropped("c_total")).toBe(7);
		expect(await dropped("g")).toBe(7);
		expect(await dropped("h")).toBe(7);
		// An admitted series keeps working past the cap.
		expect(() => counter.increment(1, { k: "user-0" })).not.toThrow();
		expect(await dropped("c_total")).toBe(7);
	});
});

describe("OtelDriver specifics", () => {
	it("forwards the normalised label set, numbers stringified, missing labels empty", () => {
		const { meter, calls } = recordingMeter();
		new OtelDriver({ meter })
			.createCounter({ name: "c_total", help: "h", labelNames: ["a", "b"] })
			.increment(1, { a: 200 });
		expect(calls.at(-1)).toEqual({
			instrument: "c_total",
			value: 1,
			attributes: { a: "200", b: "" },
		});
	});

	it("keeps the gauge's last values bounded by the cap", () => {
		const { meter, calls } = recordingMeter();
		const gauge = new OtelDriver({ meter, maxSeries: 100 }).createGauge({
			name: "g",
			help: "h",
			labelNames: ["k"],
		});
		for (let i = 0; i < 10_000; i++) gauge.set(i, { k: `user-${i}` });
		const recorded = calls.filter((call) => call.instrument === "g");
		expect(recorded).toHaveLength(100);
		// A refused label set is not tracked: incrementing it again is refused
		// again rather than starting from a remembered value.
		gauge.increment(1, { k: "user-5000" });
		expect(calls.filter((call) => call.instrument === "g")).toHaveLength(100);
	});

	it("keeps the gauge's label sets apart even when their encodings would collide", () => {
		const { meter, calls } = recordingMeter();
		const gauge = new OtelDriver({ meter }).createGauge({
			name: "g",
			help: "h",
			labelNames: ["k", "b"],
		});
		gauge.set(10, { k: "a=1,b" });
		gauge.set(100, { k: "a=1", b: "x" });
		gauge.increment(1, { k: "a=1,b" });
		expect(calls.at(-1)).toEqual({
			instrument: "g",
			value: 11,
			attributes: { k: "a=1,b", b: "" },
		});
	});
});
