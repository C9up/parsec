import {
	Container,
	createHttpKernel,
	Exception,
	type HttpContext,
	MiddlewareRegistry,
	Router,
} from "@c9up/ream";
import { describe, expect, it } from "vitest";
import { PARSEC_KEY, parsecHttpMiddleware } from "../../src/http.js";
import { drivers, MetricsManager } from "../../src/MetricsManager.js";

/**
 * The middleware through a REAL ream kernel, registered the way the docs say
 * (server tier). A fake context with a pre-set status cannot show the order in
 * which ream runs the exception handler relative to server middleware, and
 * that order is exactly what decides the status label of a failed request.
 */
function kernelWith(metrics: MetricsManager) {
	const router = new Router();
	const container = new Container();
	container.singleton(PARSEC_KEY, () => metrics);
	router.get("/ok", async (ctx: HttpContext) => {
		ctx.response.send("fine");
	});
	router.get("/created", async (ctx: HttpContext) => {
		ctx.response.status(201).send("made");
	});
	router.get("/boom", async () => {
		throw new Error("kaboom");
	});
	router.get("/denied", async () => {
		throw new Exception("nope", { status: 403 });
	});
	const kernel = createHttpKernel({
		router,
		middleware: new MiddlewareRegistry(),
		container,
		serverMiddleware: [
			(ctx: HttpContext, next: () => Promise<void>) =>
				parsecHttpMiddleware(ctx, next),
		],
	});
	return (path: string) =>
		kernel({ method: "GET", path, query: "", headers: {}, body: "" });
}

const manager = (): MetricsManager =>
	new MetricsManager({ default: "p", exporters: { p: drivers.prometheus() } });

function requestLines(body: string | null): string[] {
	return (body ?? "")
		.split("\n")
		.filter((line) => line.startsWith("http_server_requests_total"));
}

describe("http middleware inside a real ream kernel", () => {
	it("labels each request with the status the client actually received", async () => {
		const metrics = manager();
		const request = kernelWith(metrics);
		const statuses = [
			(await request("/ok")).status,
			(await request("/created")).status,
			(await request("/boom")).status,
			(await request("/denied")).status,
			(await request("/does-not-exist")).status,
		];
		expect(statuses).toEqual([200, 201, 500, 403, 404]);

		const lines = requestLines(await metrics.scrape());
		expect(lines).toEqual(
			expect.arrayContaining([
				'http_server_requests_total{method="GET",route="/ok",status="200"} 1',
				'http_server_requests_total{method="GET",route="/created",status="201"} 1',
				'http_server_requests_total{method="GET",route="/boom",status="500"} 1',
				'http_server_requests_total{method="GET",route="/denied",status="403"} 1',
				'http_server_requests_total{method="GET",route="<unmatched>",status="404"} 1',
			]),
		);
		// A failed request must never also be counted as a success.
		expect(lines.filter((line) => line.includes('status="200"'))).toHaveLength(
			1,
		);
	});

	it("puts the same final status on the duration histogram", async () => {
		const metrics = manager();
		const request = kernelWith(metrics);
		await request("/boom");
		const body = (await metrics.scrape()) ?? "";
		expect(body).toContain(
			'http_server_request_duration_seconds_count{method="GET",route="/boom",status="500"} 1',
		);
		expect(body).not.toContain('route="/boom",status="200"');
	});

	it("brings in-flight back to zero after a failed request", async () => {
		const metrics = manager();
		const request = kernelWith(metrics);
		await request("/boom");
		expect(await metrics.scrape()).toContain(
			'http_server_requests_in_flight{method="GET"} 0',
		);
	});
});
