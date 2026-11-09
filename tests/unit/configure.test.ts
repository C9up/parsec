import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configure } from "../../src/configure.js";

/**
 * Read a stub the way `codemods.makeUsingStub` does.
 *
 * The real file, not a fixture: a test that stubbed this out would pass with
 * a stub that does not exist.
 */
function renderStub(
	stubsRoot: string,
	stubPath: string,
	state: Record<string, string | number | boolean>,
): { to: string; body: string } {
	const raw = readFileSync(resolve(stubsRoot, stubPath), "utf8");
	const [, front = "", body = ""] = raw.split(/^---\r?\n/m, 3);
	const declared = /^to:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? "";
	const render = (text: string): string =>
		text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) =>
			state[key] === undefined ? match : String(state[key]),
		);
	return { to: render(declared), body: render(body) };
}

function codemods() {
	const written = new Map<string, string>();
	return {
		addProvider: vi.fn().mockResolvedValue(undefined),
		addEnvVars: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn(async (path: string, content: string) => {
			written.set(path, content);
		}),
		makeUsingStub: vi.fn(
			async (
				stubsRoot: string,
				stubPath: string,
				state: Record<string, string | number | boolean> = {},
			) => {
				const { to, body } = renderStub(stubsRoot, stubPath, state);
				written.set(to, body);
				return { path: to, contents: body };
			},
		),
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

	it("seeds a random METRICS_TOKEN instead of an empty one", async () => {
		// An empty token used to turn into "no token" in the generated route,
		// publishing the scrape to anyone.
		const first = codemods();
		const second = codemods();
		await configure(first);
		await configure(second);
		const tokenOf = (c: ReturnType<typeof codemods>): string => {
			const vars: unknown = c.addEnvVars.mock.calls[0]?.[0];
			const token =
				typeof vars === "object" && vars !== null
					? Reflect.get(vars, "METRICS_TOKEN")
					: undefined;
			return typeof token === "string" ? token : "";
		};
		// 32 random bytes, base64url: 43 characters, no padding.
		expect(tokenOf(first)).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(tokenOf(first)).not.toBe(tokenOf(second));
	});

	it("passes the token to the handler as-is, so an empty one fails the boot", async () => {
		const c = codemods();
		await configure(c);
		const route = c.written.get("start/metrics.ts") ?? "";
		expect(route).toContain("token: env.get('METRICS_TOKEN')");
		expect(route).not.toContain("|| undefined");
	});
});
