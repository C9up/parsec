import { describe, expect, it, vi } from "vitest";
import { configure } from "../../src/configure.js";

function codemods() {
	const written = new Map<string, string>();
	return {
		addProvider: vi.fn().mockResolvedValue(undefined),
		addEnvVars: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn(async (path: string, content: string) => {
			written.set(path, content);
		}),
		written,
	};
}

describe("configure", () => {
	it("registers the provider and declares the env vars its config reads", async () => {
		const c = codemods();
		await configure(c);
		expect(c.addProvider).toHaveBeenCalledWith("@c9up/parsec/provider");
		// Writing the config without these leaves an application asking the
		// environment for something nothing ever put there.
		expect(c.addEnvVars).toHaveBeenCalledWith(
			expect.objectContaining({ METRICS_EXPORTER: "prometheus" }),
		);
	});

	it("writes a config in the multi-exporter shape the manager reads", async () => {
		const c = codemods();
		await configure(c);
		const config = c.written.get("config/metrics.ts") ?? "";
		expect(config).toContain("defineConfig({");
		expect(config).toContain("exporters: {");
		expect(config).toContain("drivers.prometheus(");
		expect(config).toContain("METRICS_EXPORTER");
	});

	it("writes the scrape route separately, behind a token", async () => {
		// The provider does not mount it: a metrics body names every route the
		// application has. Publishing it is a decision, so it lives in a file
		// that can be read and changed.
		const c = codemods();
		await configure(c);
		const route = c.written.get("start/metrics.ts") ?? "";
		expect(route).toContain("metricsHandler");
		expect(route).toContain("METRICS_TOKEN");
	});
});
