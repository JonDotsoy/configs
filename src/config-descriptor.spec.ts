import { describe, expect, test } from "bun:test";
import {
  boolean,
  choice,
  Descriptor,
  isConfigDescriptor,
  numeric,
  shape,
  string,
  url,
  type DescriptorControl,
  type FieldType,
} from "./config-descriptor.js";
import { ConfigError } from "./errors.js";
import { Store } from "./utils/store.js";
import { z } from "zod";

/** A `Descriptor` carries its own `start` closure, never equal by reference across two calls — assert `.type`/`.options` shape instead of a full `toEqual` against a hand-built instance. */
function expectDescriptor(descriptor: unknown, type: FieldType, options: object): void {
  expect(descriptor).toBeInstanceOf(Descriptor);
  expect((descriptor as Descriptor<unknown>).type).toBe(type);
  expect((descriptor as Descriptor<unknown>).options).toEqual(options);
  expect(typeof (descriptor as Descriptor<unknown>).start).toBe("function");
}

/**
 * Runs `descriptor.start(control)` against a fresh `rawStore` seeded with `initialRaw`, recording
 * every `control.set(...)` call in order — the same way `config-node.ts`'s `buildField()` drives a
 * real field, minus the `Store` it would otherwise write into.
 */
function runStart<T>(descriptor: Descriptor<T, object>, initialRaw: unknown, path: string[] = []) {
  const rawStore = new Store<unknown>(initialRaw);
  const values: T[] = [];
  descriptor.start({ rawStore, path, set: (value) => values.push(value) });
  return { rawStore, values, last: () => values[values.length - 1] };
}

describe("string/numeric/boolean field builders", () => {
  test('string() builds a Descriptor<string> carrying a { type: "string" } schema', () => {
    expectDescriptor(string(), "string", {});
    expectDescriptor(string({ summary: "bind host", default: "localhost" }), "string", {
      summary: "bind host",
      default: "localhost",
    });
  });

  test('numeric() builds a Descriptor<number> carrying a { type: "number" } schema', () => {
    expectDescriptor(numeric(), "number", {});
    expectDescriptor(numeric({ summary: "HTTP port", default: 3000 }), "number", {
      summary: "HTTP port",
      default: 3000,
    });
  });

  test('boolean() builds a Descriptor<boolean> carrying a { type: "boolean" } schema', () => {
    expectDescriptor(boolean(), "boolean", {});
    expectDescriptor(boolean({ summary: "enable the promo service", default: false }), "boolean", {
      summary: "enable the promo service",
      default: false,
    });
  });

  test("string() carries a pattern through unchanged", () => {
    const pattern = /^[\w.-]+$/;
    expectDescriptor(string({ pattern }), "string", { pattern });
  });
});

describe("url() field builder", () => {
  test('url() builds a Descriptor<URL> carrying a { type: "url" } schema', () => {
    expectDescriptor(url(), "url", {});
    expectDescriptor(url({ key: "DATABASE_URL" }), "url", { key: "DATABASE_URL" });
  });

  test("parses a valid URL string into a URL instance", () => {
    const parsed = runStart(url(), "postgres://user:pass@localhost:5432/app", ["uri"]).last();
    expect(parsed).toBeInstanceOf(URL);
    expect(parsed?.hostname).toBe("localhost");
    expect(parsed?.pathname).toBe("/app");
  });

  test("rejects a value that isn't a valid URL", () => {
    expect(() => runStart(url(), "not a url", ["uri"])).toThrow(ConfigError);
  });
});

describe("choice() field builder", () => {
  test('choice() builds a Descriptor carrying a { type: "choice" } schema', () => {
    expectDescriptor(choice({ options: ["a", "b"] }), "choice", { options: ["a", "b"] });
    expectDescriptor(choice({ options: ["a", "b"], default: "a" }), "choice", {
      options: ["a", "b"],
      default: "a",
    });
  });

  test("start accepts only one of the listed options", () => {
    const descriptor = choice({ options: ["debug", "info", "warn", "error"] });
    expect(runStart(descriptor, "warn", ["logLevel"]).last()).toBe("warn");
    expect(() => runStart(descriptor, "verbose", ["logLevel"])).toThrow(ConfigError);
  });
});

describe("shape() field builder", () => {
  test('shape() builds a Descriptor carrying a { type: "shape" } schema', () => {
    const schema = z.object({ issuer: z.string() });
    expectDescriptor(shape({ schema, required: true }), "shape", { schema, required: true });
  });

  test("parses a valid value via schema.parse, inferring the field's type from it", () => {
    const descriptor = shape({ schema: z.object({ issuer: z.string(), ttl: z.number() }) });
    expect(runStart(descriptor, { issuer: "auth0", ttl: 3600 }, ["jwt"]).last()).toEqual({ issuer: "auth0", ttl: 3600 });
  });

  test("without schema, passes any object value through untyped", () => {
    expect(runStart(shape(), { any: "thing" }, ["metadata"]).last()).toEqual({ any: "thing" });
  });

  test("required: true escalates an invalid value into a thrown ConfigError instead of logging", () => {
    const descriptor = shape({ schema: z.object({ issuer: z.string() }), required: true });
    expect(() => runStart(descriptor, { issuer: 42 }, ["jwt"])).toThrow(ConfigError);
  });
});

describe("every built-in field builder's own start(): default fallback and liveness (numeric() as a representative)", () => {
  test("falls back to options.default when raw is undefined/null, without running the parser", () => {
    expect(runStart(numeric({ default: 3000 }), undefined).last()).toBe(3000);
    expect(runStart(numeric({ default: 3000 }), null).last()).toBe(3000);
  });

  test("resolves to null when raw is missing and there is no default", () => {
    expect(runStart(numeric(), undefined).last()).toBeNull();
  });

  test("runs raw through the field's own parser synchronously, right when start() is called", () => {
    expect(runStart(numeric(), "8080").last()).toBe(8080);
    expect(runStart(string({ pattern: /^\w+$/ }), "abc").last()).toBe("abc");
    expect(() => runStart(string({ pattern: /^\w+$/ }), "not valid")).toThrow(ConfigError);
  });

  test("stays live: re-runs the parser (calling control.set again) on every rawStore change", () => {
    const { rawStore, values } = runStart(numeric(), "8080");
    expect(values).toEqual([8080]);

    rawStore.set("9090");
    expect(values).toEqual([8080, 9090]);

    rawStore.set(undefined);
    expect(values as (number | null)[]).toEqual([8080, 9090, null]);
  });
});

describe("Descriptor.start()", () => {
  test("runs the constructor's own start against the given control", () => {
    const descriptor = new Descriptor<string>({
      type: "csv",
      options: {},
      start: (control) => control.set(String(control.rawStore.get())),
    });

    expect(runStart(descriptor, "abc").values).toEqual(["abc"]);
  });

  test("start can call control.set() more than once synchronously, at tick 0", () => {
    const descriptor = new Descriptor<number>({
      type: "counter",
      options: {},
      start: (control) => {
        control.set(1);
        control.set(2);
      },
    });

    expect(runStart(descriptor, null).values).toEqual([1, 2]);
  });

  test("start can call control.set() later, from a resolved promise, without create() waiting on it", async () => {
    let resolveWork!: () => void;
    const work = new Promise<void>((resolve) => {
      resolveWork = resolve;
    });

    const descriptor = new Descriptor<string>({
      type: "async",
      options: {},
      async start(control) {
        control.set("seed");
        await work;
        control.set("resolved");
      },
    });

    const { values } = runStart(descriptor, null);
    expect(values).toEqual(["seed"]);

    resolveWork();
    await work;
    // Give the microtask queue a turn for start()'s own continuation to run.
    await Promise.resolve();
    expect(values).toEqual(["seed", "resolved"]);
  });
});

describe("Descriptor.close()", () => {
  test("resolves to undefined when the constructor wasn't given a close hook", async () => {
    await expect(numeric().close()).resolves.toBeUndefined();
  });

  test("runs the constructor's own close hook", async () => {
    let closed = false;
    const descriptor = new Descriptor<string>({
      type: "csv",
      options: {},
      start: (control) => control.set(String(control.rawStore.get())),
      async close() {
        closed = true;
      },
    });

    await descriptor.close();
    expect(closed).toBe(true);
  });
});

describe("isConfigDescriptor()", () => {
  test("recognizes a real Descriptor built by every field builder", () => {
    expect(isConfigDescriptor(string())).toBe(true);
    expect(isConfigDescriptor(numeric())).toBe(true);
    expect(isConfigDescriptor(boolean())).toBe(true);
    expect(isConfigDescriptor(url())).toBe(true);
    expect(isConfigDescriptor(choice({ options: ["a", "b"] }))).toBe(true);
    expect(isConfigDescriptor(shape())).toBe(true);
  });

  test("recognizes a directly-constructed Descriptor instance", () => {
    const descriptor = new Descriptor({
      type: "csv",
      options: {},
      start: (control: DescriptorControl<string[]>) => control.set(String(control.rawStore.get()).split(",")),
    });
    expect(isConfigDescriptor(descriptor)).toBe(true);
  });

  test("recognizes a hand-written object exposing a callable start() — no tag needed, close() is optional", () => {
    const handWritten = { start: (control: DescriptorControl<string>) => control.set(String(control.rawStore.get())) };
    expect(isConfigDescriptor(handWritten)).toBe(true);
    expect(isConfigDescriptor({ ...handWritten, close: async () => {} })).toBe(true);
  });

  test("rejects an object without a start()", () => {
    expect(isConfigDescriptor({})).toBe(false);
    expect(isConfigDescriptor({ close: async () => {} })).toBe(false);
  });

  test("rejects a plain shape entry (nested group, or an unrelated object)", () => {
    expect(isConfigDescriptor({ port: numeric() })).toBe(false);
    expect(isConfigDescriptor({})).toBe(false);
  });

  test("rejects null and primitives", () => {
    expect(isConfigDescriptor(null)).toBe(false);
    expect(isConfigDescriptor(undefined)).toBe(false);
    expect(isConfigDescriptor(42)).toBe(false);
    expect(isConfigDescriptor("string")).toBe(false);
  });
});

describe("writing a custom Descriptor by hand (structural start() contract)", () => {
  test("a hand-written descriptor (key + start()) behaves like a real one", () => {
    function csv(options: { key?: string | string[] } = {}) {
      const parse = (raw: unknown): string[] => (typeof raw === "string" ? raw.split(",").map((s) => s.trim()) : []);

      return {
        key: options.key,
        start(control: DescriptorControl<string[]>) {
          control.set(parse(control.rawStore.get()));
          control.rawStore.listen((raw) => control.set(parse(raw)));
        },
      };
    }

    const descriptor = csv({ key: "ALLOWED_ORIGINS" });
    expect(isConfigDescriptor(descriptor)).toBe(true);
    expect(descriptor.key).toBe("ALLOWED_ORIGINS");

    const rawStore = new Store<unknown>("a.com, b.com, c.com");
    const values: string[][] = [];
    descriptor.start({ rawStore, path: [], set: (v) => values.push(v) });

    expect(values[0]).toEqual(["a.com", "b.com", "c.com"]);

    rawStore.set("d.com");
    expect(values[1]).toEqual(["d.com"]);
  });
});
