/**
 * Test helpers. Per the cohort convention, a package's fakes live on its own
 * `/testing` subpath rather than in the runner.
 */

import { drivers, MetricsManager } from "../MetricsManager.js";
import { clearMetrics, getMetrics, setMetrics } from "../services/main.js";

/**
 * A Prometheus-backed manager published on `services/main`, so a test can
 * assert on what was actually recorded. `restore` puts back the manager the
 * fake replaced.
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
	const previous = getMetrics();
	setMetrics(metrics);
	return {
		metrics,
		restore: () => {
			// Only while it is still ours: a manager seated after the fake (a
			// nested fake, an app that booted) is not this teardown's to replace.
			if (getMetrics() !== metrics) return;
			if (previous === undefined) clearMetrics();
			else setMetrics(previous);
		},
	};
}
