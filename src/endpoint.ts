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
 *
 * Building the handler with neither a token nor `public: true` throws, and so
 * does an empty token: an unset variable must fail the boot, not open the
 * endpoint.
 */

import { timingSafeEqual } from "node:crypto";
import { PROMETHEUS_CONTENT_TYPE } from "./drivers/PrometheusDriver.js";
import { EmptyTokenError, UnprotectedEndpointError } from "./errors.js";
import type { MetricsManager } from "./MetricsManager.js";

export interface MetricsEndpointContext {
	request: { header(name: string): string | undefined };
	response: {
		status(code: number): unknown;
		header(name: string, value: string): unknown;
		send(body: string): void;
	};
}

/**
 * A secret wrapper such as the one `Env.schema.secret()` returns, read only
 * through `release()` so it never reaches a log on its way here.
 */
export interface ReleasableSecret {
	release(): string;
}

export interface MetricsEndpointOptions {
	/**
	 * Require `Authorization: Bearer <token>`. A plain string or a secret
	 * wrapper; empty or blank is refused.
	 */
	token?: string | ReleasableSecret | undefined;
	/**
	 * Serve the body to anyone who reaches the route, with no token.
	 *
	 * Only for a deployment where nothing outside its own network reaches this
	 * route. It has to be said explicitly: leaving it out without a token is
	 * an error, because that is the choice that publishes the route table.
	 */
	public?: boolean;
}

function releaseToken(token: string | ReleasableSecret): string {
	return typeof token === "string" ? token : token.release();
}

/**
 * The token the handler enforces, or `null` for a deliberately public one.
 * Decided once, when the route is declared, so a misconfiguration stops the
 * boot instead of surfacing on the first scrape.
 */
function resolveToken(options: MetricsEndpointOptions): string | null {
	if (options.token !== undefined) {
		if (options.public === true) {
			throw new UnprotectedEndpointError(
				"the metrics endpoint was given both a token and `public: true`; pick one.",
			);
		}
		const token = releaseToken(options.token);
		if (typeof token !== "string" || token.trim().length === 0) {
			throw new EmptyTokenError();
		}
		return token;
	}
	if (options.public === true) return null;
	throw new UnprotectedEndpointError(
		"the metrics endpoint has no token. Pass `token` (METRICS_TOKEN), or `public: true` if only your own network reaches this route.",
	);
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
	const token = resolveToken(options);
	return async (ctx: MetricsEndpointContext): Promise<void> => {
		if (token !== null) {
			const header = ctx.request.header("authorization") ?? "";
			const prefix = "Bearer ";
			const given = header.startsWith(prefix)
				? header.slice(prefix.length)
				: "";
			if (!matches(token, given)) {
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
