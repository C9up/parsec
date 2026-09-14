/**
 * Parsec — metrics for the Ream framework.
 *
 *   import { defineConfig, drivers } from "@c9up/parsec"
 *
 *   export default defineConfig({
 *     default: "prometheus",
 *     exporters: { prometheus: drivers.prometheus() },
 *   })
 */

// Contributes this package's tokens to ream's ContainerBindings. Type-only.
import "./augmentations.js";

export { HEALTH_CHANNEL, instrumentHealthChecks } from "./diagnostics.js";
export { NoopDriver } from "./drivers/NoopDriver.js";
export {
	OtelDriver,
	type OtelDriverOptions,
	type OtelMeter,
} from "./drivers/OtelDriver.js";
export {
	PROMETHEUS_CONTENT_TYPE,
	PrometheusDriver,
} from "./drivers/PrometheusDriver.js";
export {
	type MetricsEndpointContext,
	type MetricsEndpointOptions,
	metricsHandler,
} from "./endpoint.js";
export {
	InstrumentConflictError,
	InvalidMeasurementError,
	InvalidMetricNameError,
	ParsecError,
	UndeclaredLabelError,
	UnknownExporterError,
} from "./errors.js";
export {
	defineConfig,
	drivers,
	type MetricsConfig,
	MetricsManager,
} from "./MetricsManager.js";
export type {
	Counter,
	DriverOptions,
	Gauge,
	Histogram,
	HistogramOptions,
	InstrumentOptions,
	Labels,
	MetricsDriver,
} from "./types.js";
