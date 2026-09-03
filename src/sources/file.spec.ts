import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { configs } from "../configs";
import type { CounterMetric, HistogramMetric } from "../utils/metric";
import { fileSource } from "./file";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "configs-file-source-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Waits for `predicate()` to become true, polling every few ms — for a live fs.watch() update to land. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("fileSource", () => {
  describe("format detection", () => {
    test("parses a .json file", async () => {
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ port: 3000, host: "localhost" }));

      const source = fileSource(path, { watch: false });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000, host: "localhost" });
    });

    test("accepts a file: URL for the path", async () => {
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ port: 3000, host: "localhost" }));

      const source = fileSource(pathToFileURL(path), { watch: false });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000, host: "localhost" });
    });

    test("parses a nested .json file", async () => {
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ server: { port: 3000 } }));

      const source = fileSource(path, { watch: false });
      const store = await source.open();

      expect(store.get()).toEqual({ server: { port: 3000 } });
    });

    test("parses a file with an unrecognized extension as JSON by default", async () => {
      const path = join(dir, "config.conf");
      await Bun.write(path, JSON.stringify({ port: 3000 }));

      const source = fileSource(path, { watch: false });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000 });
    });

    test("parses a named .env file into a flat string map", async () => {
      const path = join(dir, "file.env");
      await Bun.write(path, "PORT=3000\nHOST=localhost\n");

      const source = fileSource(path, { watch: false });
      const store = await source.open();

      expect(store.get()).toEqual({ PORT: "3000", HOST: "localhost" });
    });

    test("parses a bare .env file", async () => {
      const path = join(dir, ".env");
      await Bun.write(path, "PORT=3000\n");

      const source = fileSource(path, { watch: false });
      const store = await source.open();

      expect(store.get()).toEqual({ PORT: "3000" });
    });

    test("skips blank lines and #-comments in a .env file", async () => {
      const path = join(dir, ".env");
      await Bun.write(path, "\n# a comment\nPORT=3000\n\n# another\nHOST=localhost\n");

      const source = fileSource(path, { watch: false });
      const store = await source.open();

      expect(store.get()).toEqual({ PORT: "3000", HOST: "localhost" });
    });

    test("strips matching quotes from a .env value", async () => {
      const path = join(dir, ".env");
      await Bun.write(path, `NAME="my app"\nOTHER='it\\'s fine'\n`);

      const source = fileSource(path, { watch: false });
      const store = await source.open();

      // The backslash isn't stripped by DotEnv.parse — see src/utils/dotenv.md.
      expect(store.get()).toEqual({ NAME: "my app", OTHER: "it\\'s fine" });
    });
  });

  describe("parser", () => {
    test("uses a custom parser instead of extension-based detection", async () => {
      const path = join(dir, "config.yaml");
      await Bun.write(path, "port: 3000\nhost: localhost\n");

      const source = fileSource(path, {
        watch: false,
        parser: (buffer) => {
          const text = new TextDecoder().decode(buffer);
          const result: Record<string, string | number> = {};
          for (const line of text.split("\n")) {
            const [key, value] = line.split(": ");
            if (!key || value === undefined) continue;
            result[key] = /^\d+$/.test(value) ? Number(value) : value;
          }
          return result;
        },
      });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000, host: "localhost" });
    });

    test("a custom parser is used even for a recognized extension like .json", async () => {
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ port: 3000 }));

      const source = fileSource(path, {
        watch: false,
        parser: () => ({ overridden: true }),
      });
      const store = await source.open();

      expect(store.get()).toEqual({ overridden: true });
    });

    test("a custom parser error is logged and leaves the store null", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const path = join(dir, "config.yaml");
      await Bun.write(path, "not: [valid");

      const source = fileSource(path, {
        watch: false,
        parser: () => {
          throw new Error("bad yaml");
        },
      });
      const store = await source.open();

      expect(store.get()).toBeNull();
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    test("stays live with a custom parser: a later change republishes", async () => {
      const path = join(dir, "config.yaml");
      await Bun.write(path, "port: 3000\n");

      const source = fileSource<{ port: number }>(path, {
        parser: (buffer) => {
          const text = new TextDecoder().decode(buffer);
          const [, value] = text.trim().split(": ");
          return { port: Number(value) };
        },
      });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000 });

      await Bun.write(path, "port: 4000\n");
      await waitFor(() => store.get()?.port === 4000);

      expect(store.get()).toEqual({ port: 4000 });

      await source.close();
    });
  });

  describe("format", () => {
    test("parses an extensionless path as .env when format: \"env\" is set", async () => {
      const path = join(dir, "config");
      await Bun.write(path, "PORT=3000\nHOST=localhost\n");

      const source = fileSource(path, { watch: false, format: "env" });
      const store = await source.open();

      expect(store.get()).toEqual({ PORT: "3000", HOST: "localhost" });
    });

    test("without format, an extensionless path falls back to JSON and fails to parse .env content", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const path = join(dir, "config");
      await Bun.write(path, "PORT=3000\n");

      const source = fileSource(path, { watch: false });
      const store = await source.open();

      expect(store.get()).toBeNull();
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    test("format: \"json\" forces JSON parsing on a .env-named file", async () => {
      const path = join(dir, ".env");
      await Bun.write(path, JSON.stringify({ port: 3000 }));

      const source = fileSource(path, { watch: false, format: "json" });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000 });
    });

    test("format is ignored once parser is set", async () => {
      const path = join(dir, "config");
      await Bun.write(path, "PORT=3000\n");

      const source = fileSource(path, {
        watch: false,
        format: "env",
        parser: () => ({ overridden: true }),
      });
      const store = await source.open();

      expect(store.get()).toEqual({ overridden: true });
    });
  });

  describe("treePath", () => {
    test("selects a nested subtree, ignoring everything else in the file", async () => {
      const path = join(dir, "config.json");
      await Bun.write(
        path,
        JSON.stringify({
          containers: { settings: { port: 3000, host: "localhost" } },
          metadata: { generatedAt: "2024-01-01" },
        }),
      );

      const source = fileSource(path, { watch: false, treePath: ["containers", "settings"] });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000, host: "localhost" });
    });

    test("selects a single-segment subtree", async () => {
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ server: { port: 3000 }, other: 1 }));

      const source = fileSource(path, { watch: false, treePath: ["server"] });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000 });
    });

    test("an empty treePath (or omitting it) uses the whole tree, same as the default", async () => {
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ port: 3000 }));

      const source = fileSource(path, { watch: false, treePath: [] });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000 });
    });

    test("a leaf value at treePath is used as-is, not just objects", async () => {
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ server: { port: 3000 } }));

      const source = fileSource(path, { watch: false, treePath: ["server", "port"] });
      const store = await source.open();

      expect(store.get()).toBe(3000);
    });

    test("logs and sets an empty object when treePath doesn't resolve to anything", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ containers: {} }));

      const source = fileSource(path, { watch: false, treePath: ["containers", "settings"] });
      const store = await source.open();

      expect(store.get()).toEqual({});
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    test("logs and sets an empty object when an intermediate segment isn't an object", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ containers: "not an object" }));

      const source = fileSource(path, { watch: false, treePath: ["containers", "settings"] });
      const store = await source.open();

      expect(store.get()).toEqual({});
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    test("stays live: a later change that no longer matches treePath sets an empty object", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const path = join(dir, "config.json");
      await Bun.write(
        path,
        JSON.stringify({ containers: { settings: { port: 3000 } }, metadata: {} }),
      );

      const source = fileSource(path, { treePath: ["containers", "settings"] });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000 });

      await Bun.write(path, JSON.stringify({ containers: {}, metadata: {} }));
      await waitFor(() => errorSpy.mock.calls.length > 0);

      expect(store.get()).toEqual({});

      await source.close();
      errorSpy.mockRestore();
    });

    test("stays live: a later change updates only the selected subtree", async () => {
      const path = join(dir, "config.json");
      await Bun.write(
        path,
        JSON.stringify({ containers: { settings: { port: 3000 } }, metadata: {} }),
      );

      const source = fileSource<{ port: number }>(path, {
        treePath: ["containers", "settings"],
      });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000 });

      await Bun.write(
        path,
        JSON.stringify({ containers: { settings: { port: 4000 } }, metadata: {} }),
      );
      await waitFor(() => store.get()?.port === 4000);

      expect(store.get()).toEqual({ port: 4000 });

      await source.close();
    });
  });

  describe("error handling", () => {
    test("logs and leaves the store null when a non-JSON, non-.env file fails to parse as JSON", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const path = join(dir, "config.toml");
      await Bun.write(path, "port = 3000");

      const source = fileSource(path, { watch: false });
      const store = await source.open();

      expect(store.get()).toBeNull();
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    test("logs and leaves the store null when the file doesn't exist", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const path = join(dir, "missing.json");

      const source = fileSource(path, { watch: false });
      const store = await source.open();

      expect(store.get()).toBeNull();
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    test("logs and leaves the file invalid JSON without throwing", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const path = join(dir, "config.json");
      await Bun.write(path, "{not valid json");

      const source = fileSource(path, { watch: false });
      const store = await source.open();

      expect(store.get()).toBeNull();
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    test("a malformed JSON file resolves the store to null during open(), even with watch: true", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const path = join(dir, "config.json");
      await Bun.write(path, "{not valid json");

      const source = fileSource(path);
      const store = await source.open();

      expect(store.get()).toBeNull();
      expect(errorSpy).toHaveBeenCalled();

      await source.close();
      errorSpy.mockRestore();
    });
  });

  describe("metrics", () => {
    test("bumps reads and readDuration, labeled ok=true, on a successful read", async () => {
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ port: 3000 }));

      const source = fileSource(path, { watch: false });
      await source.open();
      const reads = source.metrics.reads as CounterMetric;
      const readDuration = source.metrics.readDuration as HistogramMetric;

      expect(reads.get({ ok: "true" })).toBe(1);
      expect(reads.get({ ok: "false" })).toBe(0);
      expect(readDuration.get({ ok: "true" }).count).toBe(1);
    });

    test("bumps reads, labeled ok=false, when the file doesn't exist", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const path = join(dir, "missing.json");

      const source = fileSource(path, { watch: false });
      await source.open();
      const reads = source.metrics.reads as CounterMetric;

      expect(reads.get({ ok: "false" })).toBe(1);
      expect(reads.get({ ok: "true" })).toBe(0);
      errorSpy.mockRestore();
    });

    test("bumps reads, labeled ok=false, on invalid JSON", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const path = join(dir, "config.json");
      await Bun.write(path, "{not valid json");

      const source = fileSource(path, { watch: false });
      await source.open();
      const reads = source.metrics.reads as CounterMetric;

      expect(reads.get({ ok: "false" })).toBe(1);
      errorSpy.mockRestore();
    });

    test("bumps reads again on every watch-triggered re-read", async () => {
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ port: 3000 }));

      const source = fileSource<{ port: number }>(path);
      const store = await source.open();
      const reads = source.metrics.reads as CounterMetric;

      expect(reads.get({ ok: "true" })).toBe(1);

      await Bun.write(path, JSON.stringify({ port: 4000 }));
      await waitFor(() => store.get()?.port === 4000);

      expect(reads.get({ ok: "true" })).toBe(2);
      await source.close();
    });
  });

  describe("watch (defaults to true)", () => {
    test("republishes the file's contents live once it changes", async () => {
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ port: 3000 }));

      const source = fileSource<{ port: number }>(path);
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000 });

      await Bun.write(path, JSON.stringify({ port: 4000 }));
      await waitFor(() => store.get()?.port === 4000);

      expect(store.get()).toEqual({ port: 4000 });

      await source.close();
    });

    test("watch: false reads once and never updates after a later file change", async () => {
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ port: 3000 }));

      const source = fileSource<{ port: number }>(path, { watch: false });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000 });

      await Bun.write(path, JSON.stringify({ port: 4000 }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(store.get()).toEqual({ port: 3000 });
    });

    test("close() stops watching for further file changes", async () => {
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ port: 3000 }));

      const source = fileSource<{ port: number }>(path);
      const store = await source.open();

      await source.close();

      await Bun.write(path, JSON.stringify({ port: 9999 }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(store.get()).toEqual({ port: 3000 });
    });

    test("a parse error on a later change is logged and keeps the last good value", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ port: 3000 }));

      const source = fileSource<{ port: number }>(path);
      const store = await source.open();

      await Bun.write(path, "{not valid json");
      await waitFor(() => errorSpy.mock.calls.length > 0);

      expect(store.get()).toEqual({ port: 3000 });

      await source.close();
      errorSpy.mockRestore();
    });

    test("a later malformed write logs exactly one console.error and doesn't wipe the last good value", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ port: 3000 }));

      const source = fileSource<{ port: number }>(path);
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000 });

      await Bun.write(path, "{not valid json");
      await waitFor(() => errorSpy.mock.calls.length > 0);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(store.get()).toEqual({ port: 3000 });

      await source.close();
      errorSpy.mockRestore();
    });

    test("deleting the watched file is logged and keeps the last good value", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ port: 3000 }));

      const source = fileSource<{ port: number }>(path);
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000 });

      await rm(path);
      await waitFor(() => errorSpy.mock.calls.length > 0);

      expect(store.get()).toEqual({ port: 3000 });

      await source.close();
      errorSpy.mockRestore();
    });
  });

  describe("reduce", () => {
    test("defaults to a full replace: a later watched change overwrites the previous value", async () => {
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ port: 3000 }));

      const source = fileSource<Record<string, unknown>>(path);
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000 });

      await Bun.write(path, JSON.stringify({ host: "localhost" }));
      await waitFor(() => store.get()?.host !== undefined);

      expect(store.get()).toEqual({ host: "localhost" });

      await source.close();
    });

    test("merges each read into the previously published value instead of replacing it", async () => {
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ port: 3000 }));

      const source = fileSource<Record<string, unknown>>(path, {
        reduce: (incoming, previous) => ({ ...(previous ?? {}), ...incoming }),
      });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000 });

      await Bun.write(path, JSON.stringify({ host: "localhost" }));
      await waitFor(() => store.get()?.host !== undefined);

      expect(store.get()).toEqual({ port: 3000, host: "localhost" });

      await source.close();
    });

    test("receives the treePath-selected value, not the whole parsed file", async () => {
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ containers: { settings: { port: 3000 } } }));

      let received: unknown;
      const source = fileSource<{ port: number }>(path, {
        watch: false,
        treePath: ["containers", "settings"],
        reduce: (incoming) => {
          received = incoming;
          return incoming;
        },
      });
      await source.open();

      expect(received).toEqual({ port: 3000 });
    });
  });

  test("wires into configs.create as a source", async () => {
    const path = join(dir, "config.json");
    await Bun.write(path, JSON.stringify({ port: 3000, host: "localhost" }));

    const cfg = await configs.create(
      { port: { type: "number", required: true }, host: { type: "string", required: true } },
      { sources: [fileSource(path, { watch: false })] },
    );

    expect(cfg.port.get()).toBe(3000);
    expect(cfg.host.get()).toBe("localhost");
  });
});
