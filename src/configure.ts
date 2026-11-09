/**
 * `ream configure @c9up/parsec` — wire metrics in one command.
 *
 * The provider alone is not enough: it reads `config/metrics.ts`, and a
 * package registered without one falls back to measuring nothing. Writing both
 * together is what makes `ream add` mean installed AND working.
 */

import { randomBytes } from "node:crypto";
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
	registerMiddleware(
		importPath: string,
		options?: { tier?: "server" | "router" },
	): Promise<void>;
	/** Absent from a ream older than the hook; the rules are then added by hand. */
	defineEnvValidations?(definition: {
		leadingComment?: string;
		variables: Record<string, string>;
	}): Promise<string[]>;
	/** Absent from a ream older than the hook; the preload is then added by hand. */
	addPreloadFile?(modulePath: string): Promise<void>;
}

export async function configure(codemods: Codemods): Promise<void> {
	// The config below reads these, so they are declared here. Writing the file
	// without them leaves an application whose config asks the environment for
	// something nothing ever put there.
	//
	// The token is generated, never left empty: the scrape route refuses to
	// build without one, and a placeholder a person must remember to fill in is
	// how an endpoint ends up public. `.env` only — it is not committed.
	await codemods.addEnvVars({
		METRICS_EXPORTER: "prometheus",
		METRICS_TOKEN: randomBytes(32).toString("base64url"),
	});

	// The token as a Secret, so it stays out of logs until the handler reads
	// it; required, so a missing one stops the boot with the variable's name.
	await codemods.defineEnvValidations?.({
		leadingComment: "Variables for metrics (@c9up/parsec)",
		variables: {
			METRICS_EXPORTER: "Env.schema.string.optional()",
			METRICS_TOKEN: "Env.schema.secret()",
		},
	});

	await codemods.addProvider("@c9up/parsec/provider");
	await codemods.makeUsingStub(stubsRoot, "config/metrics.stub");

	// Server tier: router middleware never sees an unmatched request, and the
	// 404 sweep the error-rate chart exists to show would be invisible.
	await codemods.registerMiddleware("@c9up/parsec/http", { tier: "server" });

	// NOT mounted by the provider: a metrics body names every route the
	// application has, its traffic shape and its error rate. Publishing it is
	// a decision, so it is written here where it can be read and changed —
	// and preloaded, or nothing would ever import it.
	await codemods.makeUsingStub(stubsRoot, "start/metrics.stub");
	await codemods.addPreloadFile?.("#start/metrics.js");
}
