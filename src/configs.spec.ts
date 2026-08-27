import { describe, expect, expectTypeOf, test } from "bun:test";
import { Store, store } from "./utils/store";
import { DataSource } from "./datasources/datasource";
import { envDataSource, envKeyToPath } from "./datasources/env";
import { ConfigError } from "./errors";
import { ConfigNode, ConfigNodeResolved } from "./config.types.ts";
import type { configs, InferReadOnlyAccessors, ReadOnlyStore, SchemaGroup } from "./config.types.ts";

declare const configs: configs;

/** Builds a `DataSource` that immediately publishes `value` and closes, since `datasources` now requires actual `DataSource` instances. */
function testSource<T>(value: T): DataSource<T> {
  return new DataSource<T>({
    async start(control) {
      control.set(value);
      control.close();
    },
  });
}

describe("configs.create", () => {
  test("earlier datasources win per field; a field missing there falls through to the next one", async () => {
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
        datasources: [
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

    expectTypeOf(serverConfigs.port).toEqualTypeOf<ReadOnlyStore<number | null>>();
    expectTypeOf(serverConfigs.host).toEqualTypeOf<ReadOnlyStore<string | null>>();
    expectTypeOf(serverConfigs.tls.key).toEqualTypeOf<ReadOnlyStore<string | null>>();
    expectTypeOf(serverConfigs.tls.cert).toEqualTypeOf<ReadOnlyStore<string | null>>();
  });

  test("falls back to the next datasource when the first store's value is null", async () => {
    const neverSets = new DataSource<{ port: number }>({
      async start(control) {
        control.close();
      },
    });

    const cfg = await configs.create(
      { port: { type: "number", required: true } },
      { datasources: [neverSets, testSource({ port: 3000 })] },
    );

    expect(cfg.port.get()).toBe(3000);
  });

  describe("port priority resolution", () => {
    test("first datasource's value wins when both have it", async () => {
      const cfg = await configs.create(
        { port: { type: "number", summary: "HTTP port", required: true } },
        { datasources: [testSource({ port: 8080 }), testSource({ port: 3000 })] },
      );

      expect(cfg.port.get()).toBe(8080);
    });

    test("falls through to the second datasource when the first doesn't have the field", async () => {
      const cfg = await configs.create(
        { port: { type: "number", summary: "HTTP port", required: true } },
        { datasources: [testSource({}), testSource({ port: 3000 })] },
      );

      expect(cfg.port.get()).toBe(3000);
    });

    test("resolves to null when no datasource has the field", async () => {
      const cfg = await configs.create(
        { port: { type: "number", summary: "HTTP port", required: true } },
        { datasources: [testSource({}), testSource({})] },
      );

      expect(cfg.port.get()).toBeNull();
    });

    test("coerces a numeric string from the winning datasource", async () => {
      const cfg = await configs.create(
        { port: { type: "number", summary: "HTTP port", required: true } },
        { datasources: [testSource({ port: "3000" }), testSource({})] },
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
      { datasources: [testSource({ port: 80, tls: { key: "k" } })] },
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
      { datasources: [testSource({ port: 80, tls: { key: "k" } })] },
    );

    expectTypeOf(serverConfigs.port).not.toHaveProperty("set");
    expectTypeOf(serverConfigs.tls.key).not.toHaveProperty("set");

    expect(() => (serverConfigs.port as unknown as Store<number>).set(90)).toThrow(ConfigError);
    expect(() => (serverConfigs.tls.key as unknown as Store<string>).set("k2")).toThrow(ConfigError);
  });

  test("the field's Store is the same instance across accesses", async () => {
    const serverConfigs = await configs.create(
      { port: { type: "number", required: true } },
      { datasources: [testSource({ port: 80 })] },
    );

    expect(serverConfigs.port).toBe(serverConfigs.port);
    expect(serverConfigs.port.get()).toBe(80);
  });

  test("falls back to default when no datasource has a value", async () => {
    const cfg = await configs.create(
      { retries: { type: "number", default: 3 } },
      { datasources: [testSource({})] },
    );

    expect(cfg.get()).toEqual({ retries: 3 });
  });

  describe("field.get() type inference", () => {
    test("without a default, the type includes null", async () => {
      const cfg = await configs.create(
        { port: { type: "number" } },
        { datasources: [testSource({ port: 3000 })] },
      );

      expectTypeOf(cfg.port.get()).toEqualTypeOf<number | null>();
    });

    test("with a default, the type excludes null", async () => {
      const cfg = await configs.create(
        { port: { type: "number", default: 3000 } },
        { datasources: [testSource({})] },
      );

      expectTypeOf(cfg.port.get()).toEqualTypeOf<number>();
    });
  });

  test("returns null for optional fields with no value", async () => {
    const cfg = await configs.create(
      { nickname: { type: "string" } },
      { datasources: [testSource({})] },
    );

    expect(cfg.get()).toEqual({ nickname: null });
  });

  test("resolves required fields with no value anywhere to null instead of throwing", async () => {
    const cfg = await configs.create(
      { apiKey: { type: "string", required: true } },
      { datasources: [testSource({})] },
    );

    expect(cfg.get()).toEqual({ apiKey: null });
  });

  test("validates string values against a pattern", async () => {
    const cfg = await configs.create(
      { host: { type: "string", pattern: /^[a-z]+$/ } },
      { datasources: [testSource({ host: "not valid!" })] },
    );

    expect(() => cfg.get()).toThrow(ConfigError);
  });

  test("coerces numeric strings but rejects non-numeric ones", async () => {
    const cfg = await configs.create(
      { port: { type: "number" } },
      { datasources: [testSource({ port: "1234" })] },
    );
    expect(cfg.get()).toEqual({ port: 1234 });

    const bad = await configs.create(
      { port: { type: "number" } },
      { datasources: [testSource({ port: "not-a-number" })] },
    );
    expect(() => bad.get()).toThrow(ConfigError);
  });

  test("coerces boolean-ish strings", async () => {
    const cfg = await configs.create(
      { debug: { type: "boolean" } },
      { datasources: [testSource({ debug: "true" })] },
    );
    expect(cfg.get()).toEqual({ debug: true });
  });

  test("set throws when no datasource is writable", async () => {
    const cfg = await configs.create(
      { port: { type: "number" } },
      { datasources: [testSource({ port: 3000 })] },
    );
    expect(() => cfg.set("port", 4000)).toThrow(ConfigError);
  });

  test("create() without options stays synchronous, for nested groups", () => {
    const group = configs.create({ key: { type: "string" } });
    expectTypeOf(group).not.toEqualTypeOf<Promise<unknown>>();
    expect(group.get()).toEqual({ key: null });
  });
});

describe("nested groups with their own datasources", () => {
  test("a nested group resolves its own datasource independently of the parent", async () => {
    const cfg = await configs.create({
      server: configs.create(
        { port: { type: "number" } },
        { datasources: [envDataSource({ env: { PORT: "3000" }, mapKey: envKeyToPath })] },
      ),
    });

    expect(cfg.server.port.get()).toBe(3000);
  });

  test("a nested group's own datasource does not leak into the parent's fields", async () => {
    const cfg = await configs.create(
      {
        name: { type: "string" },
        server: configs.create(
          { port: { type: "number" } },
          { datasources: [envDataSource({ env: { PORT: "3000" }, mapKey: envKeyToPath })] },
        ),
      },
      { datasources: [testSource({ name: "svc" })] },
    );

    expect(cfg.name.get()).toBe("svc");
    expect(cfg.server.port.get()).toBe(3000);
    expect((cfg.get() as Record<string, unknown>).port).toBeUndefined();
  });

  test("the parent's datasources do not leak into a nested group with its own datasource", async () => {
    const cfg = await configs.create(
      {
        server: configs.create(
          { port: { type: "number" } },
          { datasources: [envDataSource({ env: { PORT: "3000" }, mapKey: envKeyToPath })] },
        ),
      },
      { datasources: [testSource({ server: { port: 9999 } })] },
    );

    expect(cfg.server.port.get()).toBe(3000);
  });

  test("multiple independent nested groups each resolve from their own datasource", async () => {
    const cfg = await configs.create({
      primary: configs.create(
        { port: { type: "number" } },
        { datasources: [envDataSource({ env: { PORT: "3000" }, mapKey: envKeyToPath })] },
      ),
      secondary: configs.create(
        { port: { type: "number" } },
        { datasources: [envDataSource({ env: { PORT: "4000" }, mapKey: envKeyToPath })] },
      ),
    });

    expect(cfg.primary.port.get()).toBe(3000);
    expect(cfg.secondary.port.get()).toBe(4000);
  });

  test("closing the parent also closes a nested group's own datasources", async () => {
    let closed = false;
    const nestedSource = new DataSource<{ port: number }>({
      start(control) {
        control.set({ port: 3000 });
        control.close();
      },
      close() {
        closed = true;
      },
    });

    const cfg = await configs.create({
      server: configs.create({ port: { type: "number" } }, { datasources: [nestedSource] }),
    });

    expect(cfg.server.port.get()).toBe(3000);
    await cfg.close();
    expect(closed).toBe(true);
  });

  test("stays a synchronous, thenable ConfigNode even once a nested group carries its own datasources", () => {
    const pending = configs.create({
      server: configs.create(
        { port: { type: "number" } },
        { datasources: [envDataSource({ env: { PORT: "3000" }, mapKey: envKeyToPath })] },
      ),
    });

    expectTypeOf(pending).toEqualTypeOf<
      ConfigNode<{ server: SchemaGroup<{ port: { type: "number" } }> }> &
        InferReadOnlyAccessors<{ server: SchemaGroup<{ port: { type: "number" } }> }>
    >();
  });

  test("infers a nested group's field the same whether it shares or owns its datasources", async () => {
    const cfg = await configs.create({
      server: configs.create(
        { port: { type: "number" } },
        { datasources: [envDataSource({ env: { PORT: "3000" }, mapKey: envKeyToPath })] },
      ),
    });

    expectTypeOf(cfg.server.port.get()).toEqualTypeOf<number | null>();
    expectTypeOf(cfg.server).toHaveProperty("close");
    expectTypeOf(cfg.server.close()).toEqualTypeOf<Promise<void>>();
  });
});

describe("configs.create() as a ConfigNode", () => {
  test("root form returns a ConfigNode instance synchronously, before it resolves", () => {
    const cfg = configs.create(
      { port: { type: "number" } },
      { datasources: [testSource({ port: 3000 })] },
    );

    expect(cfg).toBeInstanceOf(ConfigNode);
    expectTypeOf(cfg).not.toEqualTypeOf<Promise<unknown>>();
  });

  test("ConfigNode.then() resolves to a ConfigNodeResolved instance", async () => {
    const cfg = configs.create(
      { port: { type: "number" } },
      { datasources: [testSource({ port: 3000 })] },
    );

    const resolved = await cfg;

    expect(resolved).toBeInstanceOf(ConfigNodeResolved);
  });

  test("a ConfigNodeResolved is still a ConfigNode", async () => {
    const cfg = configs.create(
      { port: { type: "number" } },
      { datasources: [testSource({ port: 3000 })] },
    );

    const resolved = await cfg;

    expect(resolved).toBeInstanceOf(ConfigNode);
  });

  test("awaiting still exposes live field access on the resolved node", async () => {
    const cfg = await configs.create(
      { port: { type: "number" } },
      { datasources: [testSource({ port: 3000 })] },
    );

    expect(cfg.port.get()).toBe(3000);
  });
});

describe("DataSource", () => {
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
        datasources: [
          new DataSource<{
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
    const source = new DataSource<{ port: number }>({
      async start(control) {
        control.set({ port: 3000 });
      },
    });

    const store = await source.open();
    expect(store.get()).toEqual({ port: 3000 });
  });

  test("open() returns the same live Store on every call", async () => {
    const source = new DataSource<{ port: number }>({
      async start(control) {
        control.set({ port: 3000 });
      },
    });

    const [storeA, storeB] = await Promise.all([source.open(), source.open()]);
    expect(storeA).toBe(storeB);
  });

  test("the underlying close() runs once control.close() is called from within start()", async () => {
    let closed = false;
    const source = new DataSource<{ value: number }>({
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

    const source = new DataSource<{ tick: number }>({
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
    const source = new DataSource<{ port: number }>({
      async start() {
        // never sets a value
      },
    });

    const store = await source.open();
    expect(store.get()).toBeNull();
  });

  test("a rejected start() rejects configs.create()", async () => {
    const failing = new DataSource<{ port: number }>({
      async start() {
        throw new Error("boom");
      },
    });

    await expect(
      Promise.resolve(configs.create({ port: { type: "number" } }, { datasources: [failing] })),
    ).rejects.toThrow("boom");
  });

  describe("close()", () => {
    test("runs the underlying close() hook", async () => {
      let closed = false;
      const source = new DataSource<{ port: number }>({
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
      const source = new DataSource<{ port: number }>({
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
      const source = new DataSource<{ port: number }>({
        async start(control) {
          control.set({ port: 3000 });
        },
      });

      await source.open();
      await expect(source.close()).resolves.toBeUndefined();
    });

    test("calling close() before open() still lets open() resolve, but drops the pending set()", async () => {
      let closed = false;
      const source = new DataSource<{ port: number }>({
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
  test("closes every configured datasource", async () => {
    let closedA = false;
    let closedB = false;
    const sourceA = new DataSource<{ port: number }>({
      async start(control) {
        control.set({ port: 3000 });
      },
      async close() {
        closedA = true;
      },
    });
    const sourceB = new DataSource<{ host: string }>({
      async start(control) {
        control.set({ host: "localhost" });
      },
      async close() {
        closedB = true;
      },
    });

    const cfg = await configs.create(
      { port: { type: "number" }, host: { type: "string" } },
      { datasources: [sourceA, sourceB] },
    );

    await cfg.close();

    expect(closedA).toBe(true);
    expect(closedB).toBe(true);
  });

  test("closes the same datasources from a nested group", async () => {
    let closed = false;
    const source = new DataSource<{ server: { port: number } }>({
      async start(control) {
        control.set({ server: { port: 3000 } });
      },
      async close() {
        closed = true;
      },
    });

    const cfg = await configs.create(
      { server: configs.create({ port: { type: "number" } }) },
      { datasources: [source] },
    );

    await cfg.server.close();

    expect(closed).toBe(true);
  });

  test("is a no-op for a nested-form group created without its own datasources", async () => {
    const cfg = configs.create({ port: { type: "number" } });
    await expect(cfg.close()).resolves.toBeUndefined();
  });
});

describe("await using configs.create(...)", () => {
  test("disposal closes the config's datasources", async () => {
    let closed = false;
    const source = new DataSource<{ port: number }>({
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
        { datasources: [source] },
      );
      expect(cfg.port.get()).toBe(3000);
      expect(closed).toBe(false);
    }

    expect(closed).toBe(true);
  });

  test("disposal happens on scope exit even when the block throws", async () => {
    let closed = false;
    const source = new DataSource<{ port: number }>({
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
          { datasources: [source] },
        );
        throw new Error("boom");
      })(),
    ).rejects.toThrow("boom");

    expect(closed).toBe(true);
  });
});

describe("DataSource wrapping a Store", () => {
  function testSourceStream<T>(value: Store<T>): DataSource<T> {
    return new DataSource<T>({
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
      { datasources: [testSourceStream(store1), testSourceStream(store2)] },
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
      { datasources: [testSourceStream(store1), testSourceStream(store2)] },
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
      { datasources: [testSourceStream(store1), testSourceStream(store2)] },
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
      { datasources: [testSourceStream(store1), testSourceStream(store2)] },
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
      { datasources: [testSourceStream(store1), testSourceStream(store2)] },
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
      { datasources: [testSourceStream(store1), testSourceStream(store2)] },
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
      { datasources: [testSourceStream(store1), testSourceStream(store2)] },
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

  test("a readonly field freezes at its first resolved value, ignoring later datasource updates", async () => {
    const store1 = store.create<Record<string, unknown>>({});
    store1.set({ port: 3000 });

    const cfg = await configs.create(
      { port: { type: "number", readonly: true } },
      { datasources: [testSourceStream(store1)] },
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
      { datasources: [testSourceStream(store1)] },
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
      { datasources: [testSourceStream(store1)] },
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
      { datasources: [testSourceStream(store1)] },
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
