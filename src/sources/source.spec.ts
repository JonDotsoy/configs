import { describe, expect, test } from "bun:test";
import { CounterMetric } from "../utils/metric";
import { Source } from "./source";

describe("Source reduce", () => {
  test("publishes control.set(value) as-is when no reduce is given", async () => {
    const source = new Source<number>({
      start(control) {
        control.set(1);
        control.close();
      },
    });
    const store = await source.open();

    expect(store.get()).toBe(1);
  });

  test("runs every control.set(incoming) through reduce before publishing it", async () => {
    const source = new Source<number>({
      start(control) {
        control.set(1);
        control.set(2);
        control.set(3);
        control.close();
      },
      reduce: (incoming, previous) => (previous ?? 0) + incoming,
    });
    const store = await source.open();

    expect(store.get()).toBe(6);
  });

  test("passes null as previous on the first control.set() call", async () => {
    const previousValues: (number | null)[] = [];
    const source = new Source<number>({
      start(control) {
        control.set(1);
        control.set(2);
        control.close();
      },
      reduce: (incoming, previous) => {
        previousValues.push(previous);
        return incoming;
      },
    });
    await source.open();

    expect(previousValues).toEqual([null, 1]);
  });

  test("merges a partial patch onto the accumulated value, like sseSource does", async () => {
    const source = new Source<Record<string, unknown>>({
      start(control) {
        control.set({ port: 3000 });
        control.set({ host: "localhost" });
        control.close();
      },
      reduce: (patch, previous) => ({ ...(previous ?? {}), ...patch }),
    });
    const store = await source.open();

    expect(store.get()).toEqual({ port: 3000, host: "localhost" });
  });
});

describe("Source keys", () => {
  test("defaults to [] when open() is called with no keys", async () => {
    let received: string[][] | undefined;
    const source = new Source<number>({
      start(control) {
        received = control.keys;
        control.set(1);
        control.close();
      },
    });
    await source.open();

    expect(received).toEqual([]);
  });

  test("open(keys) hands the same keys to control.keys inside start()", async () => {
    let received: string[][] | undefined;
    const source = new Source<number>({
      start(control) {
        received = control.keys;
        control.set(1);
        control.close();
      },
    });
    await source.open([["server", "port"], ["HOST"]]);

    expect(received).toEqual([["server", "port"], ["HOST"]]);
  });

  test("start() only runs once open() is first called, not at construction", async () => {
    let started = false;
    const source = new Source<number>({
      start(control) {
        started = true;
        control.set(1);
        control.close();
      },
    });

    // Give any eagerly-scheduled microtask a chance to run before open() is ever called.
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toBe(false);

    await source.open();
    expect(started).toBe(true);
  });
});

describe("Source metrics", () => {
  test("defaults to an empty object when no metrics are given", () => {
    const source = new Source<number>({
      start(control) {
        control.set(1);
        control.close();
      },
    });

    expect(source.metrics).toEqual({});
  });

  test("exposes the metrics passed to the constructor", () => {
    const rounds = new CounterMetric({ name: "rounds_total" });
    const source = new Source<number>({
      metrics: { rounds },
      start(control) {
        rounds.inc();
        control.set(1);
        control.close();
      },
    });

    expect(source.metrics.rounds).toBe(rounds);
  });

  test("start() can bump a metric through `this.metrics`, reachable via the underlying object", async () => {
    const rounds = new CounterMetric({ name: "rounds_total" });
    const source = new Source<number>({
      metrics: { rounds },
      start(control) {
        (this.metrics?.rounds as CounterMetric | undefined)?.inc();
        control.set(1);
        control.close();
      },
    });
    await source.open();

    expect(rounds.get()).toBe(1);
  });
});
