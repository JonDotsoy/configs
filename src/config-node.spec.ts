import { describe, expect, expectTypeOf, spyOn, test } from "bun:test";
import { create, isConfigsNode, type ConfigsNode, type ConfigsNodePending, type ConfigsShape, type Options } from "./config-node.ts";
import { boolean, choice, Descriptor, isConfigDescriptor, numeric, shape, string, url } from "./config-descriptor.ts";
import { ConfigError } from "./errors.ts";
import { envSource } from "./sources/env.ts";
import { Source } from "./sources/source.ts";
import { Store, type ReadOnlyStore } from "./utils/store.ts";
import { z } from "zod";

function testSource<T>(value: T): Source<T> {
  return new Source<T>({
    async start(control) {
      control.set(value);
      control.close();
    },
  });
}

/** A `Source` that never closes, so `push()` can publish further snapshots after `open()` resolves. */
function liveTestSource<T>(initial: T): { source: Source<T>; push: (value: T) => void } {
  let push: (value: T) => void = () => {};
  const source = new Source<T>({
    start(control) {
      control.set(initial);
      push = (value: T) => control.set(value);
    },
  });
  return { source, push: (value: T) => push(value) };
}

describe("create", () => {
  test("resolves every field synchronously (default) and live once its source opens", async () => {
    const shape = { port: numeric({ default: 3000 }) };
    const cfg = create(shape, { sources: [testSource({ port: "8080" })] });

    expect(cfg.port.get()).toBe(3000);

    const resolved = await cfg;

    expect(resolved.port.get()).toBe(8080);
    expect(resolved.port).toBe(cfg.port);
  });

  test("first source (in array order) whose snapshot has the field wins", async () => {
    const shape = { host: string({ default: "localhost" }) };
    const cfg = await create(shape, {
      sources: [testSource({}), testSource({ host: "example.com" })],
    });

    expect(cfg.host.get()).toBe("example.com");
  });

  test("without sources, resolves immediately to every field's default", async () => {
    const shape = { port: numeric({ default: 3000 }) };
    const resolved = await create(shape);

    expect(resolved.port.get()).toBe(3000);
  });

  test("a field with a default resolves to it synchronously, no sources needed, and stays overridable by a source", async () => {
    const shape = { port: numeric({ default: 4000 }) };
    const cfg = create(shape, { sources: [testSource({ port: "9000" })] });

    expect(cfg.port.get()).toBe(4000);
    expectTypeOf(cfg.port.get()).toEqualTypeOf<number>();

    const resolved = await cfg;

    expect(resolved.port.get()).toBe(9000);
  });

  test("types: each field is a Store, and the pending node stays awaitable to a plain node", () => {
    const shape = { port: numeric() };
    const cfg = create(shape);

    expectTypeOf(cfg).toEqualTypeOf<ConfigsNodePending<typeof shape>>();
    expectTypeOf(cfg.port).toEqualTypeOf<Store<number | null>>();
  });

  test("types: a field with a default narrows out null", () => {
    const shape = { port: numeric({ default: 3000 }) };
    const cfg = create(shape);

    expectTypeOf(cfg.port).toEqualTypeOf<Store<number>>();
  });
});

describe("create — nested groups", () => {
  test("a plain nested object in the shape becomes a nested group of Stores, resolved via its own nested path", async () => {
    const shape = { server: { port: numeric({ default: 3000 }) } };
    const cfg = create(shape, { sources: [testSource({ server: { port: "8080" } })] });

    expect(cfg.server.port.get()).toBe(3000);

    const resolved = await cfg;

    expect(resolved.server.port.get()).toBe(8080);
    expect(resolved.server.port).toBe(cfg.server.port);
  });

  test("nesting can go several levels deep", async () => {
    const shape = { a: { b: { c: numeric({ default: 1 }) } } };
    const cfg = await create(shape, { sources: [testSource({ a: { b: { c: "2" } } })] });

    expect(cfg.a.b.c.get()).toBe(2);
  });

  test("types: create({ server: { port: numeric() } }) resolves to { server: { port: ReadOnlyStore<number | null> } }", () => {
    const cfg = create({ server: { port: numeric() } });

    expectTypeOf(cfg.server).toEqualTypeOf<{ port: Store<number | null> }>();
    expectTypeOf(cfg.server.port).toMatchTypeOf<ReadOnlyStore<number | null>>();
  });
});

describe("create — embedding another create() result", () => {
  test("isConfigsNode() recognizes a node returned by create(), and nothing else", () => {
    const node = create({ port: numeric() });

    expect(isConfigsNode(node)).toBe(true);
    expect(isConfigsNode({ port: numeric() })).toBe(false);
    expect(isConfigsNode(null)).toBe(false);
    expect(isConfigsNode(42)).toBe(false);
  });

  test("an embedded create() result is adopted as-is — same Store identity, resolved from its own sources", async () => {
    const tls = create(
      { cert: string(), key: string() },
      { sources: [testSource({ cert: "cert.pem", key: "key.pem" })] },
    );

    const cfg = create({
      port: numeric({ default: 3000 }),
      server: { tls },
    });

    // Adopted by reference: the parent doesn't rebuild it.
    expect(cfg.server.tls).toBe(tls);

    const resolved = await cfg;

    expect(resolved.port.get()).toBe(3000);
    expect(resolved.server.tls.cert.get()).toBe("cert.pem");
    expect(resolved.server.tls.key.get()).toBe("key.pem");
  });

  test("an embedded node's own sources are independent of the parent's — never looked up against the parent's path", async () => {
    const tls = create({ cert: string({ default: "default.pem" }) }, { sources: [testSource({ cert: "inner.pem" })] });

    // The parent's own source publishes something at "server.tls.cert" too — the embedded node
    // must never see it, since it resolves only from its own sources.
    const cfg = await create(
      { server: { tls } },
      { sources: [testSource({ server: { tls: { cert: "outer.pem" } } })] },
    );

    expect(cfg.server.tls.cert.get()).toBe("inner.pem");
  });

  test("awaiting the outer node also waits for the embedded node's own (slower) sources", async () => {
    const opened: string[] = [];
    const delayedSource = new Source<{ tar: string }>({
      async start(control) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        opened.push("inner");
        control.set({ tar: "42" });
        control.close();
      },
    });

    const inner = create({ tar: numeric() }, { sources: [delayedSource] });
    const cfg = create({ foo: inner });

    const resolved = await cfg;

    expect(opened).toEqual(["inner"]);
    expect(resolved.foo.tar.get()).toBe(42);
  });

  test("a live update in the embedded node's own source updates its Store in place, visible through the parent", async () => {
    const { source, push } = liveTestSource({ port: "3000" });
    const inner = create({ port: numeric() }, { sources: [source] });
    const cfg = await create({ server: inner });

    expect(cfg.server.port.get()).toBe(3000);

    push({ port: "4000" });

    expect(cfg.server.port.get()).toBe(4000);
  });

  test("types: an embedded create() result's field types flow through the parent's ConfigsNode", () => {
    const tls = create({ cert: string(), key: string({ default: "k" }) });
    const cfg = create({ server: { tls } });

    expectTypeOf(cfg.server.tls.cert).toEqualTypeOf<Store<string | null>>();
    expectTypeOf(cfg.server.tls.key).toEqualTypeOf<Store<string>>();
  });
});

describe("create — key: reading a field from an explicit path", () => {
  test("a field's key overrides its own shape position — create({ key: numeric({ key: \"PORT\" }) }) reads PORT, not \"key\"", async () => {
    const cfg = await create({ key: numeric({ key: "PORT" }) }, { sources: [envSource({ env: { PORT: "4000" } })] });

    expect(cfg.key.get()).toBe(4000);
  });

  test("key still resolves relative to the top level even when the field itself is nested", async () => {
    const cfg = await create(
      { server: { port: numeric({ key: "PORT" }) } },
      { sources: [envSource({ env: { PORT: "4000", "server.port": "9999" } })] },
    );

    // "PORT" wins over the nested "server.port" — the shape's own nesting is ignored once `key` is set.
    expect(cfg.server.port.get()).toBe(4000);
  });

  test("key works the same way inside an embedded create() — resolved against its own independent source only", async () => {
    const server = create({ key: numeric({ key: "PORT" }) }, { sources: [envSource({ env: { PORT: "5000" } })] });

    const cfg = await create(
      { server },
      {
        sources: [
          envSource({ env: { PORT: "9999" } }),
          testSource({ server: { key: "1111" } }),
        ],
      },
    );

    // The embedded node's own PORT=5000 wins — never the outer PORT=9999, and never the nested
    // testSource's server.key=1111 either, since the embedded node ignores the parent's sources
    // entirely (see "create — embedding another create() result" above).
    expect(cfg.server.key.get()).toBe(5000);
  });
});

describe("types — every field builder", () => {
  test("without a default, every builder's field is Store<T | null>", () => {
    const cfg = create({
      host: string(),
      port: numeric(),
      debug: boolean(),
      endpoint: url(),
      logLevel: choice({ options: ["debug", "info", "warn", "error"] as const }),
      metadata: shape(),
      jwt: shape({ schema: z.object({ issuer: z.string(), ttl: z.number() }) }),
    });

    expectTypeOf(cfg.host).toEqualTypeOf<Store<string | null>>();
    expectTypeOf(cfg.port).toEqualTypeOf<Store<number | null>>();
    expectTypeOf(cfg.debug).toEqualTypeOf<Store<boolean | null>>();
    expectTypeOf(cfg.endpoint).toEqualTypeOf<Store<URL | null>>();
    expectTypeOf(cfg.logLevel).toEqualTypeOf<Store<"debug" | "info" | "warn" | "error" | null>>();
    expectTypeOf(cfg.metadata).toEqualTypeOf<Store<unknown>>();
    expectTypeOf(cfg.jwt).toEqualTypeOf<Store<{ issuer: string; ttl: number } | null>>();
  });

  test("with a default, every builder's field narrows out null", () => {
    const cfg = create({
      host: string({ default: "localhost" }),
      port: numeric({ default: 3000 }),
      debug: boolean({ default: false }),
      endpoint: url({ default: new URL("http://localhost") }),
      logLevel: choice({ options: ["debug", "info", "warn", "error"] as const, default: "info" }),
      jwt: shape({ schema: z.object({ issuer: z.string(), ttl: z.number() }), default: { issuer: "a", ttl: 1 } }),
    });

    expectTypeOf(cfg.host).toEqualTypeOf<Store<string>>();
    expectTypeOf(cfg.port).toEqualTypeOf<Store<number>>();
    expectTypeOf(cfg.debug).toEqualTypeOf<Store<boolean>>();
    expectTypeOf(cfg.endpoint).toEqualTypeOf<Store<URL>>();
    expectTypeOf(cfg.logLevel).toEqualTypeOf<Store<"debug" | "info" | "warn" | "error">>();
    expectTypeOf(cfg.jwt).toEqualTypeOf<Store<{ issuer: string; ttl: number }>>();
  });
});

describe("types — ConfigsNode / ConfigsNodePending / Options", () => {
  test("ConfigsNode<T> maps a flat shape's keys straight to Store<T>", () => {
    type Shape = { port: ReturnType<typeof numeric<{ default: 3000 }>> };
    expectTypeOf<ConfigsNode<Shape>>().toEqualTypeOf<{ port: Store<number> }>();
  });

  test("ConfigsNode<T> recurses into a nested shape entry", () => {
    type Shape = { server: { port: ReturnType<typeof numeric> } };
    expectTypeOf<ConfigsNode<Shape>>().toEqualTypeOf<{ server: { port: Store<number | null> } }>();
  });

  test("ConfigsNodePending<T> is ConfigsNode<T> plus a then() that resolves to ConfigsNode<T>", () => {
    type Shape = { port: ReturnType<typeof numeric> };
    expectTypeOf<ConfigsNodePending<Shape>>().toMatchTypeOf<ConfigsNode<Shape>>();
    expectTypeOf<Awaited<ConfigsNodePending<Shape>>>().toEqualTypeOf<ConfigsNode<Shape>>();
  });

  test("create()'s return type is exactly ConfigsNodePending<typeof shape>, and awaiting it drops `then`", async () => {
    const shape = { port: numeric({ default: 3000 }) };
    const cfg = create(shape);

    expectTypeOf(cfg).toEqualTypeOf<ConfigsNodePending<typeof shape>>();

    const resolved = await cfg;
    expectTypeOf(resolved).toEqualTypeOf<ConfigsNode<typeof shape>>();
  });

  test("Options.sources accepts an array of Source<any> and is itself optional", () => {
    expectTypeOf<Options>().toEqualTypeOf<{ sources?: Source<any>[] }>();

    type Shape = { port: ReturnType<typeof numeric> };
    // create()'s second parameter is optional and, when given, must be an `Options`.
    create<Shape>({ port: numeric() });
    create<Shape>({ port: numeric() }, {});
    create<Shape>({ port: numeric() }, { sources: [] });
  });

  test("ConfigsShape allows both a leaf ConfigDescriptor and an arbitrarily nested plain object", () => {
    const shape = {
      port: numeric(),
      server: {
        host: string(),
        tls: { cert: string(), key: string() },
      },
    } satisfies ConfigsShape;

    const cfg = create(shape);
    expectTypeOf(cfg.server.tls).toEqualTypeOf<{ cert: Store<string | null>; key: Store<string | null> }>();
  });
});

describe("create — deep nesting (mirrors the legacy engine's multi-level merge tests)", () => {
  test("resolves a field 7 levels deep, matched against the same nested path in the source's snapshot", async () => {
    const treeShape = {
      foo: { tar: { biz: { liz: { lol: { flip: { fof: numeric() } } } } } },
    };
    const cfg = await create(treeShape, {
      sources: [testSource({ foo: { tar: { biz: { liz: { lol: { flip: { fof: "42" } } } } } } })],
    });

    const value = cfg.foo.tar.biz.liz.lol.flip.fof.get();

    expect(typeof value).toBe("number");
    expect(value).toBe(42);
    expectTypeOf(cfg.foo.tar.biz.liz.lol.flip.fof).toEqualTypeOf<Store<number | null>>();
  });

  test("resolves to null at the same depth when the leaf is unset and there's no default", async () => {
    const treeShape = {
      foo: { tar: { biz: { liz: { lol: { flip: { fof: numeric() } } } } } },
    };
    const cfg = await create(treeShape, { sources: [testSource({ foo: { tar: {} } })] });

    expect(cfg.foo.tar.biz.liz.lol.flip.fof.get()).toBeNull();
  });

  test("earlier sources win per leaf field, independent of nesting depth — a field missing there falls through to the next source", async () => {
    const treeShape = {
      foo: {
        tar: {
          fof: numeric(),
          other: string(),
        },
      },
    };

    const cfg = await create(treeShape, {
      sources: [
        // only "other" here
        testSource({ foo: { tar: { other: "from-source-1" } } }),
        // "fof" falls through to here; "other" is shadowed by the earlier source
        testSource({ foo: { tar: { fof: "99", other: "from-source-2" } } }),
      ],
    });

    expect(cfg.foo.tar.fof.get()).toBe(99);
    expect(cfg.foo.tar.other.get()).toBe("from-source-1");
  });

  test("nested groups mix independently-typed siblings at multiple depths", async () => {
    const treeShape = {
      port: numeric({ default: 3000 }),
      server: {
        host: string({ default: "localhost" }),
        tls: {
          enabled: boolean({ default: false }),
          cert: string(),
        },
      },
    };

    const cfg = await create(treeShape, {
      sources: [testSource({ port: "8080", server: { host: "example.com", tls: { enabled: "true", cert: "cert.pem" } } })],
    });

    expect(cfg.port.get()).toBe(8080);
    expect(cfg.server.host.get()).toBe("example.com");
    expect(cfg.server.tls.enabled.get()).toBe(true);
    expect(cfg.server.tls.cert.get()).toBe("cert.pem");
  });
});

describe("create — live updates", () => {
  test("a source that keeps publishing new snapshots updates the already-returned Store in place", async () => {
    const { source, push } = liveTestSource({ port: "3000" });
    const cfg = await create({ port: numeric() }, { sources: [source] });

    expect(cfg.port.get()).toBe(3000);

    push({ port: "4000" });

    expect(cfg.port.get()).toBe(4000);
  });

  test("a live update to a nested leaf updates that leaf's Store, without disturbing its siblings", async () => {
    const { source, push } = liveTestSource({ server: { port: "3000", host: "a.example.com" } });
    const cfg = await create({ server: { port: numeric(), host: string() } }, { sources: [source] });

    expect(cfg.server.port.get()).toBe(3000);
    expect(cfg.server.host.get()).toBe("a.example.com");

    push({ server: { port: "4000", host: "a.example.com" } });

    expect(cfg.server.port.get()).toBe(4000);
    expect(cfg.server.host.get()).toBe("a.example.com");
  });

  test("a live update from a lower-priority source is still shadowed by an earlier source that already has the field", async () => {
    const { source: liveSource, push } = liveTestSource<{ port?: string }>({});
    const cfg = await create(
      { port: numeric({ default: 0 }) },
      { sources: [testSource({ port: "1111" }), liveSource] },
    );

    expect(cfg.port.get()).toBe(1111);

    push({ port: "2222" });

    // testSource's snapshot never changes — it still wins, since it comes first.
    expect(cfg.port.get()).toBe(1111);
  });
});

describe("create — close()", () => {
  test("closes every own source", async () => {
    let closed = false;
    const source = new Source<{ port?: string }>({
      async start(control) {
        control.set({ port: "3000" });
      },
      async close() {
        closed = true;
      },
    });
    const cfg = create({ port: numeric() }, { sources: [source] });
    await cfg;

    await cfg.close();

    expect(closed).toBe(true);
  });

  test("closes every field descriptor's own close hook, at every nesting depth", async () => {
    const closedFields: string[] = [];
    function tracked(name: string) {
      return new Descriptor<string>({
        type: "tracked",
        options: {},
        start: (raw) => String(raw),
        async close() {
          closedFields.push(name);
        },
      });
    }

    const cfg = create(
      { port: tracked("port"), server: { host: tracked("host") } },
      { sources: [testSource({ port: "3000", server: { host: "example.com" } })] },
    );
    await cfg;

    await cfg.close();

    expect(closedFields.sort()).toEqual(["host", "port"]);
  });

  test("closes an embedded create() result's own close(), cascading into its own sources", async () => {
    let embeddedClosed = false;
    const embeddedSource = new Source<{ cert?: string }>({
      async start(control) {
        control.set({ cert: "cert.pem" });
      },
      async close() {
        embeddedClosed = true;
      },
    });

    const cfg = create({
      server: { tls: create({ cert: string() }, { sources: [embeddedSource] }) },
    });
    await cfg;

    await cfg.close();

    expect(embeddedClosed).toBe(true);
  });

  test("a hand-written descriptor with no close() doesn't break close()", async () => {
    const handWritten = {
      start: (raw: unknown) => String(raw),
      async reduce(rawStore: Store<unknown>) {
        return new Store(String(rawStore.get()));
      },
    };

    const cfg = create({ field: handWritten as any }, { sources: [testSource({ field: "abc" })] });
    await cfg;

    await expect(cfg.close()).resolves.toBeUndefined();
  });
});

describe("create — parser failures", () => {
  test("a raw value that fails the field's own parser rejects the awaited node with a ConfigError", async () => {
    const cfg = create({ port: numeric() }, { sources: [testSource({ port: "not-a-number" })] });

    // No source has opened yet, so the field falls back to null — no throw before that.
    expect(cfg.port.get()).toBeNull();

    await expect(Promise.resolve(cfg)).rejects.toThrow(ConfigError);
  });

  test("shape() with required:true rejects the awaited node instead of logging", async () => {
    const cfg = create(
      { jwt: shape({ schema: z.object({ issuer: z.string() }), required: true }) },
      { sources: [testSource({ jwt: { issuer: 42 } })] },
    );

    await expect(Promise.resolve(cfg)).rejects.toThrow(ConfigError);
  });

  test("shape() without required:true logs the failure and resolves the field to null instead of throwing", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const resolved = await create(
        { jwt: shape({ schema: z.object({ issuer: z.string() }) }) },
        { sources: [testSource({ jwt: { issuer: 42 } })] },
      );

      expect(resolved.jwt.get()).toBeNull();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("create — every field builder resolves its raw value at runtime", () => {
  test("string()/numeric()/boolean()/url()/choice() coerce their raw string values", async () => {
    const cfg = await create(
      {
        host: string({ pattern: /^[\w.-]+$/ }),
        port: numeric(),
        debug: boolean(),
        endpoint: url(),
        logLevel: choice({ options: ["debug", "info", "warn", "error"] as const }),
      },
      {
        sources: [
          testSource({
            host: "example.com",
            port: "8080",
            debug: "true",
            endpoint: "https://example.com",
            logLevel: "warn",
          }),
        ],
      },
    );

    expect(cfg.host.get()).toBe("example.com");
    expect(cfg.port.get()).toBe(8080);
    expect(cfg.debug.get()).toBe(true);
    expect(cfg.endpoint.get()).toEqual(new URL("https://example.com"));
    expect(cfg.logLevel.get()).toBe("warn");
  });

  test("choice() rejects a raw value outside its declared options", async () => {
    const cfg = create(
      { logLevel: choice({ options: ["debug", "info"] as const }) },
      { sources: [testSource({ logLevel: "not-a-level" })] },
    );

    await expect(Promise.resolve(cfg)).rejects.toThrow(ConfigError);
  });

  test("url() rejects a raw value that isn't a valid URL", async () => {
    const cfg = create({ endpoint: url() }, { sources: [testSource({ endpoint: "not a url" })] });

    await expect(Promise.resolve(cfg)).rejects.toThrow(ConfigError);
  });

  test("shape() without a schema passes any object value through untyped", async () => {
    const cfg = await create({ metadata: shape() }, { sources: [testSource({ metadata: { any: "thing" } })] });

    expect(cfg.metadata.get()).toEqual({ any: "thing" });
  });
});

describe("create — a hand-written custom Descriptor (structural start()/reduce() contract)", () => {
  // Cast to `Descriptor` since `ConfigsShape` is typed against the real class — the hand-written
  // contract (key? + start() + reduce()) is a runtime-only extension point, recognized
  // structurally by `isConfigDescriptor()` (no tag needed) but not by the shape's own static type.
  // `reduce()` is what actually keeps the field live — `start()` alone only seeds its very first
  // value, before any source has even opened.
  function csv(options: { key?: string | string[] } = {}): Descriptor<string[], { key?: string | string[] }> {
    const parse = (raw: unknown) => (typeof raw === "string" ? raw.split(",").map((s) => s.trim()) : []);

    return {
      key: options.key,
      start(raw: unknown) {
        return parse(raw);
      },
      async reduce(rawStore: Store<unknown>) {
        const store = new Store<string[]>(parse(rawStore.get()));
        rawStore.listen((raw) => store.set(parse(raw)));
        return store;
      },
    } as unknown as Descriptor<string[], { key?: string | string[] }>;
  }

  test("create() resolves a field backed by a hand-written descriptor, same as a built-in one", async () => {
    const cfg = await create(
      { allowedOrigins: csv() },
      { sources: [testSource({ allowedOrigins: "a.com, b.com, c.com" })] },
    );

    expect(cfg.allowedOrigins.get()).toEqual(["a.com", "b.com", "c.com"]);
  });

  test("respects the hand-written descriptor's own key override", async () => {
    const cfg = await create(
      { server: { allowedOrigins: csv({ key: "ALLOWED_ORIGINS" }) } },
      { sources: [testSource({ ALLOWED_ORIGINS: "a.com, b.com" })] },
    );

    expect(cfg.server.allowedOrigins.get()).toEqual(["a.com", "b.com"]);
  });

  test("stays live: updates when its source publishes a new value", async () => {
    const { source, push } = liveTestSource({ allowedOrigins: "a.com" });
    const cfg = await create({ allowedOrigins: csv() }, { sources: [source] });

    expect(cfg.allowedOrigins.get()).toEqual(["a.com"]);

    push({ allowedOrigins: "b.com, c.com" });

    expect(cfg.allowedOrigins.get()).toEqual(["b.com", "c.com"]);
  });

  test("an object with only start() (no reduce()) isn't a Descriptor at all — create() treats it as a nested group instead", () => {
    const startOnly = { start: (raw: unknown) => String(raw) };

    expect(isConfigDescriptor(startOnly)).toBe(false);
  });

  test("if reduce()'s own Store doesn't stay live off rawStore, the field is pinned at whatever it resolved with", async () => {
    const pinned = {
      start(raw: unknown) {
        return typeof raw === "string" ? raw.split(",").map((s) => s.trim()) : [];
      },
      async reduce(rawStore: Store<unknown>) {
        // Snapshots once and never listens — deliberately not live, unlike `csv()` above.
        const raw = rawStore.get();
        return new Store<string[]>(typeof raw === "string" ? raw.split(",").map((s) => s.trim()) : []);
      },
    } as unknown as Descriptor<string[], object>;

    const { source, push } = liveTestSource({ allowedOrigins: "a.com" });
    const cfg = await create({ allowedOrigins: pinned }, { sources: [source] });

    // `reduce()` ran (and snapshotted `rawStore`) before `source` had even opened, so it's stuck
    // with the empty snapshot it saw then — it never listened, so it never sees anything later.
    expect(cfg.allowedOrigins.get()).toEqual([]);

    push({ allowedOrigins: "b.com, c.com" });

    expect(cfg.allowedOrigins.get()).toEqual([]);
  });
});
