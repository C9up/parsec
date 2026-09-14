import { describe, expect, it } from "vitest";
import { InvalidMetricNameError } from "../../src/errors.js";
import {
	assertLabelName,
	assertMetricName,
	escapeHelp,
	escapeLabelValue,
	formatLabels,
	formatValue,
} from "../../src/exposition.js";

describe("exposition format", () => {
	it("escapes the backslash first, so an escaped quote is not re-escaped", () => {
		// Escaping the quote first would turn `"` into `\\"`, which closes the
		// label early and corrupts the rest of the line.
		expect(escapeLabelValue('a"b')).toBe('a\\"b');
		expect(escapeLabelValue("a\\b")).toBe("a\\\\b");
		expect(escapeLabelValue('a\\"b')).toBe('a\\\\\\"b');
	});

	it("escapes newlines, which would otherwise end the sample line", () => {
		expect(escapeLabelValue("a\nb")).toBe("a\\nb");
	});

	it("leaves quotes alone in a HELP docstring, where they are literal", () => {
		expect(escapeHelp('say "hi"')).toBe('say "hi"');
		expect(escapeHelp("a\nb")).toBe("a\\nb");
	});

	it("rejects a metric name the parser cannot read, at declaration time", () => {
		// One bad name would otherwise make the whole scrape body unparseable,
		// taking every other metric in the process down with it.
		expect(() => assertMetricName("http-requests")).toThrow(
			InvalidMetricNameError,
		);
		expect(() => assertMetricName("1xx")).toThrow(InvalidMetricNameError);
		expect(() => assertMetricName("http_requests_total")).not.toThrow();
		expect(() => assertMetricName("app:requests:rate")).not.toThrow();
	});

	it("refuses label names reserved for the scraper", () => {
		expect(() => assertLabelName("__name__")).toThrow(/reserved/);
		expect(() => assertLabelName("route")).not.toThrow();
		expect(() => assertLabelName("a:b")).toThrow(InvalidMetricNameError);
	});

	it("writes infinities the way the format spells them", () => {
		expect(formatValue(Number.POSITIVE_INFINITY)).toBe("+Inf");
		expect(formatValue(Number.NEGATIVE_INFINITY)).toBe("-Inf");
		expect(formatValue(Number.NaN)).toBe("NaN");
		expect(formatValue(1.5)).toBe("1.5");
	});

	it("sorts labels so two scrapes of the same state render identically", () => {
		expect(formatLabels({ b: "2", a: "1" })).toBe('{a="1",b="2"}');
		expect(formatLabels({})).toBe("");
	});
});
