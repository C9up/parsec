import diagnostics_channel from "node:diagnostics_channel";
import { describe, expect, it } from "vitest";
import {
	HEALTH_CHANNEL,
	instrumentHealthChecks,
} from "../../src/diagnostics.js";
import { drivers, MetricsManager } from "../../src/MetricsManager.js";

const channel = () =>
	diagnostics_channel.tracingChannel<string, { check: { name: string } }>(
		HEALTH_CHANNEL,
	);

describe("instrumentHealthChecks", () => {
	it("times a check that ream publishes, without either package importing the other", async () => {
		const metrics = new MetricsManager({
			default: "p",
			exporters: { p: drivers.prometheus() },
		});
		const stop = instrumentHealthChecks(metrics);
		try {
			await channel().tracePromise(async () => "ok", {
				check: { name: "disk_space" },
			});
			const body = await metrics.scrape();
			expect(body).toContain(
				'health_check_duration_seconds_count{check="disk_space"} 1',
			);
		} finally {
			stop();
		}
	});

	it("counts a check that raised", async () => {
		const metrics = new MetricsManager({
			default: "p",
			exporters: { p: drivers.prometheus() },
		});
		const stop = instrumentHealthChecks(metrics);
		try {
			await expect(
				channel().tracePromise(
					async () => {
						throw new Error("disk full");
					},
					{ check: { name: "disk_space" } },
				),
			).rejects.toThrow("disk full");
			expect(await metrics.scrape()).toContain(
				'health_check_failures_total{check="disk_space"} 1',
			);
		} finally {
			stop();
		}
	});

	it("stops counting once unsubscribed, so a reload does not double-count", async () => {
		const metrics = new MetricsManager({
			default: "p",
			exporters: { p: drivers.prometheus() },
		});
		instrumentHealthChecks(metrics)();
		await channel().tracePromise(async () => "ok", {
			check: { name: "disk_space" },
		});
		expect(await metrics.scrape()).not.toContain(
			"health_check_duration_seconds",
		);
	});

	it("labels an event with no usable name by a constant", async () => {
		const metrics = new MetricsManager({
			default: "p",
			exporters: { p: drivers.prometheus() },
		});
		const stop = instrumentHealthChecks(metrics);
		try {
			await diagnostics_channel
				.tracingChannel(HEALTH_CHANNEL)
				.tracePromise(async () => "ok", {});
			expect(await metrics.scrape()).toContain('check="unknown"');
		} finally {
			stop();
		}
	});
});
