/**
 * Parsec errors. No upstream package exists, so every code carries the
 * namespace — there is no upstream id to keep verbatim.
 */

export class ParsecError extends Error {
	readonly code: string;

	constructor(code: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
		this.code = code;
	}
}

/**
 * Raised at instrument creation for a name the exposition format cannot
 * carry.
 *
 * At creation, deliberately — an invalid name accepted here produces a
 * scrape body Prometheus rejects wholesale, so ONE bad metric name silently
 * takes down every other metric in the process. Failing when the instrument
 * is declared makes it a startup error instead.
 */
export class InvalidMetricNameError extends ParsecError {
	constructor(kind: "metric" | "label", name: string, reason: string) {
		super(
			"E_PARSEC_INVALID_NAME",
			`Parsec: invalid ${kind} name "${name}" — ${reason}`,
		);
	}
}

/** Raised when a measurement is not a finite number. */
export class InvalidMeasurementError extends ParsecError {
	constructor(metric: string, value: unknown) {
		super(
			"E_PARSEC_INVALID_MEASUREMENT",
			`Parsec: "${metric}" was given ${String(value)}; a measurement must be a finite number`,
		);
	}
}

/** Raised when an instrument is given a label it never declared. */
export class UndeclaredLabelError extends ParsecError {
	constructor(metric: string, label: string, declared: readonly string[]) {
		super(
			"E_PARSEC_UNDECLARED_LABEL",
			`Parsec: "${metric}" was given the label "${label}", which it does not declare. Declared: ${declared.join(", ") || "(none)"}`,
		);
	}
}

/** Raised when the same name is declared twice with a different shape. */
export class InstrumentConflictError extends ParsecError {
	constructor(name: string, detail: string) {
		super(
			"E_PARSEC_INSTRUMENT_CONFLICT",
			`Parsec: "${name}" is already declared with a different ${detail}`,
		);
	}
}

/** Raised when a config names an exporter that does not exist. */
export class UnknownExporterError extends ParsecError {
	constructor(name: string, known: readonly string[]) {
		super(
			"E_PARSEC_UNKNOWN_EXPORTER",
			`Parsec: unknown metrics exporter "${name}". Declared exporters: ${known.join(", ") || "(none)"}`,
		);
	}
}
