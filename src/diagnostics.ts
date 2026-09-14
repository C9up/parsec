/**
 * Auto-instrumentation over `diagnostics_channel`.
 *
 * ream's health module already publishes every check run on the
 * `ream.health.check` tracing channel, explicitly so that "an APM can time
 * checks without the app wiring anything". This is that APM: it subscribes,
 * and neither package imports the other.
 */

import diagnostics_channel from "node:diagnostics_channel";
import type { MetricsManager } from "./MetricsManager.js";

/** The channel ream's health module publishes on. */
export const HEALTH_CHANNEL = "ream.health.check";

/** The shape ream puts on the channel. */
interface HealthEvent {
	check?: { name?: string };
	/** Where the start time is parked; the channel hands back the same object. */
	parsecStartedAt?: bigint;
}

function nameOf(event: unknown): string {
	if (typeof event !== "object" || event === null) return "unknown";
	const check = Reflect.get(event, "check");
	if (typeof check !== "object" || check === null) return "unknown";
	const name = Reflect.get(check, "name");
	// Bounded by the checks the application registers in code — never by a
	// request. That is what makes it safe as a label.
	return typeof name === "string" && name.length > 0 ? name : "unknown";
}

/**
 * Subscribe health checks to `metrics`. Returns the unsubscribe.
 *
 * @returns a teardown; call it on shutdown, or a reloaded application stacks a
 *   second subscriber on the same channel and double-counts every check.
 */
export function instrumentHealthChecks(metrics: MetricsManager): () => void {
	const duration = metrics.histogram({
		name: "health_check_duration_seconds",
		help: "Time to run one health check, in seconds.",
		labelNames: ["check"],
		// A health check is not a web request: seconds-scale is the interesting
		// range, and the default web ladder wastes most of its buckets below it.
		buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 30],
	});
	const failures = metrics.counter({
		name: "health_check_failures_total",
		help: "Health checks that raised.",
		labelNames: ["check"],
	});

	const channel = diagnostics_channel.tracingChannel<string, HealthEvent>(
		HEALTH_CHANNEL,
	);
	const handlers = {
		start(event: HealthEvent): void {
			event.parsecStartedAt = process.hrtime.bigint();
		},
		/**
		 * Present because the channel's subscriber type requires all five, and
		 * deliberately empty.
		 *
		 * ream runs checks through `tracePromise` (HealthChecks.ts), so `end`
		 * fires the moment the promise is RETURNED — recording there would
		 * measure how long it took to start the check, which is near zero and
		 * looks like a perfectly healthy system. `asyncEnd` is when the check
		 * actually finished.
		 */
		end(): void {},
		asyncStart(): void {},
		asyncEnd(event: HealthEvent): void {
			const started = event.parsecStartedAt;
			if (started === undefined) return;
			duration.observe(Number(process.hrtime.bigint() - started) / 1e9, {
				check: nameOf(event),
			});
		},
		error(event: HealthEvent): void {
			failures.increment(1, { check: nameOf(event) });
		},
	};
	channel.subscribe(handlers);
	return () => channel.unsubscribe(handlers);
}
