# Metric types: Counter, Gauge, Histogram, Summary

`hotconfigs` ships a small, dependency-free metrics utility
(`src/utils/metric.ts`) alongside the config system. It's the same shape
you'd expect from a Prometheus client: four metric types, each backed by
one or more labeled **series**, with flexible call syntaxes for recording a
value.

All four classes — `CounterMetric`, `GaugeMetric`, `HistogramMetric`,
`SummaryMetric` — plus the `Metric` base class they extend, and every
related type (`MetricOptions`, `MetricLabels`, `HistogramMetricOptions`,
`SummaryMetricOptions`, and the four `*MetricSample` types), are exported
from the `hotconfigs/utils/metrics` subpath — not from the package
root:

```ts
import {
  Metric,
  CounterMetric,
  GaugeMetric,
  HistogramMetric,
  SummaryMetric,
} from "hotconfigs/utils/metrics";
```

## Table of contents

- [Shared concepts](#shared-concepts)
- [`CounterMetric`](#countermetric)
- [`GaugeMetric`](#gaugemetric)
- [`HistogramMetric`](#histogrammetric)
- [`SummaryMetric`](#summarymetric)
- [Choosing a type](#choosing-a-type)
- [See also](#see-also)

## Shared concepts

### `MetricOptions`

Every constructor takes at least:

| Option       | Type                  | Required | Description                                                          |
| ------------ | --------------------- | -------- | --------------------------------------------------------------------- |
| `name`       | `string`               | yes      | Identifies the metric. Throws `ConfigError` if omitted.               |
| `help`       | `string`               | no       | Human-readable description. Defaults to `""`.                        |
| `labelNames` | `readonly string[]`    | no       | The exact set of label keys this metric's series are keyed by.        |

### Labels and series

A metric with no `labelNames` has exactly one series, recorded/read by
calling its methods with no labels. A metric with `labelNames` fans out
into one independent series per distinct combination of label values —
e.g. `{ method: "GET" }` and `{ method: "POST" }` on the same
`CounterMetric` track separately.

`labelNames` is enforced, not just documentation:

```ts
const requests = new CounterMetric({ name: "requests_total", labelNames: ["method"] });

requests.inc({ method: "GET" }); // ok
requests.inc({ status: "500" }); // throws ConfigError: unknown label "status"
requests.inc({}); // throws ConfigError: missing label "method"
```

This applies to every mutator (`inc`/`dec`/`set`/`observe`) and to `get()`
on every metric type.

### Mutator methods: `inc`, `dec`, `set`, `observe`

Each metric type only exposes the mutators that make sense for the value
it models — the type system is the enforcement, not a runtime check:

| Method    | Meaning                                        | Available on                       |
| --------- | ----------------------------------------------- | ------------------------------------ |
| `inc`     | Add to the current value (defaults to `+1`).     | `CounterMetric`, `GaugeMetric`       |
| `dec`     | Subtract from the current value (defaults to `-1`). | `GaugeMetric`                    |
| `set`     | Replace the current value outright.              | `GaugeMetric`                        |
| `observe` | Record one raw data point into the distribution. | `HistogramMetric`, `SummaryMetric`   |

- **`inc`** — use it whenever an event just happened and you only care
  about the running total: a request served, a job completed, a
  connection opened. It's the only mutator `CounterMetric` has, because a
  counter should never move except upward.
- **`dec`** — the mirror of `inc`, only on `GaugeMetric`: use it when an
  event *ends* something you previously counted up — a connection
  closing, an item leaving a queue.
- **`set`** — use it when you already know the absolute value rather than
  a delta — e.g. reading current memory usage or queue depth from the
  system and reporting it as-is, instead of tracking every increment and
  decrement yourself.
- **`observe`** — use it on `HistogramMetric`/`SummaryMetric` to feed one
  measured sample (a request's duration, a payload's size) into the
  metric; each call adds a data point, it never replaces one.

All four accept the same label patterns described above — no labels, a
labels object only (defaulting the amount to `1` for `inc`/`dec`), or
labels plus an explicit value — except `set` and `observe`, which always
require an explicit value since there's no sensible default to replace or
observe.

### `reset()`

Every metric has `reset(): void`, which drops all recorded series — every
label combination goes back to unrecorded, as if the metric were just
constructed.

### `collect()`

Every metric has a `collect()` method returning one snapshot entry per
recorded series (labels plus that series' current value/state), typed per
metric as one of the four exported sample types:

```ts
collect(): CounterMetricSample[]; // CounterMetric
collect(): GaugeMetricSample[]; // GaugeMetric
collect(): HistogramMetricSample[]; // HistogramMetric
collect(): SummaryMetricSample[]; // SummaryMetric
```

Use it to export the metric's data (e.g. to a Prometheus-format exposition
endpoint) without knowing the label combinations up front. One example
entry per sample type:

```ts
// CounterMetricSample
{ labels: { method: "GET" }, value: 42 }

// GaugeMetricSample
{ labels: { queue: "emails" }, value: 7 }

// HistogramMetricSample
{
  labels: { route: "/health" },
  buckets: [
    { le: 0.1, count: 5 },
    { le: 0.5, count: 9 },
    { le: Infinity, count: 10 },
  ],
  sum: 1.85,
  count: 10,
}

// SummaryMetricSample
{
  labels: { route: "/health" },
  quantiles: [
    { quantile: 0.5, value: 0.12 },
    { quantile: 0.99, value: 0.48 },
  ],
  sum: 1.85,
  count: 10,
}
```

Each sample type is covered under its metric type below.

## `CounterMetric`

A value that only ever goes up (or resets to zero on process restart) —
requests served, errors raised, jobs completed.

```ts
const requests = new CounterMetric({
  name: "requests_total",
  help: "total HTTP requests handled",
  labelNames: ["method"],
});
```

### Supported call syntaxes

```ts
requests.inc(); // +1, no labels
requests.inc(5); // +5, no labels
requests.inc({ method: "GET" }); // +1, labeled
requests.inc({ method: "GET" }, 5); // +5, labeled
```

`inc()` rejects a negative amount with `ConfigError` — a counter can only
increase.

### Reading

```ts
requests.get(); // number, unlabeled series
requests.get({ method: "GET" }); // number, labeled series
requests.collect(); // CounterMetricSample[]
```

## `GaugeMetric`

A value that can go up or down — open connections, queue depth, memory
used, temperature.

```ts
const queueDepth = new GaugeMetric({
  name: "queue_depth",
  labelNames: ["queue"],
});
```

### Supported call syntaxes

```ts
queueDepth.set(42); // = 42, no labels
queueDepth.set({ queue: "emails" }, 42); // = 42, labeled

queueDepth.inc(); // +1, no labels
queueDepth.inc(5); // +5, no labels
queueDepth.inc({ queue: "emails" }); // +1, labeled
queueDepth.inc({ queue: "emails" }, 5); // +5, labeled

queueDepth.dec(); // -1, no labels
queueDepth.dec(5); // -5, no labels
queueDepth.dec({ queue: "emails" }); // -1, labeled
queueDepth.dec({ queue: "emails" }, 5); // -5, labeled
```

Unlike `CounterMetric`, `dec()`/negative `set()` values are allowed — a
gauge can go negative.

### Reading

```ts
queueDepth.get(); // number, unlabeled series
queueDepth.get({ queue: "emails" }); // number, labeled series
queueDepth.collect(); // GaugeMetricSample[]
```

## `HistogramMetric`

Buckets observed values into cumulative counts — request durations,
payload sizes, anything you want percentile-like insight into via
server-side aggregation (e.g. `histogram_quantile()` in PromQL).

```ts
const duration = new HistogramMetric({
  name: "http_request_duration_seconds",
  buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  labelNames: ["route"],
});
```

`buckets` defaults to a standard ladder (`[0.005, 0.01, 0.025, 0.05, 0.1,
0.25, 0.5, 1, 2.5, 5, 10]`) if omitted. Whatever is passed is de-duplicated,
sorted ascending, and always gets a trailing `+Infinity` bucket appended
(so every observation always lands somewhere). An empty `buckets` array
throws `ConfigError`.

### Supported call syntaxes

```ts
duration.observe(0.42); // no labels
duration.observe({ route: "/health" }, 0.42); // labeled
```

### Reading

```ts
duration.get();
// { buckets: { le: number; count: number }[], sum: number, count: number }

duration.get({ route: "/health" }); // same shape, for that series

duration.collect(); // HistogramMetricSample[]
```

`buckets[i].count` is **cumulative**: it's the number of observations
`<= le`, matching how Prometheus histogram buckets work.

## `SummaryMetric`

Like `HistogramMetric`, but computes quantiles client-side over the raw
observed values instead of exposing fixed buckets — useful when you want
exact p50/p90/p99 without picking bucket boundaries up front.

```ts
const latency = new SummaryMetric({
  name: "response_latency_seconds",
  percentiles: [0.5, 0.9, 0.99],
  labelNames: ["route"],
});
```

`percentiles` defaults to `[0.5, 0.9, 0.99]` if omitted. Each value must be
in `(0, 1]`; an empty array or an out-of-range percentile throws
`ConfigError`.

### Supported call syntaxes

```ts
latency.observe(0.42); // no labels
latency.observe({ route: "/health" }, 0.42); // labeled
```

### Reading

```ts
latency.get();
// { quantiles: { quantile: number; value: number }[], sum: number, count: number }

latency.get({ route: "/health" }); // same shape, for that series

latency.collect(); // SummaryMetricSample[]
```

`SummaryMetric` keeps every observed value in memory per series (to
compute exact quantiles on read) — for very high-cardinality or
high-volume series, prefer `HistogramMetric`, which stores only bucket
counts.

### Sliding window: `maxAgeSeconds` and `ageBuckets`

By default a `SummaryMetric` keeps every observation for its entire
lifetime, so quantiles reflect the metric's whole history — not "how's
latency right now." For a rolling window instead (the same shape
Prometheus client libraries expose), set `maxAgeSeconds`:

```ts
const latency = new SummaryMetric({
  name: "response_latency_seconds",
  maxAgeSeconds: 600, // only the last 10 minutes count
  ageBuckets: 5, // sliced into 5 x 2-minute buckets (the default)
});
```

| Option          | Type     | Required                              | Description                                                                                             |
| ---------------- | -------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `maxAgeSeconds`   | `number` | no                                     | Window length in seconds. Omit to never evict (the default). Must be finite and `> 0` when set.               |
| `ageBuckets`      | `number` | no — only meaningful with `maxAgeSeconds` | How many slices the window is split into internally. Defaults to `5` when `maxAgeSeconds` is set. Must be an integer `>= 1`. Throws `ConfigError` if given without `maxAgeSeconds`. |

Internally, each series keeps `ageBuckets` rotating buckets, each covering
`maxAgeSeconds / ageBuckets` of the window; as time passes, the oldest
bucket is periodically cleared and reused. `get()`/`collect()` always
report the combined values across every still-active bucket, so:

- More `ageBuckets` → the window evicts smoothly (closer to a true rolling
  window), at the cost of a little more memory.
- Fewer `ageBuckets` → coarser eviction (values can look up to one
  bucket-width — `maxAgeSeconds / ageBuckets` — older than the nominal
  window), but cheaper.

```ts
latency.observe(0.42);
// ... 11 minutes pass ...
latency.get(); // that 0.42 observation is now outside the 10-minute window
```

This is a good practice whenever a `SummaryMetric` sits behind something
that stays running for a long time (a server process) and you care about
recent behavior rather than a lifetime average — unbounded, it both grows
memory forever and makes old traffic patterns drag down current quantiles.

## Choosing a type

| You want to track...                          | Use               | Memory per series                                                        |
| ---------------------------------------------- | ------------------ | --------------------------------------------------------------------------- |
| A count that only grows (requests, errors)      | `CounterMetric`   | Constant — one number.                                                    |
| A value that moves up and down (queue size)      | `GaugeMetric`     | Constant — one number.                                                    |
| A distribution, aggregated server-side           | `HistogramMetric` | Constant — one counter per configured bucket, regardless of volume.       |
| A distribution, with exact quantiles computed here | `SummaryMetric`   | Grows with every `observe()` — unbounded unless `maxAgeSeconds` bounds it to a rolling window. |

Some worked examples:

- **HTTP requests served** → `CounterMetric` (`requests_total`, labeled by
  `method`/`status`). It only goes up, and you'll graph it as a rate
  (`rate(requests_total[5m])`), not as a raw total.
- **Active WebSocket connections** → `GaugeMetric` (`ws_connections`).
  `inc()` on connect, `dec()` on disconnect — you need the current count,
  which can go down.
- **Process memory (RSS) sampled every 15s** → `GaugeMetric`. You already
  have the absolute value from `process.memoryUsage()`, so `set()` it
  directly rather than tracking deltas yourself.
- **HTTP request duration, exposed to Prometheus/Grafana** →
  `HistogramMetric` (`http_request_duration_seconds`, labeled by `route`).
  Aggregating percentiles across many instances only works with
  histograms — `histogram_quantile()` in PromQL needs the bucket counts,
  not pre-computed quantiles from each instance.
- **p99 latency read directly from a single process** (a CLI tool, a local
  dashboard, no PromQL aggregation involved) → `SummaryMetric`. You get
  the exact quantile with no bucket-boundary tuning; since there's one
  process, cross-instance aggregation isn't a concern.
- **Response latency, but only "the last 10 minutes" matters** (an admin
  panel showing "is the service healthy right now") → `SummaryMetric`
  with `maxAgeSeconds: 600`. A plain `SummaryMetric` would let an old
  incident's slow requests keep dragging down the quantiles long after
  they're resolved; `HistogramMetric` doesn't expose a window at all —
  each bucket count is cumulative for the metric's whole lifetime.
- **Payload size, high-volume, high-cardinality (per-tenant labels)** →
  `HistogramMetric`, not `SummaryMetric` — a `SummaryMetric` keeps every
  raw observation per series in memory, which doesn't scale when there
  are many series and many observations each.

## See also

- `src/utils/metric.ts` — implementation.
- `src/utils/metric.spec.ts` — the full spec suite, including every
  supported call syntax and the label-validation behavior described above.
