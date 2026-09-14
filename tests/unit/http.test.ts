import { describe, expect, it, vi } from "vitest";
import ParsecHttpMiddleware, {
	methodLabel,
	PARSEC_KEY,
	parsecHttpMiddleware,
	type ReamContext,
	routeLabel,
} from "../../src/http.js";
import { drivers, MetricsManager } from "../../src/MetricsManager.js";

function context(
	metrics: MetricsManager | undefined,
	over: {
		method?: string;
		pattern?: string;
		status?: number;
	} = {},
): ReamContext {
	return {
		containerResolver: {
			make: async (token: string) =>
				token === PARSEC_KEY ? metrics : undefined,
		},
		request: { method: () => over.method ?? "GET" },
		route: over.pattern === undefined ? undefined : { pattern: over.pattern },
		response: { getStatus: () => over.status ?? 200 },
	};
}

const manager = (): MetricsManager =>
	new MetricsManager({ default: "p", exporters: { p: drivers.prometheus() } });

describe("http middleware", () => {
	it("labels by the matched route PATTERN, never the URL", async () => {
		// /users/1 and /users/2 must be one series. Using the URL is the
		// textbook way to hand an attacker an unbounded metric.
		const metrics = manager();
		await parsecHttpMiddleware(
			context(metrics, { pattern: "/users/:id" }),
			async () => {},
		);
		await parsecHttpMiddleware(
			context(metrics, { pattern: "/users/:id" }),
			async () => {},
		);
		const body = await metrics.scrape();
		expect(body).toContain('route="/users/:id"');
		expect(body).toContain(
			'http_server_requests_total{method="GET",route="/users/:id",status="200"} 2',
		);
	});

	it("gives an unmatched request a constant, not its path", async () => {
		const metrics = manager();
		await parsecHttpMiddleware(
			context(metrics, { status: 404 }),
			async () => {},
		);
		expect(await metrics.scrape()).toContain('route="<unmatched>"');
	});

	it("folds an unknown method into OTHER", () => {
		// The method comes straight off the wire; the label set must be bounded
		// by this list rather than by trust in the parser.
		expect(methodLabel("get")).toBe("GET");
		expect(methodLabel("PROPFIND")).toBe("OTHER");
		expect(methodLabel("../../etc/passwd")).toBe("OTHER");
	});

	it("uses the constant when a route carries an empty pattern", () => {
		expect(routeLabel(context(undefined, { pattern: "" }))).toBe("<unmatched>");
	});

	it("records a request whose handler threw", async () => {
		const metrics = manager();
		await expect(
			parsecHttpMiddleware(
				context(metrics, { pattern: "/x", status: 500 }),
				() => {
					throw new Error("boom");
				},
			),
		).rejects.toThrow("boom");
		const body = await metrics.scrape();
		expect(body).toContain('status="500"');
		expect(body).toContain("http_server_request_duration_seconds_count");
	});

	it("brings in-flight back to zero, including after a failure", async () => {
		const metrics = manager();
		await parsecHttpMiddleware(
			context(metrics, { pattern: "/x" }),
			async () => {},
		);
		await expect(
			parsecHttpMiddleware(context(metrics, { pattern: "/x" }), () => {
				throw new Error("boom");
			}),
		).rejects.toThrow();
		expect(await metrics.scrape()).toContain(
			'http_server_requests_in_flight{method="GET"} 0',
		);
	});

	it("builds its instruments once, not once per request", async () => {
		const metrics = manager();
		const spy = vi.spyOn(metrics, "counter");
		const ctx = context(metrics, { pattern: "/x" });
		await parsecHttpMiddleware(ctx, async () => {});
		await parsecHttpMiddleware(ctx, async () => {});
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("reports clearly when the provider never bound the manager", async () => {
		await expect(
			parsecHttpMiddleware(context(undefined), async () => {}),
		).rejects.toThrow(/ParsecProvider must bind/);
	});

	it("exposes the class form ream's lazy resolver instantiates", async () => {
		const metrics = manager();
		await new ParsecHttpMiddleware().handle(
			context(metrics, { pattern: "/x" }),
			async () => {},
		);
		expect(await metrics.scrape()).toContain("http_server_requests_total");
	});
});
