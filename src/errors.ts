/**
 * Parsec errors, one per code. No upstream package exists, so every code
 * carries the `E_PARSEC_` namespace.
 */
import { createError } from "@c9up/flare";

/**
 * A metric or label name the exposition format cannot carry.
 *
 * Raised at instrument creation, deliberately: an invalid name accepted here
 * produces a scrape body Prometheus rejects wholesale, so ONE bad metric name
 * silently takes down every other metric in the process. Failing when the
 * instrument is declared makes it a startup error instead.
 */
export const E_PARSEC_INVALID_NAME = createError<[string, unknown, string]>(
	'Parsec: invalid %s name "%s" — %s',
	"E_PARSEC_INVALID_NAME",
);

/** A measurement that is not a finite number. */
export const E_PARSEC_INVALID_MEASUREMENT = createError<[string, string]>(
	'Parsec: "%s" was given %s; a measurement must be a finite number',
	"E_PARSEC_INVALID_MEASUREMENT",
);

/**
 * An instrument whose options cannot be rendered or exported: a missing help,
 * unusable bucket bounds.
 */
export const E_PARSEC_INVALID_INSTRUMENT = createError<[string, string]>(
	'Parsec: "%s" — %s',
	"E_PARSEC_INVALID_INSTRUMENT",
);

/**
 * A label value that is not a string or a finite number.
 *
 * Raised at the call, deliberately: stored, it would only fail when rendered,
 * and then on every later scrape.
 */
export const E_PARSEC_INVALID_LABEL_VALUE = createError<
	[string, string, string]
>(
	'Parsec: "%s" was given %s for the label "%s"; a label value must be a string or a finite number',
	"E_PARSEC_INVALID_LABEL_VALUE",
);

/** An instrument given a label it never declared. */
export const E_PARSEC_UNDECLARED_LABEL = createError<[string, string, string]>(
	'Parsec: "%s" was given the label "%s", which it does not declare. Declared: %s',
	"E_PARSEC_UNDECLARED_LABEL",
);

/** The same name declared twice with a different shape. */
export const E_PARSEC_INSTRUMENT_CONFLICT = createError<[string, string]>(
	'Parsec: "%s" is already declared with a different %s',
	"E_PARSEC_INSTRUMENT_CONFLICT",
);

/** A config naming an exporter that does not exist. */
export const E_PARSEC_UNKNOWN_EXPORTER = createError<[string, string]>(
	'Parsec: unknown metrics exporter "%s". Declared exporters: %s',
	"E_PARSEC_UNKNOWN_EXPORTER",
);

/**
 * A scrape endpoint built with neither a token nor an explicit
 * `public: true`, or with both.
 *
 * A metrics body names every route, its traffic and its error rate. A token
 * that was simply forgotten (an unset environment variable) must not be the
 * thing that publishes it.
 */
export const E_PARSEC_UNPROTECTED_ENDPOINT = createError<[string]>(
	"Parsec: %s",
	"E_PARSEC_UNPROTECTED_ENDPOINT",
);

/** A scrape endpoint given an empty or blank token. */
export const E_PARSEC_EMPTY_TOKEN = createError(
	"Parsec: the metrics endpoint token is empty. An empty secret would match a request that sends no credentials; set METRICS_TOKEN or pass `public: true` deliberately.",
	"E_PARSEC_EMPTY_TOKEN",
);

/** The metrics manager used before a provider or `setMetrics()` bound it. */
export const E_PARSEC_NOT_BOOTED = createError<[string]>(
	"[parsec] %s",
	"E_PARSEC_NOT_BOOTED",
);

/** The container answered something that is not a MetricsManager. */
export const E_PARSEC_INVALID_BINDING = createError(
	"[parsec] the container returned something that is not a MetricsManager for the MetricsManager token.",
	"E_PARSEC_INVALID_BINDING",
);

/** `config/metrics.ts` exports something `defineConfig()` did not build. */
export const E_PARSEC_INVALID_CONFIG = createError(
	"[parsec] config/metrics.ts must export defineConfig({ default, exporters }).",
	"E_PARSEC_INVALID_CONFIG",
);
