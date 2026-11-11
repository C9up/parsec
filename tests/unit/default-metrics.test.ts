import { describe, expect, it } from "vitest";
import { collectDefaultMetrics } from "../../src/defaultMetrics.js";
import type { OtelMeter } from "../../src/drivers/OtelDriver.js";
import { drivers, MetricsManager } from "../../src/MetricsManager.js";

const manager = (): MetricsManager =>
	new MetricsManager({ default: "p", exporters: { p: drivers.prometheus() } });

function sampleOf(body: string, name: string): number {
	const match = new RegExp(`^${name}(?:\\{[^}]*\\})? (\\S+)$`, "m").exec(body);
	return Number(match?.[1] ?? Number.NaN);
}

describe("collectDefaultMetrics", () => {
	it("exposes the process and runtime baseline, read at scrape", async () => {
		const metrics = manager();
		const stop = collectDefaultMetrics(metrics);
		try {
			// Burn a little CPU so the counters have something to add.
			let x = 0;
			for (let i = 0; i < 2e6; i++) x += i;
			expect(x).toBeGreaterThan(0);
			const body = (await metrics.scrape()) ?? "";

			expect(sampleOf(body, "process_cpu_user_seconds_total")).toBeGreaterThan(
				0,
			);
			expect(
				sampleOf(body, "process_cpu_system_seconds_total"),
			).toBeGreaterThanOrEqual(0);
			expect(sampleOf(body, "process_cpu_seconds_total")).toBeGreaterThan(0);
			expect(sampleOf(body, "process_resident_memory_bytes")).toBeGreaterThan(
				0,
			);
			expect(sampleOf(body, "nodejs_heap_size_used_bytes")).toBeGreaterThan(0);
			expect(sampleOf(body, "nodejs_heap_size_total_bytes")).toBeGreaterThan(0);
			expect(
				sampleOf(body, "nodejs_external_memory_bytes"),
			).toBeGreaterThanOrEqual(0);
			expect(
				sampleOf(body, "nodejs_eventloop_lag_seconds"),
			).toBeGreaterThanOrEqual(0);
			expect(body).toMatch(/^nodejs_eventloop_lag_p99_seconds \S+$/m);
			expect(body).toMatch(/^nodejs_active_resources_total \d+$/m);

			const started = sampleOf(body, "process_start_time_seconds");
			// Rounded to the second, like prom-client.
			expect(started).toBeLessThanOrEqual(Date.now() / 1000 + 1);
			expect(started).toBeGreaterThan(Date.now() / 1000 - process.uptime() - 5);

			const [major = "", minor = "", patch = ""] =
				process.versions.node.split(".");
			expect(body).toContain(
				`nodejs_version_info{major="${major}",minor="${minor}",patch="${patch}",version="${process.version}"} 1`,
			);
			if (process.platform === "linux") {
				expect(sampleOf(body, "process_open_fds")).toBeGreaterThan(0);
				expect(sampleOf(body, "process_max_fds")).toBeGreaterThan(0);
			}
		} finally {
			stop();
		}
	});

	it("reports the CPU time since the process started, not since the call", async () => {
		const before = process.cpuUsage();
		const metrics = manager();
		const stop = collectDefaultMetrics(metrics);
		try {
			const total = sampleOf(
				(await metrics.scrape()) ?? "",
				"process_cpu_seconds_total",
			);
			expect(total).toBeGreaterThanOrEqual((before.user + before.system) / 1e6);
		} finally {
			stop();
		}
	});

	it("keeps counting CPU across scrapes rather than reporting a window", async () => {
		const metrics = manager();
		const stop = collectDefaultMetrics(metrics);
		try {
			const first = sampleOf(
				(await metrics.scrape()) ?? "",
				"process_cpu_seconds_total",
			);
			let x = 0;
			for (let i = 0; i < 2e6; i++) x += i;
			expect(x).toBeGreaterThan(0);
			const second = sampleOf(
				(await metrics.scrape()) ?? "",
				"process_cpu_seconds_total",
			);
			expect(second).toBeGreaterThan(first);
		} finally {
			stop();
		}
	});

	it("prefixes every name", async () => {
		const metrics = manager();
		const stop = collectDefaultMetrics(metrics, { prefix: "app_" });
		try {
			const body = (await metrics.scrape()) ?? "";
			expect(body).toContain("app_process_cpu_seconds_total ");
			expect(body).not.toMatch(/^process_cpu_seconds_total /m);
		} finally {
			stop();
		}
	});

	it("refuses a prefix that would make an invalid name", () => {
		expect(() =>
			collectDefaultMetrics(manager(), { prefix: "bad prefix" }),
		).toThrow(expect.objectContaining({ code: "E_PARSEC_INVALID_NAME" }));
	});

	it("starts once per target, so observers are not stacked", () => {
		const metrics = manager();
		const stop = collectDefaultMetrics(metrics);
		try {
			expect(collectDefaultMetrics(metrics)).toBe(stop);
		} finally {
			stop();
		}
		// Stopped, it can start again.
		const again = collectDefaultMetrics(metrics);
		expect(again).not.toBe(stop);
		again();
	});

	it("reads the event loop again after a stop and a restart", async () => {
		const metrics = manager();
		// Stopped before any scrape: every delay statistic is still unset.
		collectDefaultMetrics(metrics)();
		const stop = collectDefaultMetrics(metrics);
		try {
			// Long enough for the restarted monitor to take samples.
			await new Promise((resolve) => setTimeout(resolve, 50));
			const body = (await metrics.scrape()) ?? "";
			// Read from the restarted run's monitor; with the first run's
			// callback still bound, the statistics stayed at zero for good.
			expect(
				sampleOf(body, "nodejs_eventloop_lag_max_seconds"),
			).toBeGreaterThan(0);
			expect(
				sampleOf(body, "nodejs_eventloop_lag_mean_seconds"),
			).toBeGreaterThan(0);
		} finally {
			stop();
		}
	});

	it("refuses a restart that changes the GC buckets of the running declaration", () => {
		const metrics = manager();
		collectDefaultMetrics(metrics, { gcDurationBuckets: [0.1, 1] })();
		expect(() =>
			collectDefaultMetrics(metrics, { gcDurationBuckets: [0.5, 5] }),
		).toThrow(
			expect.objectContaining({ code: "E_PARSEC_INSTRUMENT_CONFLICT" }),
		);
		// The refused restart left nothing running: a matching one still starts.
		const stop = collectDefaultMetrics(metrics, {
			gcDurationBuckets: [0.1, 1],
		});
		stop();
	});

	it("feeds an OpenTelemetry meter through observable instruments", async () => {
		const callbacks = new Map<
			string,
			Array<
				(result: {
					observe(value: number, attributes?: Record<string, string>): void;
				}) => void | Promise<void>
			>
		>();
		const sync = () => ({ add: () => {}, record: () => {} });
		const meter: OtelMeter = {
			createCounter: sync,
			createGauge: sync,
			createHistogram: sync,
			createObservableCounter: (name) => ({
				addCallback: (callback) => {
					callbacks.set(name, [...(callbacks.get(name) ?? []), callback]);
				},
			}),
			createObservableGauge: (name) => ({
				addCallback: (callback) => {
					callbacks.set(name, [...(callbacks.get(name) ?? []), callback]);
				},
			}),
		};
		const metrics = new MetricsManager({
			default: "otel",
			exporters: { otel: drivers.otel({ meter }) },
		});
		const stop = collectDefaultMetrics(metrics);
		try {
			const observed: number[] = [];
			for (const callback of callbacks.get("process_resident_memory_bytes") ??
				[]) {
				await callback({ observe: (value) => observed.push(value) });
			}
			expect(observed).toHaveLength(1);
			expect(observed[0]).toBeGreaterThan(0);
		} finally {
			stop();
		}
	});
});
