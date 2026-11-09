import { describe, expect, it, vi } from "vitest";
import {
	type MetricsEndpointContext,
	metricsHandler,
} from "../../src/endpoint.js";
import { ParsecError } from "../../src/errors.js";
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
		await metricsHandler(withOrders(), { public: true })(ctx);
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
		await metricsHandler(metrics, { public: true })(ctx);
		expect(sent.status).toBe(404);
	});

	it("scrapes once per request, with no cached body between them", async () => {
		const metrics = withOrders();
		const spy = vi.spyOn(metrics, "scrape");
		const handler = metricsHandler(metrics, { public: true });
		await handler(context().ctx);
		await handler(context().ctx);
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("refuses to build an endpoint with neither a token nor an explicit public opt-out", () => {
		// Publishing the route table is a decision; forgetting the token must
		// not make it for the application.
		expect(() => metricsHandler(withOrders())).toThrow(
			expect.objectContaining({ code: "E_PARSEC_UNPROTECTED_ENDPOINT" }),
		);
		expect(() => metricsHandler(withOrders(), {})).toThrow(ParsecError);
		expect(() => metricsHandler(withOrders(), { public: false })).toThrow(
			expect.objectContaining({ code: "E_PARSEC_UNPROTECTED_ENDPOINT" }),
		);
	});

	it("refuses an empty or blank token instead of letting an empty header match it", () => {
		// `env.get("METRICS_TOKEN")` with the variable left empty: an empty
		// secret authenticates nobody, and certainly not everybody.
		for (const token of ["", "   ", "\t\n"]) {
			expect(() => metricsHandler(withOrders(), { token })).toThrow(
				expect.objectContaining({ code: "E_PARSEC_EMPTY_TOKEN" }),
			);
		}
	});

	it("refuses an unset token that came straight from the environment", () => {
		const fromEnv: string | undefined = undefined;
		expect(() => metricsHandler(withOrders(), { token: fromEnv })).toThrow(
			expect.objectContaining({ code: "E_PARSEC_UNPROTECTED_ENDPOINT" }),
		);
	});

	it("refuses a token and public together, which contradict each other", () => {
		expect(() =>
			metricsHandler(withOrders(), { token: "secret", public: true }),
		).toThrow(ParsecError);
	});

	it("accepts the token as a secret wrapper, as Env.schema.secret() returns it", async () => {
		const secret = { release: () => "secret", toString: () => "[redacted]" };
		const ok = context("Bearer secret");
		await metricsHandler(withOrders(), { token: secret })(ok.ctx);
		expect(ok.sent.status).toBe(200);
		const redacted = context("Bearer [redacted]");
		await metricsHandler(withOrders(), { token: secret })(redacted.ctx);
		expect(redacted.sent.status).toBe(404);
		expect(() =>
			metricsHandler(withOrders(), { token: { release: () => "" } }),
		).toThrow(expect.objectContaining({ code: "E_PARSEC_EMPTY_TOKEN" }));
	});

	it("never serves the body to a caller with no header, whatever the token", async () => {
		const { ctx, sent } = context();
		await metricsHandler(withOrders(), { token: "secret" })(ctx);
		expect(sent.status).toBe(404);
		expect(sent.body).toBe("");
	});

	it("matches the Bearer scheme case-insensitively, with any run of spaces", async () => {
		// RFC 9110 §11.1: the auth scheme is a case-insensitive token.
		for (const header of [
			"Bearer secret",
			"bearer secret",
			"BEARER secret",
			"bEaReR secret",
			"Bearer  secret",
			"Bearer   secret",
		]) {
			const { ctx, sent } = context(header);
			await metricsHandler(withOrders(), { token: "secret" })(ctx);
			expect(sent.status, header).toBe(200);
		}
	});

	it("still refuses another scheme, a glued scheme, or extra credentials", async () => {
		for (const header of [
			"Basic secret",
			"Bearersecret",
			"Bearer",
			"Bearer ",
			"Bearer secret extra",
			"Bearer\tsecret",
			"secret",
			"Token secret",
		]) {
			const { ctx, sent } = context(header);
			await metricsHandler(withOrders(), { token: "secret" })(ctx);
			expect(sent.status, header).toBe(404);
		}
	});
});
