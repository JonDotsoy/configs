import { describe, expect, test } from "bun:test";
import { boolean, choice, ConfigDescriptor, numeric, shape, string, url, type FieldType } from "./config-descriptor.js";
import { ConfigError } from "./errors.js";
import { Store } from "./utils/store.js";
import { z } from "zod";

/** A `ConfigDescriptor` carries its own `parser` closure (e.g. `stringParser()`), never equal by reference across two calls — assert `.type`/`.options`/`.parser` shape instead of a full `toEqual` against a hand-built instance. */
function expectDescriptor(descriptor: unknown, type: FieldType, options: object): void {
  expect(descriptor).toBeInstanceOf(ConfigDescriptor);
  expect((descriptor as ConfigDescriptor<unknown>).type).toBe(type);
  expect((descriptor as ConfigDescriptor<unknown>).options).toEqual(options);
  expect(typeof (descriptor as ConfigDescriptor<unknown>).parser).toBe("function");
}

describe("string/numeric/boolean field builders", () => {
  test('string() builds a ConfigDescriptor<string> carrying a { type: "string" } schema', () => {
    expectDescriptor(string(), "string", {});
    expectDescriptor(string({ summary: "bind host", default: "localhost" }), "string", {
      summary: "bind host",
      default: "localhost",
    });
  });

  test('numeric() builds a ConfigDescriptor<number> carrying a { type: "number" } schema', () => {
    expectDescriptor(numeric(), "number", {});
    expectDescriptor(numeric({ summary: "HTTP port", default: 3000 }), "number", {
      summary: "HTTP port",
      default: 3000,
    });
  });

  test('boolean() builds a ConfigDescriptor<boolean> carrying a { type: "boolean" } schema', () => {
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
  test('url() builds a ConfigDescriptor<URL> carrying a { type: "url" } schema', () => {
    expectDescriptor(url(), "url", {});
    expectDescriptor(url({ key: "DATABASE_URL" }), "url", { key: "DATABASE_URL" });
  });

  test("parses a valid URL string into a URL instance", () => {
    const parsed = url().parser("postgres://user:pass@localhost:5432/app", ["uri"]);
    expect(parsed).toBeInstanceOf(URL);
    expect(parsed.hostname).toBe("localhost");
    expect(parsed.pathname).toBe("/app");
  });

  test("rejects a value that isn't a valid URL", () => {
    expect(() => url().parser("not a url", ["uri"])).toThrow(ConfigError);
  });
});

describe("choice() field builder", () => {
  test('choice() builds a ConfigDescriptor carrying a { type: "choice" } schema', () => {
    expectDescriptor(choice({ options: ["a", "b"] }), "choice", { options: ["a", "b"] });
    expectDescriptor(choice({ options: ["a", "b"], default: "a" }), "choice", {
      options: ["a", "b"],
      default: "a",
    });
  });

  test("parser accepts only one of the listed options", () => {
    const descriptor = choice({ options: ["debug", "info", "warn", "error"] });
    expect(descriptor.parser("warn", ["logLevel"])).toBe("warn");
    expect(() => descriptor.parser("verbose", ["logLevel"])).toThrow(ConfigError);
  });
});

describe("shape() field builder", () => {
  test('shape() builds a ConfigDescriptor carrying a { type: "shape" } schema', () => {
    const schema = z.object({ issuer: z.string() });
    expectDescriptor(shape({ schema, required: true }), "shape", { schema, required: true });
  });

  test("parses a valid value via schema.parse, inferring the field's type from it", () => {
    const descriptor = shape({ schema: z.object({ issuer: z.string(), ttl: z.number() }) });
    expect(descriptor.parser({ issuer: "auth0", ttl: 3600 }, ["jwt"])).toEqual({ issuer: "auth0", ttl: 3600 });
  });

  test("without schema, passes any object value through untyped", () => {
    const descriptor = shape();
    expect(descriptor.parser({ any: "thing" }, ["metadata"])).toEqual({ any: "thing" });
  });

  test("required: true escalates an invalid value into a thrown ConfigError instead of logging", () => {
    const descriptor = shape({ schema: z.object({ issuer: z.string() }), required: true });
    expect(() => descriptor.parser({ issuer: 42 }, ["jwt"])).toThrow(ConfigError);
  });
});

describe("ConfigDescriptor.reduce()", () => {
  test("falls back to options.default when raw is undefined/null, without running the parser", () => {
    expect(numeric({ default: 3000 }).reduce(new Store<unknown>(undefined)).get()).toBe(3000);
    expect(numeric({ default: 3000 }).reduce(new Store<unknown>(null)).get()).toBe(3000);
  });

  test("resolves to null when raw is missing and there is no default", () => {
    expect(numeric().reduce(new Store<unknown>(undefined)).get()).toBeNull();
  });

  test("runs raw through the field's own parser when present", () => {
    expect(numeric().reduce(new Store<unknown>("8080")).get()).toBe(8080);
    expect(string({ pattern: /^\w+$/ }).reduce(new Store<unknown>("abc")).get()).toBe("abc");
    expect(() => string({ pattern: /^\w+$/ }).reduce(new Store<unknown>("not valid"))).toThrow(ConfigError);
  });

  test("stays live: recomputes whenever rawStore changes", () => {
    const rawStore = new Store<unknown>("8080");
    const reduced = numeric().reduce(rawStore);
    expect(reduced.get()).toBe(8080);

    rawStore.set("9090");
    expect(reduced.get()).toBe(9090);

    rawStore.set(undefined);
    expect(reduced.get()).toBeNull();
  });
});
