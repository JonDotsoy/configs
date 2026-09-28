import { describe, expect, test } from "bun:test";
import {
  boolean,
  choice,
  Descriptor,
  isConfigDescriptor,
  list,
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
 * every `control.set(...)`/`control.error(...)` call in order — the same way `config-node.ts`'s
 * `buildField()` drives a real field, minus the `Store`/error-aggregation it would otherwise write
 * into.
 */
function runStart<T>(descriptor: Descriptor<T>, initialRaw: unknown, path: string[] = []) {
  const rawStore = new Store<unknown>(initialRaw);
  const values: T[] = [];
  const errors: ConfigError[] = [];
  descriptor.start({ rawStore, path, set: (value) => values.push(value), error: (error) => errors.push(error) });
  return { rawStore, values, errors, last: () => values[values.length - 1] };
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

  test("rejects a value that isn't a valid URL by reporting it via control.error(), not by throwing", () => {
    const { errors, values } = runStart(url(), "not a url", ["uri"]);
    expect(errors[0]).toBeInstanceOf(ConfigError);
    expect(values).toEqual([]);
  });

  test("resolves a relative value against an explicit base", () => {
    const parsed = runStart(url({ base: "https://example.com/api/" }), "users", ["uri"]).last();
    expect(parsed?.toString()).toBe("https://example.com/api/users");
  });

  test("without base, a relative value falls back to globalThis.location when set", () => {
    const original = (globalThis as { location?: unknown }).location;
    (globalThis as { location?: unknown }).location = { href: "https://example.com/base/" };
    try {
      const parsed = runStart(url(), "users", ["uri"]).last();
      expect(parsed?.toString()).toBe("https://example.com/base/users");
    } finally {
      (globalThis as { location?: unknown }).location = original;
    }
  });

  test("without base or location, a relative value fails to parse via control.error()", () => {
    const { errors, values } = runStart(url(), "users", ["uri"]);
    expect(errors[0]).toBeInstanceOf(ConfigError);
    expect(values).toEqual([]);
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
    const { errors } = runStart(descriptor, "verbose", ["logLevel"]);
    expect(errors[0]).toBeInstanceOf(ConfigError);
  });
});

describe("list() field builder", () => {
  test('list() builds a Descriptor carrying a { type: "list" } schema', () => {
    expectDescriptor(list(), "list", {});
    expectDescriptor(list({ summary: "allowed origins", default: ["a.com"] }), "list", {
      summary: "allowed origins",
      default: ["a.com"],
    });
  });

  test("splits a plain comma-separated string", () => {
    expect(runStart(list(), "1,2,3,4,5", ["ids"]).last()).toEqual(["1", "2", "3", "4", "5"]);
  });

  test("a double-quoted field may contain literal commas", () => {
    expect(runStart(list(), '"Foo tar , bios did",tar,1234', ["values"]).last()).toEqual([
      "Foo tar , bios did",
      "tar",
      "1234",
    ]);
  });

  test("a backslash escapes a literal comma outside quotes", () => {
    expect(runStart(list(), "Foo\\,tar,biz", ["values"]).last()).toEqual(["Foo,tar", "biz"]);
  });

  test("passes an already-array raw value through, coercing each element to a string", () => {
    expect(runStart(list(), ["a", "b"], ["values"]).last()).toEqual(["a", "b"]);
  });

  test("falls back to options.default when raw is undefined/null", () => {
    expect(runStart(list({ default: ["x"] }), undefined).last()).toEqual(["x"]);
    expect(runStart(list({ default: ["x"] }), null).last()).toEqual(["x"]);
  });

  test("resolves to null when raw is missing and there is no default", () => {
    expect(runStart(list(), undefined).last()).toBeNull();
  });

  test("rejects a non-string, non-array value by reporting it via control.error()", () => {
    const { errors, values } = runStart(list(), 42, ["values"]);
    expect(errors[0]).toBeInstanceOf(ConfigError);
    expect(values).toEqual([]);
  });

  test("required: true is carried through .options and exposed via the .required getter, same as every other field type", () => {
    expectDescriptor(list({ required: true }), "list", { required: true });
    expect(list({ required: true }).required).toBe(true);
    expect(list().required).toBe(false);
  });

  test("required: true alone does not change parsing — a missing value still resolves to null at this point; create()'s own requiredChecks sweep is what escalates it (see config-node.spec.ts)", () => {
    expect(runStart(list({ required: true }), undefined).last()).toBeNull();
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

  test("required: true escalates an invalid value into control.error() instead of logging", () => {
    const descriptor = shape({ schema: z.object({ issuer: z.string() }), required: true });
    const { errors, values } = runStart(descriptor, { issuer: 42 }, ["jwt"]);
    expect(errors[0]).toBeInstanceOf(ConfigError);
    expect(values).toEqual([]);
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
    const { errors } = runStart(string({ pattern: /^\w+$/ }), "not valid");
    expect(errors[0]).toBeInstanceOf(ConfigError);
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
    expect(isConfigDescriptor(list())).toBe(true);
  });

  test("recognizes a directly-constructed Descriptor instance", () => {
    const descriptor = new Descriptor({
      type: "csv",
      options: {},
      start: (control: DescriptorControl<string[]>) => control.set(String(control.rawStore.get()).split(",")),
    });
    expect(isConfigDescriptor(descriptor)).toBe(true);
  });

  test("rejects a plain object exposing a callable start(), even close(), unless it's a real Descriptor instance", () => {
    const handWritten = { start: (control: DescriptorControl<string>) => control.set(String(control.rawStore.get())) };
    expect(isConfigDescriptor(handWritten)).toBe(false);
    expect(isConfigDescriptor({ ...handWritten, close: async () => {} })).toBe(false);
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

describe("writing a custom Descriptor by hand (must go through new Descriptor(...))", () => {
  test("a hand-written descriptor (key + start()), built via new Descriptor(...), behaves like a real one", () => {
    function csv(options: { key?: string | string[] } = {}) {
      const parse = (raw: unknown): string[] => (typeof raw === "string" ? raw.split(",").map((s) => s.trim()) : []);

      return new Descriptor<string[]>({
        type: "csv",
        options,
        start(control: DescriptorControl<string[]>) {
          control.rawStore.subscribe((raw) => control.set(parse(raw)));
        },
      });
    }

    const descriptor = csv({ key: "ALLOWED_ORIGINS" });
    expect(isConfigDescriptor(descriptor)).toBe(true);
    expect(descriptor.key).toBe("ALLOWED_ORIGINS");

    const rawStore = new Store<unknown>("a.com, b.com, c.com");
    const values: string[][] = [];
    descriptor.start({ rawStore, path: [], set: (v) => values.push(v), error: () => {} });

    expect(values[0]).toEqual(["a.com", "b.com", "c.com"]);

    rawStore.set("d.com");
    expect(values[1]).toEqual(["d.com"]);
  });

  test("the same shape (key + start()) as a plain object, without new Descriptor(...), is not recognized", () => {
    function csvPlain(options: { key?: string | string[] } = {}) {
      const parse = (raw: unknown): string[] => (typeof raw === "string" ? raw.split(",").map((s) => s.trim()) : []);

      return {
        key: options.key,
        start(control: DescriptorControl<string[]>) {
          control.rawStore.subscribe((raw) => control.set(parse(raw)));
        },
      };
    }

    expect(isConfigDescriptor(csvPlain({ key: "ALLOWED_ORIGINS" }))).toBe(false);
  });
});
