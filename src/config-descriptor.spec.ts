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
  type FieldType,
} from "./config-descriptor.js";
import { ConfigError } from "./errors.js";
import { Store } from "./utils/store.js";
import { z } from "zod";

/** A `Descriptor` carries its own `start` closure (e.g. `stringParser()`), never equal by reference across two calls — assert `.type`/`.options` shape instead of a full `toEqual` against a hand-built instance. */
function expectDescriptor(descriptor: unknown, type: FieldType, options: object): void {
  expect(descriptor).toBeInstanceOf(Descriptor);
  expect((descriptor as Descriptor<unknown>).type).toBe(type);
  expect((descriptor as Descriptor<unknown>).options).toEqual(options);
  expect(typeof (descriptor as Descriptor<unknown>).start).toBe("function");
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
    const parsed = url().start("postgres://user:pass@localhost:5432/app", ["uri"]);
    expect(parsed).toBeInstanceOf(URL);
    expect(parsed.hostname).toBe("localhost");
    expect(parsed.pathname).toBe("/app");
  });

  test("rejects a value that isn't a valid URL", () => {
    expect(() => url().start("not a url", ["uri"])).toThrow(ConfigError);
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
    expect(descriptor.start("warn", ["logLevel"])).toBe("warn");
    expect(() => descriptor.start("verbose", ["logLevel"])).toThrow(ConfigError);
  });
});

describe("shape() field builder", () => {
  test('shape() builds a Descriptor carrying a { type: "shape" } schema', () => {
    const schema = z.object({ issuer: z.string() });
    expectDescriptor(shape({ schema, required: true }), "shape", { schema, required: true });
  });

  test("parses a valid value via schema.parse, inferring the field's type from it", () => {
    const descriptor = shape({ schema: z.object({ issuer: z.string(), ttl: z.number() }) });
    expect(descriptor.start({ issuer: "auth0", ttl: 3600 }, ["jwt"])).toEqual({ issuer: "auth0", ttl: 3600 });
  });

  test("without schema, passes any object value through untyped", () => {
    const descriptor = shape();
    expect(descriptor.start({ any: "thing" }, ["metadata"])).toEqual({ any: "thing" });
  });

  test("required: true escalates an invalid value into a thrown ConfigError instead of logging", () => {
    const descriptor = shape({ schema: z.object({ issuer: z.string() }), required: true });
    expect(() => descriptor.start({ issuer: 42 }, ["jwt"])).toThrow(ConfigError);
  });
});

describe("Descriptor.start()", () => {
  test("falls back to options.default when raw is undefined/null, without running the underlying start", () => {
    expect(numeric({ default: 3000 }).start(undefined)).toBe(3000);
    expect(numeric({ default: 3000 }).start(null)).toBe(3000);
  });

  test("resolves to null when raw is missing and there is no default", () => {
    expect(numeric().start(undefined)).toBeNull();
  });

  test("runs raw through the field's own start when present", () => {
    expect(numeric().start("8080")).toBe(8080);
    expect(string({ pattern: /^\w+$/ }).start("abc")).toBe("abc");
    expect(() => string({ pattern: /^\w+$/ }).start("not valid")).toThrow(ConfigError);
  });
});

describe("Descriptor.reduce()", () => {
  test("without a reduce hook, resolves to a Store built from start, live off rawStore changes", async () => {
    const rawStore = new Store<unknown>("8080");
    const reduced = await numeric().reduce(rawStore);

    expect(reduced.get()).toBe(8080);

    rawStore.set("9090");
    expect(reduced.get()).toBe(9090);
  });

  test("resolves to the Store its own reduce hook produces", async () => {
    const descriptor = new Descriptor<string>({
      type: "csv",
      options: {},
      start: (raw) => String(raw),
      async reduce(rawStore) {
        return new Store(`reduced:${rawStore.get()}`);
      },
    });

    const resultStore = await descriptor.reduce(new Store<unknown>("abc"));
    expect(resultStore.get()).toBe("reduced:abc");
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
      start: (raw) => String(raw),
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
    expect(isConfigDescriptor(new Descriptor({ type: "csv", options: {}, start: (raw) => String(raw).split(",") }))).toBe(true);
  });

  test("recognizes a hand-written object exposing callable start()/reduce() — no tag needed, close() is optional", () => {
    const handWritten = {
      start: (raw: unknown) => String(raw),
      reduce: async (rawStore: Store<unknown>) => new Store(String(rawStore.get())),
    };
    expect(isConfigDescriptor(handWritten)).toBe(true);
    expect(isConfigDescriptor({ ...handWritten, close: async () => {} })).toBe(true);
  });

  test("rejects an object missing reduce()", () => {
    expect(isConfigDescriptor({ start: (raw: unknown) => raw })).toBe(false);
    expect(isConfigDescriptor({ start: (raw: unknown) => raw, close: async () => {} })).toBe(false);
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

describe("writing a custom Descriptor by hand (structural start()/reduce() contract)", () => {
  test("a hand-written descriptor (key + start() + reduce()) behaves like a real one", () => {
    function csv(options: { key?: string | string[] } = {}) {
      const parse = (raw: unknown): string[] => (typeof raw === "string" ? raw.split(",").map((s) => s.trim()) : []);

      return {
        key: options.key,
        start: parse,
        async reduce(rawStore: Store<unknown>) {
          const store = new Store(parse(rawStore.get()));
          rawStore.listen((raw) => store.set(parse(raw)));
          return store;
        },
      };
    }

    const descriptor = csv({ key: "ALLOWED_ORIGINS" });
    expect(isConfigDescriptor(descriptor)).toBe(true);
    expect(descriptor.key).toBe("ALLOWED_ORIGINS");
    expect(descriptor.start("a.com, b.com, c.com")).toEqual(["a.com", "b.com", "c.com"]);
  });
});
