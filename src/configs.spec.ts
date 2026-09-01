import { afterEach, describe, expect, expectTypeOf, test } from "bun:test";
import { Store, store } from "./utils/store";
import { Source } from "./sources/source";
import { envSource, mapKey } from "./sources/env";
import { fetchSource } from "./sources/fetch";
import { ConfigError } from "./errors";
import { create } from "./configs.ts";
import type { ConfigNode, configs, PendingConfigNode, ReadOnlyStore, SchemaGroup } from "./config.types.ts";

declare const configs: configs;

/** Builds a `Source` that immediately publishes `value` and closes, since `sources` now requires actual `Source` instances. */
function testSource<T>(value: T): Source<T> {
  return new Source<T>({
    async start(control) {
      control.set(value);
      control.close();
    },
  });
}

describe("configs.create", () => {
  test("earlier sources win per field; a field missing there falls through to the next one", async () => {
    const serverConfigs = await configs.create(
      {
        port: { type: "number", summary: "HTTP port", required: true },
        host: { type: "string", pattern: /^[\w.-]+$/, summary: "bind host", required: true },
        tls: configs.create({
          key: { type: "string", summary: "TLS key path", required: true },
          cert: { type: "string", summary: "TLS cert path", required: true },
        }),
      },
      {
        sources: [
          // only port and tls.key
          testSource({ port: 8080, tls: { key: "key.pem" } }),
          // host and tls.cert fall through to here
          testSource({ port: 3000, host: "localhost", tls: { cert: "cert.pem" } }),
        ],
      },
    );

    expect(serverConfigs.get()).toEqual({
      port: 8080,
      host: "localhost",
      tls: { key: "key.pem", cert: "cert.pem" },
    });

    expect(serverConfigs.port.get()).toBe(8080);
    expect(serverConfigs.host.get()).toBe("localhost");
    expect(serverConfigs.tls.key.get()).toBe("key.pem");
    expect(serverConfigs.tls.cert.get()).toBe("cert.pem");

    // `required: true` alone (no `default`) never narrows the type, resolved or not: it isn't
    // enforced at runtime, so the field can still be `null` after resolving (see the
    // "resolves required fields with no value anywhere to null instead of throwing" spec below).
    expectTypeOf(serverConfigs.port).toEqualTypeOf<ReadOnlyStore<number | null>>();
    expectTypeOf(serverConfigs.host).toEqualTypeOf<ReadOnlyStore<string | null>>();
    expectTypeOf(serverConfigs.tls.key).toEqualTypeOf<ReadOnlyStore<string | null>>();
    expectTypeOf(serverConfigs.tls.cert).toEqualTypeOf<ReadOnlyStore<string | null>>();
  });

  test("falls back to the next source when the first store's value is null", async () => {
    const neverSets = new Source<{ port: number }>({
      async start(control) {
        control.close();
      },
    });

    const cfg = await configs.create(
      { port: { type: "number", required: true } },
      { sources: [neverSets, testSource({ port: 3000 })] },
    );

    expect(cfg.port.get()).toBe(3000);
  });

  describe("port priority resolution", () => {
    test("first source's value wins when both have it", async () => {
      const cfg = await configs.create(
        { port: { type: "number", summary: "HTTP port", required: true } },
        { sources: [testSource({ port: 8080 }), testSource({ port: 3000 })] },
      );

      expect(cfg.port.get()).toBe(8080);
    });

    test("falls through to the second source when the first doesn't have the field", async () => {
      const cfg = await configs.create(
        { port: { type: "number", summary: "HTTP port", required: true } },
        { sources: [testSource({}), testSource({ port: 3000 })] },
      );

      expect(cfg.port.get()).toBe(3000);
    });

    test("resolves to null when no source has the field", async () => {
      const cfg = await configs.create(
        { port: { type: "number", summary: "HTTP port", required: true } },
        { sources: [testSource({}), testSource({})] },
      );

      expect(cfg.port.get()).toBeNull();
    });

    test("coerces a numeric string from the winning source", async () => {
      const cfg = await configs.create(
        { port: { type: "number", summary: "HTTP port", required: true } },
        { sources: [testSource({ port: "3000" }), testSource({})] },
      );

      expect(cfg.port.get()).toBe(3000);
    });
  });

  test("exposes live property access, including nested groups", async () => {
    const serverConfigs = await configs.create(
      {
        port: { type: "number" },
        tls: configs.create({
          key: { type: "string" },
        }),
      },
      { sources: [testSource({ port: 80, tls: { key: "k" } })] },
    );

    expect(serverConfigs.port.get()).toBe(80);
    expect(serverConfigs.tls.key.get()).toBe("k");
  });

  test("field stores are read-only", async () => {
    const serverConfigs = await configs.create(
      {
        port: { type: "number" },
        tls: configs.create({ key: { type: "string" } }),
      },
      { sources: [testSource({ port: 80, tls: { key: "k" } })] },
    );

    expectTypeOf(serverConfigs.port).not.toHaveProperty("set");
    expectTypeOf(serverConfigs.tls.key).not.toHaveProperty("set");

    expect(() => (serverConfigs.port as unknown as Store<number>).set(90)).toThrow(ConfigError);
    expect(() => (serverConfigs.tls.key as unknown as Store<string>).set("k2")).toThrow(ConfigError);
  });

  test("the field's Store is the same instance across accesses", async () => {
    const serverConfigs = await configs.create(
      { port: { type: "number", required: true } },
      { sources: [testSource({ port: 80 })] },
    );

    expect(serverConfigs.port).toBe(serverConfigs.port);
    expect(serverConfigs.port.get()).toBe(80);
  });

  test("falls back to default when no source has a value", async () => {
    const cfg = await configs.create(
      { retries: { type: "number", default: 3 } },
      { sources: [testSource({})] },
    );

    expect(cfg.get()).toEqual({ retries: 3 });
  });

  describe("field.get() type inference", () => {
    test("without a default, the type includes null", async () => {
      const cfg = await configs.create(
        { port: { type: "number" } },
        { sources: [testSource({ port: 3000 })] },
      );

      expectTypeOf(cfg.port.get()).toEqualTypeOf<number | null>();
    });

    test("with a default, the type excludes null", async () => {
      const cfg = await configs.create(
        { port: { type: "number", default: 3000 } },
        { sources: [testSource({})] },
      );

      expectTypeOf(cfg.port.get()).toEqualTypeOf<number>();
    });

    test("required: true, unresolved: the type still includes null", () => {
      const cfg = configs.create(
        { port: { type: "number", required: true } },
        { sources: [testSource({ port: 3000 })] },
      );

      expectTypeOf(cfg.port).toEqualTypeOf<ReadOnlyStore<number | null>>();
    });

    test("required: true, resolved: the type still includes null — required isn't enforced at runtime", async () => {
      const pending = configs.create(
        { port: { type: "number", required: true } },
        { sources: [testSource({ port: 3000 })] },
      );
      const cfg = await pending;

      // this particular source happens to have published a value...
      expect(cfg.port.get()).toBe(3000);
      // ...but the type can't assume that: a `required` field with no `default` still resolves to
      // `null` whenever no source has it (see "resolves required fields with no value anywhere to
      // null instead of throwing" below), so narrowing to non-null here would be unsound.
      expectTypeOf(cfg.port).toEqualTypeOf<ReadOnlyStore<number | null>>();
    });

    test("required: true, resolved, but genuinely no source has the value: still null, proving the type above is honest", async () => {
      const cfg = await configs.create(
        { port: { type: "number", required: true } },
        { sources: [testSource({})] },
      );

      expect(cfg.port.get()).toBeNull();
      expectTypeOf(cfg.port).toEqualTypeOf<ReadOnlyStore<number | null>>();
    });

    test("required: false (default), resolved: the type still includes null", async () => {
      const pending = configs.create(
        { port: { type: "number" } },
        { sources: [testSource({})] },
      );
      const cfg = await pending;

      expect(cfg.port.get()).toBeNull();
      expectTypeOf(cfg.port).toEqualTypeOf<ReadOnlyStore<number | null>>();
    });

    test("resolved, but with a default instead of required: the type excludes null, same as before", async () => {
      const cfg = await configs.create(
        { port: { type: "number", default: 3000 } },
        { sources: [testSource({})] },
      );

      expectTypeOf(cfg.port).toEqualTypeOf<ReadOnlyStore<number>>();
    });

    test("required: true with a default: the value and type are already non-null before the promise resolves", () => {
      let resolveStart: () => void;
      const started = new Promise<void>((resolve) => {
        resolveStart = resolve;
      });
      const slowSource = new Source<{ myFeature: boolean }>({
        async start(control) {
          await started;
          control.set({ myFeature: true });
          control.close();
        },
      });

      const cfg = configs.create(
        { myFeature: { type: "boolean", required: true, default: false } },
        { sources: [slowSource] },
      );

      // the `default` is what backfills the value while no source has published yet — `required`
      // alone (no default) can't do that, since it's only checked once a source resolves.
      expect(cfg.myFeature.get()).toBe(false);
      expectTypeOf(cfg.myFeature).toEqualTypeOf<ReadOnlyStore<boolean>>();

      resolveStart!();
    });
  });

  test("returns null for optional fields with no value", async () => {
    const cfg = await configs.create(
      { nickname: { type: "string" } },
      { sources: [testSource({})] },
    );

    expect(cfg.get()).toEqual({ nickname: null });
  });

  test("resolves required fields with no value anywhere to null instead of throwing", async () => {
    const cfg = await configs.create(
      { apiKey: { type: "string", required: true } },
      { sources: [testSource({})] },
    );

    expect(cfg.get()).toEqual({ apiKey: null });
  });

  test("validates string values against a pattern", async () => {
    const cfg = await configs.create(
      { host: { type: "string", pattern: /^[a-z]+$/ } },
      { sources: [testSource({ host: "not valid!" })] },
    );

    expect(() => cfg.get()).toThrow(ConfigError);
  });

  test("coerces numeric strings but rejects non-numeric ones", async () => {
    const cfg = await configs.create(
      { port: { type: "number" } },
      { sources: [testSource({ port: "1234" })] },
    );
    expect(cfg.get()).toEqual({ port: 1234 });

    const bad = await configs.create(
      { port: { type: "number" } },
      { sources: [testSource({ port: "not-a-number" })] },
    );
    expect(() => bad.get()).toThrow(ConfigError);
  });

  test("coerces boolean-ish strings", async () => {
    const cfg = await configs.create(
      { debug: { type: "boolean" } },
      { sources: [testSource({ debug: "true" })] },
    );
    expect(cfg.get()).toEqual({ debug: true });
  });

  test("a ConfigNode has no set() at all: it's always read-only", async () => {
    const cfg = await configs.create(
      { port: { type: "number" } },
      { sources: [testSource({ port: 3000 })] },
    );
    expectTypeOf(cfg).not.toHaveProperty("set");
    expect((cfg as { set?: unknown }).set).toBeUndefined();
  });

  test("create() without options stays synchronous, for nested groups", () => {
    const group = configs.create({ key: { type: "string" } });
    expectTypeOf(group).not.toEqualTypeOf<Promise<unknown>>();
    expect(group.get()).toEqual({ key: null });
  });
});

describe("named `create` export", () => {
  test("is the same function as configs.create, usable as `import { create } from \"@jondotsoy/configs\"`", async () => {
    const cfg = await create(
      { port: { type: "number", required: true } },
      { sources: [testSource({ port: 3000 })] },
    );

    expect(cfg.port.get()).toBe(3000);
  });
});

describe("nested groups with their own sources", () => {
  test("a nested group resolves its own source independently of the parent", async () => {
    const cfg = await configs.create({
      server: configs.create(
        { port: { type: "number" } },
        { sources: [envSource({ env: { PORT: "3000" }, mapKey: mapKey.snakeCase() })] },
      ),
    });

    expect(cfg.server.port.get()).toBe(3000);
  });

  test("a nested group's own source does not leak into the parent's fields", async () => {
    const cfg = await configs.create(
      {
        name: { type: "string" },
        server: configs.create(
          { port: { type: "number" } },
          { sources: [envSource({ env: { PORT: "3000" }, mapKey: mapKey.snakeCase() })] },
        ),
      },
      { sources: [testSource({ name: "svc" })] },
    );

    expect(cfg.name.get()).toBe("svc");
    expect(cfg.server.port.get()).toBe(3000);
    expect((cfg.get() as Record<string, unknown>).port).toBeUndefined();
  });

  test("the parent's sources do not leak into a nested group with its own source", async () => {
    const cfg = await configs.create(
      {
        server: configs.create(
          { port: { type: "number" } },
          { sources: [envSource({ env: { PORT: "3000" }, mapKey: mapKey.snakeCase() })] },
        ),
      },
      { sources: [testSource({ server: { port: 9999 } })] },
    );

    expect(cfg.server.port.get()).toBe(3000);
  });

  test("multiple independent nested groups each resolve from their own source", async () => {
    const cfg = await configs.create({
      primary: configs.create(
        { port: { type: "number" } },
        { sources: [envSource({ env: { PORT: "3000" }, mapKey: mapKey.snakeCase() })] },
      ),
      secondary: configs.create(
        { port: { type: "number" } },
        { sources: [envSource({ env: { PORT: "4000" }, mapKey: mapKey.snakeCase() })] },
      ),
    });

    expect(cfg.primary.port.get()).toBe(3000);
    expect(cfg.secondary.port.get()).toBe(4000);
  });

  test("closing the parent also closes a nested group's own sources", async () => {
    let closed = false;
    const nestedSource = new Source<{ port: number }>({
      start(control) {
        control.set({ port: 3000 });
        control.close();
      },
      close() {
        closed = true;
      },
    });

    const cfg = await configs.create({
      server: configs.create({ port: { type: "number" } }, { sources: [nestedSource] }),
    });

    expect(cfg.server.port.get()).toBe(3000);
    await cfg.close();
    expect(closed).toBe(true);
  });

  test("stays a synchronous, thenable ConfigNode even once a nested group carries its own sources", () => {
    const pending = configs.create({
      server: configs.create(
        { port: { type: "number" } },
        { sources: [envSource({ env: { PORT: "3000" }, mapKey: mapKey.snakeCase() })] },
      ),
    });

    expectTypeOf(pending).toEqualTypeOf<
      PendingConfigNode<{ server: SchemaGroup<{ port: { type: "number" } }> }>
    >();
  });

  test("infers a nested group's field the same whether it shares or owns its sources", async () => {
    const cfg = await configs.create({
      server: configs.create(
        { port: { type: "number" } },
        { sources: [envSource({ env: { PORT: "3000" }, mapKey: mapKey.snakeCase() })] },
      ),
    });

    expectTypeOf(cfg.server.port.get()).toEqualTypeOf<number | null>();
    expectTypeOf(cfg.server).toHaveProperty("close");
    expectTypeOf(cfg.server.close()).toEqualTypeOf<Promise<void>>();
  });

  describe("multiple sibling groups, each with a different source kind", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    test("an envSource-backed group and a fetchSource-backed group resolve independently", async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ promoService: true }), {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;

      const serverConfigs = await configs.create({
        server: configs.create(
          {
            port: { type: "number", summary: "HTTP port", default: 3000 },
            host: { type: "string", summary: "bind host", default: "localhost" },
          },
          { sources: [envSource({ env: {}, mapKey: mapKey.snakeCase() })] },
        ),
        features: configs.create(
          {
            promoService: { type: "boolean", summary: "enable the promo service", default: false },
          },
          { sources: [fetchSource({ url: "https://example.com/features" })] },
        ),
      });

      expect(serverConfigs.server.port.get()).toBe(3000);
      expect(serverConfigs.server.host.get()).toBe("localhost");
      expect(serverConfigs.features.promoService.get()).toBe(true);
    });

    test("a doubly-nested group reads from its ancestor's fetchSource at the right sub-path", async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ home: { showSummaryActivity: true } }), {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;

      const serverConfigs = await configs.create({
        features: configs.create(
          {
            home: configs.create({
              showSummaryActivity: { type: "boolean" },
            }),
          },
          { sources: [fetchSource({ url: "https://example.com/features" })] },
        ),
      });

      expect(serverConfigs.features.home.showSummaryActivity.get()).toBe(true);
      expectTypeOf(serverConfigs.features.home.showSummaryActivity.get()).toEqualTypeOf<boolean | null>();
    });

    test("infers a default-free null-excluding type for each sibling group's own fields", async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ promoService: true }), {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;

      const serverConfigs = await configs.create({
        server: configs.create(
          {
            port: { type: "number", summary: "HTTP port", default: 3000 },
            host: { type: "string", summary: "bind host", default: "localhost" },
          },
          { sources: [envSource({ env: {}, mapKey: mapKey.snakeCase() })] },
        ),
        features: configs.create(
          {
            promoService: { type: "boolean", summary: "enable the promo service", default: false },
          },
          { sources: [fetchSource({ url: "https://example.com/features" })] },
        ),
      });

      expectTypeOf(serverConfigs.server.port.get()).toEqualTypeOf<number>();
      expectTypeOf(serverConfigs.server.host.get()).toEqualTypeOf<string>();
      expectTypeOf(serverConfigs.features.promoService.get()).toEqualTypeOf<boolean>();

      expectTypeOf(serverConfigs.server.port).toEqualTypeOf<ReadOnlyStore<number>>();
      expectTypeOf(serverConfigs.server.host).toEqualTypeOf<ReadOnlyStore<string>>();
      expectTypeOf(serverConfigs.features.promoService).toEqualTypeOf<ReadOnlyStore<boolean>>();
    });
  });

  describe("several levels of nesting", () => {
    test("resolves fields at every depth of a 4-level-deep embedded tree", async () => {
      const cfg = await configs.create(
        {
          app: configs.create({
            name: { type: "string", required: true },
            server: configs.create({
              port: { type: "number", default: 8080 },
              tls: configs.create({
                cert: configs.create({
                  path: { type: "string", required: true },
                }),
              }),
            }),
          }),
        },
        {
          sources: [
            testSource({
              app: {
                name: "svc",
                server: {
                  port: 3000,
                  tls: { cert: { path: "cert.pem" } },
                },
              },
            }),
          ],
        },
      );

      expect(cfg.app.name.get()).toBe("svc");
      expect(cfg.app.server.port.get()).toBe(3000);
      expect(cfg.app.server.tls.cert.path.get()).toBe("cert.pem");

      expect(cfg.get()).toEqual({
        app: {
          name: "svc",
          server: {
            port: 3000,
            tls: { cert: { path: "cert.pem" } },
          },
        },
      });
    });

    test("an unresolved node exposes defaults and nulls synchronously at every depth, before the source resolves", async () => {
      let resolveStart: () => void;
      const started = new Promise<void>((resolve) => {
        resolveStart = resolve;
      });
      const slowSource = new Source<Record<string, unknown>>({
        async start(control) {
          await started;
          control.set({
            env: "production",
            app: {
              name: "svc",
              server: {
                port: 9090,
                tls: { cert: { path: "cert.pem" } },
              },
            },
          });
          control.close();
        },
      });

      const cfg = configs.create(
        {
          // top-level, required, no default: null until resolved — and stays `string | null`
          // even once resolved, since `required` alone is never enforced at runtime.
          env: { type: "string", required: true },
          app: configs.create({
            // nested, required, no default: same story, one level down.
            name: { type: "string", required: true },
            server: configs.create({
              // a `default` backfills (and narrows the type) the same way whether resolved or not,
              // at any depth — unlike `required`, it's an actual runtime guarantee.
              port: { type: "number", default: 8080 },
              tls: configs.create({
                cert: configs.create({
                  path: { type: "string", required: true, default: "default.pem" },
                }),
              }),
            }),
          }),
        },
        { sources: [slowSource] },
      );

      // before the source resolves: a `default` already backfills the value at any depth, while a
      // plain `required` field (no default) is still null — and the *type* reflects the same split.
      expect(cfg.env.get()).toBeNull();
      expect(cfg.app.name.get()).toBeNull();
      expect(cfg.app.server.port.get()).toBe(8080);
      expect(cfg.app.server.tls.cert.path.get()).toBe("default.pem");

      expectTypeOf(cfg.env).toEqualTypeOf<ReadOnlyStore<string | null>>();
      expectTypeOf(cfg.app.name).toEqualTypeOf<ReadOnlyStore<string | null>>();
      expectTypeOf(cfg.app.server.port).toEqualTypeOf<ReadOnlyStore<number>>();
      expectTypeOf(cfg.app.server.tls.cert.path).toEqualTypeOf<ReadOnlyStore<string>>();

      resolveStart!();
      const resolved = await cfg;

      // once resolved: the source's values win everywhere...
      expect(resolved.env.get()).toBe("production");
      expect(resolved.app.name.get()).toBe("svc");
      expect(resolved.app.server.port.get()).toBe(9090);
      expect(resolved.app.server.tls.cert.path.get()).toBe("cert.pem");

      // ...but a plain `required` field's type stays `T | null` even now, at any depth: this
      // particular source happened to publish a value, but the type can't assume that in general
      // (see "resolved, but genuinely no source has the value" above) — only `default` narrows.
      expectTypeOf(resolved.env).toEqualTypeOf<ReadOnlyStore<string | null>>();
      expectTypeOf(resolved.app.name).toEqualTypeOf<ReadOnlyStore<string | null>>();
    });

    test("falls back through defaults and nulls independently at each depth", async () => {
      const cfg = await configs.create(
        {
          app: configs.create({
            name: { type: "string" },
            server: configs.create({
              port: { type: "number", default: 8080 },
              tls: configs.create({
                cert: configs.create({
                  path: { type: "string", required: true },
                }),
              }),
            }),
          }),
        },
        { sources: [testSource({})] },
      );

      expect(cfg.get()).toEqual({
        app: {
          name: null,
          server: {
            port: 8080,
            tls: { cert: { path: null } },
          },
        },
      });
    });

    test("a group partway down the tree with its own source resolves independently of its ancestors and descendants", async () => {
      const cfg = await configs.create(
        {
          app: configs.create({
            name: { type: "string" },
            server: configs.create(
              {
                port: { type: "number" },
                tls: configs.create({
                  cert: configs.create({
                    path: { type: "string" },
                  }),
                }),
              },
              { sources: [envSource({ env: { PORT: "3000" }, mapKey: mapKey.snakeCase() })] },
            ),
          }),
        },
        { sources: [testSource({ app: { name: "svc", server: { tls: { cert: { path: "cert.pem" } } } } })] },
      );

      expect(cfg.app.name.get()).toBe("svc");
      // `server` owns its own source, so its descendants (`tls`, `cert`) resolve from it too —
      // `port` comes from the envSource...
      expect(cfg.app.server.port.get()).toBe(3000);
      // ...and `path`, absent from that same envSource, does *not* fall through to the
      // ancestor's testSource (which had it), even though that testSource does carry a value there.
      expect(cfg.app.server.tls.cert.path.get()).toBeNull();
    });

    test("stays live through three levels of embedded nesting", async () => {
      const store1 = store.create<Record<string, unknown>>({});
      const source = new Source<Record<string, unknown>>({
        async start(control) {
          control.set(store1.get());
          store1.subscribe((v) => control.set(v));
        },
      });
      store1.set({ a: { b: { c: { value: 1 } } } });

      const cfg = await configs.create(
        {
          a: configs.create({
            b: configs.create({
              c: configs.create({
                value: { type: "number", required: true },
              }),
            }),
          }),
        },
        { sources: [source] },
      );

      const seen: (number | null)[] = [];
      const unsub = cfg.a.b.c.value.subscribe((value) => {
        seen.push(value);
      });

      store1.set({ a: { b: { c: { value: 2 } } } });

      expect(seen).toEqual([1, 2]);

      unsub();
    });

    test("closing the root also closes a source owned by a group several levels down", async () => {
      let closed = false;
      const deepSource = new Source<{ cert: { path: string } }>({
        start(control) {
          // `deepSource` is `tls`'s own source, so values must be shaped from `tls`'s root —
          // including the embedded `cert` sub-path, not just `path` on its own.
          control.set({ cert: { path: "cert.pem" } });
          control.close();
        },
        close() {
          closed = true;
        },
      });

      const cfg = await configs.create({
        app: configs.create({
          server: configs.create({
            tls: configs.create(
              {
                cert: configs.create({ path: { type: "string" } }),
              },
              { sources: [deepSource] },
            ),
          }),
        }),
      });

      expect(cfg.app.server.tls.cert.path.get()).toBe("cert.pem");
      await cfg.close();
      expect(closed).toBe(true);
    });
  });
});

describe("configs.create() as a ConfigNode", () => {
  test("root form returns a plain object synchronously, before it resolves — not a class instance, not a Promise", () => {
    const cfg = configs.create(
      { port: { type: "number" } },
      { sources: [testSource({ port: 3000 })] },
    );

    // a plain object (Proxy over an object literal): no custom prototype/class identity.
    expect(Object.getPrototypeOf(cfg)).toBe(Object.prototype);
    expect(cfg).not.toBeInstanceOf(Promise);
    // but it is thenable, so `await`ing it works.
    expect(typeof cfg.then).toBe("function");
    expectTypeOf(cfg).not.toEqualTypeOf<Promise<unknown>>();
    expectTypeOf(cfg).toEqualTypeOf<PendingConfigNode<{ port: { type: "number" } }>>();
  });

  test("ConfigNode.then() resolves to a plain object with no `then` of its own", async () => {
    const cfg = configs.create(
      { port: { type: "number" } },
      { sources: [testSource({ port: 3000 })] },
    );

    const resolved = await cfg;

    expect(Object.getPrototypeOf(resolved)).toBe(Object.prototype);
    // not thenable: awaiting it again is a plain identity, not another resolution step.
    expect(typeof (resolved as { then?: unknown }).then).toBe("undefined");
    expectTypeOf(resolved).toEqualTypeOf<ConfigNode<{ port: { type: "number" } }>>();
  });

  test("the resolved node still exposes the full ConfigNode surface: get, subscribe, listen, close — but no set, it's always read-only", async () => {
    const cfg = configs.create(
      { port: { type: "number" } },
      { sources: [testSource({ port: 3000 })] },
    );

    const resolved = await cfg;

    expect(typeof resolved.get).toBe("function");
    expect(typeof resolved.subscribe).toBe("function");
    expect(typeof resolved.listen).toBe("function");
    expect(typeof resolved.close).toBe("function");
    expect((resolved as { set?: unknown }).set).toBeUndefined();
    expect(resolved.get()).toEqual({ port: 3000 });
  });

  test("awaiting still exposes live field access on the resolved node", async () => {
    const cfg = await configs.create(
      { port: { type: "number" } },
      { sources: [testSource({ port: 3000 })] },
    );

    expect(cfg.port.get()).toBe(3000);
  });

  test("the field's Store is reachable synchronously before the promise resolves, and reflects the resolved value once it does", async () => {
    let resolveStart: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const source = new Source<{ myFeature: boolean }>({
      async start(control) {
        await started;
        control.set({ myFeature: true });
        control.close();
      },
    });

    const cfg = configs.create(
      { myFeature: { type: "boolean", required: true } },
      { sources: [source] },
    );

    // accessible immediately, without awaiting `cfg`: null until the source publishes.
    expect(cfg.myFeature.get()).toBeNull();
    expectTypeOf(cfg.myFeature).toEqualTypeOf<ReadOnlyStore<boolean | null>>();

    resolveStart!();
    const resolved = await cfg;

    // the runtime value updates once resolved...
    expect(resolved.myFeature.get()).toBe(true);
    // ...but the type stays `boolean | null`: `required` alone isn't enforced at runtime (a
    // source that never sets the field would leave it `null` even after resolving), so the type
    // can't assume non-null just because the promise settled.
    expectTypeOf(resolved.myFeature).toEqualTypeOf<ReadOnlyStore<boolean | null>>();
  });

  test("the unresolved node's field Store stays live and picks up the resolved value even without awaiting it", async () => {
    let resolveStart: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const source = new Source<{ myFeature: boolean }>({
      async start(control) {
        await started;
        control.set({ myFeature: true });
        control.close();
      },
    });

    const cfg = configs.create(
      { myFeature: { type: "boolean", required: true } },
      { sources: [source] },
    );
    const field = cfg.myFeature;

    expect(field.get()).toBeNull();

    resolveStart!();
    await cfg;

    // same Store instance, now reflecting the resolved value.
    expect(field.get()).toBe(true);
  });
});

describe("Source", () => {
  test("resolves the config once control.set() then control.close() are called", async () => {
    const serverConfigs = await configs.create(
      {
        port: { type: "number", summary: "HTTP port", required: true },
        host: { type: "string", pattern: /^[\w.-]+$/, summary: "bind host", required: true },
        tls: configs.create({
          key: { type: "string", summary: "TLS key path", required: true },
          cert: { type: "string", summary: "TLS cert path", required: true },
        }),
      },
      {
        sources: [
          new Source<{
            port: number;
            host: string;
            tls: { key: string; cert: string };
          }>({
            async start(control) {
              control.set({
                port: 3000,
                host: "0.0.0.0",
                tls: { key: "key.pem", cert: "cert.pem" },
              });
              control.close();
            },
          }),
        ],
      },
    );

    expect(serverConfigs.get()).toEqual({
      port: 3000,
      host: "0.0.0.0",
      tls: { key: "key.pem", cert: "cert.pem" },
    });
  });

  test("open() resolves once start() itself finishes, with a Store populated via control.set()", async () => {
    const source = new Source<{ port: number }>({
      async start(control) {
        control.set({ port: 3000 });
      },
    });

    const store = await source.open();
    expect(store.get()).toEqual({ port: 3000 });
  });

  test("open() returns the same live Store on every call", async () => {
    const source = new Source<{ port: number }>({
      async start(control) {
        control.set({ port: 3000 });
      },
    });

    const [storeA, storeB] = await Promise.all([source.open(), source.open()]);
    expect(storeA).toBe(storeB);
  });

  test("the underlying close() runs once control.close() is called from within start()", async () => {
    let closed = false;
    const source = new Source<{ value: number }>({
      async start(control) {
        control.set({ value: 1 });
        control.close();
      },
      async close() {
        closed = true;
      },
    });

    await source.open();
    await Promise.resolve();

    expect(closed).toBe(true);
  });

  test("close() tears down a resource start() set up (e.g. a timer)", async () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let ticks = 0;

    const source = new Source<{ tick: number }>({
      async start(control) {
        control.set({ tick: ticks });
        timer = setInterval(() => control.set({ tick: ++ticks }), 5);
      },
      close() {
        clearInterval(timer);
      },
    });

    await source.open();
    await source.close();
    const ticksAtClose = ticks;

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ticks).toBe(ticksAtClose); // the timer no longer fires after close()
  });

  test("when start() never calls control.set(), the store's value is null", async () => {
    const source = new Source<{ port: number }>({
      async start() {
        // never sets a value
      },
    });

    const store = await source.open();
    expect(store.get()).toBeNull();
  });

  test("a rejected start() rejects configs.create()", async () => {
    const failing = new Source<{ port: number }>({
      async start() {
        throw new Error("boom");
      },
    });

    await expect(
      Promise.resolve(configs.create({ port: { type: "number" } }, { sources: [failing] })),
    ).rejects.toThrow("boom");
  });

  describe("close()", () => {
    test("runs the underlying close() hook", async () => {
      let closed = false;
      const source = new Source<{ port: number }>({
        async start(control) {
          control.set({ port: 3000 });
        },
        async close() {
          closed = true;
        },
      });

      await source.open();
      await source.close();

      expect(closed).toBe(true);
    });

    test("is safe to call multiple times, running the hook only once", async () => {
      let calls = 0;
      const source = new Source<{ port: number }>({
        async start(control) {
          control.set({ port: 3000 });
        },
        async close() {
          calls++;
        },
      });

      await source.open();
      await Promise.all([source.close(), source.close(), source.close()]);

      expect(calls).toBe(1);
    });

    test("resolves even when there's no close() hook", async () => {
      const source = new Source<{ port: number }>({
        async start(control) {
          control.set({ port: 3000 });
        },
      });

      await source.open();
      await expect(source.close()).resolves.toBeUndefined();
    });

    test("calling close() before open() still lets open() resolve, but drops the pending set()", async () => {
      let closed = false;
      const source = new Source<{ port: number }>({
        async start(control) {
          control.set({ port: 3000 });
        },
        async close() {
          closed = true;
        },
      });

      await source.close();
      const store = await source.open();

      expect(store.get()).toBeNull();
      expect(closed).toBe(true);
    });
  });
});

describe("configs.create(...).close()", () => {
  test("closes every configured source", async () => {
    let closedA = false;
    let closedB = false;
    const sourceA = new Source<{ port: number }>({
      async start(control) {
        control.set({ port: 3000 });
      },
      async close() {
        closedA = true;
      },
    });
    const sourceB = new Source<{ host: string }>({
      async start(control) {
        control.set({ host: "localhost" });
      },
      async close() {
        closedB = true;
      },
    });

    const cfg = await configs.create(
      { port: { type: "number" }, host: { type: "string" } },
      { sources: [sourceA, sourceB] },
    );

    await cfg.close();

    expect(closedA).toBe(true);
    expect(closedB).toBe(true);
  });

  test("closes the same sources from a nested group", async () => {
    let closed = false;
    const source = new Source<{ server: { port: number } }>({
      async start(control) {
        control.set({ server: { port: 3000 } });
      },
      async close() {
        closed = true;
      },
    });

    const cfg = await configs.create(
      { server: configs.create({ port: { type: "number" } }) },
      { sources: [source] },
    );

    await cfg.server.close();

    expect(closed).toBe(true);
  });

  test("is a no-op for a nested-form group created without its own sources", async () => {
    const cfg = configs.create({ port: { type: "number" } });
    await expect(cfg.close()).resolves.toBeUndefined();
  });
});

describe("await using configs.create(...)", () => {
  test("disposal closes the config's sources", async () => {
    let closed = false;
    const source = new Source<{ port: number }>({
      async start(control) {
        control.set({ port: 3000 });
      },
      async close() {
        closed = true;
      },
    });

    {
      await using cfg = await configs.create(
        { port: { type: "number" } },
        { sources: [source] },
      );
      expect(cfg.port.get()).toBe(3000);
      expect(closed).toBe(false);
    }

    expect(closed).toBe(true);
  });

  test("disposal happens on scope exit even when the block throws", async () => {
    let closed = false;
    const source = new Source<{ port: number }>({
      async start(control) {
        control.set({ port: 3000 });
      },
      async close() {
        closed = true;
      },
    });

    await expect(
      (async () => {
        await using _cfg = await configs.create(
          { port: { type: "number" } },
          { sources: [source] },
        );
        throw new Error("boom");
      })(),
    ).rejects.toThrow("boom");

    expect(closed).toBe(true);
  });
});

describe("Source wrapping a Store", () => {
  function testSourceStream<T>(value: Store<T>): Source<T> {
    return new Source<T>({
      async start(control) {
        control.set(value.get());
        value.subscribe((v) => control.set(v));
      },
    });
  }

  test("first store's value wins when both have the field", async () => {
    const store1 = store.create<Record<string, unknown>>({});
    const store2 = store.create<Record<string, unknown>>({});
    store1.set({ port: 3000 });
    store2.set({});

    const serverConfigs = await configs.create(
      { port: { type: "number", summary: "HTTP port", required: true } },
      { sources: [testSourceStream(store1), testSourceStream(store2)] },
    );

    expect(serverConfigs.port.get()).toBe(3000);
  });

  test("resolves to null when neither store has the field", async () => {
    const store1 = store.create<Record<string, unknown>>({});
    const store2 = store.create<Record<string, unknown>>({});
    store1.set({});
    store2.set({});

    const serverConfigs = await configs.create(
      { port: { type: "number", summary: "HTTP port", required: true } },
      { sources: [testSourceStream(store1), testSourceStream(store2)] },
    );

    expect(serverConfigs.port.get()).toBeNull();
  });

  test("coerces a numeric string from the first store", async () => {
    const store1 = store.create<Record<string, unknown>>({});
    const store2 = store.create<Record<string, unknown>>({});
    store1.set({ port: "8989" });
    store2.set({});

    const serverConfigs = await configs.create(
      { port: { type: "number", summary: "HTTP port", required: true } },
      { sources: [testSourceStream(store1), testSourceStream(store2)] },
    );

    expect(serverConfigs.port.get()).toBe(8989);
  });

  test("stays live: a later change on the winning store updates the field's .get()", async () => {
    const store1 = store.create<Record<string, unknown>>({});
    const store2 = store.create<Record<string, unknown>>({});
    store1.set({ port: 3000 });
    store2.set({});

    const serverConfigs = await configs.create(
      { port: { type: "number", summary: "HTTP port", required: true } },
      { sources: [testSourceStream(store1), testSourceStream(store2)] },
    );

    expect(serverConfigs.port.get()).toBe(3000);

    store1.set({ port: 9090 });

    expect(serverConfigs.port.get()).toBe(9090);
  });

  test("stays live: subscribers are notified when a later change updates the field", async () => {
    const store1 = store.create<Record<string, unknown>>({});
    const store2 = store.create<Record<string, unknown>>({});
    store1.set({ port: 3000 });
    store2.set({});

    const serverConfigs = await configs.create(
      { port: { type: "number", summary: "HTTP port", required: true } },
      { sources: [testSourceStream(store1), testSourceStream(store2)] },
    );

    const seen: (number | null)[] = [];
    const unsub = serverConfigs.port.subscribe((value) => {
      seen.push(value);
    });

    store1.set({ port: 9090 });

    expect(seen).toEqual([3000, 9090]);

    unsub();
  });

  test("stays live: a losing store's change is silent, but resolving falls through once the winner drops out", async () => {
    const store1 = store.create<Record<string, unknown>>({});
    const store2 = store.create<Record<string, unknown>>({});
    store1.set({ port: 3000 });
    store2.set({});

    const serverConfigs = await configs.create(
      { port: { type: "number", summary: "HTTP port", required: true } },
      { sources: [testSourceStream(store1), testSourceStream(store2)] },
    );

    const seen: (number | null)[] = [];
    const unsub = serverConfigs.port.subscribe((value) => {
      seen.push(value);
    });

    store1.set({ port: 9090 });
    // store1 still wins over store2, so this resolves to the same 9090: no emission.
    store2.set({ port: 1414 });
    // store1 no longer has a port, so resolution falls through to store2's already-set 1414.
    store1.set({ port: null });

    expect(seen).toEqual([3000, 9090, 1414]);

    unsub();
  });

  test("stays live through a nested group", async () => {
    const store1 = store.create<Record<string, unknown>>({});
    const store2 = store.create<Record<string, unknown>>({});
    store1.set({ server: { port: 3000 } });
    store2.set({});

    const systemConfigs = await configs.create(
      {
        server: configs.create({
          port: { type: "number", summary: "HTTP port", required: true },
        }),
      },
      { sources: [testSourceStream(store1), testSourceStream(store2)] },
    );

    const seen: (number | null)[] = [];
    const unsub = systemConfigs.server.port.subscribe((value) => {
      seen.push(value);
    });

    store1.set({ server: { port: 9090 } });
    // store1 still wins over store2, so this resolves to the same 9090: no emission.
    store2.set({ server: { port: 1414 } });
    // store1 no longer has a port, so resolution falls through to store2's already-set 1414.
    store1.set({ server: { port: null } });

    expect(seen).toEqual([3000, 9090, 1414]);

    unsub();
  });

  test("a readonly field freezes at its first resolved value, ignoring later source updates", async () => {
    const store1 = store.create<Record<string, unknown>>({});
    store1.set({ port: 3000 });

    const cfg = await configs.create(
      { port: { type: "number", readonly: true } },
      { sources: [testSourceStream(store1)] },
    );

    expect(cfg.port.get()).toBe(3000);

    store1.set({ port: 9090 });

    expect(cfg.port.get()).toBe(3000);
  });

  test("cfg.get() reflects a readonly field frozen at its first resolved value", async () => {
    const store1 = store.create<Record<string, unknown>>({});
    store1.set({ port: 3000 });

    const cfg = await configs.create(
      { port: { type: "number", readonly: true } },
      { sources: [testSourceStream(store1)] },
    );

    expect(cfg.get()).toEqual({ port: 3000 });

    store1.set({ port: 4000 });

    expect(cfg.get()).toEqual({ port: 3000 });
  });

  test("cfg.subscribe() fires only once for a readonly field, since its resolved snapshot never mutates", async () => {
    const store1 = store.create<Record<string, unknown>>({});
    store1.set({ port: 3000 });

    const cfg = await configs.create(
      { port: { type: "number", readonly: true } },
      { sources: [testSourceStream(store1)] },
    );

    const seen: { port: number | null }[] = [];
    const unsub = cfg.subscribe((value) => {
      seen.push(value);
    });

    expect(seen).toEqual([{ port: 3000 }]);

    store1.set({ port: 4000 });

    // the field is readonly, so the resolved snapshot is still { port: 3000 }: no new emission.
    expect(seen).toEqual([{ port: 3000 }]);

    unsub();
  });

  test("cfg.listen() does not fire immediately, and never fires again for a readonly field", async () => {
    const store1 = store.create<Record<string, unknown>>({});
    store1.set({ port: 3000 });

    const cfg = await configs.create(
      { port: { type: "number", readonly: true } },
      { sources: [testSourceStream(store1)] },
    );

    const seen: { port: number | null }[] = [];
    const unsub = cfg.listen((value) => {
      seen.push(value);
    });

    expect(seen).toEqual([]);

    store1.set({ port: 4000 });

    expect(seen).toEqual([]);

    unsub();
  });
});
