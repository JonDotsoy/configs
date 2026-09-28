import { describe, expect, expectTypeOf, mock, spyOn, test } from "bun:test";
import { create, isConfigsNode, type ConfigsNode, type ConfigsNodePending, type ConfigsNodeReady, type ConfigsShape, type Options } from "./config-node.ts";
import { boolean, choice, Descriptor, isConfigDescriptor, list, numeric, shape, string, url, type DescriptorControl } from "./config-descriptor.ts";
import { ConfigError, ConfigValidationError } from "./errors.ts";
import { envSource } from "./sources/env.ts";
import { literalSource } from "./sources/literal.ts";
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

  test("types: required without a default does NOT narrow the pending node — `.get()` on the still-unresolved `Store` can genuinely be null at that exact moment", () => {
    const shape = { port: numeric({ required: true }) };
    const cfg = create(shape, { sources: [testSource({ port: 3000 })] });

    expectTypeOf(cfg.port).toEqualTypeOf<Store<number | null>>();
  });

  test("types: list() with required alone narrows only once awaited, same as every other field type", async () => {
    const cfg = create({ tags: list({ required: true }) }, { sources: [testSource({ tags: "a,b" })] });

    expectTypeOf(cfg.tags).toEqualTypeOf<Store<string[] | null>>();

    const resolved = await cfg;

    expectTypeOf(resolved.tags).toEqualTypeOf<Store<string[]>>();
  });

  test("types: awaiting narrows each field by its own descriptor's `Awaited` type parameter — a default always narrows out null, `required` alone narrows it only once awaited, and neither narrows the still-pending node", async () => {
    const withDefault = create({ port: numeric({ default: 3000 }) });
    const withoutDefault = create({ port: numeric() });
    const requiredOnly = create({ port: numeric({ required: true }) }, { sources: [testSource({ port: 3000 })] });

    // Pending (before await): only `default` narrows.
    expectTypeOf(withDefault.port).toEqualTypeOf<Store<number>>();
    expectTypeOf(withoutDefault.port).toEqualTypeOf<Store<number | null>>();
    expectTypeOf(requiredOnly.port).toEqualTypeOf<Store<number | null>>();

    const readyWithDefault = await withDefault;
    const readyWithoutDefault = await withoutDefault;
    const readyRequiredOnly = await requiredOnly;

    // Awaited (after await): `default` or bare `required` both narrow.
    expectTypeOf(readyWithDefault.port).toEqualTypeOf<Store<number>>();
    expectTypeOf(readyWithoutDefault.port).toEqualTypeOf<Store<number | null>>();
    expectTypeOf(readyRequiredOnly.port).toEqualTypeOf<Store<number>>();
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

describe("create — control.keys: a source sees every field path before its start() runs", () => {
  test("lists each field's resolved path — nested groups joined, an explicit key taken as its own absolute path", async () => {
    let receivedKeys: string[][] | undefined;
    const source = new Source<Record<string, unknown>>({
      start(control) {
        receivedKeys = control.keys;
        control.set({});
        control.close();
      },
    });

    await create({ server: { port: numeric() }, host: string({ key: "HOST" }) }, { sources: [source] });

    expect(receivedKeys).toEqual([["server", "port"], ["HOST"]]);
  });

  test("every source in options.sources sees the same shape-wide keys", async () => {
    const seen: string[][][] = [];
    const record = (): Source<unknown> =>
      new Source({
        start(control) {
          seen.push(control.keys);
          control.close();
        },
      });

    await create({ a: numeric(), b: string() }, { sources: [record(), record()] });

    expect(seen).toEqual([
      [["a"], ["b"]],
      [["a"], ["b"]],
    ]);
  });

  test("defaults to [] when a source is opened directly, without a create() shape behind it", async () => {
    let receivedKeys: string[][] | undefined;
    const source = new Source<number>({
      start(control) {
        receivedKeys = control.keys;
        control.set(1);
        control.close();
      },
    });

    await source.open();

    expect(receivedKeys).toEqual([]);
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

  test("ConfigsNodePending<T> is ConfigsNode<T> plus a then() that resolves to ConfigsNodeReady<T>", () => {
    type Shape = { port: ReturnType<typeof numeric> };
    expectTypeOf<ConfigsNodePending<Shape>>().toMatchTypeOf<ConfigsNode<Shape>>();
    expectTypeOf<Awaited<ConfigsNodePending<Shape>>>().toEqualTypeOf<ConfigsNodeReady<Shape>>();
  });

  test("ConfigsNode<T> (pending) and ConfigsNodeReady<T> (awaited) diverge for a required field with no default — each reads a different type parameter off the same Descriptor", () => {
    type Shape = { port: ReturnType<typeof numeric<{ required: true }>> };

    expectTypeOf<ConfigsNode<Shape>>().toEqualTypeOf<{ port: Store<number | null> }>();
    expectTypeOf<ConfigsNodeReady<Shape>>().toEqualTypeOf<
      { port: Store<number> } & { close(): Promise<void>; [Symbol.asyncDispose](): Promise<void> }
    >();
    expectTypeOf<Awaited<ConfigsNodePending<Shape>>>().toEqualTypeOf<ConfigsNodeReady<Shape>>();
  });

  test("create()'s return type is exactly ConfigsNodePending<typeof shape>, and awaiting it drops `then`", async () => {
    const shape = { port: numeric({ default: 3000 }) };
    const cfg = create(shape);

    expectTypeOf(cfg).toEqualTypeOf<ConfigsNodePending<typeof shape>>();

    const resolved = await cfg;
    expectTypeOf(resolved).toEqualTypeOf<ConfigsNodeReady<typeof shape>>();
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

  test("a numeric field's Store reflects the value its source publishes a few ms after opening", async () => {
    const source = new Source<{ port?: string }>({
      start(control) {
        control.set({ port: "3000" });
        setTimeout(() => control.set({ port: "5000" }), 20);
      },
    });

    const cfg = await create({ port: numeric() }, { sources: [source] });

    expect(cfg.port.get()).toBe(3000);

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(cfg.port.get()).toBe(5000);
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

describe("create — start(control) is 100% in control of the field's value", () => {
  test("a start that never calls control.set() leaves the field at null forever", async () => {
    const inert = new Descriptor<unknown>({ type: "inert", options: {}, start: () => {} });

    const { source, push } = liveTestSource({ value: "abc" });
    const cfg = await create({ value: inert }, { sources: [source] });

    expect(cfg.value.get()).toBeNull();

    push({ value: "xyz" });

    // start() only ever ran once, at build time, and never called control.set() — nothing else
    // in this engine can set this field's value.
    expect(cfg.value.get()).toBeNull();
  });

  test("a start that calls control.set() once and never listens to rawStore never updates again", async () => {
    const fixed = new Descriptor<number>({
      type: "fixed",
      options: {},
      start: (control) => control.set(3000),
    });

    const { source, push } = liveTestSource({ port: "8080" });
    const cfg = await create({ port: fixed }, { sources: [source] });

    // `await cfg` did wait for `source` to open — but `start()` never looked at
    // `control.rawStore` at all, so the source's value never reaches the field.
    expect(cfg.port.get()).toBe(3000);

    push({ port: "9090" });

    expect(cfg.port.get()).toBe(3000);
  });

  test("a start that listens to control.rawStore with its own transform fully drives every update", async () => {
    const doubled = new Descriptor<number>({
      type: "doubled",
      options: {},
      start(control) {
        const parse = (raw: unknown): number => Number(raw ?? 0) * 2;
        control.rawStore.subscribe((raw) => control.set(parse(raw)));
      },
    });

    const { source, push } = liveTestSource({ value: "5" });
    const cfg = await create({ value: doubled }, { sources: [source] });

    expect(cfg.value.get()).toBe(10);

    push({ value: "7" });

    expect(cfg.value.get()).toBe(14);
  });

  test("field starts at a fixed seed (tick 0, via control.set), picks up the source's delayed value, then start()'s own later override", async () => {
    const sourceDelayMs = 20;
    const startDelayMs = sourceDelayMs + 20; // n ms more than the source's own delay

    // Seeds synchronously via `control.set`, stays live off `control.rawStore` (so it still
    // picks up the source's own update), and also schedules its own unrelated override further
    // out — independent of anything the source does.
    function delayed(defaultValue: number, overrideAfterMs: number, overrideValue: number): Descriptor<number> {
      const parse = (raw: unknown): number => (raw === null || raw === undefined ? defaultValue : Number(raw));

      return new Descriptor<number>({
        type: "delayed",
        options: {},
        start(control) {
          control.rawStore.subscribe((raw) => control.set(parse(raw)));
          setTimeout(() => control.set(overrideValue), overrideAfterMs);
        },
      });
    }

    const source = new Source<{ value?: string }>({
      start(control) {
        setTimeout(() => control.set({ value: "2000" }), sourceDelayMs);
      },
    });

    const cfg = create({ value: delayed(3000, startDelayMs, 4000) }, { sources: [source] });

    // No source has opened yet at this synchronous point — start()'s own seed wins.
    expect(cfg.value.get()).toBe(3000);

    await new Promise((resolve) => setTimeout(resolve, sourceDelayMs + 10));
    expect(cfg.value.get()).toBe(2000);

    await new Promise((resolve) => setTimeout(resolve, startDelayMs - sourceDelayMs + 10));
    expect(cfg.value.get()).toBe(4000);
  });

  test("a hand-written Descriptor narrows its own Awaited type with neither `default` nor `required` in its options — Descriptor performs no inference itself, it only carries whatever Pending/Awaited the caller passed in", async () => {
    // `options` here is just `{}` — no `default`, no `required`, nothing `WithDefault`/`Settled`
    // could key off. The narrowing on `Awaited` comes purely from the two type arguments given to
    // `new Descriptor<Pending, Awaited>(...)` below, same as `string()`/`numeric()`/... do for
    // themselves, but written by hand instead of derived from an options object at all.
    function alwaysEventually(): Descriptor<number | null, number> {
      return new Descriptor<number | null, number>({
        type: "always-eventually",
        options: {},
        start(control) {
          control.set(null);
          control.rawStore.subscribe((raw) => {
            if (raw !== null && raw !== undefined) control.set(Number(raw));
          });
        },
      });
    }

    const shape = { port: alwaysEventually() };
    const cfg = create(shape, { sources: [testSource({ port: 9090 })] });

    // Pending: honestly nullable — nothing forces `start()` to have set a real value yet.
    expectTypeOf(cfg.port).toEqualTypeOf<Store<number | null>>();
    expect(cfg.port.get()).toBeNull();

    const resolved = await cfg;

    // Awaited: narrowed to `number` — not because of any `default`/`required` option (there is
    // none), but because the descriptor's own `Awaited` type argument said so.
    expectTypeOf(resolved.port).toEqualTypeOf<Store<number>>();
    expect(resolved.port.get()).toBe(9090);
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
        start: (control) => control.set(String(control.rawStore.get())),
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

  test("closes a field descriptor's close() and a source's close() exactly once each", async () => {
    const descriptorCloseMock = mock(() => {});
    const sourceCloseMock = mock(() => {});

    const descriptor = new Descriptor<string>({
      type: "tracked",
      options: {},
      start: (control) => control.set(String(control.rawStore.get())),
      async close() {
        descriptorCloseMock();
      },
    });
    const source = new Source<{ port?: string }>({
      async start(control) {
        control.set({ port: "3000" });
      },
      async close() {
        sourceCloseMock();
      },
    });

    const cfg = await create({ port: descriptor }, { sources: [source] });

    await cfg.close();

    expect(descriptorCloseMock).toHaveBeenCalledTimes(1);
    expect(sourceCloseMock).toHaveBeenCalledTimes(1);
  });

  test("calling close() multiple times still only closes each field descriptor and source once", async () => {
    const descriptorCloseMock = mock(() => {});
    const sourceCloseMock = mock(() => {});

    const descriptor = new Descriptor<string>({
      type: "tracked",
      options: {},
      start: (control) => control.set(String(control.rawStore.get())),
      async close() {
        descriptorCloseMock();
      },
    });
    const source = new Source<{ port?: string }>({
      async start(control) {
        control.set({ port: "3000" });
      },
      async close() {
        sourceCloseMock();
      },
    });

    const cfg = await create({ port: descriptor }, { sources: [source] });

    await Promise.all([cfg.close(), cfg.close(), cfg.close()]);
    await cfg.close();

    expect(descriptorCloseMock).toHaveBeenCalledTimes(1);
    expect(sourceCloseMock).toHaveBeenCalledTimes(1);
  });

  test("exposes [Symbol.asyncDispose](), so `await using` closes the field descriptor and the source", async () => {
    const descriptorCloseMock = mock(() => {});
    const sourceCloseMock = mock(() => {});

    const descriptor = new Descriptor<string>({
      type: "tracked",
      options: {},
      start: (control) => control.set(String(control.rawStore.get())),
      async close() {
        descriptorCloseMock();
      },
    });
    const source = new Source<{ port?: string }>({
      async start(control) {
        control.set({ port: "3000" });
      },
      async close() {
        sourceCloseMock();
      },
    });

    {
      await using cfg = await create({ port: descriptor }, { sources: [source] });
      expect(descriptorCloseMock).not.toHaveBeenCalled();
      expect(sourceCloseMock).not.toHaveBeenCalled();
    }

    expect(descriptorCloseMock).toHaveBeenCalledTimes(1);
    expect(sourceCloseMock).toHaveBeenCalledTimes(1);
  });

  test("closing the outer node also closes the embedded (nested create()) node's own field descriptor and source, each exactly once", async () => {
    const descriptorCloseMock = mock(() => {});
    const sourceCloseMock = mock(() => {});

    const nestedDescriptor = new Descriptor<string>({
      type: "tracked",
      options: {},
      start: (control) => control.set(String(control.rawStore.get())),
      async close() {
        descriptorCloseMock();
      },
    });
    const nestedSource = new Source<{ cert?: string }>({
      async start(control) {
        control.set({ cert: "cert.pem" });
      },
      async close() {
        sourceCloseMock();
      },
    });

    const cfg = create({
      server: { tls: create({ cert: nestedDescriptor }, { sources: [nestedSource] }) },
    });
    await cfg;

    await cfg.close();

    expect(descriptorCloseMock).toHaveBeenCalledTimes(1);
    expect(sourceCloseMock).toHaveBeenCalledTimes(1);
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

describe("create — error aggregation by path (ConfigValidationError)", () => {
  test("a required field with no resolved value rejects with a ConfigValidationError naming its path", async () => {
    const cfg = create({ port: numeric({ required: true }) }, { sources: [testSource({})] });

    await expect(Promise.resolve(cfg)).rejects.toThrow(ConfigValidationError);
    await Promise.resolve(cfg).catch((err: unknown) => {
      expect((err as ConfigValidationError).errors).toEqual([{ path: ["port"], error: expect.any(ConfigError) }]);
    });
  });

  test("two required fields missing at once reject with a single ConfigValidationError naming both paths", async () => {
    const cfg = create({ port: numeric({ required: true }), host: string({ required: true }) }, { sources: [testSource({})] });

    await Promise.resolve(cfg).catch((err: unknown) => {
      const validationError = err as ConfigValidationError;
      expect(validationError).toBeInstanceOf(ConfigValidationError);
      expect(validationError.errors).toHaveLength(2);
      expect(validationError.errors.map((e) => e.path)).toEqual(expect.arrayContaining([["port"], ["host"]]));
    });
  });

  test("an embedded create() node's own errors are inherited by the parent, with the embed's path prefixed", async () => {
    const cfg = create({
      server: create({ port: numeric({ required: true }) }, { sources: [testSource({})] }),
    });

    await Promise.resolve(cfg).catch((err: unknown) => {
      const validationError = err as ConfigValidationError;
      expect(validationError).toBeInstanceOf(ConfigValidationError);
      expect(validationError.errors).toEqual([{ path: ["server", "port"], error: expect.any(ConfigError) }]);
    });
  });

  test("a required field nested under a group, fed only by a literalSource, still rejects — but only once ready, not synchronously", async () => {
    // Every `Source` — even a fully static one like `literalSource` — defers its own `start()` by at
    // least one microtask (see `Source`'s own doc comment, and `configs.spec.ts`'s "resolves
    // synchronously to each field's default before process.env is read"): no field can ever see real
    // source data at the exact synchronous point `create()` itself returns, so a missing `required`
    // value can only be confirmed once `ready` settles here, same as with any other source.
    const cfg = create({ server: { port: numeric({ required: true }) } }, { sources: [literalSource({})] });
    expect(cfg.server.port.get()).toBeNull();

    await expect(Promise.resolve(cfg)).rejects.toThrow(ConfigValidationError);
    await Promise.resolve(cfg).catch((err: unknown) => {
      expect((err as ConfigValidationError).errors).toEqual([{ path: ["server", "port"], error: expect.any(ConfigError) }]);
    });
  });

  test("the same shape with the value actually present doesn't throw", async () => {
    const cfg = await create({ server: { port: numeric({ required: true }) } }, { sources: [literalSource({ server: { port: 3000 } })] });

    expect(cfg.server.port.get()).toBe(3000);
  });

  test("a required list() field with no resolved value rejects with a ConfigValidationError naming its path", async () => {
    const cfg = create({ tags: list({ required: true }) }, { sources: [testSource({})] });

    await expect(Promise.resolve(cfg)).rejects.toThrow(ConfigValidationError);
    await Promise.resolve(cfg).catch((err: unknown) => {
      expect((err as ConfigValidationError).errors).toEqual([{ path: ["tags"], error: expect.any(ConfigError) }]);
    });
  });

  test("a required list() field with the value actually present doesn't throw", async () => {
    const cfg = await create({ tags: list({ required: true }) }, { sources: [testSource({ tags: "a,b,c" })] });

    expect(cfg.tags.get()).toEqual(["a", "b", "c"]);
  });

  test("a required field with no sources configured at all still only rejects the awaited node, never create() itself", async () => {
    const cfg = create({ port: numeric({ required: true }) }); // no throw here — no sources at all

    await expect(Promise.resolve(cfg)).rejects.toThrow(ConfigValidationError);
    await Promise.resolve(cfg).catch((err: unknown) => {
      expect((err as ConfigValidationError).errors).toEqual([{ path: ["port"], error: expect.any(ConfigError) }]);
    });
  });

  test("a descriptor that calls control.error() synchronously still only rejects the awaited node, never create() itself", async () => {
    const boom = new ConfigError("boom");
    const dummy = new Descriptor({
      type: "string",
      options: {},
      start(control) {
        control.error(boom);
      },
    });

    const cfg = create({ field: dummy }); // no throw here, even though the error is already known

    await expect(Promise.resolve(cfg)).rejects.toThrow(ConfigValidationError);
    await Promise.resolve(cfg).catch((err: unknown) => {
      expect((err as ConfigValidationError).errors).toEqual([{ path: ["field"], error: boom }]);
    });
  });

  test("nesting a create() whose only failure would be synchronous (no sources) doesn't throw while building the shape — only the parent's await rejects", async () => {
    // If create() still threw synchronously for "no sources at all", this line alone would blow up,
    // before the parent create() below even exists — the whole point of staying exclusively thenable.
    const inner = create({ port: numeric({ required: true }) });

    const cfg = create({ server: inner });

    await expect(Promise.resolve(cfg)).rejects.toThrow(ConfigValidationError);
    await Promise.resolve(cfg).catch((err: unknown) => {
      expect((err as ConfigValidationError).errors).toEqual([{ path: ["server", "port"], error: expect.any(ConfigError) }]);
    });
  });

  test("a parse failure from a live source arriving after the node already resolved is only logged, not rejected", async () => {
    const { source, push } = liveTestSource<{ port: unknown }>({ port: 8080 });
    const cfg = await create({ port: numeric() }, { sources: [source] });
    expect(cfg.port.get()).toBe(8080);

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      push({ port: "not-a-number" });
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

describe("create — a hand-written custom Descriptor (must be a real Descriptor instance)", () => {
  // Every descriptor accepted anywhere in this package must be a real `new Descriptor(...)`
  // instance (`isConfigDescriptor()` checks `instanceof Descriptor`, not a structural shape) — a
  // hand-written field type still only needs its own `start(control)`, same as a built-in one, but
  // it has to go through the class constructor to be recognized at all.
  function csv(options: { key?: string | string[] } = {}): Descriptor<string[]> {
    const parse = (raw: unknown) => (typeof raw === "string" ? raw.split(",").map((s) => s.trim()) : []);

    return new Descriptor<string[]>({
      type: "csv",
      options,
      start(control: DescriptorControl<string[]>) {
        control.rawStore.subscribe((raw) => control.set(parse(raw)));
      },
    });
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

  test("an object without a start() isn't a Descriptor at all — create() treats it as a nested group instead", () => {
    expect(isConfigDescriptor({ key: "ALLOWED_ORIGINS" })).toBe(false);
  });

  test("a plain object with a start() method, but not built via new Descriptor(...), isn't recognized either", () => {
    const plainObjectWithStart = {
      type: "csv",
      options: {},
      start(control: DescriptorControl<string[]>) {
        control.set([]);
      },
    };

    expect(isConfigDescriptor(plainObjectWithStart)).toBe(false);
  });

  test("if start() only snapshots rawStore once and never listens, the field is pinned at whatever it saw", async () => {
    const pinned = new Descriptor<string[]>({
      type: "csv-pinned",
      options: {},
      start(control: DescriptorControl<string[]>) {
        // Snapshots once and never listens — deliberately not live, unlike `csv()` above.
        const raw = control.rawStore.get();
        control.set(typeof raw === "string" ? raw.split(",").map((s) => s.trim()) : []);
      },
    });

    const { source, push } = liveTestSource({ allowedOrigins: "a.com" });
    const cfg = await create({ allowedOrigins: pinned }, { sources: [source] });

    // `start()` ran (and snapshotted `rawStore`) before `source` had even opened, so it's stuck
    // with the empty snapshot it saw then — it never listened, so it never sees anything later.
    expect(cfg.allowedOrigins.get()).toEqual([]);

    push({ allowedOrigins: "b.com, c.com" });

    expect(cfg.allowedOrigins.get()).toEqual([]);
  });
});
