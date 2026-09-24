import { afterEach, describe, expect, expectTypeOf, spyOn, test } from "bun:test";
import { boolean, ConfigDescriptor, create, load, numeric, shape, string, url } from "./configs.js";
import { envSource, mapKey } from "./sources/env.js";
import { fetchSource } from "./sources/fetch.js";
import { Source } from "./sources/source.js";
import { ConfigError } from "./errors.js";
import { z } from "zod";
import { __resetDeprecatedFieldSchemaWarningForTests } from "./config.types.js";
import type { ReadOnlyStore } from "./config.types.js";

/** Builds a `Source` that immediately publishes `value` and closes. */
function testSource<T>(value: T): Source<T> {
  return new Source<T>({
    async start(control) {
      control.set(value);
      control.close();
    },
  });
}

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

describe("shape() field builder", () => {
  test("shape() builds a ConfigDescriptor carrying a { type: \"shape\" } schema", () => {
    const schema = z.object({ issuer: z.string() });
    expect(shape({ schema, required: true })).toBeInstanceOf(ConfigDescriptor);
    expect(shape({ schema, required: true })).toEqual(new ConfigDescriptor("shape", { schema, required: true }));
  });

  test("required: true escalates an invalid value into a thrown ConfigError instead of logging", async () => {
    const cfg = await create(
      { jwt: shape({ schema: z.object({ issuer: z.string() }), required: true }) },
      { sources: [testSource({ jwt: { issuer: 42 } })] },
    );

    expect(() => cfg.get()).toThrow(ConfigError);
  });

  test("parses a valid value via schema.parse, inferring the field's type from it", async () => {
    const cfg = await create(
      { jwt: shape({ schema: z.object({ issuer: z.string(), ttl: z.number() }) }) },
      { sources: [testSource({ jwt: { issuer: "auth0", ttl: 3600 } })] },
    );

    expect(cfg.jwt.get()).toEqual({ issuer: "auth0", ttl: 3600 });
    expectTypeOf(cfg.jwt).toEqualTypeOf<ReadOnlyStore<{ issuer: string; ttl: number } | null>>();
  });

  test("without schema, passes the raw value through untyped", async () => {
    const cfg = await create({ metadata: shape() }, { sources: [testSource({ metadata: { any: "thing" } })] });

    expect(cfg.metadata.get()).toEqual({ any: "thing" });
    expectTypeOf(cfg.metadata).toEqualTypeOf<ReadOnlyStore<unknown>>();
  });

  test("a default is used as-is when nothing resolves the field", async () => {
    const fallback = { issuer: "auth0", ttl: 3600 };

    const cfg = await create(
      { jwt: shape({ schema: z.object({ issuer: z.string(), ttl: z.number() }), default: fallback }) },
      { sources: [testSource({})] },
    );

    expect(cfg.jwt.get()).toEqual(fallback);
    expectTypeOf(cfg.jwt).toEqualTypeOf<ReadOnlyStore<{ issuer: string; ttl: number }>>();
  });
});

describe("{ type: \"...\" } object-literal fields are deprecated", () => {
  afterEach(() => {
    __resetDeprecatedFieldSchemaWarningForTests();
  });

  test("still resolves correctly (backward compatible)", async () => {
    const cfg = await create(
      { port: { type: "number", default: 3000 } },
      { sources: [testSource({ port: 8080 })] },
    );

    expect(cfg.port.get()).toBe(8080);
  });

  test("logs a one-time console.warn pointing at the builder functions", async () => {
    __resetDeprecatedFieldSchemaWarningForTests();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const cfg = await create({ port: { type: "number", default: 3000 } }, { sources: [] });
      cfg.port.get();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain('{ type: "...", ... }');
      expect(warnSpy.mock.calls[0]?.[0]).toContain("string()/numeric()/boolean()/url()/shape()");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("warns only once even across many literal fields and create() calls", async () => {
    __resetDeprecatedFieldSchemaWarningForTests();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const cfg1 = await create(
        { port: { type: "number" }, host: { type: "string" } },
        { sources: [] },
      );
      cfg1.port.get();
      cfg1.host.get();

      const cfg2 = await create({ debug: { type: "boolean" } }, { sources: [] });
      cfg2.debug.get();

      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("string()/numeric()/boolean()/url()/shape() never trigger the warning", async () => {
    __resetDeprecatedFieldSchemaWarningForTests();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const cfg = await create(
        {
          port: numeric({ default: 3000 }),
          host: string({ default: "localhost" }),
          debug: boolean({ default: false }),
          site: url({ default: new URL("https://example.com") }),
          meta: shape(),
        },
        { sources: [] },
      );
      cfg.get();

      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("the untagged shape shorthands (bare schema, { schema } with no type) don't trigger the warning either", async () => {
    __resetDeprecatedFieldSchemaWarningForTests();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const cfg = await create(
        {
          bare: z.number(),
          untagged: { schema: z.number() },
        },
        { sources: [testSource({ bare: 1, untagged: 2 })] },
      );
      cfg.get();

      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("deeply nested plain-object shapes", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete (process.env as Record<string, string | undefined>)[key];
    }
    Object.assign(process.env, originalEnv);
  });

  test("resolves a field 7 levels deep, via key, against a flat envSource()", async () => {
    process.env.FOF = "42";

    const cfg = await create(
      {
        foo: {
          tar: {
            biz: {
              liz: {
                lol: {
                  flip: {
                    fof: numeric({ key: "FOF" }),
                  },
                },
              },
            },
          },
        },
      },
      { sources: [envSource()] },
    );

    const value = cfg.foo.tar.biz.liz.lol.flip.fof.get();

    expect(typeof value).toBe("number");
    expect(value).toBe(42);
    expect(cfg.get()).toEqual({
      foo: { tar: { biz: { liz: { lol: { flip: { fof: 42 } } } } } },
    });

    expectTypeOf(cfg.foo.tar.biz.liz.lol.flip.fof).toEqualTypeOf<ReadOnlyStore<number | null>>();
  });

  test("resolves to null at the same depth when FOF is unset and there's no default", async () => {
    delete process.env.FOF;

    const cfg = await create(
      {
        foo: {
          tar: {
            biz: {
              liz: {
                lol: {
                  flip: {
                    fof: numeric({ key: "FOF" }),
                  },
                },
              },
            },
          },
        },
      },
      { sources: [envSource()] },
    );

    expect(cfg.foo.tar.biz.liz.lol.flip.fof.get()).toBeNull();
  });

  test("live updates at that depth are reflected without re-fetching the whole tree", async () => {
    const source = new Source<{ FOF?: string }>({
      start(control) {
        control.set({ FOF: "1" });
        setTimeout(() => control.set({ FOF: "2" }), 0);
      },
    });

    const cfg = await create(
      {
        foo: { tar: { biz: { liz: { lol: { flip: { fof: numeric({ key: "FOF" }) } } } } } },
      },
      { sources: [source] },
    );

    expect(cfg.foo.tar.biz.liz.lol.flip.fof.get()).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(cfg.foo.tar.biz.liz.lol.flip.fof.get()).toBe(2);
  });

  test("a typo'd path segment surfaces as undefined, not a crash", async () => {
    process.env.FOF = "7";

    const cfg = await create(
      {
        foo: { tar: { biz: { liz: { lol: { flip: { fof: numeric({ key: "FOF" }) } } } } } },
      },
      { sources: [envSource()] },
    );

    // @ts-expect-error "biiz" is not a key of this shape
    expect(cfg.foo.tar.biiz).toBeUndefined();
  });
});

describe("load() — like create(), but defaults sources to [envSource()]", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete (process.env as Record<string, string | undefined>)[key];
    }
    Object.assign(process.env, originalEnv);
  });

  test("with no options at all, reads straight from process.env", async () => {
    process.env.PORT = "8080";

    const cfg = await load({
      server: {
        port: numeric({ key: "PORT" }),
      },
    });

    expect(cfg.server.port.get()).toBe(8080);
  });

  test("with options but no sources, still defaults to envSource()", async () => {
    process.env.PORT = "9090";

    const cfg = await load(
      { server: { port: numeric({ key: "PORT" }) } },
      {},
    );

    expect(cfg.server.port.get()).toBe(9090);
  });

  test("passing an explicit sources array overrides the envSource() default entirely", async () => {
    process.env.PORT = "should be ignored";

    const cfg = await load(
      { server: { port: numeric({ key: "PORT" }) } },
      { sources: [testSource({ PORT: 1234 })] },
    );

    expect(cfg.server.port.get()).toBe(1234);
  });

  test("with explicit sources, behaves exactly like create() — same resolved value either way", async () => {
    const shapeDef = { port: numeric({ default: 3000 }) };
    const sources = [testSource({ port: 7000 })];

    const viaLoad = await load(shapeDef, { sources });
    const viaCreate = await create(shapeDef, { sources });

    expect(viaLoad.get()).toEqual(viaCreate.get());
    expect(viaLoad.get()).toEqual({ port: 7000 });
  });

  test("with an empty sources array, no env var is read and defaults apply, same as create()", async () => {
    process.env.PORT = "ignored too";

    const cfg = await load(
      { server: { port: numeric({ key: "PORT", default: 3000 }) } },
      { sources: [] },
    );

    expect(cfg.server.port.get()).toBe(3000);
  });

  test("falls back to the field's own default when envSource() doesn't have the key", async () => {
    delete process.env.PORT;

    const cfg = await load({
      server: { port: numeric({ key: "PORT", default: 3000 }) },
    });

    expect(cfg.server.port.get()).toBe(3000);
  });

  test("the exact requested syntax: deeply-typed key against a flat envSource()", async () => {
    process.env.FOF = "42";

    const cfg = await load({
      foo: {
        tar: {
          biz: {
            liz: {
              lol: {
                flip: {
                  fof: numeric({ key: "FOF" }),
                },
              },
            },
          },
        },
      },
    });

    const value = cfg.foo.tar.biz.liz.lol.flip.fof.get();

    expect(typeof value).toBe("number");
    expect(value).toBe(42);
    expectTypeOf(cfg.foo.tar.biz.liz.lol.flip.fof).toEqualTypeOf<ReadOnlyStore<number | null>>();
  });
});
