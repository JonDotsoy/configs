import { ConfigError } from "../errors.js";

export type MetricLabels = Record<string, string>;

export interface MetricOptions {
  name: string;
  help?: string;
  labelNames?: readonly string[];
}

export interface HistogramMetricOptions extends MetricOptions {
  buckets?: readonly number[];
}

export interface SummaryMetricOptions extends MetricOptions {
  percentiles?: readonly number[];
  /**
   * Sliding window: only observations from the last `maxAgeSeconds` count
   * toward `get()`/`collect()` (quantiles, sum, count). Omit to keep every
   * observation for the metric's lifetime instead, until `reset()`.
   */
  maxAgeSeconds?: number;
  /**
   * How many slices the sliding window is split into. Higher means eviction
   * is smoother (closer to a true rolling window) at the cost of more
   * memory; lower is coarser. Defaults to 5 when `maxAgeSeconds` is set —
   * only meaningful together with it.
   */
  ageBuckets?: number;
  /** @internal Clock override, for deterministic window-rotation tests. */
  clock?: () => number;
}

export interface CounterMetricSample {
  labels: MetricLabels;
  value: number;
}

export interface GaugeMetricSample {
  labels: MetricLabels;
  value: number;
}

export interface HistogramMetricSample {
  labels: MetricLabels;
  buckets: { le: number; count: number }[];
  sum: number;
  count: number;
}

export interface SummaryMetricSample {
  labels: MetricLabels;
  quantiles: { quantile: number; value: number }[];
  sum: number;
  count: number;
}

const DEFAULT_HISTOGRAM_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];
const DEFAULT_SUMMARY_PERCENTILES: readonly number[] = [0.5, 0.9, 0.99];

function assertKnownLabels(
  labels: MetricLabels,
  labelNames: readonly string[],
  metricName: string,
): void {
  const allowed = new Set(labelNames);
  for (const key of Object.keys(labels)) {
    if (!allowed.has(key)) {
      throw new ConfigError(`Metric "${metricName}": unknown label "${key}"`);
    }
  }
  for (const name of labelNames) {
    if (!(name in labels)) {
      throw new ConfigError(`Metric "${metricName}": missing label "${name}"`);
    }
  }
}

function labelsKey(labels: MetricLabels, labelNames: readonly string[]): string {
  return labelNames.map((name) => `${name}=${JSON.stringify(labels[name])}`).join(",");
}

/**
 * Splits the two loosely-typed positional args every mutator method accepts
 * (`(value?)`, `(labels?)`, `(labels?, value?)`) into a normalized pair, so
 * each metric only has to handle one shape.
 */
function normalizeArgs(
  a: number | MetricLabels | undefined,
  b: number | undefined,
  defaultValue: number,
): [MetricLabels, number] {
  if (typeof a === "number") return [{}, a];
  if (a && typeof a === "object") return [a, b ?? defaultValue];
  return [{}, defaultValue];
}

interface Series<TState> {
  labels: MetricLabels;
  state: TState;
}

export abstract class Metric<TState = unknown> {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];
  protected readonly series = new Map<string, Series<TState>>();

  constructor(options: MetricOptions) {
    if (!options.name) {
      throw new ConfigError('Metric: "name" is required');
    }
    this.name = options.name;
    this.help = options.help ?? "";
    this.labelNames = options.labelNames ?? [];
  }

  protected abstract initialState(): TState;

  protected resolveSeries(labels: MetricLabels): Series<TState> {
    assertKnownLabels(labels, this.labelNames, this.name);
    const key = labelsKey(labels, this.labelNames);
    let entry = this.series.get(key);
    if (!entry) {
      entry = { labels, state: this.initialState() };
      this.series.set(key, entry);
    }
    return entry;
  }

  /** Drops every recorded series (all label combinations), back to a fresh metric. */
  reset(): void {
    this.series.clear();
  }
}

/**
 * A value that only ever goes up (or resets to zero on process restart) —
 * requests served, errors raised, jobs completed.
 *
 * Supported call syntaxes:
 * ```ts
 * counter.inc();                          // +1, no labels
 * counter.inc(5);                         // +5, no labels
 * counter.inc({ method: "GET" });         // +1, labeled
 * counter.inc({ method: "GET" }, 5);      // +5, labeled
 * ```
 */
export class CounterMetric extends Metric<{ value: number }> {
  protected initialState(): { value: number } {
    return { value: 0 };
  }

  inc(): void;
  inc(value: number): void;
  inc(labels: MetricLabels): void;
  inc(labels: MetricLabels, value: number): void;
  inc(a?: number | MetricLabels, b?: number): void {
    const [labels, value] = normalizeArgs(a, b, 1);
    if (value < 0) {
      throw new ConfigError(`CounterMetric "${this.name}": cannot decrement by ${value}`);
    }
    this.resolveSeries(labels).state.value += value;
  }

  get(): number;
  get(labels: MetricLabels): number;
  get(labels: MetricLabels = {}): number {
    return this.resolveSeries(labels).state.value;
  }

  collect(): CounterMetricSample[] {
    return [...this.series.values()].map((entry) => ({
      labels: entry.labels,
      value: entry.state.value,
    }));
  }
}

/**
 * A value that can go up or down — connections open, queue depth, memory used.
 *
 * Supported call syntaxes:
 * ```ts
 * gauge.set(42);                          // = 42, no labels
 * gauge.set({ queue: "emails" }, 42);     // = 42, labeled
 * gauge.inc();                            // +1, no labels
 * gauge.inc(5);                           // +5, no labels
 * gauge.inc({ queue: "emails" });         // +1, labeled
 * gauge.inc({ queue: "emails" }, 5);      // +5, labeled
 * gauge.dec();                            // -1, no labels
 * gauge.dec(5);                           // -5, no labels
 * gauge.dec({ queue: "emails" });         // -1, labeled
 * gauge.dec({ queue: "emails" }, 5);      // -5, labeled
 * ```
 */
export class GaugeMetric extends Metric<{ value: number }> {
  protected initialState(): { value: number } {
    return { value: 0 };
  }

  set(value: number): void;
  set(labels: MetricLabels, value: number): void;
  set(a: number | MetricLabels, b?: number): void {
    if (typeof a === "number") {
      this.resolveSeries({}).state.value = a;
      return;
    }
    if (b === undefined) {
      throw new ConfigError(`GaugeMetric "${this.name}": set() requires a value`);
    }
    this.resolveSeries(a).state.value = b;
  }

  inc(): void;
  inc(value: number): void;
  inc(labels: MetricLabels): void;
  inc(labels: MetricLabels, value: number): void;
  inc(a?: number | MetricLabels, b?: number): void {
    const [labels, value] = normalizeArgs(a, b, 1);
    this.resolveSeries(labels).state.value += value;
  }

  dec(): void;
  dec(value: number): void;
  dec(labels: MetricLabels): void;
  dec(labels: MetricLabels, value: number): void;
  dec(a?: number | MetricLabels, b?: number): void {
    const [labels, value] = normalizeArgs(a, b, 1);
    this.resolveSeries(labels).state.value -= value;
  }

  get(): number;
  get(labels: MetricLabels): number;
  get(labels: MetricLabels = {}): number {
    return this.resolveSeries(labels).state.value;
  }

  collect(): GaugeMetricSample[] {
    return [...this.series.values()].map((entry) => ({
      labels: entry.labels,
      value: entry.state.value,
    }));
  }
}

interface HistogramState {
  bucketCounts: number[];
  sum: number;
  count: number;
}

/**
 * Distribution of observed values into cumulative buckets — request
 * durations, payload sizes.
 *
 * Supported call syntaxes:
 * ```ts
 * histogram.observe(0.42);                        // no labels
 * histogram.observe({ route: "/health" }, 0.42);   // labeled
 * ```
 */
export class HistogramMetric extends Metric<HistogramState> {
  readonly buckets: readonly number[];

  constructor(options: HistogramMetricOptions) {
    super(options);
    const configured = options.buckets ?? DEFAULT_HISTOGRAM_BUCKETS;
    if (configured.length === 0) {
      throw new ConfigError(`HistogramMetric "${this.name}": "buckets" must not be empty`);
    }
    const sorted = [...new Set(configured)].sort((a, b) => a - b);
    this.buckets = sorted[sorted.length - 1] === Infinity ? sorted : [...sorted, Infinity];
  }

  protected initialState(): HistogramState {
    return { bucketCounts: this.buckets.map(() => 0), sum: 0, count: 0 };
  }

  observe(value: number): void;
  observe(labels: MetricLabels, value: number): void;
  observe(a: number | MetricLabels, b?: number): void {
    const [labels, value] = normalizeObserveArgs(a, b, this.name);
    const state = this.resolveSeries(labels).state;
    this.buckets.forEach((le, i) => {
      if (value <= le) state.bucketCounts[i] = (state.bucketCounts[i] ?? 0) + 1;
    });
    state.sum += value;
    state.count += 1;
  }

  get(): { buckets: { le: number; count: number }[]; sum: number; count: number };
  get(
    labels: MetricLabels,
  ): { buckets: { le: number; count: number }[]; sum: number; count: number };
  get(labels: MetricLabels = {}) {
    const state = this.resolveSeries(labels).state;
    return {
      buckets: this.buckets.map((le, i) => ({ le, count: state.bucketCounts[i] ?? 0 })),
      sum: state.sum,
      count: state.count,
    };
  }

  collect(): HistogramMetricSample[] {
    return [...this.series.values()].map((entry) => ({
      labels: entry.labels,
      buckets: this.buckets.map((le, i) => ({ le, count: entry.state.bucketCounts[i] ?? 0 })),
      sum: entry.state.sum,
      count: entry.state.count,
    }));
  }
}

interface SummaryBucket {
  values: number[];
  sum: number;
  count: number;
}

function createSummaryBucket(): SummaryBucket {
  return { values: [], sum: 0, count: 0 };
}

interface SummaryState {
  /** Ring buffer of `ageBuckets` slices; only rotated when `maxAgeSeconds` is finite. */
  buckets: SummaryBucket[];
  currentIndex: number;
  lastRotateAt: number;
}

function quantileOf(sortedValues: number[], quantile: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.ceil(quantile * sortedValues.length) - 1,
  );
  return sortedValues[Math.max(0, index)] ?? 0;
}

function requireValue(value: number | undefined, method: string, metricName: string): number {
  if (value === undefined) {
    throw new ConfigError(`Metric "${metricName}": ${method}() requires a value`);
  }
  return value;
}

function normalizeObserveArgs(
  a: number | MetricLabels,
  b: number | undefined,
  metricName: string,
): [MetricLabels, number] {
  if (typeof a === "number") return [{}, a];
  return [a, requireValue(b, "observe", metricName)];
}

/**
 * Like `HistogramMetric`, but reports client-side quantiles over the raw
 * observed values instead of fixed buckets — response-time p50/p90/p99.
 *
 * Supported call syntaxes:
 * ```ts
 * summary.observe(0.42);                        // no labels
 * summary.observe({ route: "/health" }, 0.42);   // labeled
 * ```
 *
 * Without `maxAgeSeconds`, every observation is kept for the metric's
 * lifetime (until `reset()`) — quantiles reflect the entire history. With
 * `maxAgeSeconds` set, only observations from that trailing window count;
 * older ones are evicted in `ageBuckets` slices as time passes.
 */
export class SummaryMetric extends Metric<SummaryState> {
  readonly percentiles: readonly number[];
  readonly maxAgeSeconds: number;
  readonly ageBuckets: number;
  private readonly bucketDurationMs: number;
  private readonly clock: () => number;

  constructor(options: SummaryMetricOptions) {
    super(options);
    const percentiles = options.percentiles ?? DEFAULT_SUMMARY_PERCENTILES;
    if (percentiles.length === 0) {
      throw new ConfigError(`SummaryMetric "${this.name}": "percentiles" must not be empty`);
    }
    for (const p of percentiles) {
      if (p <= 0 || p > 1) {
        throw new ConfigError(
          `SummaryMetric "${this.name}": percentile ${p} must be in the range (0, 1]`,
        );
      }
    }
    this.percentiles = [...new Set(percentiles)].sort((a, b) => a - b);

    if (options.ageBuckets !== undefined && options.maxAgeSeconds === undefined) {
      throw new ConfigError(
        `SummaryMetric "${this.name}": "ageBuckets" requires "maxAgeSeconds" to also be set`,
      );
    }
    if (
      options.maxAgeSeconds !== undefined &&
      (!Number.isFinite(options.maxAgeSeconds) || options.maxAgeSeconds <= 0)
    ) {
      throw new ConfigError(
        `SummaryMetric "${this.name}": "maxAgeSeconds" must be a finite number > 0`,
      );
    }
    const ageBuckets = options.ageBuckets ?? (options.maxAgeSeconds !== undefined ? 5 : 1);
    if (!Number.isInteger(ageBuckets) || ageBuckets < 1) {
      throw new ConfigError(`SummaryMetric "${this.name}": "ageBuckets" must be an integer >= 1`);
    }
    this.maxAgeSeconds = options.maxAgeSeconds ?? Infinity;
    this.ageBuckets = ageBuckets;
    this.bucketDurationMs = (this.maxAgeSeconds * 1000) / ageBuckets;
    this.clock = options.clock ?? Date.now;
  }

  protected initialState(): SummaryState {
    return {
      buckets: Array.from({ length: this.ageBuckets }, createSummaryBucket),
      currentIndex: 0,
      lastRotateAt: this.clock(),
    };
  }

  /** Evicts buckets that have aged out of the sliding window, if `maxAgeSeconds` is finite. */
  private rotate(state: SummaryState): void {
    if (this.maxAgeSeconds === Infinity) return;
    const now = this.clock();
    const elapsed = now - state.lastRotateAt;
    if (elapsed < this.bucketDurationMs) return;
    const steps = Math.min(this.ageBuckets, Math.floor(elapsed / this.bucketDurationMs));
    for (let i = 0; i < steps; i++) {
      state.currentIndex = (state.currentIndex + 1) % this.ageBuckets;
      state.buckets[state.currentIndex] = createSummaryBucket();
    }
    state.lastRotateAt = steps === this.ageBuckets ? now : state.lastRotateAt + steps * this.bucketDurationMs;
  }

  observe(value: number): void;
  observe(labels: MetricLabels, value: number): void;
  observe(a: number | MetricLabels, b?: number): void {
    const [labels, value] = normalizeObserveArgs(a, b, this.name);
    const state = this.resolveSeries(labels).state;
    this.rotate(state);
    const bucket = state.buckets[state.currentIndex] ?? createSummaryBucket();
    state.buckets[state.currentIndex] = bucket;
    bucket.values.push(value);
    bucket.sum += value;
    bucket.count += 1;
  }

  /** Rotates, then folds every active bucket into one combined view of the current window. */
  private windowSnapshot(state: SummaryState): { values: number[]; sum: number; count: number } {
    this.rotate(state);
    const values: number[] = [];
    let sum = 0;
    let count = 0;
    for (const bucket of state.buckets) {
      values.push(...bucket.values);
      sum += bucket.sum;
      count += bucket.count;
    }
    return { values, sum, count };
  }

  get(): { quantiles: { quantile: number; value: number }[]; sum: number; count: number };
  get(
    labels: MetricLabels,
  ): { quantiles: { quantile: number; value: number }[]; sum: number; count: number };
  get(labels: MetricLabels = {}) {
    const state = this.resolveSeries(labels).state;
    const { values, sum, count } = this.windowSnapshot(state);
    const sorted = values.sort((a, b) => a - b);
    return {
      quantiles: this.percentiles.map((quantile) => ({
        quantile,
        value: quantileOf(sorted, quantile),
      })),
      sum,
      count,
    };
  }

  collect(): SummaryMetricSample[] {
    return [...this.series.values()].map((entry) => {
      const { values, sum, count } = this.windowSnapshot(entry.state);
      const sorted = values.sort((a, b) => a - b);
      return {
        labels: entry.labels,
        quantiles: this.percentiles.map((quantile) => ({
          quantile,
          value: quantileOf(sorted, quantile),
        })),
        sum,
        count,
      };
    });
  }
}
