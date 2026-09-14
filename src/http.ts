/**
 * HTTP middleware — the three numbers an application is blind without:
 * throughput, latency and error rate.
 *
 *   // start/kernel.ts
 *   import { parsecHttpMiddleware } from "@c9up/parsec/http"
 *   server.use([parsecHttpMiddleware])
 *
 * `server.use`, NOT `router.use`. Router middleware runs only for MATCHED
 * routes, so an unmatched request never reaches it — and `<unmatched>` below
 * becomes a label nothing can ever produce, while a 404 sweep stays invisible
 * on the one chart meant to show it.
 *
 * Resolved through `ctx.containerResolver` (the Adonis idiom), reading from
 * the context the host hands it, so parsec never imports `@c9up/ream`.
 */

import { MetricsManager } from "./MetricsManager.js";
import type { Counter, Gauge, Histogram, Labels } from "./types.js";

/** The container token `ParsecProvider` binds. */
export const PARSEC_KEY = "parsec.metrics";

interface ContainerResolver {
	make(token: string): Promise<unknown>;
}

/**
 * The slice of ream's `HttpContext` this reads. Narrow and permissive, so the
 * real class satisfies it structurally.
 */
export interface ReamContext {
	containerResolver?: ContainerResolver;
	request: { method(): string };
	/**
	 * The matched route. Its `pattern` — `/users/:id` — is the label, never
	 * the URL: see {@link routeLabel}.
	 */
	route?: { pattern?: string };
	response: { getStatus(): number };
}

type ReamNext = () => Promise<void> | void;

/**
 * The methods that may appear as a label.
 *
 * Anything else becomes `OTHER`. A method reaches this straight from the
 * wire, and while a server rejects most junk, the label set must be bounded
 * by THIS list rather than by trust in the parser — an unbounded method label
 * is one request away from an unbounded metric.
 */
const METHODS = new Set([
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
	"TRACE",
	"CONNECT",
]);

/** The label for a request with no matched route. Never the path. */
const UNMATCHED = "<unmatched>";

export function methodLabel(method: string): string {
	const upper = method.toUpperCase();
	return METHODS.has(upper) ? upper : "OTHER";
}

/**
 * The route label.
 *
 * The matched PATTERN, so `/users/1` and `/users/2` are one series. Using the
 * URL instead is the textbook way to turn a metric into an unbounded map fed
 * directly by whoever is sending the requests — and a 404 sweep would be
 * enough to do it deliberately. A request that matched nothing has no pattern,
 * and gets a constant.
 */
export function routeLabel(ctx: ReamContext): string {
	const pattern = ctx.route?.pattern;
	return typeof pattern === "string" && pattern.length > 0
		? pattern
		: UNMATCHED;
}

function isManager(value: unknown): value is MetricsManager {
	return value instanceof MetricsManager;
}

interface Instruments {
	total: Counter;
	duration: Histogram;
	inFlight: Gauge;
}

/** Built once per manager, not per request. */
const built = new WeakMap<MetricsManager, Instruments>();

export function instrumentsFor(metrics: MetricsManager): Instruments {
	const existing = built.get(metrics);
	if (existing) return existing;
	const instruments: Instruments = {
		total: metrics.counter({
			name: "http_server_requests_total",
			help: "Requests served, by method, route and status.",
			labelNames: ["method", "route", "status"],
		}),
		duration: metrics.histogram({
			name: "http_server_request_duration_seconds",
			help: "Time to serve a request, in seconds.",
			labelNames: ["method", "route", "status"],
		}),
		inFlight: metrics.gauge({
			name: "http_server_requests_in_flight",
			help: "Requests currently being served.",
			labelNames: ["method"],
		}),
	};
	built.set(metrics, instruments);
	return instruments;
}

export async function parsecHttpMiddleware(
	ctx: ReamContext,
	next: ReamNext,
): Promise<void> {
	const resolved = await ctx.containerResolver?.make(PARSEC_KEY);
	if (!isManager(resolved)) {
		throw new Error(
			"[parsec] ParsecProvider must bind parsec.metrics before the middleware runs, and the host must expose ctx.containerResolver.",
		);
	}
	const { total, duration, inFlight } = instrumentsFor(resolved);
	const method = methodLabel(ctx.request.method());
	const started = process.hrtime.bigint();

	inFlight.increment(1, { method });
	try {
		await next();
	} finally {
		// In the `finally`, so a handler that threw is still counted. Its
		// status is whatever the error handler set by the time the stack
		// unwinds — dropping those requests is how an error rate stays at zero
		// through an outage.
		inFlight.decrement(1, { method });
		const labels: Labels = {
			method,
			route: routeLabel(ctx),
			status: String(ctx.response.getStatus()),
		};
		total.increment(1, labels);
		duration.observe(Number(process.hrtime.bigint() - started) / 1e9, labels);
	}
}

/**
 * Default export — the class form ream's lazy middleware resolver expects
 * (`new mod.default().handle(ctx, next)`), so
 * `router.use([() => import("@c9up/parsec/http")])` works.
 */
export default class ParsecHttpMiddleware {
	handle(ctx: ReamContext, next: ReamNext): Promise<void> {
		return parsecHttpMiddleware(ctx, next);
	}
}
