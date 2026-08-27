import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configs } from "../configs";
import { fileDataSource } from "./file";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "configs-file-datasource-"));
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

describe("fileDataSource", () => {
  describe("format detection", () => {
    test("parses a .json file", async () => {
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ port: 3000, host: "localhost" }));

      const source = fileDataSource(path, { watch: false });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000, host: "localhost" });
    });

    test("parses a nested .json file", async () => {
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ server: { port: 3000 } }));

      const source = fileDataSource(path, { watch: false });
      const store = await source.open();

      expect(store.get()).toEqual({ server: { port: 3000 } });
    });

    test("parses a named .env file into a flat string map", async () => {
      const path = join(dir, "file.env");
      await Bun.write(path, "PORT=3000\nHOST=localhost\n");

      const source = fileDataSource(path, { watch: false });
      const store = await source.open();

      expect(store.get()).toEqual({ PORT: "3000", HOST: "localhost" });
    });

    test("parses a bare .env file", async () => {
      const path = join(dir, ".env");
      await Bun.write(path, "PORT=3000\n");

      const source = fileDataSource(path, { watch: false });
      const store = await source.open();

      expect(store.get()).toEqual({ PORT: "3000" });
    });

    test("skips blank lines and #-comments in a .env file", async () => {
      const path = join(dir, ".env");
      await Bun.write(path, "\n# a comment\nPORT=3000\n\n# another\nHOST=localhost\n");

      const source = fileDataSource(path, { watch: false });
      const store = await source.open();

      expect(store.get()).toEqual({ PORT: "3000", HOST: "localhost" });
    });

    test("strips matching quotes from a .env value", async () => {
      const path = join(dir, ".env");
      await Bun.write(path, `NAME="my app"\nOTHER='it\\'s fine'\n`);

      const source = fileDataSource(path, { watch: false });
      const store = await source.open();

      // The backslash isn't stripped by DotEnv.parse — see src/utils/dotenv.md.
      expect(store.get()).toEqual({ NAME: "my app", OTHER: "it\\'s fine" });
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

      const source = fileDataSource(path, { watch: false, treePath: ["containers", "settings"] });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000, host: "localhost" });
    });

    test("selects a single-segment subtree", async () => {
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ server: { port: 3000 }, other: 1 }));

      const source = fileDataSource(path, { watch: false, treePath: ["server"] });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000 });
    });

    test("an empty treePath (or omitting it) uses the whole tree, same as the default", async () => {
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ port: 3000 }));

      const source = fileDataSource(path, { watch: false, treePath: [] });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000 });
    });

    test("a leaf value at treePath is used as-is, not just objects", async () => {
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ server: { port: 3000 } }));

      const source = fileDataSource(path, { watch: false, treePath: ["server", "port"] });
      const store = await source.open();

      expect(store.get()).toBe(3000);
    });

    test("logs and sets an empty object when treePath doesn't resolve to anything", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ containers: {} }));

      const source = fileDataSource(path, { watch: false, treePath: ["containers", "settings"] });
      const store = await source.open();

      expect(store.get()).toEqual({});
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    test("logs and sets an empty object when an intermediate segment isn't an object", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ containers: "not an object" }));

      const source = fileDataSource(path, { watch: false, treePath: ["containers", "settings"] });
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

      const source = fileDataSource(path, { treePath: ["containers", "settings"] });
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

      const source = fileDataSource<{ port: number }>(path, {
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
    test("logs and leaves the store null for an unrecognized extension", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const path = join(dir, "config.toml");
      await Bun.write(path, "port = 3000");

      const source = fileDataSource(path, { watch: false });
      const store = await source.open();

      expect(store.get()).toBeNull();
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    test("logs and leaves the store null when the file doesn't exist", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const path = join(dir, "missing.json");

      const source = fileDataSource(path, { watch: false });
      const store = await source.open();

      expect(store.get()).toBeNull();
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    test("logs and leaves the file invalid JSON without throwing", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const path = join(dir, "config.json");
      await Bun.write(path, "{not valid json");

      const source = fileDataSource(path, { watch: false });
      const store = await source.open();

      expect(store.get()).toBeNull();
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    test("a malformed JSON file resolves the store to null during open(), even with watch: true", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const path = join(dir, "config.json");
      await Bun.write(path, "{not valid json");

      const source = fileDataSource(path);
      const store = await source.open();

      expect(store.get()).toBeNull();
      expect(errorSpy).toHaveBeenCalled();

      await source.close();
      errorSpy.mockRestore();
    });
  });

  describe("watch (defaults to true)", () => {
    test("republishes the file's contents live once it changes", async () => {
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ port: 3000 }));

      const source = fileDataSource<{ port: number }>(path);
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

      const source = fileDataSource<{ port: number }>(path, { watch: false });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000 });

      await Bun.write(path, JSON.stringify({ port: 4000 }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(store.get()).toEqual({ port: 3000 });
    });

    test("close() stops watching for further file changes", async () => {
      const path = join(dir, "config.json");
      await Bun.write(path, JSON.stringify({ port: 3000 }));

      const source = fileDataSource<{ port: number }>(path);
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

      const source = fileDataSource<{ port: number }>(path);
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

      const source = fileDataSource<{ port: number }>(path);
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

      const source = fileDataSource<{ port: number }>(path);
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000 });

      await rm(path);
      await waitFor(() => errorSpy.mock.calls.length > 0);

      expect(store.get()).toEqual({ port: 3000 });

      await source.close();
      errorSpy.mockRestore();
    });
  });

  test("wires into configs.create as a datasource", async () => {
    const path = join(dir, "config.json");
    await Bun.write(path, JSON.stringify({ port: 3000, host: "localhost" }));

    const cfg = await configs.create(
      { port: { type: "number", required: true }, host: { type: "string", required: true } },
      { datasources: [fileDataSource(path, { watch: false })] },
    );

    expect(cfg.port.get()).toBe(3000);
    expect(cfg.host.get()).toBe("localhost");
  });
});
