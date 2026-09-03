import { describe, expect, expectTypeOf, test } from "bun:test";
import { ConfigError } from "../errors";
import {
  CounterMetric,
  GaugeMetric,
  HistogramMetric,
  Metric,
  SummaryMetric,
  type CounterMetricSample,
  type GaugeMetricSample,
  type HistogramMetricSample,
  type SummaryMetricSample,
} from "./metric";

describe("Metric base class", () => {
  test("CounterMetric, GaugeMetric, HistogramMetric and SummaryMetric extend Metric", () => {
    expectTypeOf(new CounterMetric({ name: "c" })).toMatchTypeOf<Metric<unknown>>();
    expectTypeOf(new GaugeMetric({ name: "g" })).toMatchTypeOf<Metric<unknown>>();
    expectTypeOf(new HistogramMetric({ name: "h" })).toMatchTypeOf<Metric<unknown>>();
    expectTypeOf(new SummaryMetric({ name: "s" })).toMatchTypeOf<Metric<unknown>>();
  });

  test("throws when constructed without a name", () => {
    // @ts-expect-error - name is required
    expect(() => new CounterMetric({})).toThrow(ConfigError);
  });

  test("exposes name and help", () => {
    const counter = new CounterMetric({ name: "requests_total", help: "total requests" });
    expect(counter.name).toBe("requests_total");
    expect(counter.help).toBe("total requests");
  });

  test("help defaults to an empty string", () => {
    const counter = new CounterMetric({ name: "requests_total" });
    expect(counter.help).toBe("");
  });
});

describe("CounterMetric", () => {
  test("inc() — no args increments by 1, no labels", () => {
    const counter = new CounterMetric({ name: "hits" });
    counter.inc();
    counter.inc();
    expect(counter.get()).toBe(2);
  });

  test("inc(value) — increments by a custom amount, no labels", () => {
    const counter = new CounterMetric({ name: "hits" });
    counter.inc(5);
    counter.inc(3);
    expect(counter.get()).toBe(8);
  });

  test("inc(labels) — increments by 1 for a labeled series", () => {
    const counter = new CounterMetric({ name: "hits", labelNames: ["method"] });
    counter.inc({ method: "GET" });
    counter.inc({ method: "GET" });
    counter.inc({ method: "POST" });
    expect(counter.get({ method: "GET" })).toBe(2);
    expect(counter.get({ method: "POST" })).toBe(1);
  });

  test("inc(labels, value) — increments a labeled series by a custom amount", () => {
    const counter = new CounterMetric({ name: "hits", labelNames: ["method"] });
    counter.inc({ method: "GET" }, 5);
    counter.inc({ method: "GET" }, 2);
    expect(counter.get({ method: "GET" })).toBe(7);
  });

  test("get() with no args reads the unlabeled series", () => {
    const counter = new CounterMetric({ name: "hits" });
    expect(counter.get()).toBe(0);
  });

  test("get(labels) reads a series that was never inc()'d", () => {
    const counter = new CounterMetric({ name: "hits", labelNames: ["method"] });
    expect(counter.get({ method: "GET" })).toBe(0);
  });

  test("rejects a negative increment", () => {
    const counter = new CounterMetric({ name: "hits" });
    expect(() => counter.inc(-1)).toThrow(ConfigError);
    expect(() => counter.inc({}, -1)).toThrow(ConfigError);
  });

  test("rejects an unknown label", () => {
    const counter = new CounterMetric({ name: "hits", labelNames: ["method"] });
    expect(() => counter.inc({ path: "/x" })).toThrow(ConfigError);
  });

  test("rejects a missing required label", () => {
    const counter = new CounterMetric({ name: "hits", labelNames: ["method"] });
    expect(() => counter.inc({})).toThrow(ConfigError);
  });

  test("collect() reports every observed series", () => {
    const counter = new CounterMetric({ name: "hits", labelNames: ["method"] });
    counter.inc({ method: "GET" }, 2);
    counter.inc({ method: "POST" });
    expect(counter.collect()).toEqual(
      expect.arrayContaining([
        { labels: { method: "GET" }, value: 2 },
        { labels: { method: "POST" }, value: 1 },
      ]),
    );
  });

  test("reset() clears every series back to unrecorded", () => {
    const counter = new CounterMetric({ name: "hits" });
    counter.inc(10);
    counter.reset();
    expect(counter.collect()).toEqual([]);
    expect(counter.get()).toBe(0);
  });

  test("collect() return type matches CounterMetricSample[]", () => {
    const counter = new CounterMetric({ name: "hits" });
    expectTypeOf(counter.collect()).toEqualTypeOf<CounterMetricSample[]>();
  });
});

describe("GaugeMetric", () => {
  test("set(value) — sets the unlabeled series", () => {
    const gauge = new GaugeMetric({ name: "temp" });
    gauge.set(42);
    expect(gauge.get()).toBe(42);
    gauge.set(10);
    expect(gauge.get()).toBe(10);
  });

  test("set(labels, value) — sets a labeled series", () => {
    const gauge = new GaugeMetric({ name: "temp", labelNames: ["room"] });
    gauge.set({ room: "kitchen" }, 21);
    gauge.set({ room: "bedroom" }, 18);
    expect(gauge.get({ room: "kitchen" })).toBe(21);
    expect(gauge.get({ room: "bedroom" })).toBe(18);
  });

  test("set(labels) without a value throws", () => {
    const gauge = new GaugeMetric({ name: "temp" });
    // @ts-expect-error - value is required
    expect(() => gauge.set({})).toThrow(ConfigError);
  });

  test("inc() — no args increments by 1, no labels", () => {
    const gauge = new GaugeMetric({ name: "conns" });
    gauge.inc();
    gauge.inc();
    expect(gauge.get()).toBe(2);
  });

  test("inc(value) — increments by a custom amount, no labels", () => {
    const gauge = new GaugeMetric({ name: "conns" });
    gauge.inc(5);
    expect(gauge.get()).toBe(5);
  });

  test("inc(labels) — increments by 1 for a labeled series", () => {
    const gauge = new GaugeMetric({ name: "conns", labelNames: ["pool"] });
    gauge.inc({ pool: "db" });
    expect(gauge.get({ pool: "db" })).toBe(1);
  });

  test("inc(labels, value) — increments a labeled series by a custom amount", () => {
    const gauge = new GaugeMetric({ name: "conns", labelNames: ["pool"] });
    gauge.inc({ pool: "db" }, 4);
    expect(gauge.get({ pool: "db" })).toBe(4);
  });

  test("dec() — no args decrements by 1, no labels", () => {
    const gauge = new GaugeMetric({ name: "conns" });
    gauge.set(5);
    gauge.dec();
    expect(gauge.get()).toBe(4);
  });

  test("dec(value) — decrements by a custom amount, no labels", () => {
    const gauge = new GaugeMetric({ name: "conns" });
    gauge.set(10);
    gauge.dec(3);
    expect(gauge.get()).toBe(7);
  });

  test("dec(labels) — decrements by 1 for a labeled series", () => {
    const gauge = new GaugeMetric({ name: "conns", labelNames: ["pool"] });
    gauge.set({ pool: "db" }, 5);
    gauge.dec({ pool: "db" });
    expect(gauge.get({ pool: "db" })).toBe(4);
  });

  test("dec(labels, value) — decrements a labeled series by a custom amount", () => {
    const gauge = new GaugeMetric({ name: "conns", labelNames: ["pool"] });
    gauge.set({ pool: "db" }, 10);
    gauge.dec({ pool: "db" }, 6);
    expect(gauge.get({ pool: "db" })).toBe(4);
  });

  test("a gauge can go negative, unlike a counter", () => {
    const gauge = new GaugeMetric({ name: "delta" });
    gauge.dec(5);
    expect(gauge.get()).toBe(-5);
  });

  test("rejects an unknown label", () => {
    const gauge = new GaugeMetric({ name: "conns", labelNames: ["pool"] });
    expect(() => gauge.set({ region: "us" }, 1)).toThrow(ConfigError);
    expect(() => gauge.inc({ region: "us" })).toThrow(ConfigError);
    expect(() => gauge.dec({ region: "us" })).toThrow(ConfigError);
    expect(() => gauge.get({ region: "us" })).toThrow(ConfigError);
  });

  test("rejects a missing required label", () => {
    const gauge = new GaugeMetric({ name: "conns", labelNames: ["pool"] });
    expect(() => gauge.set({}, 1)).toThrow(ConfigError);
    expect(() => gauge.inc({})).toThrow(ConfigError);
  });

  test("collect() reports every observed series", () => {
    const gauge = new GaugeMetric({ name: "conns", labelNames: ["pool"] });
    gauge.set({ pool: "db" }, 3);
    expect(gauge.collect()).toEqual([{ labels: { pool: "db" }, value: 3 }]);
  });

  test("collect() return type matches GaugeMetricSample[]", () => {
    const gauge = new GaugeMetric({ name: "conns" });
    expectTypeOf(gauge.collect()).toEqualTypeOf<GaugeMetricSample[]>();
  });
});

describe("HistogramMetric", () => {
  test("observe(value) — records into the unlabeled series", () => {
    const histogram = new HistogramMetric({ name: "duration", buckets: [0.1, 0.5, 1] });
    histogram.observe(0.05);
    histogram.observe(0.3);
    histogram.observe(2);
    const snapshot = histogram.get();
    expect(snapshot.count).toBe(3);
    expect(snapshot.sum).toBeCloseTo(2.35);
  });

  test("observe(labels, value) — records into a labeled series", () => {
    const histogram = new HistogramMetric({
      name: "duration",
      buckets: [0.1, 0.5, 1],
      labelNames: ["route"],
    });
    histogram.observe({ route: "/a" }, 0.05);
    histogram.observe({ route: "/b" }, 0.9);
    expect(histogram.get({ route: "/a" }).count).toBe(1);
    expect(histogram.get({ route: "/b" }).count).toBe(1);
  });

  test("observe(labels) without a value throws", () => {
    const histogram = new HistogramMetric({ name: "duration" });
    // @ts-expect-error - value is required
    expect(() => histogram.observe({})).toThrow(ConfigError);
  });

  test("buckets are cumulative and always include +Infinity", () => {
    const histogram = new HistogramMetric({ name: "duration", buckets: [1, 5] });
    histogram.observe(0.5);
    histogram.observe(3);
    histogram.observe(10);
    const snapshot = histogram.get();
    expect(snapshot.buckets).toEqual([
      { le: 1, count: 1 },
      { le: 5, count: 2 },
      { le: Infinity, count: 3 },
    ]);
  });

  test("defaults to a standard bucket ladder when none is given", () => {
    const histogram = new HistogramMetric({ name: "duration" });
    expect(histogram.buckets[histogram.buckets.length - 1]).toBe(Infinity);
    expect(histogram.buckets.length).toBeGreaterThan(1);
  });

  test("de-duplicates and sorts unordered custom buckets", () => {
    const histogram = new HistogramMetric({ name: "duration", buckets: [5, 1, 5, 1] });
    expect(histogram.buckets).toEqual([1, 5, Infinity]);
  });

  test("rejects an empty bucket list", () => {
    expect(() => new HistogramMetric({ name: "duration", buckets: [] })).toThrow(ConfigError);
  });

  test("rejects an unknown label", () => {
    const histogram = new HistogramMetric({ name: "duration", labelNames: ["route"] });
    expect(() => histogram.observe({ status: "500" }, 1)).toThrow(ConfigError);
    expect(() => histogram.get({ status: "500" })).toThrow(ConfigError);
  });

  test("rejects a missing required label", () => {
    const histogram = new HistogramMetric({ name: "duration", labelNames: ["route"] });
    expect(() => histogram.observe({}, 1)).toThrow(ConfigError);
  });

  test("collect() reports every observed series", () => {
    const histogram = new HistogramMetric({
      name: "duration",
      buckets: [1],
      labelNames: ["route"],
    });
    histogram.observe({ route: "/a" }, 0.5);
    expect(histogram.collect()).toEqual([
      {
        labels: { route: "/a" },
        buckets: [
          { le: 1, count: 1 },
          { le: Infinity, count: 1 },
        ],
        sum: 0.5,
        count: 1,
      },
    ]);
  });

  test("collect() return type matches HistogramMetricSample[]", () => {
    const histogram = new HistogramMetric({ name: "duration" });
    expectTypeOf(histogram.collect()).toEqualTypeOf<HistogramMetricSample[]>();
  });
});

describe("SummaryMetric", () => {
  test("observe(value) — records into the unlabeled series", () => {
    const summary = new SummaryMetric({ name: "latency" });
    for (let i = 1; i <= 100; i++) summary.observe(i);
    const snapshot = summary.get();
    expect(snapshot.count).toBe(100);
    expect(snapshot.sum).toBe(5050);
  });

  test("observe(labels, value) — records into a labeled series", () => {
    const summary = new SummaryMetric({ name: "latency", labelNames: ["route"] });
    summary.observe({ route: "/a" }, 10);
    summary.observe({ route: "/b" }, 20);
    expect(summary.get({ route: "/a" }).count).toBe(1);
    expect(summary.get({ route: "/b" }).count).toBe(1);
  });

  test("observe(labels) without a value throws", () => {
    const summary = new SummaryMetric({ name: "latency" });
    // @ts-expect-error - value is required
    expect(() => summary.observe({})).toThrow(ConfigError);
  });

  test("computes the configured quantiles over observed values", () => {
    const summary = new SummaryMetric({ name: "latency", percentiles: [0.5, 0.99] });
    for (let i = 1; i <= 100; i++) summary.observe(i);
    const snapshot = summary.get();
    expect(snapshot.quantiles).toEqual([
      { quantile: 0.5, value: 50 },
      { quantile: 0.99, value: 99 },
    ]);
  });

  test("defaults to p50/p90/p99 when no percentiles are given", () => {
    const summary = new SummaryMetric({ name: "latency" });
    expect(summary.percentiles).toEqual([0.5, 0.9, 0.99]);
  });

  test("de-duplicates and sorts unordered custom percentiles", () => {
    const summary = new SummaryMetric({ name: "latency", percentiles: [0.99, 0.5, 0.99] });
    expect(summary.percentiles).toEqual([0.5, 0.99]);
  });

  test("rejects an empty percentile list", () => {
    expect(() => new SummaryMetric({ name: "latency", percentiles: [] })).toThrow(ConfigError);
  });

  test("rejects a percentile outside (0, 1]", () => {
    expect(() => new SummaryMetric({ name: "latency", percentiles: [0] })).toThrow(ConfigError);
    expect(() => new SummaryMetric({ name: "latency", percentiles: [1.5] })).toThrow(ConfigError);
  });

  test("rejects an unknown label", () => {
    const summary = new SummaryMetric({ name: "latency", labelNames: ["route"] });
    expect(() => summary.observe({ status: "500" }, 1)).toThrow(ConfigError);
    expect(() => summary.get({ status: "500" })).toThrow(ConfigError);
  });

  test("rejects a missing required label", () => {
    const summary = new SummaryMetric({ name: "latency", labelNames: ["route"] });
    expect(() => summary.observe({}, 1)).toThrow(ConfigError);
  });

  test("an unobserved series reports zeroed quantiles", () => {
    const summary = new SummaryMetric({ name: "latency", percentiles: [0.5] });
    expect(summary.get()).toEqual({ quantiles: [{ quantile: 0.5, value: 0 }], sum: 0, count: 0 });
  });

  test("collect() reports every observed series", () => {
    const summary = new SummaryMetric({
      name: "latency",
      percentiles: [0.5],
      labelNames: ["route"],
    });
    summary.observe({ route: "/a" }, 10);
    expect(summary.collect()).toEqual([
      { labels: { route: "/a" }, quantiles: [{ quantile: 0.5, value: 10 }], sum: 10, count: 1 },
    ]);
  });

  test("collect() return type matches SummaryMetricSample[]", () => {
    const summary = new SummaryMetric({ name: "latency" });
    expectTypeOf(summary.collect()).toEqualTypeOf<SummaryMetricSample[]>();
  });
});

describe("SummaryMetric sliding window (maxAgeSeconds/ageBuckets)", () => {
  function fakeClock(startMs = 0) {
    let now = startMs;
    return { clock: () => now, advance: (ms: number) => (now += ms) };
  }

  test("without maxAgeSeconds, defaults to a single never-rotating bucket", () => {
    const summary = new SummaryMetric({ name: "latency" });
    expect(summary.maxAgeSeconds).toBe(Infinity);
    expect(summary.ageBuckets).toBe(1);
  });

  test("ageBuckets defaults to 5 when only maxAgeSeconds is given", () => {
    const summary = new SummaryMetric({ name: "latency", maxAgeSeconds: 60 });
    expect(summary.ageBuckets).toBe(5);
  });

  test("ageBuckets without maxAgeSeconds throws", () => {
    expect(() => new SummaryMetric({ name: "latency", ageBuckets: 3 })).toThrow(ConfigError);
  });

  test("rejects a non-positive or non-finite maxAgeSeconds", () => {
    expect(() => new SummaryMetric({ name: "latency", maxAgeSeconds: 0 })).toThrow(ConfigError);
    expect(() => new SummaryMetric({ name: "latency", maxAgeSeconds: -1 })).toThrow(ConfigError);
    expect(() => new SummaryMetric({ name: "latency", maxAgeSeconds: Infinity })).toThrow(
      ConfigError,
    );
  });

  test("rejects a non-integer or non-positive ageBuckets", () => {
    expect(
      () => new SummaryMetric({ name: "latency", maxAgeSeconds: 60, ageBuckets: 0 }),
    ).toThrow(ConfigError);
    expect(
      () => new SummaryMetric({ name: "latency", maxAgeSeconds: 60, ageBuckets: 2.5 }),
    ).toThrow(ConfigError);
  });

  test("without maxAgeSeconds, old observations are never evicted regardless of time passed", () => {
    const { clock, advance } = fakeClock();
    const summary = new SummaryMetric({ name: "latency", clock });
    summary.observe(1);
    advance(365 * 24 * 60 * 60 * 1000);
    summary.observe(2);
    expect(summary.get().count).toBe(2);
  });

  test("evicts a single bucket once its slice of the window elapses", () => {
    // maxAgeSeconds=10, ageBuckets=5 -> each bucket covers 2s (2000ms).
    const { clock, advance } = fakeClock();
    const summary = new SummaryMetric({
      name: "latency",
      maxAgeSeconds: 10,
      ageBuckets: 5,
      clock,
    });
    summary.observe(1);
    expect(summary.get().count).toBe(1);

    advance(2000);
    summary.observe(2);
    expect(summary.get().count).toBe(2);

    // Advancing a further 8s (4 more bucket-widths) rotates out the first
    // observation's bucket, leaving only the second one's.
    advance(8000);
    expect(summary.get().count).toBe(1);
    expect(summary.get().quantiles[0]?.value).toBe(2);
  });

  test("advancing past the full window clears every bucket", () => {
    const { clock, advance } = fakeClock();
    const summary = new SummaryMetric({
      name: "latency",
      maxAgeSeconds: 10,
      ageBuckets: 5,
      clock,
    });
    summary.observe(1);
    summary.observe(2);
    advance(100_000);
    expect(summary.get()).toEqual({
      quantiles: [
        { quantile: 0.5, value: 0 },
        { quantile: 0.9, value: 0 },
        { quantile: 0.99, value: 0 },
      ],
      sum: 0,
      count: 0,
    });
  });

  test("each label gets its own independently rotating window", () => {
    const { clock, advance } = fakeClock();
    const summary = new SummaryMetric({
      name: "latency",
      maxAgeSeconds: 10,
      ageBuckets: 5,
      labelNames: ["route"],
      clock,
    });
    summary.observe({ route: "/a" }, 1);
    advance(8000);
    summary.observe({ route: "/b" }, 2);
    expect(summary.get({ route: "/a" }).count).toBe(1);
    expect(summary.get({ route: "/b" }).count).toBe(1);
  });

  test("collect() reflects the current window per series", () => {
    const { clock, advance } = fakeClock();
    const summary = new SummaryMetric({
      name: "latency",
      maxAgeSeconds: 10,
      ageBuckets: 5,
      percentiles: [0.5],
      clock,
    });
    summary.observe(1);
    advance(10_000);
    summary.observe(3);
    expect(summary.collect()).toEqual([
      { labels: {}, quantiles: [{ quantile: 0.5, value: 3 }], sum: 3, count: 1 },
    ]);
  });
});

describe("reset() across all metric types", () => {
  test("CounterMetric.reset() clears every series", () => {
    const counter = new CounterMetric({ name: "m" });
    counter.inc(5);
    counter.reset();
    expect(counter.collect()).toEqual([]);
  });

  test("GaugeMetric.reset() clears every series", () => {
    const gauge = new GaugeMetric({ name: "m" });
    gauge.set(5);
    gauge.reset();
    expect(gauge.collect()).toEqual([]);
  });

  test("HistogramMetric.reset() clears every series", () => {
    const histogram = new HistogramMetric({ name: "m" });
    histogram.observe(5);
    histogram.reset();
    expect(histogram.collect()).toEqual([]);
  });

  test("SummaryMetric.reset() clears every series", () => {
    const summary = new SummaryMetric({ name: "m" });
    summary.observe(5);
    summary.reset();
    expect(summary.collect()).toEqual([]);
  });
});
