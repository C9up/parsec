/**
 * `ream configure @c9up/parsec` — wire metrics in one command.
 *
 * The provider alone is not enough: it reads `config/metrics.ts`, and a
 * package registered without one falls back to measuring nothing. Writing both
 * together is what makes `ream add` mean installed AND working.
 */

import { stubsRoot } from "./stubs.js";

interface Codemods {
	addProvider(importPath: string): Promise<void>;
	addEnvVars(vars: Record<string, string>): Promise<void>;
	writeFile(
		filePath: string,
		content: string,
		options?: { force?: boolean },
	): Promise<void>;
	makeUsingStub(
		stubsRoot: string,
		stubPath: string,
		state?: Record<string, string | number | boolean>,
		options?: { force?: boolean },
	): Promise<{ path: string; contents: string }>;
}

export async function configure(codemods: Codemods): Promise<void> {
	// The config below reads these, so they are declared here. Writing the file
	// without them leaves an application whose config asks the environment for
	// something nothing ever put there.
	await codemods.addEnvVars({
		METRICS_EXPORTER: "prometheus",
		METRICS_TOKEN: "",
	});

	await codemods.addProvider("@c9up/parsec/provider");
	await codemods.makeUsingStub(stubsRoot, "config/metrics.stub");

	// NOT mounted by the provider: a metrics body names every route the
	// application has, its traffic shape and its error rate. Publishing it is
	// a decision, so it is written here where it can be read and changed.
	await codemods.makeUsingStub(stubsRoot, "start/metrics.stub");
}
