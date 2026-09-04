import { describe, expect, spyOn, test } from "bun:test";
import type { CounterMetric, HistogramMetric } from "../utils/metric";
import { shellSource } from "./shell";

const bun = process.execPath;

describe("shellSource", () => {
  test("runs args and parses stdout as JSON", async () => {
    const source = shellSource<{ port: number }>([
      bun,
      "-e",
      "console.log(JSON.stringify({ port: 3000 }))",
    ]);
    const store = await source.open();

    expect(store.get()).toEqual({ port: 3000 });
  });

  test("uses a custom stdoutParser instead of the default JSON parsing", async () => {
    const source = shellSource<string>([bun, "-e", "console.log('hello')"], {
      stdoutParser: (stdout) => stdout.trim(),
    });
    const store = await source.open();

    expect(store.get()).toBe("hello");
  });

  test("selects a subtree via treePath", async () => {
    const source = shellSource<{ port: number }>(
      [bun, "-e", "console.log(JSON.stringify({ containers: { settings: { port: 3000 } } }))"],
      { treePath: ["containers", "settings"] },
    );
    const store = await source.open();

    expect(store.get()).toEqual({ port: 3000 });
  });

  test("logs and leaves the store empty when the process exits non-zero", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const source = shellSource([bun, "-e", "process.exit(1)"]);
    const store = await source.open();

    expect(store.get()).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test("logs and leaves the store empty when stdout fails to parse", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const source = shellSource([bun, "-e", "console.log('not json')"]);
    const store = await source.open();

    expect(store.get()).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test("keeps re-running on pollingInterval, updating the store each time", async () => {
    const source = shellSource<{ now: number }>(
      [bun, "-e", "console.log(JSON.stringify({ now: Date.now() }))"],
      { pollingInterval: 20 },
    );
    const store = await source.open();
    const first = store.get();

    await Bun.sleep(80);

    expect(store.get()).not.toEqual(first);

    await source.close();
  });

  test("close() stops the polling", async () => {
    const source = shellSource<{ now: number }>(
      [bun, "-e", "console.log(JSON.stringify({ now: Date.now() }))"],
      { pollingInterval: 10 },
    );
    await source.open();
    await source.close();
    const valueAfterClose = source.metrics.runs as CounterMetric;
    const countAfterClose = valueAfterClose.get({ ok: "true" });

    await Bun.sleep(50);

    expect(valueAfterClose.get({ ok: "true" })).toBe(countAfterClose);
  });

  describe("metrics", () => {
    test("bumps runs and duration, labeled ok=true, on a successful round", async () => {
      const source = shellSource([bun, "-e", "console.log(JSON.stringify({ ok: true }))"]);
      await source.open();
      const runs = source.metrics.runs as CounterMetric;
      const duration = source.metrics.duration as HistogramMetric;

      expect(runs.get({ ok: "true" })).toBe(1);
      expect(runs.get({ ok: "false" })).toBe(0);
      expect(duration.get({ ok: "true" }).count).toBe(1);
    });

    test("bumps runs, labeled ok=false, when the process exits non-zero", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});

      const source = shellSource([bun, "-e", "process.exit(1)"]);
      await source.open();
      const runs = source.metrics.runs as CounterMetric;

      expect(runs.get({ ok: "false" })).toBe(1);
      expect(runs.get({ ok: "true" })).toBe(0);
      errorSpy.mockRestore();
    });
  });
});
