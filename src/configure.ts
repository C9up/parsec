/**
 * `ream configure @c9up/parsec` — wire metrics in one command.
 *
 * The provider alone is not enough: it reads `config/metrics.ts`, and a
 * package registered without one falls back to measuring nothing. Writing both
 * together is what makes `ream add` mean installed AND working.
 */

interface Codemods {
	addProvider(importPath: string): Promise<void>;
	addEnvVars(vars: Record<string, string>): Promise<void>;
	writeFile(
		filePath: string,
		content: string,
		options?: { force?: boolean },
	): Promise<void>;
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
	await codemods.writeFile(
		"config/metrics.ts",
		`import { defineConfig, drivers } from '@c9up/parsec'
import env from '#start/env'

export default defineConfig({
  default: env.get('METRICS_EXPORTER', 'prometheus'),

  exporters: {
    // Scraped. Holds series in memory and renders them on /metrics.
    prometheus: drivers.prometheus({
      // Distinct label combinations one instrument may hold. A label fed
      // from a request is what makes this grow without bound.
      maxSeries: 1000,
    }),

    // Measures nothing, at the cost of one empty call per measurement.
    noop: drivers.noop(),
  },
})`,
	);

	// NOT mounted by the provider: a metrics body names every route the
	// application has, its traffic shape and its error rate. Publishing it is
	// a decision, so it is written here where it can be read and changed.
	await codemods.writeFile(
		"start/metrics.ts",
		`import router from '@c9up/ream/services/router'
import metrics from '@c9up/parsec/services/main'
import { metricsHandler } from '@c9up/parsec/endpoint'
import env from '#start/env'

/**
 * The scrape endpoint. Behind a bearer token by default — leaving
 * METRICS_TOKEN empty publishes your route table to anyone who asks.
 */
router.get(
  '/__metrics',
  metricsHandler(metrics, { token: env.get('METRICS_TOKEN') || undefined }),
)`,
	);
}
