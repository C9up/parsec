/**
 * Teach ream's `ContainerBindings` what `container.make(...)` returns for the
 * tokens parsec binds.
 *
 * ream declares that interface open on purpose: it registers its own entries
 * and expects each package to contribute the ones it owns. Without this,
 * resolving by the string token answers `unknown` and every call site has to
 * assert a type it cannot prove.
 *
 * Loaded from the package barrel, so importing parsec anywhere in the
 * application is enough — nobody writes a `declare module` of their own.
 *
 * Type-only, and ream stays an OPTIONAL peer: nothing here reaches a runtime
 * import, and a `declare module` for a specifier that does not resolve is
 * simply inert.
 */

// Referenced so the augmentation below resolves the module it augments.
import type {} from "@c9up/ream/types";

import type { MetricsManager } from "./MetricsManager.js";

declare module "@c9up/ream/types" {
	interface ContainerBindings {
		/** The metrics manager, bound by `ParsecProvider`. */
		"parsec.metrics": MetricsManager;
		/** The same binding under the bare role name. */
		metrics: MetricsManager;
	}
}
