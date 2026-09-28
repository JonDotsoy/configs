import { describe, expect, spyOn, test } from "bun:test";
import { realpathSync } from "node:fs";
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

  test("runs the process in cwd, when given", async () => {
    const source = shellSource<string>([bun, "-e", "console.log(JSON.stringify(process.cwd()))"], {
      cwd: "/tmp",
    });
    const store = await source.open();

    expect(realpathSync(store.get()!)).toBe(realpathSync("/tmp"));
  });

  test("passes env through to the spawned process", async () => {
    const source = shellSource<{ value: string | undefined }>(
      [bun, "-e", "console.log(JSON.stringify({ value: process.env.SHELL_SOURCE_TEST_VAR }))"],
      { env: { ...process.env, SHELL_SOURCE_TEST_VAR: "from-shell-source" } },
    );
    const store = await source.open();

    expect(store.get()).toEqual({ value: "from-shell-source" });
  });

  test("a custom acceptExitCode accepts a nonstandard exit code as success", async () => {
    const source = shellSource<{ port: number }>(
      [bun, "-e", "console.log(JSON.stringify({ port: 3000 })); process.exit(2)"],
      { acceptExitCode: (exitCode) => exitCode === 2 },
    );
    const store = await source.open();

    expect(store.get()).toEqual({ port: 3000 });
  });

  test("masks a sensitive flag's value in the console.error log for a failed run", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const source = shellSource([bun, "-e", "process.exit(1)", "--api-key", "s3cr3t-value"]);
    await source.open();

    const logged = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).toContain("****");
    expect(logged).not.toContain("s3cr3t-value");
    errorSpy.mockRestore();
  });

  test("a custom acceptExitCode rejects an exit code the default would accept", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const source = shellSource([bun, "-e", "console.log(JSON.stringify({ port: 3000 }))"], {
      acceptExitCode: () => false,
    });
    const store = await source.open();

    expect(store.get()).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test("signal aborts the in-flight run", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const controller = new AbortController();

    const source = shellSource([bun, "-e", "setTimeout(() => console.log('{}'), 2000)"], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    const store = await source.open();

    expect(store.get()).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  describe("onRun", () => {
    test("is called once, with the round's outcome, on a successful run", async () => {
      const events: unknown[] = [];
      const source = shellSource<{ port: number }>([bun, "-e", "console.log(JSON.stringify({ port: 3000 }))"], {
        onRun: (event) => events.push(event),
      });
      await source.open();

      expect(events).toHaveLength(1);
      const [event] = events as [{ ok: boolean; exitCode?: number; durationMs: number }];
      expect(event.ok).toBe(true);
      expect(event.exitCode).toBe(0);
      expect(typeof event.durationMs).toBe("number");
    });

    test("is called with ok: false and the failing exitCode when the process exits non-zero", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const events: { ok: boolean; exitCode?: number }[] = [];

      const source = shellSource([bun, "-e", "process.exit(1)"], {
        onRun: (event) => events.push(event),
      });
      await source.open();

      expect(events).toHaveLength(1);
      expect(events[0]!.ok).toBe(false);
      errorSpy.mockRestore();
    });

    test("is called once per round when polling", async () => {
      const events: unknown[] = [];
      const source = shellSource<{ now: number }>(
        [bun, "-e", "console.log(JSON.stringify({ now: Date.now() }))"],
        { pollingInterval: 20, onRun: (event) => events.push(event) },
      );
      await source.open();

      await Bun.sleep(50);
      await source.close();

      expect(events.length).toBeGreaterThan(1);
    });
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
