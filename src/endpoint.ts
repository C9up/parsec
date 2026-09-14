/**
 * The scrape endpoint.
 *
 * Deliberately NOT mounted by the provider. A metrics body names every route
 * an application has, its traffic shape and its error rate; publishing it is a
 * decision, not a default. The application mounts it where it wants, on the
 * port it wants, behind whatever its deployment already trusts.
 *
 *   // start/routes.ts
 *   import { metricsHandler } from "@c9up/parsec/endpoint"
 *   import metrics from "@c9up/parsec/services/main"
 *
 *   router.get("/__metrics", metricsHandler(metrics, { token: env.get("METRICS_TOKEN") }))
 */

import { timingSafeEqual } from "node:crypto";
import { PROMETHEUS_CONTENT_TYPE } from "./drivers/PrometheusDriver.js";
import type { MetricsManager } from "./MetricsManager.js";

export interface MetricsEndpointContext {
	request: { header(name: string): string | undefined };
	response: {
		status(code: number): unknown;
		header(name: string, value: string): unknown;
		send(body: string): void;
	};
}

export interface MetricsEndpointOptions {
	/**
	 * Require `Authorization: Bearer <token>`.
	 *
	 * Optional because a deployment that reaches this route only from inside
	 * its own network has already solved the problem. Set it for anything
	 * else — and note that leaving it unset is the choice that publishes your
	 * route table.
	 */
	token?: string;
}

/**
 * Compare without leaking the answer through timing.
 *
 * A naive `===` on a secret returns faster the earlier it differs, which is
 * enough to recover it one byte at a time. Lengths are compared first because
 * `timingSafeEqual` throws on a length mismatch — that leak is the token's
 * LENGTH, which is not the secret.
 */
function matches(expected: string, given: string): boolean {
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(given, "utf8");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

export function metricsHandler(
	metrics: MetricsManager,
	options: MetricsEndpointOptions = {},
) {
	return async (ctx: MetricsEndpointContext): Promise<void> => {
		if (options.token !== undefined) {
			const header = ctx.request.header("authorization") ?? "";
			const prefix = "Bearer ";
			const given = header.startsWith(prefix)
				? header.slice(prefix.length)
				: "";
			if (!matches(options.token, given)) {
				// 404, not 401. A 401 confirms the endpoint is there and invites
				// the next request; an unauthenticated caller has no business
				// learning that this application exposes metrics at all.
				ctx.response.status(404);
				ctx.response.send("");
				return;
			}
		}

		const body = await metrics.scrape();
		if (body === null) {
			// The driver pushes rather than being scraped. An empty 200 would
			// read to a scraper as a healthy target with no metrics, which is
			// the one answer that is actively misleading.
			ctx.response.status(404);
			ctx.response.send("");
			return;
		}
		ctx.response.status(200);
		ctx.response.header("content-type", PROMETHEUS_CONTENT_TYPE);
		// A scrape body is a snapshot of internal state; a cache of it is only
		// ever wrong.
		ctx.response.header("cache-control", "no-store");
		ctx.response.send(body);
	};
}
