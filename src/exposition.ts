/**
 * Prometheus text exposition format (version 0.0.4), written from scratch.
 *
 * Kept in its own module because the escaping is the part that breaks
 * silently. A label value carrying a quote or a newline does not produce a
 * wrong number — it produces a body the scraper rejects, taking every OTHER
 * metric in the process down with it, and the only symptom is a target that
 * has gone quiet.
 *
 * Unlike a line-delimited format where a terminator cannot be represented at
 * all, this one DEFINES escapes for exactly three characters, so the right
 * answer here is to escape rather than reject.
 */

import { InvalidMetricNameError } from "./errors.js";

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Validate a metric name, at declaration time. */
export function assertMetricName(name: string): void {
	if (!METRIC_NAME.test(name)) {
		throw new InvalidMetricNameError(
			"metric",
			name,
			"it must match [a-zA-Z_:][a-zA-Z0-9_:]*",
		);
	}
}

/** Validate a label name, at declaration time. */
export function assertLabelName(name: string): void {
	if (!LABEL_NAME.test(name)) {
		throw new InvalidMetricNameError(
			"label",
			name,
			"it must match [a-zA-Z_][a-zA-Z0-9_]*",
		);
	}
	// `__name__`, `__meta_*` and friends belong to the scraper. A metric that
	// sets one does not fail — it overwrites the scraper's own idea of what
	// the series is, which is worse.
	if (name.startsWith("__")) {
		throw new InvalidMetricNameError(
			"label",
			name,
			"names beginning with __ are reserved for the scraper",
		);
	}
}

/**
 * Escape a label value: backslash, double quote and newline, in that order.
 *
 * Backslash FIRST. Escaping the quote first would then have its introduced
 * backslash escaped again by the backslash pass, turning `"` into `\\"` —
 * which closes the label early and corrupts the rest of the line.
 */
export function escapeLabelValue(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("\n", "\\n");
}

/** Escape a HELP docstring: backslash and newline only — quotes are literal there. */
export function escapeHelp(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}

/**
 * Render a number the way the format expects.
 *
 * `Infinity` must be written `+Inf`; JavaScript's own `String(Infinity)` is
 * `"Infinity"`, which the parser rejects.
 */
export function formatValue(value: number): string {
	if (Number.isNaN(value)) return "NaN";
	if (value === Number.POSITIVE_INFINITY) return "+Inf";
	if (value === Number.NEGATIVE_INFINITY) return "-Inf";
	return String(value);
}

/** Render `{a="1",b="2"}`, or an empty string when there are no labels. */
export function formatLabels(labels: Readonly<Record<string, string>>): string {
	const pairs = Object.entries(labels);
	if (pairs.length === 0) return "";
	// Sorted so a series renders identically between scrapes regardless of
	// the order labels happened to be written in — it makes a diff of two
	// scrapes readable, and the tests deterministic.
	pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const rendered = pairs
		.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
		.join(",");
	return `{${rendered}}`;
}

/** One `# HELP` / `# TYPE` pair. */
export function formatMetadata(
	name: string,
	type: "counter" | "gauge" | "histogram",
	help: string,
): string {
	return `# HELP ${name} ${escapeHelp(help)}\n# TYPE ${name} ${type}`;
}

/** One sample line. */
export function formatSample(
	name: string,
	labels: Readonly<Record<string, string>>,
	value: number,
): string {
	return `${name}${formatLabels(labels)} ${formatValue(value)}`;
}
