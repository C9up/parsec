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

export {
	collectDefaultMetrics,
	type DefaultMetricsOptions,
	type InstrumentFactory,
} from "./defaultMetrics.js";
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
	type ReleasableSecret,
} from "./endpoint.js";
export {
	EmptyTokenError,
	InstrumentConflictError,
	InvalidInstrumentError,
	InvalidLabelValueError,
	InvalidMeasurementError,
	InvalidMetricNameError,
	ParsecError,
	UndeclaredLabelError,
	UnknownExporterError,
	UnprotectedEndpointError,
} from "./errors.js";
export {
	defineConfig,
	drivers,
	type MetricsConfig,
	MetricsManager,
} from "./MetricsManager.js";
export type {
	Collect,
	Counter,
	CounterOptions,
	DriverOptions,
	EndTimer,
	Gauge,
	GaugeOptions,
	Histogram,
	HistogramOptions,
	InstrumentOptions,
	Labels,
	MetricsDriver,
	SeriesLifecycle,
} from "./types.js";
