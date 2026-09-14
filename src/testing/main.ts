/**
 * Test helpers. Per the cohort convention, a package's fakes live on its own
 * `/testing` subpath rather than in the runner.
 */

import { drivers, MetricsManager } from "../MetricsManager.js";
import { clearMetrics, setMetrics } from "../services/main.js";

/**
 * A Prometheus-backed manager published on `services/main`, so a test can
 * assert on what was actually recorded.
 *
 *   const { metrics, restore } = fakeMetrics()
 *   afterEach(restore)
 *   expect(await metrics.scrape()).toContain("orders_total 1")
 */
export function fakeMetrics(): {
	metrics: MetricsManager;
	restore: () => void;
} {
	const metrics = new MetricsManager({
		default: "prometheus",
		exporters: { prometheus: drivers.prometheus() },
	});
	setMetrics(metrics);
	return { metrics, restore: () => clearMetrics() };
}
