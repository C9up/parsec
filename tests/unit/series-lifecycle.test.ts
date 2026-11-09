import { describe, expect, it } from "vitest";
import { NoopDriver } from "../../src/drivers/NoopDriver.js";
import { OtelDriver, type OtelMeter } from "../../src/drivers/OtelDriver.js";
import { PrometheusDriver } from "../../src/drivers/PrometheusDriver.js";
import { ParsecError } from "../../src/errors.js";

interface Observation {
	instrument: string;
	value: number;
	attributes: Record<string, unknown> | undefined;
}

type ObservableCallback = (result: {
	observe(value: number, attributes?: Record<string, string>): void;
}) => void | Promise<void>;

/** A meter that records sync calls and lets the test run observable callbacks. */
function otelMeter() {
	const calls: Observation[] = [];
	const callbacks = new Map<string, ObservableCallback[]>();
	const sync = (name: string) => ({
		add: (value: number, attributes?: Record<string, unknown>) => {
			calls.push({ instrument: name, value, attributes });
		},
		record: (value: number, attributes?: Record<string, unknown>) => {
			calls.push({ instrument: name, value, attributes });
		},
	});
	const observable = (name: string) => ({
		addCallback: (callback: ObservableCallback) => {
			callbacks.set(name, [...(callbacks.get(name) ?? []), callback]);
		},
	});
	const meter: OtelMeter = {
		createCounter: sync,
		createGauge: sync,
		createHistogram: sync,
		createObservableCounter: observable,
		createObservableGauge: observable,
	};
	/** What one SDK collection cycle would export for `name`. */
	const collect = async (name: string): Promise<Observation[]> => {
		const observed: Observation[] = [];
		for (const callback of callbacks.get(name) ?? []) {
			await callback({
				observe: (value, attributes) => {
					observed.push({ instrument: name, value, attributes });
				},
			});
		}
		return observed;
	};
	return { meter, calls, collect };
}

describe("PrometheusDriver: removing and resetting series", () => {
	it("removes one label set and frees its slot under the cap", async () => {
		const driver = new PrometheusDriver({ maxSeries: 2 });
		const counter = driver.createCounter({
			name: "jobs_total",
			help: "j",
			labelNames: ["job"],
		});
		counter.increment(1, { job: "a" });
		counter.increment(1, { job: "b" });
		counter.remove({ job: "a" });
		counter.increment(5, { job: "c" });
		const body = await driver.scrape();
		expect(body).not.toContain('job="a"');
		expect(body).toContain('jobs_total{job="b"} 1');
		expect(body).toContain('jobs_total{job="c"} 5');
		expect(body).not.toContain("parsec_series_dropped_total{");
	});

	it("resets every series of a gauge and a histogram", async () => {
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
		gauge.set(3, { k: "x" });
		histogram.observe(0.2, { k: "x" });
		gauge.reset();
		histogram.reset();
		expect(await driver.scrape()).toBe("");
		histogram.observe(0.2, { k: "y" });
		expect(await driver.scrape()).toContain('h_count{k="y"} 1');
	});

	it("validates the labels it is asked to remove", () => {
		const counter = new PrometheusDriver().createCounter({
			name: "c_total",
			help: "c",
			labelNames: ["k"],
		});
		expect(() => counter.remove({ other: "x" })).toThrow(
			expect.objectContaining({ code: "E_PARSEC_UNDECLARED_LABEL" }),
		);
		// Removing a series that was never recorded is not an error.
		expect(() => counter.remove({ k: "never" })).not.toThrow();
	});
});

describe("PrometheusDriver: values computed at scrape", () => {
	it("runs a gauge's collect before rendering, so the value is read rather than pushed", async () => {
		const driver = new PrometheusDriver();
		let depth = 3;
		driver.createGauge({
			name: "queue_depth",
			help: "q",
			collect: (gauge) => gauge.set(depth),
		});
		expect(await driver.scrape()).toContain("queue_depth 3");
		depth = 7;
		expect(await driver.scrape()).toContain("queue_depth 7");
	});

	it("awaits an asynchronous collect, with labels", async () => {
		const driver = new PrometheusDriver();
		driver.createGauge({
			name: "pool_size",
			help: "p",
			labelNames: ["pool"],
			collect: async (gauge) => {
				await Promise.resolve();
				gauge.set(4, { pool: "primary" });
			},
		});
		expect(await driver.scrape()).toContain('pool_size{pool="primary"} 4');
	});

	it("lets a counter's collect add what happened since the last scrape", async () => {
		const driver = new PrometheusDriver();
		driver.createCounter({
			name: "ticks_total",
			help: "t",
			collect: (counter) => counter.increment(2),
		});
		await driver.scrape();
		expect(await driver.scrape()).toContain("ticks_total 4");
	});

	it("keeps the rest of the scrape when one collect throws, and counts the failure", async () => {
		const driver = new PrometheusDriver();
		driver.createCounter({ name: "ok_total", help: "o" }).increment();
		const broken = driver.createGauge({
			name: "broken",
			help: "b",
			collect: () => {
				throw new Error("database down");
			},
		});
		broken.set(1);
		const body = await driver.scrape();
		expect(body).toContain("ok_total 1");
		// The last value it had stays.
		expect(body).toContain("broken 1");
		expect(body).toContain('parsec_collect_failures_total{metric="broken"} 1');
	});

	it("gives up on a collect that hangs instead of hanging the scrape", async () => {
		const driver = new PrometheusDriver({ collectTimeout: 20 });
		driver.createCounter({ name: "ok_total", help: "o" }).increment();
		driver.createGauge({
			name: "stuck",
			help: "s",
			collect: () => new Promise<void>(() => {}),
		});
		const body = await driver.scrape();
		expect(body).toContain("ok_total 1");
		expect(body).toContain('parsec_collect_failures_total{metric="stuck"} 1');
	});

	it("refuses a collect that is not a function at declaration", () => {
		const driver = new PrometheusDriver();
		const options: Record<string, unknown> = {
			name: "g",
			help: "g",
			collect: "nope",
		};
		expect(() => Reflect.apply(driver.createGauge, driver, [options])).toThrow(
			expect.objectContaining({ code: "E_PARSEC_INVALID_INSTRUMENT" }),
		);
	});
});

describe("startTimer", () => {
	it("observes the elapsed seconds on a histogram, merging start and end labels", async () => {
		const driver = new PrometheusDriver();
		const histogram = driver.createHistogram({
			name: "job_seconds",
			help: "j",
			labelNames: ["job", "outcome"],
		});
		const end = histogram.startTimer({ job: "import" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		const seconds = end({ outcome: "ok" });
		expect(seconds).toBeGreaterThan(0.004);
		const body = await driver.scrape();
		expect(body).toContain('job_seconds_count{job="import",outcome="ok"} 1');
	});

	it("sets a gauge to the elapsed seconds", async () => {
		const driver = new PrometheusDriver();
		const gauge = driver.createGauge({ name: "last_run_seconds", help: "l" });
		const seconds = gauge.startTimer()();
		expect(seconds).toBeGreaterThanOrEqual(0);
		expect(await driver.scrape()).toMatch(/^last_run_seconds \d/m);
	});
});

describe("OtelDriver: removing and computing series", () => {
	it("frees a removed label set's slot under the cap", () => {
		const { meter, calls } = otelMeter();
		const counter = new OtelDriver({ meter, maxSeries: 1 }).createCounter({
			name: "c_total",
			help: "c",
			labelNames: ["k"],
		});
		counter.increment(1, { k: "a" });
		counter.remove({ k: "a" });
		counter.increment(1, { k: "b" });
		expect(
			calls.filter((call) => call.instrument === "parsec_series_dropped_total"),
		).toHaveLength(0);
		counter.reset();
		counter.increment(1, { k: "c" });
		expect(
			calls.filter((call) => call.instrument === "parsec_series_dropped_total"),
		).toHaveLength(0);
	});

	it("forgets a removed gauge's last value", () => {
		const { meter, calls } = otelMeter();
		const gauge = new OtelDriver({ meter }).createGauge({
			name: "g",
			help: "g",
			labelNames: ["k"],
		});
		gauge.set(10, { k: "a" });
		gauge.remove({ k: "a" });
		gauge.increment(1, { k: "a" });
		expect(calls.at(-1)).toMatchObject({ value: 1 });
	});

	it("exports a collected gauge through an observable gauge, run on each collection", async () => {
		const { meter, collect } = otelMeter();
		let depth = 3;
		new OtelDriver({ meter }).createGauge({
			name: "queue_depth",
			help: "q",
			labelNames: ["queue"],
			collect: (gauge) => gauge.set(depth, { queue: "mail" }),
		});
		expect(await collect("queue_depth")).toEqual([
			{ instrument: "queue_depth", value: 3, attributes: { queue: "mail" } },
		]);
		depth = 9;
		expect(await collect("queue_depth")).toEqual([
			{ instrument: "queue_depth", value: 9, attributes: { queue: "mail" } },
		]);
	});

	it("exports a collected counter as its running total", async () => {
		const { meter, collect } = otelMeter();
		new OtelDriver({ meter }).createCounter({
			name: "ticks_total",
			help: "t",
			collect: (counter) => counter.increment(2),
		});
		await collect("ticks_total");
		expect(await collect("ticks_total")).toEqual([
			{ instrument: "ticks_total", value: 4, attributes: {} },
		]);
	});

	it("refuses collect when the meter offers no observable instruments", () => {
		const { meter } = otelMeter();
		const plain: OtelMeter = {
			createCounter: meter.createCounter,
			createGauge: meter.createGauge,
			createHistogram: meter.createHistogram,
		};
		expect(() =>
			new OtelDriver({ meter: plain }).createGauge({
				name: "g",
				help: "g",
				collect: () => {},
			}),
		).toThrow(ParsecError);
	});
});

describe("NoopDriver", () => {
	it("offers the same surface and still runs nothing it does not have to", () => {
		const driver = new NoopDriver();
		const counter = driver.createCounter();
		const gauge = driver.createGauge();
		const histogram = driver.createHistogram();
		expect(() => {
			counter.remove({});
			counter.reset();
			gauge.remove({});
			gauge.reset();
			histogram.remove({});
			histogram.reset();
		}).not.toThrow();
		expect(typeof histogram.startTimer()()).toBe("number");
		expect(typeof gauge.startTimer()()).toBe("number");
	});
});
