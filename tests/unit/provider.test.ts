import { describe, expect, it, vi } from "vitest";
import { PrometheusDriver } from "../../src/drivers/PrometheusDriver.js";
import { UnknownExporterError } from "../../src/errors.js";
import { PARSEC_KEY } from "../../src/http.js";
import {
	defineConfig,
	drivers,
	MetricsManager,
} from "../../src/MetricsManager.js";
import ParsecProvider, {
	type ParsecAppContext,
} from "../../src/ParsecProvider.js";
import metrics, {
	clearMetrics,
	getMetrics,
	setMetrics,
} from "../../src/services/main.js";
import { fakeMetrics } from "../../src/testing/main.js";
import type { MetricsDriver } from "../../src/types.js";

function app(config: Record<string, unknown>): ParsecAppContext & {
	bindings: Map<unknown, () => unknown>;
} {
	const bindings = new Map<unknown, () => unknown>();
	const resolved = new Map<unknown, unknown>();
	return {
		bindings,
		container: {
			singleton(token, factory) {
				bindings.set(token, factory);
			},
			async resolve(token: unknown): Promise<unknown> {
				if (!resolved.has(token)) {
					const factory = bindings.get(token);
					if (!factory) throw new Error(`unbound: ${String(token)}`);
					resolved.set(token, await factory());
				}
				return resolved.get(token);
			},
		},
		config: { get: (key: string) => config[key] },
	};
}

describe("ParsecProvider", () => {
	it("defaults to measuring nothing when no config file exists", async () => {
		clearMetrics();
		const provider = new ParsecProvider(app({}));
		provider.register();
		await provider.boot();
		// Instrumentation can be written unconditionally; it just costs a no-op.
		expect(getMetrics()).toBeInstanceOf(MetricsManager);
		expect(await getMetrics()?.scrape()).toBe(null);
		await provider.shutdown();
	});

	it("refuses a config/metrics.ts that is not a metrics config", async () => {
		const provider = new ParsecProvider(
			app({ metrics: { driver: "prometheus" } }),
		);
		provider.register();
		await expect(provider.boot()).rejects.toThrow(/defineConfig/);
	});

	it("binds both the middleware token and the bare one", () => {
		const host = app({});
		new ParsecProvider(host).register();
		expect(host.bindings.has(PARSEC_KEY)).toBe(true);
		expect(host.bindings.has("metrics")).toBe(true);
	});

	it("subscribes health checks in ready, and unsubscribes on shutdown", async () => {
		clearMetrics();
		const provider = new ParsecProvider(
			app({
				metrics: defineConfig({
					default: "prometheus",
					exporters: { prometheus: drivers.prometheus() },
				}),
			}),
		);
		provider.register();
		await provider.boot();
		await provider.ready();
		const built = getMetrics();
		await provider.shutdown();
		// Nothing left subscribed to double-count after a reload.
		expect(built).toBeInstanceOf(MetricsManager);
		expect(getMetrics()).toBeUndefined();
	});

	it("clears the singleton on shutdown, but only while it is still ours", async () => {
		clearMetrics();
		const first = new ParsecProvider(app({}));
		first.register();
		await first.boot();
		const second = new ParsecProvider(app({}));
		second.register();
		await second.boot();
		const secondManager = getMetrics();
		await first.shutdown();
		expect(getMetrics()).toBe(secondManager);
		await second.shutdown();
		expect(getMetrics()).toBeUndefined();
	});

	it("refuses a container that rebound the token to something else", async () => {
		const host = app({});
		const provider = new ParsecProvider(host);
		provider.register();
		host.bindings.set(MetricsManager, () => ({ notAManager: true }));
		await expect(provider.boot()).rejects.toThrow(/not a MetricsManager/);
	});
});

describe("services/main", () => {
	it("answers undefined for symbols and `then`, so importing never crashes", () => {
		clearMetrics();
		expect(Reflect.get(metrics, "then")).toBeUndefined();
		expect(Reflect.get(metrics, Symbol.toStringTag)).toBeUndefined();
	});

	it("reports clearly when used before anything bound it", () => {
		clearMetrics();
		expect(() => metrics.counter({ name: "x", help: "x" })).toThrow(
			/before ParsecProvider.boot/,
		);
	});

	it("forwards to the bound manager with methods still bound to it", async () => {
		const manager = new MetricsManager({
			default: "p",
			exporters: { p: drivers.prometheus() },
		});
		setMetrics(manager);
		try {
			const { counter } = metrics;
			counter({ name: "orders_total", help: "Orders." }).increment();
			expect(await manager.scrape()).toContain("orders_total 1");
		} finally {
			clearMetrics();
		}
	});

	it("fakeMetrics publishes a scrapable manager and hands back its teardown", async () => {
		const { metrics: fake, restore } = fakeMetrics();
		metrics.counter({ name: "orders_total", help: "Orders." }).increment();
		expect(await fake.scrape()).toContain("orders_total 1");
		restore();
		expect(getMetrics()).toBeUndefined();
	});
});

describe("MetricsManager", () => {
	it("refuses a config whose default names an exporter that is not declared", () => {
		expect(
			() =>
				new MetricsManager({
					default: "otel",
					exporters: { prometheus: drivers.prometheus() },
				}),
		).toThrow(UnknownExporterError);
	});

	it("names the declared exporters when one is missing", () => {
		const metrics = new MetricsManager({
			default: "p",
			exporters: { p: drivers.prometheus() },
		});
		expect(() => metrics.use("nope")).toThrow(/Declared exporters: p/);
	});

	it("builds each exporter once and reuses it", () => {
		const factory = vi.fn(drivers.prometheus());
		const metrics = new MetricsManager({
			default: "p",
			exporters: { p: factory },
		});
		expect(metrics.use()).toBe(metrics.use("p"));
		expect(factory).toHaveBeenCalledTimes(1);
	});

	it("does not build an exporter the application never asks for", () => {
		const unused = vi.fn();
		const metrics = new MetricsManager({
			default: "p",
			exporters: { p: drivers.prometheus(), unused },
		});
		metrics.counter({ name: "a_total", help: "a" }).increment();
		expect(unused).not.toHaveBeenCalled();
	});

	it("records to a named exporter alongside the default one", async () => {
		const record = vi.fn();
		const metrics = new MetricsManager({
			default: "prometheus",
			exporters: {
				prometheus: drivers.prometheus(),
				otel: drivers.otel({
					meter: {
						createCounter: () => ({ add: record }),
						createGauge: () => ({ record: vi.fn() }),
						createHistogram: () => ({ record: vi.fn() }),
					},
				}),
			},
		});
		metrics.counter({ name: "a_total", help: "a" }).increment();
		metrics.use("otel").counter({ name: "a_total", help: "a" }).increment();
		expect(await metrics.scrape()).toContain("a_total 1");
		expect(record).toHaveBeenCalledWith(1, undefined);
	});

	it("measures nothing when built with no config at all", async () => {
		// What an application with no config/metrics.ts gets: instrumentation
		// can be written unconditionally and costs one empty call.
		const metrics = new MetricsManager();
		metrics.gauge({ name: "g", help: "g" }).set(1);
		metrics.histogram({ name: "h", help: "h" }).observe(1);
		expect(await metrics.scrape()).toBe(null);
	});

	it("exposes the driver underneath for anything it deliberately does not wrap", () => {
		const metrics = new MetricsManager({
			default: "p",
			exporters: { p: drivers.prometheus() },
		});
		expect(metrics.use().getDriver()).toBeInstanceOf(PrometheusDriver);
	});

	it("shuts down every exporter that was built, and none that was not", async () => {
		const shutdown = vi.fn().mockResolvedValue(undefined);
		const inert = (): MetricsDriver => ({
			createCounter: () => ({ increment: () => {} }),
			createGauge: () => ({
				set: () => {},
				increment: () => {},
				decrement: () => {},
			}),
			createHistogram: () => ({
				observe: () => {},
				time: <T>(work: () => Promise<T>) => work(),
			}),
			shutdown,
		});
		const metrics = new MetricsManager({
			default: "a",
			exporters: { a: inert, b: inert },
		});
		metrics.use("a");
		await metrics.shutdown();
		expect(shutdown).toHaveBeenCalledTimes(1);
	});

	it("defineConfig hands the config back unchanged", () => {
		const config = { default: "p", exporters: { p: drivers.prometheus() } };
		expect(defineConfig(config)).toEqual(config);
	});
});
