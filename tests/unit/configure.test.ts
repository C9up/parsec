import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCodemods } from "@c9up/ream";
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
		registerMiddleware: vi.fn().mockResolvedValue(undefined),
		defineEnvValidations: vi.fn().mockResolvedValue([]),
		addPreloadFile: vi.fn().mockResolvedValue(undefined),
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

	it("registers the HTTP middleware on the server tier", async () => {
		// Router tier would never see an unmatched request, and the 404 sweep
		// the error-rate chart exists to show would be invisible.
		const c = codemods();
		await configure(c);
		expect(c.registerMiddleware).toHaveBeenCalledWith("@c9up/parsec/http", {
			tier: "server",
		});
	});

	it("preloads the route file it writes, so the endpoint is actually mounted", async () => {
		const c = codemods();
		await configure(c);
		expect(c.addPreloadFile).toHaveBeenCalledWith("#start/metrics.js");
		// Registered after the file exists.
		const wroteRoute = c.makeUsingStub.mock.calls.findIndex(
			([, stub]) => stub === "start/metrics.stub",
		);
		expect(wroteRoute).toBeGreaterThanOrEqual(0);
		expect(c.addPreloadFile.mock.invocationCallOrder[0]).toBeGreaterThan(
			c.makeUsingStub.mock.invocationCallOrder[wroteRoute] ??
				Number.POSITIVE_INFINITY,
		);
	});

	it("validates the variables it writes, the token as a secret", async () => {
		const c = codemods();
		await configure(c);
		expect(c.defineEnvValidations).toHaveBeenCalledWith(
			expect.objectContaining({
				variables: {
					METRICS_EXPORTER: "Env.schema.string.optional()",
					METRICS_TOKEN: "Env.schema.secret()",
				},
			}),
		);
	});

	it("still configures against a host without the preload and env-validation codemods", async () => {
		const c = codemods();
		const older = {
			addProvider: c.addProvider,
			addEnvVars: c.addEnvVars,
			writeFile: c.writeFile,
			makeUsingStub: c.makeUsingStub,
			registerMiddleware: c.registerMiddleware,
		};
		await expect(configure(older)).resolves.toBeUndefined();
		expect(c.addProvider).toHaveBeenCalled();
		expect(c.registerMiddleware).toHaveBeenCalled();
	});
});

describe("configure against ream's real codemods", () => {
	it("leaves an application whose endpoint, middleware and env rules are all wired", async () => {
		// The files `ream new` writes, trimmed to what configure touches.
		const root = mkdtempSync(join(tmpdir(), "parsec-configure-"));
		try {
			mkdirSync(join(root, "start"));
			writeFileSync(
				join(root, "reamrc.ts"),
				"import { defineConfig } from '@c9up/ream'\n\nexport default defineConfig({\n  providers: [],\n  preloads: [\n    () => import('#start/routes.js'),\n    () => import('#start/kernel.js'),\n  ],\n})\n",
			);
			writeFileSync(
				join(root, "start/kernel.ts"),
				"import server from '@c9up/ream/services/server'\n\nserver.use([\n])\n",
			);
			writeFileSync(
				join(root, "start/env.ts"),
				"import { Env } from '@c9up/ream'\n\nexport default await Env.create(new URL('../', import.meta.url), {\n  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),\n})\n",
			);

			await configure(createCodemods({ cwd: root }));

			const read = (file: string): string =>
				readFileSync(join(root, file), "utf8");
			expect(read("reamrc.ts")).toContain("() => import('#start/metrics.js')");
			expect(read("reamrc.ts")).toContain(
				"() => import('@c9up/parsec/provider')",
			);
			expect(read("start/kernel.ts")).toContain(
				"() => import('@c9up/parsec/http')",
			);
			expect(read("start/env.ts")).toContain(
				"METRICS_TOKEN: Env.schema.secret()",
			);
			expect(read("start/env.ts")).toContain(
				"METRICS_EXPORTER: Env.schema.string.optional()",
			);
			expect(read(".env")).toMatch(/^METRICS_TOKEN=[A-Za-z0-9_-]{43}$/m);
			expect(read("start/metrics.ts")).toContain("metricsHandler(metrics");
			expect(read("config/metrics.ts")).toContain("defineConfig({");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
