import { describe, expect, test } from "bun:test";
import { configs } from "../configs";
import { envSource, mapKey } from "./env";

describe("mapKey.snakeCase", () => {
  test("splits a SCREAMING_SNAKE_CASE key into a lowercase path", () => {
    expect(mapKey.snakeCase()("FOO_TAR")).toEqual(["foo", "tar"]);
  });

  test("passes a key without underscores through as a single segment", () => {
    expect(mapKey.snakeCase()("PORT")).toEqual(["port"]);
  });

  test("splits on a custom separator instead of a single underscore", () => {
    expect(mapKey.snakeCase({ separator: "__" })("API_KEY_V2__ENABLED")).toEqual([
      "api_key_v2",
      "enabled",
    ]);
  });
});

describe("mapKey.identity", () => {
  test("passes a key through unchanged as a single-segment path", () => {
    expect(mapKey.identity()("FOO_TAR")).toEqual(["FOO_TAR"]);
  });
});

describe("mapKey.camelCase", () => {
  test("maps a SCREAMING_SNAKE_CASE key to a single camelCase segment", () => {
    expect(mapKey.camelCase()("FOO_TAR")).toEqual(["fooTar"]);
  });

  test("passes a key without underscores through lowercased", () => {
    expect(mapKey.camelCase()("PORT")).toEqual(["port"]);
  });

  test("camelCases every underscore-separated word", () => {
    expect(mapKey.camelCase()("SERVER_HTTP_PORT")).toEqual(["serverHttpPort"]);
  });
});

describe("mapKey.lookup", () => {
  test("maps a key found in the table", () => {
    expect(mapKey.lookup({ PORT: ["server", "port"] })("PORT")).toEqual(["server", "port"]);
  });

  test("falls back to the identity mapping for a key not in the table", () => {
    expect(mapKey.lookup({ PORT: ["server", "port"] })("HOST")).toEqual(["HOST"]);
  });

  test("falls back to a custom mapper for a key not in the table", () => {
    const mapped = mapKey.lookup({ PORT: ["server", "port"] }, mapKey.snakeCase())("SERVER_HOST");
    expect(mapped).toEqual(["server", "host"]);
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
      mapKey: mapKey.snakeCase(),
    });
    const store = await source.open();

    expect(store.get()).toEqual({ foo: { tar: "baz" } });
  });

  test("merges multiple keys mapped under the same parent", async () => {
    const source = envSource({
      env: { SERVER_PORT: "3000", SERVER_HOST: "localhost" },
      mapKey: mapKey.snakeCase(),
    });
    const store = await source.open();

    expect(store.get()).toEqual({ server: { port: "3000", host: "localhost" } });
  });

  test("maps a specific key via mapKey.lookup while falling back to the identity mapping for the rest", async () => {
    const source = envSource({
      env: { PORT: "3000", HOST: "localhost" },
      mapKey: mapKey.lookup({ PORT: ["server", "port"] }),
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
      mapKey: mapKey.snakeCase(),
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
            mapKey: mapKey.snakeCase(),
          }),
        ],
      },
    );

    expect(cfg.server.port.get()).toBe(3000);
    expect(cfg.server.host.get()).toBe("localhost");
  });
});
