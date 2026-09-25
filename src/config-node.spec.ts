import { describe, expect, expectTypeOf, test } from "bun:test";
import { create, type ConfigsNodePending } from "./config-node.ts";
import { numeric, string } from "./config-descriptor.ts";
import { Source } from "./sources/source.ts";
import { Store } from "./utils/store.ts";

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

  test("types: each field is a Store, and the pending node stays awaitable to a plain node", () => {
    const shape = { port: numeric() };
    const cfg = create(shape);

    expectTypeOf(cfg).toEqualTypeOf<ConfigsNodePending<typeof shape>>();
    expectTypeOf(cfg.port).toEqualTypeOf<Store<number | null>>();
  });
});
