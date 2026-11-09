/**
 * The instrument contract every driver enforces, in one place.
 *
 * A check that lives in one driver only is a contract that changes when
 * METRICS_EXPORTER does, so declaration and call validation are shared here
 * and each driver only decides what to do with a value already known good.
 */

import {
	InvalidInstrumentError,
	InvalidLabelValueError,
	UndeclaredLabelError,
} from "./errors.js";
import type { Labels } from "./types.js";

/** Validate a HELP text at declaration. */
export function assertHelp(name: string, help: unknown): void {
	if (typeof help !== "string") {
		throw new InvalidInstrumentError(name, "its help must be a string");
	}
}

/**
 * One label value, as the string both backends store.
 *
 * Numbers are accepted and stringified here, once, so `{ status: 200 }` and
 * `{ status: "200" }` are the same series on every driver. Anything else is
 * refused at the call: accepted, it would only fail when rendered, on every
 * later scrape, taking every other metric of the process down with it.
 */
function labelValue(metric: string, label: string, value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return String(value);
	throw new InvalidLabelValueError(metric, label, value);
}

/**
 * Normalise a caller's labels to the declared shape: every declared label
 * present (empty when not given), each value a string.
 *
 * An undeclared label RAISES rather than being dropped: it is almost always
 * the request-derived value that would have made the instrument unbounded,
 * and silently ignoring it hides the bug until the chart is missing a
 * dimension nobody can explain.
 */
export function normaliseLabels(
	metric: string,
	labelNames: readonly string[],
	labels: Labels | undefined,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of labelNames) out[name] = "";
	if (labels) {
		for (const [key, value] of Object.entries(labels)) {
			if (!labelNames.includes(key)) {
				throw new UndeclaredLabelError(metric, key, labelNames);
			}
			out[key] = labelValue(metric, key, value);
		}
	}
	return out;
}

/**
 * A key for one label combination, injective over the values.
 *
 * Built from the DECLARED order, not from the caller's object, so `{a, b}`
 * and `{b, a}` land on one series. JSON-encoded rather than joined with a
 * separator: any separator can appear inside a value, and then two distinct
 * label sets share one series — the second one's counts credited to the
 * first, and a request-derived value able to absorb another set's traffic.
 */
export function seriesKey(
	labelNames: readonly string[],
	labels: Readonly<Record<string, string>>,
): string {
	return JSON.stringify(labelNames.map((name) => labels[name] ?? ""));
}
