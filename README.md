# @c9up/parsec

Metrics for the Ream framework. Throughput, latency and error rate — the three
numbers an application is blind without.

```bash
pnpm add @c9up/parsec
```

## Why

`@c9up/spectrum` gives you logs. Logs tell you what happened to one request;
they do not tell you that p99 latency tripled an hour ago. Without metrics, a
deployment with no APM has no answer to "is it slow?" other than opening it.

## Configure

```ts
// config/metrics.ts
import { defineConfig, drivers } from "@c9up/parsec"
import env from "#start/env"

export default defineConfig({
  default: env.get("METRICS_EXPORTER", "prometheus"),

  exporters: {
    prometheus: drivers.prometheus({ maxSeries: 1000 }),
    noop: drivers.noop(),
  },
})
```

```ts
// reamrc.ts
providers: [() => import("@c9up/parsec/provider")]

// start/kernel.ts — throughput, latency and error rate for every request
//
// `server.use`, NOT `router.use`: router middleware runs only for MATCHED
// routes, so a request that hit nothing never reaches it — and a 404 sweep,
// the one thing an error-rate chart most needs to show, would be invisible.
import { parsecHttpMiddleware } from "@c9up/parsec/http"
server.use([parsecHttpMiddleware])
```

`ream configure @c9up/parsec` writes all of it.

## Record

```ts
import metrics from "@c9up/parsec/services/main"

metrics.counter({ name: "orders_total", help: "Orders placed." }).increment()

const duration = metrics.histogram({
  name: "checkout_duration_seconds",
  help: "Time to complete a checkout.",
  labelNames: ["outcome"],
})
await duration.time(() => checkout(cart), { outcome: "paid" })
```

`metrics.use("otel")` records to a named exporter instead of the default —
scrape *and* push, if that is what the deployment wants.

Durations are **seconds**, the Prometheus convention. (`@c9up/eclipse` is
milliseconds, because Redis takes milliseconds. Each is native to its layer.)

## Expose

Deliberately not mounted for you. A metrics body names every route the
application has, its traffic shape and its error rate; publishing it is a
decision.

```ts
// start/metrics.ts
import { metricsHandler } from "@c9up/parsec/endpoint"
import metrics from "@c9up/parsec/services/main"

router.get("/__metrics", metricsHandler(metrics, { token: env.get("METRICS_TOKEN") }))
```

A wrong token gets a 404, not a 401 — a 401 confirms the endpoint is there and
invites the next request. The comparison is constant-time.

## Cardinality

The failure mode of a metrics system is not a wrong number, it is a process
that runs out of memory because one label was fed from a request. Parsec makes
that hard on purpose:

- **Labels are declared up front.** An undeclared label raises instead of being
  silently recorded.
- **Each instrument has a series cap** (`maxSeries`, default 1000). Past it, new
  label combinations are refused and counted in
  `parsec_series_dropped_total{metric="..."}` — visible on the dashboard rather
  than invisible until the container dies.
- **The HTTP middleware labels by matched route PATTERN**, never the URL, so
  `/users/1` and `/users/2` are one series and a 404 sweep cannot inflate
  anything. An unmatched request gets the constant `<unmatched>`.
- **Unknown HTTP methods fold into `OTHER`.**

## OpenTelemetry

```ts
import { metrics as otel } from "@opentelemetry/api"

drivers.otel({ meter: otel.getMeter("my-app") })
```

Parsec never imports `@opentelemetry/api` — pass your own meter, already
configured with whatever exporter and resource attributes you have set up. An
application that only wants a scrape endpoint installs nothing extra.

## Health checks, for free

ream's health module publishes every check on the `ream.health.check`
diagnostics channel. `ParsecProvider.ready()` subscribes, so
`health_check_duration_seconds` and `health_check_failures_total` appear with
no wiring. Neither package imports the other.

## Testing

```ts
import { fakeMetrics } from "@c9up/parsec/testing"

const { metrics, restore } = fakeMetrics()
afterEach(restore)
expect(await metrics.scrape()).toContain("orders_total 1")
```

## License

MIT
