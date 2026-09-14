import { describe, expect, it, vi } from "vitest";
import {
	type MetricsEndpointContext,
	metricsHandler,
} from "../../src/endpoint.js";
import { drivers, MetricsManager } from "../../src/MetricsManager.js";

function context(authorization?: string) {
	const sent: {
		status?: number;
		body?: string;
		headers: Record<string, string>;
	} = { headers: {} };
	const ctx: MetricsEndpointContext = {
		request: {
			header: (name) =>
				name.toLowerCase() === "authorization" ? authorization : undefined,
		},
		response: {
			status: (code) => {
				sent.status = code;
				return ctx.response;
			},
			header: (name, value) => {
				sent.headers[name] = value;
				return ctx.response;
			},
			send: (body) => {
				sent.body = body;
			},
		},
	};
	return { ctx, sent };
}

const withOrders = (): MetricsManager => {
	const metrics = new MetricsManager({
		default: "p",
		exporters: { p: drivers.prometheus() },
	});
	metrics.counter({ name: "orders_total", help: "Orders." }).increment();
	return metrics;
};

describe("metricsHandler", () => {
	it("serves the body with the content type a scraper expects", async () => {
		const { ctx, sent } = context();
		await metricsHandler(withOrders())(ctx);
		expect(sent.status).toBe(200);
		expect(sent.body).toContain("orders_total 1");
		expect(sent.headers["content-type"]).toContain("version=0.0.4");
		// A snapshot of internal state; a cached copy is only ever wrong.
		expect(sent.headers["cache-control"]).toBe("no-store");
	});

	it("answers 404 rather than 401 to a bad token", async () => {
		// A 401 confirms the endpoint exists and invites the next request.
		const { ctx, sent } = context("Bearer wrong");
		await metricsHandler(withOrders(), { token: "secret" })(ctx);
		expect(sent.status).toBe(404);
		expect(sent.body).toBe("");
	});

	it("answers 404 when no Authorization header is sent at all", async () => {
		const { ctx, sent } = context();
		await metricsHandler(withOrders(), { token: "secret" })(ctx);
		expect(sent.status).toBe(404);
	});

	it("serves the body for the right token", async () => {
		const { ctx, sent } = context("Bearer secret");
		await metricsHandler(withOrders(), { token: "secret" })(ctx);
		expect(sent.status).toBe(200);
		expect(sent.body).toContain("orders_total 1");
	});

	it("does not leak the token through a length-dependent early return", async () => {
		// A token of a different length must be refused without comparing
		// bytes, because timingSafeEqual throws on a length mismatch.
		const { ctx, sent } = context("Bearer s");
		await expect(
			metricsHandler(withOrders(), { token: "secret" })(ctx),
		).resolves.toBeUndefined();
		expect(sent.status).toBe(404);
	});

	it("answers 404 for a driver that pushes instead of being scraped", async () => {
		// An empty 200 would read to a scraper as a healthy target with no
		// metrics — the one answer that actively misleads.
		const { ctx, sent } = context();
		const metrics = new MetricsManager();
		await metricsHandler(metrics)(ctx);
		expect(sent.status).toBe(404);
	});

	it("scrapes once per request, with no cached body between them", async () => {
		const metrics = withOrders();
		const spy = vi.spyOn(metrics, "scrape");
		const handler = metricsHandler(metrics);
		await handler(context().ctx);
		await handler(context().ctx);
		expect(spy).toHaveBeenCalledTimes(2);
	});
});
