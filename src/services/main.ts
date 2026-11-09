/**
 * Default `MetricsManager` singleton.
 *
 *   import metrics from "@c9up/parsec/services/main"
 *   metrics.counter({ name: "orders_total", help: "Orders placed." }).increment()
 */

import { MetricsManager } from "../MetricsManager.js";

let instance: MetricsManager | undefined;

/** @internal Bind the singleton (called by ParsecProvider or by the app). */
export function setMetrics(value: MetricsManager): void {
	instance = value;
}

/** @internal Read the singleton (or `undefined` pre-boot). */
export function getMetrics(): MetricsManager | undefined {
	return instance;
}

/** @internal Release the singleton. */
export function clearMetrics(): void {
	instance = undefined;
}

/**
 * What the proxy stands on. Never reached: every read goes through the trap
 * below, to the bound manager or to the not-booted error. A real (noop)
 * manager rather than an asserted `{}`, so the facade is a MetricsManager by
 * type and by prototype.
 */
const placeholder = new MetricsManager();

const metrics: MetricsManager = new Proxy(placeholder, {
	get(_target, prop) {
		// A module loader inspects what it imports before anyone uses it: it
		// reads `then` to decide whether the namespace is thenable, and various
		// symbols for interop and formatting. Throwing on those turns a plain
		// import into a crash far from any real use.
		if (typeof prop === "symbol" || prop === "then") return undefined;
		if (!instance) {
			throw new Error(
				"[parsec] MetricsManager singleton accessed before ParsecProvider.boot() ran " +
					"or `setMetrics(myManager)` was called. Wire one of them first.",
			);
		}
		const value = Reflect.get(instance, prop, instance);
		return typeof value === "function" ? value.bind(instance) : value;
	},
});

export default metrics;
