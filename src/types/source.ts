import type { Metric } from "../utils/metric.js";

/** Passed to `start()`, mirroring a `ReadableStreamDefaultController`. */
export interface SourceControl<T> {
  /**
   * Every field path this source is being opened for, e.g. `[["server", "port"], ["HOST"]]` for
   * `create({ server: { port: numeric() }, host: string({ key: "HOST" }) })` — the same paths
   * `create()` itself resolves each field against (a field's explicit `key`, or its position in
   * the shape tree). Known up front because `create()` computes the whole shape's field paths
   * before opening any of its `options.sources`, so `start()` can read `control.keys` to decide
   * what to fetch/subscribe to instead of always pulling everything. Empty when the source is
   * opened directly (`source.open()`, with no `create()` shape behind it).
   */
  keys: string[][];
  /** Publishes a new full-tree snapshot. */
  set(value: T): void;
  /** Marks the source as done; no further `set()` calls are expected. */
  close(): void;
}

/** The object passed to `new Source(...)`, mirroring an `UnderlyingSource` for `ReadableStream`. */
export interface UnderlyingSource<T> {
  start(control: SourceControl<T>): void | Promise<void>;
  close?(): void | Promise<void>;
  /**
   * When present, every `control.set(incoming)` call runs `incoming` through `reduce` (along with
   * the last published value, `null` before the first `set()`) instead of publishing it as-is —
   * so a source that only ever hands `start()` a partial patch, like an SSE message, can publish
   * the merged result without keeping its own accumulator variable around.
   */
  reduce?(incoming: T, previous: T | null): T;
  /**
   * Metrics this source records — e.g. a `CounterMetric` of fetch attempts or a `HistogramMetric`
   * of round durations, bumped from inside `start()`/`close()`. Exposed as-is on the resulting
   * `Source` via its own `metrics` property, so callers can read or export them (e.g. to a
   * Prometheus endpoint) without reaching into the source's internals.
   */
  metrics?: Record<string, Metric>;
}
