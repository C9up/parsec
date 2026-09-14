/**
 * ParsecProvider — publishes a {@link MetricsManager} from `config/metrics.ts`.
 *
 *   // reamrc.ts
 *   providers: [() => import("@c9up/parsec/provider")]
 *
 *   // config/metrics.ts
 *   import { defineConfig, drivers } from "@c9up/parsec"
 *   export default defineConfig({ driver: drivers.prometheus() })
 */

import "./augmentations.js";
import { instrumentHealthChecks } from "./diagnostics.js";
import { PARSEC_KEY } from "./http.js";
import { type MetricsConfig, MetricsManager } from "./MetricsManager.js";
import { clearMetrics, getMetrics, setMetrics } from "./services/main.js";

interface ParsecContainer {
	singleton(token: unknown, factory: () => unknown): void;
	/**
	 * `unknown`, not a generic `resolve<T>`: a signature promising a type
	 * nothing verified cannot be implemented without an unchecked cast, so the
	 * check lives here instead. ream's own generic container satisfies this.
	 */
	resolve(token: unknown): Promise<unknown>;
}
interface ParsecConfigStore {
	get(key: string): unknown;
}
export interface ParsecAppContext {
	container: ParsecContainer;
	config: ParsecConfigStore;
}

function isMetricsConfig(value: unknown): value is MetricsConfig {
	if (typeof value !== "object" || value === null) return false;
	return (
		typeof Reflect.get(value, "default") === "string" &&
		typeof Reflect.get(value, "exporters") === "object" &&
		Reflect.get(value, "exporters") !== null
	);
}

export default class ParsecProvider {
	constructor(protected app: ParsecAppContext) {}

	#metrics: MetricsManager | undefined;
	#stopHealth: (() => void) | undefined;

	async #resolveManager(): Promise<MetricsManager> {
		const resolved = await this.app.container.resolve(MetricsManager);
		if (!(resolved instanceof MetricsManager)) {
			throw new Error(
				"[parsec] the container returned something that is not a MetricsManager for the MetricsManager token.",
			);
		}
		return resolved;
	}

	register(): void {
		this.app.container.singleton(MetricsManager, () => {
			const raw = this.app.config.get("metrics");
			// No config file means no backend, which is the honest default: a
			// NoopDriver costs one call per measurement and nothing else, so
			// instrumentation can be written unconditionally.
			if (raw === undefined) return new MetricsManager();
			if (!isMetricsConfig(raw)) {
				throw new Error(
					"[parsec] config/metrics.ts must export defineConfig({ default, exporters }).",
				);
			}
			return new MetricsManager(raw);
		});
		const manager = (): Promise<MetricsManager> => this.#resolveManager();
		this.app.container.singleton(PARSEC_KEY, manager);
		this.app.container.singleton("metrics", manager);
	}

	/**
	 * Publish at BOOT.
	 *
	 * The HTTP socket opens before providers are readied, so a manager
	 * published later leaves a window where a request reaches the middleware
	 * and the accessor throws. Building it opens nothing.
	 */
	async boot(): Promise<void> {
		this.#metrics = await this.#resolveManager();
		setMetrics(this.#metrics);
	}

	/**
	 * Subscribe to what the rest of the framework already publishes.
	 *
	 * In `ready`, the phase reserved for operational effects and the one an
	 * inspection never reaches — `ream inspect` runs register/boot/start but
	 * not shutdown, so a subscription opened earlier would be left behind by a
	 * command that only meant to list the routes.
	 */
	async ready(): Promise<void> {
		if (this.#metrics) this.#stopHealth = instrumentHealthChecks(this.#metrics);
	}

	async shutdown(): Promise<void> {
		// Unsubscribed first: a reloaded application otherwise stacks a second
		// subscriber on the same channel and double-counts every check.
		this.#stopHealth?.();
		this.#stopHealth = undefined;
		if (!this.#metrics) return;
		await this.#metrics.shutdown();
		// Two applications can share a process — parallel tests, a hot reload.
		// Only ours to clear while it still points at what this provider booted.
		if (getMetrics() === this.#metrics) clearMetrics();
		this.#metrics = undefined;
	}
}
