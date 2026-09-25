import { describe, expect, test } from "bun:test";
import {
  boolean,
  choice,
  CONFIG_DESCRIPTOR_TAG,
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
  test("is undefined when the constructor wasn't given a reduce hook", () => {
    expect(numeric().reduce(new Store<unknown>("8080"))).toBeUndefined();
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
    expect(resultStore?.get()).toBe("reduced:abc");
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

  test("recognizes a hand-written object carrying the tag plus a callable start()", () => {
    const handWritten = {
      [CONFIG_DESCRIPTOR_TAG]: true as const,
      start: (raw: unknown) => String(raw),
    };
    expect(isConfigDescriptor(handWritten)).toBe(true);
  });

  test("rejects an object carrying the tag but no start()", () => {
    expect(isConfigDescriptor({ [CONFIG_DESCRIPTOR_TAG]: true })).toBe(false);
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

describe("writing a custom Descriptor by hand (CONFIG_DESCRIPTOR_TAG contract)", () => {
  test("a hand-written descriptor (tag + key + start()) behaves like a real one", () => {
    function csv(options: { key?: string | string[] } = {}) {
      return {
        [CONFIG_DESCRIPTOR_TAG]: true as const,
        key: options.key,
        start(raw: unknown): string[] {
          return typeof raw === "string" ? raw.split(",").map((s) => s.trim()) : [];
        },
      };
    }

    const descriptor = csv({ key: "ALLOWED_ORIGINS" });
    expect(isConfigDescriptor(descriptor)).toBe(true);
    expect(descriptor.key).toBe("ALLOWED_ORIGINS");
    expect(descriptor.start("a.com, b.com, c.com")).toEqual(["a.com", "b.com", "c.com"]);
  });
});
