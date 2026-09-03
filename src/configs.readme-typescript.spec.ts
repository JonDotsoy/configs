import { expectTypeOf, test } from "bun:test";
import { Source } from "./sources/source.js";
import { create } from "./configs.js";
import { z } from "zod";
import type { ConfigNode, Parseable, PendingConfigNode, ReadOnlyStore } from "./config.types.js";

/**
 * Type-only checks that the "TypeScript inference" section of the README stays accurate.
 * Every assertion here mirrors a code snippet from that section verbatim — a broken assertion
 * means the README needs updating (or the type change needs reverting). `expectTypeOf` never
 * runs at runtime, so each `test()` still needs one real check to count as a test.
 */

function testSource<T>(value: T): Source<T> {
  return new Source<T>({
    async start(control) {
      control.set(value);
      control.close();
    },
  });
}

test("no default: the type includes null", () => {
  const cfg = create({ port: { type: "number" } }, { sources: [testSource({ port: 3000 })] });
  expectTypeOf(cfg).toEqualTypeOf<PendingConfigNode<{ port: { type: "number" } }>>();
  expectTypeOf(cfg.port.get()).toEqualTypeOf<number | null>();
});

test("with a default: the type excludes null", () => {
  const cfg = create(
    { port: { type: "number", default: 3000 } },
    { sources: [testSource({})] },
  );
  expectTypeOf(cfg.port.get()).toEqualTypeOf<number>();
});

test("required: true alone does not narrow the type — it stays T | null", () => {
  const cfg = create(
    { port: { type: "number", required: true } },
    { sources: [testSource({ port: 3000 })] },
  );
  expectTypeOf(cfg.port.get()).toEqualTypeOf<number | null>();
});

test("required: true combined with default: the type excludes null", () => {
  const cfg = create(
    { port: { type: "number", required: true, default: 3000 } },
    { sources: [testSource({ port: 3000 })] },
  );
  expectTypeOf(cfg.port.get()).toEqualTypeOf<number>();
});

test("a pending node already exposes fully-typed fields before awaiting, and awaiting keeps the same field types", async () => {
  const pending = create(
    { port: { type: "number", default: 3000 } },
    { sources: [testSource({})] },
  );
  expectTypeOf(pending.port.get()).toEqualTypeOf<number>();

  const cfg = await pending;
  expectTypeOf(cfg).toEqualTypeOf<ConfigNode<{ port: { type: "number"; default: number } }>>();
  expectTypeOf(cfg.port.get()).toEqualTypeOf<number>();
});

test("a nested group infers the same way, recursively", () => {
  const cfg = create(
    { server: create({ port: { type: "number" } }) },
    { sources: [testSource({ server: { port: 3000 } })] },
  );
  expectTypeOf(cfg.server.port.get()).toEqualTypeOf<number | null>();
});

test("shape field: the type is extracted from schema.parse's return type", () => {
  const cfg = create(
    { jwt: { type: "shape", schema: z.object({ issuer: z.string(), ttl: z.number() }) } },
    { sources: [testSource({})] },
  );
  expectTypeOf(cfg.jwt.get()).toEqualTypeOf<{ issuer: string; ttl: number } | null>();
});

test("shape field with a default: the type excludes null", () => {
  const cfg = create(
    {
      jwt: {
        type: "shape",
        schema: z.object({ issuer: z.string(), ttl: z.number() }),
        default: { issuer: "auth0", ttl: 3600 },
      },
    },
    { sources: [testSource({})] },
  );
  expectTypeOf(cfg.jwt.get()).toEqualTypeOf<{ issuer: string; ttl: number }>();
});

test("shape field: a schema whose parse narrows to a literal union is inferred as that union, not widened to string", () => {
  const parity: Parseable<"even" | "odd"> = {
    parse: (value: unknown) => (Number(value) % 2 === 0 ? "even" : "odd"),
  };
  const cfg = create({ n: { type: "shape", schema: parity } }, { sources: [testSource({})] });
  expectTypeOf(cfg.n.get()).toEqualTypeOf<"even" | "odd" | null>();
});

test("shape field with no schema: passed through as plain unknown, no | null to see", () => {
  const cfg = create({ metadata: { type: "shape" } }, { sources: [testSource({})] });
  expectTypeOf(cfg.metadata).toEqualTypeOf<ReadOnlyStore<unknown>>();
});

test("bare schema shorthand: infers identically to the explicit form, with no default slot", () => {
  const cfg = create({ port: z.number() }, { sources: [testSource({})] });
  expectTypeOf(cfg.port.get()).toEqualTypeOf<number | null>();
});

test("untagged shorthand ({ schema }) keeps default/required, so it can still narrow to non-null", () => {
  const cfg = create(
    { port: { schema: z.number(), default: 3000 } },
    { sources: [testSource({})] },
  );
  expectTypeOf(cfg.port.get()).toEqualTypeOf<number>();
});
