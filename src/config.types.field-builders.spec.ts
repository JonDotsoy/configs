import { afterEach, describe, expect, expectTypeOf, test } from "bun:test";
import { boolean, ConfigDescriptor, create, numeric, string, url } from "./configs.js";
import { envSource, mapKey } from "./sources/env.js";
import { fetchSource } from "./sources/fetch.js";
import { ConfigError } from "./errors.js";
import type { ReadOnlyStore } from "./config.types.js";

describe("string/numeric/boolean field builders", () => {
  test("string() builds a ConfigDescriptor<string> carrying a { type: \"string\" } schema", () => {
    expect(string()).toBeInstanceOf(ConfigDescriptor);
    expect(string()).toEqual(new ConfigDescriptor("string", {}));
    expect(string({ summary: "bind host", default: "localhost" })).toEqual(
      new ConfigDescriptor("string", { summary: "bind host", default: "localhost" }),
    );
  });

  test("numeric() builds a ConfigDescriptor<number> carrying a { type: \"number\" } schema", () => {
    expect(numeric()).toBeInstanceOf(ConfigDescriptor);
    expect(numeric()).toEqual(new ConfigDescriptor("number", {}));
    expect(numeric({ summary: "HTTP port", default: 3000 })).toEqual(
      new ConfigDescriptor("number", { summary: "HTTP port", default: 3000 }),
    );
  });

  test("boolean() builds a ConfigDescriptor<boolean> carrying a { type: \"boolean\" } schema", () => {
    expect(boolean()).toBeInstanceOf(ConfigDescriptor);
    expect(boolean()).toEqual(new ConfigDescriptor("boolean", {}));
    expect(boolean({ summary: "enable the promo service", default: false })).toEqual(
      new ConfigDescriptor("boolean", { summary: "enable the promo service", default: false }),
    );
  });

  test("string() carries a pattern through unchanged", () => {
    const pattern = /^[\w.-]+$/;
    expect(string({ pattern })).toEqual(new ConfigDescriptor("string", { pattern }));
  });

  test("resolve the same as their equivalent object-literal field schemas", async () => {
    const viaBuilders = await create(
      {
        port: numeric({ default: 3000 }),
        host: string({ default: "localhost" }),
        enabled: boolean({ default: false }),
      },
      { sources: [] },
    );
    const viaLiterals = await create(
      {
        port: { type: "number", default: 3000 },
        host: { type: "string", default: "localhost" },
        enabled: { type: "boolean", default: false },
      },
      { sources: [] },
    );

    expect(viaBuilders.get()).toEqual(viaLiterals.get());
  });
});

describe("README example: create() + string/numeric/boolean + envSource + fetchSource", () => {
  test("server group resolves numeric/string fields from a snake_case-mapped envSource", async () => {
    const serverConfigs = await create(
      {
        port: numeric({ summary: "HTTP port", default: 3000 }),
        host: string({ summary: "bind host", default: "localhost" }),
      },
      {
        sources: [
          envSource({
            env: { PORT: "4000", HOST: "example.com" },
            mapKey: mapKey.snakeCase(),
          }),
        ],
      },
    );

    expect(serverConfigs.get()).toEqual({ port: 4000, host: "example.com" });
    expect(serverConfigs.port.get()).toBe(4000);
    expect(serverConfigs.host.get()).toBe("example.com");

    expectTypeOf(serverConfigs.port).toEqualTypeOf<ReadOnlyStore<number>>();
    expectTypeOf(serverConfigs.host).toEqualTypeOf<ReadOnlyStore<string>>();
  });

  test("server group falls back to defaults when the mapped env vars are absent", async () => {
    const serverConfigs = await create(
      {
        port: numeric({ summary: "HTTP port", default: 3000 }),
        host: string({ summary: "bind host", default: "localhost" }),
      },
      { sources: [envSource({ env: {}, mapKey: mapKey.snakeCase() })] },
    );

    expect(serverConfigs.get()).toEqual({ port: 3000, host: "localhost" });
  });

  test("features group resolves a boolean field from a fetchSource", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ promoService: true }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      const featuresConfigs = await create(
        {
          promoService: boolean({ summary: "enable the promo service", default: false }),
        },
        {
          sources: [fetchSource({ url: "https://example.com/features", pollingInterval: 30_000 })],
        },
      );

      expect(featuresConfigs.get()).toEqual({ promoService: true });
      expect(featuresConfigs.promoService.get()).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("full example: nested server + features groups resolve together", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ promoService: true }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      const cfg = await create({
        server: create(
          {
            port: numeric({ summary: "HTTP port", default: 3000 }),
            host: string({ summary: "bind host", default: "localhost" }),
          },
          {
            sources: [
              envSource({
                env: { PORT: "3000", HOST: "localhost" },
                mapKey: mapKey.snakeCase(),
              }),
            ],
          },
        ),
        features: create(
          {
            promoService: boolean({ summary: "enable the promo service", default: false }),
          },
          {
            sources: [fetchSource({ url: "https://example.com/features", pollingInterval: 30_000 })],
          },
        ),
      });

      expect(cfg.get()).toEqual({
        server: { port: 3000, host: "localhost" },
        features: { promoService: true },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("ConfigDescriptor: implicit nested shape + key override", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete (process.env as Record<string, string | undefined>)[key];
    }
    Object.assign(process.env, originalEnv);
  });

  test("a plain nested object (no create() wrapper) resolves fields via their own key against a flat envSource()", async () => {
    process.env.PORT = "3000";
    process.env.HOST = "localhost";

    const cfg = await create(
      {
        server: {
          port: numeric({ summary: "HTTP port", default: 3000, key: "PORT" }),
          host: string({ summary: "bind host", default: "localhost", key: "HOST" }),
        },
      },
      { sources: [envSource()] },
    );

    expect(cfg.get()).toEqual({ server: { port: 3000, host: "localhost" } });
    expect(cfg.server.port.get()).toBe(3000);
    expect(cfg.server.host.get()).toBe("localhost");

    expectTypeOf(cfg.server.port).toEqualTypeOf<ReadOnlyStore<number>>();
    expectTypeOf(cfg.server.host).toEqualTypeOf<ReadOnlyStore<string>>();
  });

  test("key reads straight from the env var, overriding the port/host nesting a plain envSource() would otherwise miss", async () => {
    process.env.PORT = "4321";
    process.env.HOST = "example.com";

    const cfg = await create(
      {
        server: {
          port: numeric({ default: 3000, key: "PORT" }),
          host: string({ default: "localhost", key: "HOST" }),
        },
      },
      { sources: [envSource()] },
    );

    expect(cfg.server.port.get()).toBe(4321);
    expect(cfg.server.host.get()).toBe("example.com");
  });

  test("falls back to each field's default when the keyed env var is unset", async () => {
    delete process.env.PORT;
    delete process.env.HOST;

    const cfg = await create(
      {
        server: {
          port: numeric({ default: 3000, key: "PORT" }),
          host: string({ default: "localhost", key: "HOST" }),
        },
      },
      { sources: [envSource()] },
    );

    expect(cfg.get()).toEqual({ server: { port: 3000, host: "localhost" } });
  });

  test("a live update to the source is reflected on the nested plain-object field", async () => {
    const cfg = await create(
      {
        server: {
          port: numeric({ default: 3000, key: "PORT" }),
        },
      },
      { sources: [envSource({ env: { PORT: "1111" } })] },
    );

    expect(cfg.server.port.get()).toBe(1111);
  });
});

describe("url() field builder", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete (process.env as Record<string, string | undefined>)[key];
    }
    Object.assign(process.env, originalEnv);
  });

  test("url() builds a ConfigDescriptor<URL> carrying a { type: \"url\" } schema", () => {
    expect(url()).toBeInstanceOf(ConfigDescriptor);
    expect(url()).toEqual(new ConfigDescriptor("url", {}));
    expect(url({ key: "DATABASE_URL" })).toEqual(new ConfigDescriptor("url", { key: "DATABASE_URL" }));
  });

  test("parses DATABASE_URL into a URL instance via key", async () => {
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/app";

    const cfg = await create(
      {
        datasource: {
          uri: url({ key: "DATABASE_URL" }),
        },
      },
      { sources: [envSource()] },
    );

    const uri = cfg.datasource.uri.get();
    expect(uri).toBeInstanceOf(URL);
    expect(uri).toEqual(new URL("postgres://user:pass@localhost:5432/app"));
    expect(uri?.hostname).toBe("localhost");
    expect(uri?.pathname).toBe("/app");

    expectTypeOf(cfg.datasource.uri).toEqualTypeOf<ReadOnlyStore<URL | null>>();
  });

  test("rejects a value that isn't a valid URL", async () => {
    process.env.DATABASE_URL = "not a url";

    const cfg = await create(
      {
        datasource: { uri: url({ key: "DATABASE_URL" }) },
      },
      { sources: [envSource()] },
    );

    expect(() => cfg.get()).toThrow(ConfigError);
  });

  test("resolves to null when DATABASE_URL is unset and there's no default", async () => {
    delete process.env.DATABASE_URL;

    const cfg = await create(
      {
        datasource: { uri: url({ key: "DATABASE_URL" }) },
      },
      { sources: [envSource()] },
    );

    expect(cfg.datasource.uri.get()).toBeNull();
  });

  test("a default is used as-is (not re-parsed) when nothing resolves DATABASE_URL", async () => {
    delete process.env.DATABASE_URL;
    const fallback = new URL("postgres://localhost:5432/app");

    const cfg = await create(
      {
        datasource: { uri: url({ key: "DATABASE_URL", default: fallback }) },
      },
      { sources: [envSource()] },
    );

    expect(cfg.datasource.uri.get()).toBe(fallback);
    expectTypeOf(cfg.datasource.uri).toEqualTypeOf<ReadOnlyStore<URL>>();
  });
});
