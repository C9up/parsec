import { Exception } from "@c9up/flare";
import { describe, expect, it } from "vitest";
import { errors } from "../../src/index.js";

describe("errors", () => {
	it("are exported from the entry as flare exceptions, one class per code", () => {
		const error = new errors.E_PARSEC_UNKNOWN_EXPORTER(["otel", "prometheus"]);
		expect(error).toBeInstanceOf(Exception);
		expect(error).toMatchObject({
			code: "E_PARSEC_UNKNOWN_EXPORTER",
			status: 500,
			message:
				'Parsec: unknown metrics exporter "otel". Declared exporters: prometheus',
		});
		for (const [name, ErrorClass] of Object.entries(errors)) {
			expect(ErrorClass.code).toBe(name);
		}
	});
});
