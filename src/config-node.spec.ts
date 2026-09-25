import { describe, expect, expectTypeOf, test } from "bun:test";
import { create, type ConfigsNode, type ConfigsNodePending, type ConfigsShape, type Options } from "./config-node.ts";
import { boolean, choice, numeric, shape, string, url } from "./config-descriptor.ts";
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
