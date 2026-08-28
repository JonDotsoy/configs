import { describe, expect, test } from "bun:test";
import { configs } from "../configs";
import { envSource, envKeyToPath } from "./env";

describe("envKeyToPath", () => {
  test("splits a SCREAMING_SNAKE_CASE key into a lowercase path", () => {
    expect(envKeyToPath("FOO_TAR")).toEqual(["foo", "tar"]);
  });

  test("passes a key without underscores through as a single segment", () => {
    expect(envKeyToPath("PORT")).toEqual(["port"]);
  });
});

describe("envSource", () => {
  test("defaults to the identity mapping: FOO_TAR => ['FOO_TAR']", async () => {
    const source = envSource({ env: { FOO_TAR: "1" } });
    const store = await source.open();

    expect(store.get()).toEqual({ FOO_TAR: "1" });
  });

  test("uses a custom mapKey to build nested paths", async () => {
    const source = envSource({
      env: { FOO_TAR: "baz" },
      mapKey: envKeyToPath,
    });
    const store = await source.open();

    expect(store.get()).toEqual({ foo: { tar: "baz" } });
  });

  test("merges multiple keys mapped under the same parent", async () => {
    const source = envSource({
      env: { SERVER_PORT: "3000", SERVER_HOST: "localhost" },
      mapKey: envKeyToPath,
    });
    const store = await source.open();

    expect(store.get()).toEqual({ server: { port: "3000", host: "localhost" } });
  });

  test("maps a specific key while falling back to the identity mapping for the rest", async () => {
    const mapKey = (key: string) =>
      ({ PORT: ["server", "port"] } as Record<string, string[]>)[key] ?? [key];

    const source = envSource({
      env: { PORT: "3000", HOST: "localhost" },
      mapKey,
    });
    const store = await source.open();

    expect(store.get()).toEqual({ server: { port: "3000" }, HOST: "localhost" });
  });

  test("skips keys with an undefined value", async () => {
    const source = envSource({ env: { FOO: undefined } });
    const store = await source.open();

    expect(store.get()).toEqual({});
  });

  test("defaults to reading from process.env", async () => {
    process.env.CONFIGS_TEST_VAR = "hello";
    try {
      const source = envSource();
      const store = await source.open();

      expect((store.get() as Record<string, unknown>).CONFIGS_TEST_VAR).toBe("hello");
    } finally {
      delete process.env.CONFIGS_TEST_VAR;
    }
  });

  test("strips a matching prefix from each key", async () => {
    const source = envSource({ env: { MY_PORT: "3000" }, prefix: "MY_" });
    const store = await source.open();

    expect(store.get()).toEqual({ PORT: "3000" });
  });

  test("excludes keys that don't match the prefix", async () => {
    const source = envSource({ env: { MY_PORT: "3000", OTHER_HOST: "localhost" }, prefix: "MY_" });
    const store = await source.open();

    expect(store.get()).toEqual({ PORT: "3000" });
  });

  test("strips a matching suffix from each key", async () => {
    const source = envSource({ env: { PORT_MY: "3000" }, suffix: "_MY" });
    const store = await source.open();

    expect(store.get()).toEqual({ PORT: "3000" });
  });

  test("excludes keys that don't match the suffix", async () => {
    const source = envSource({ env: { PORT_MY: "3000", HOST_OTHER: "localhost" }, suffix: "_MY" });
    const store = await source.open();

    expect(store.get()).toEqual({ PORT: "3000" });
  });

  test("combines prefix and suffix stripping", async () => {
    const source = envSource({ env: { APP_PORT_DEV: "3000", OTHER_PORT_DEV: "x" }, prefix: "APP_", suffix: "_DEV" });
    const store = await source.open();

    expect(store.get()).toEqual({ PORT: "3000" });
  });

  test("applies prefix/suffix stripping before mapKey", async () => {
    const source = envSource({
      env: { MY_SERVER_PORT: "3000" },
      prefix: "MY_",
      mapKey: envKeyToPath,
    });
    const store = await source.open();

    expect(store.get()).toEqual({ server: { port: "3000" } });
  });

  test("wires into configs.create as a source", async () => {
    const cfg = await configs.create(
      {
        server: configs.create({
          port: { type: "number", required: true },
          host: { type: "string", required: true },
        }),
      },
      {
        sources: [
          envSource({
            env: { SERVER_PORT: "3000", SERVER_HOST: "localhost" },
            mapKey: envKeyToPath,
          }),
        ],
      },
    );

    expect(cfg.server.port.get()).toBe(3000);
    expect(cfg.server.host.get()).toBe("localhost");
  });
});
