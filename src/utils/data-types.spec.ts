import { describe, expect, test } from "bun:test";
import { ConfigError } from "../errors";
import { DataTypes } from "./data-types";

describe("DataTypes.number.from", () => {
  test("passes a number through", () => {
    expect(DataTypes.number.from(42)).toBe(42);
  });

  test("parses a numeric string", () => {
    expect(DataTypes.number.from("42")).toBe(42);
  });

  test("converts a boolean", () => {
    expect(DataTypes.number.from(true)).toBe(1);
    expect(DataTypes.number.from(false)).toBe(0);
  });

  test("throws on a non-numeric string", () => {
    expect(() => DataTypes.number.from("abc")).toThrow(ConfigError);
  });

  test("throws on an empty string", () => {
    expect(() => DataTypes.number.from("  ")).toThrow(ConfigError);
  });

  test("throws on any other type", () => {
    expect(() => DataTypes.number.from({})).toThrow(ConfigError);
    expect(() => DataTypes.number.from(null)).toThrow(ConfigError);
    expect(() => DataTypes.number.from(undefined)).toThrow(ConfigError);
  });
});

describe("DataTypes.string.from", () => {
  test("passes a string through", () => {
    expect(DataTypes.string.from("hello")).toBe("hello");
  });

  test("stringifies a number", () => {
    expect(DataTypes.string.from(42)).toBe("42");
  });

  test("stringifies a boolean", () => {
    expect(DataTypes.string.from(true)).toBe("true");
    expect(DataTypes.string.from(false)).toBe("false");
  });

  test("throws on any other type", () => {
    expect(() => DataTypes.string.from({})).toThrow(ConfigError);
    expect(() => DataTypes.string.from(null)).toThrow(ConfigError);
  });
});

describe("DataTypes.boolean.from", () => {
  test("passes a boolean through", () => {
    expect(DataTypes.boolean.from(true)).toBe(true);
    expect(DataTypes.boolean.from(false)).toBe(false);
  });

  test("converts 1 and 0", () => {
    expect(DataTypes.boolean.from(1)).toBe(true);
    expect(DataTypes.boolean.from(0)).toBe(false);
  });

  test("converts 'true'/'1' and 'false'/'0' strings", () => {
    expect(DataTypes.boolean.from("true")).toBe(true);
    expect(DataTypes.boolean.from("1")).toBe(true);
    expect(DataTypes.boolean.from("false")).toBe(false);
    expect(DataTypes.boolean.from("0")).toBe(false);
  });

  test("throws on an ambiguous number", () => {
    expect(() => DataTypes.boolean.from(2)).toThrow(ConfigError);
  });

  test("throws on an ambiguous string", () => {
    expect(() => DataTypes.boolean.from("yes")).toThrow(ConfigError);
  });

  test("throws on any other type", () => {
    expect(() => DataTypes.boolean.from({})).toThrow(ConfigError);
    expect(() => DataTypes.boolean.from(undefined)).toThrow(ConfigError);
  });
});

describe("DataTypes.factory", () => {
  test("returns the number converter", () => {
    expect(DataTypes.factory("number").from("42")).toBe(42);
  });

  test("returns the string converter", () => {
    expect(DataTypes.factory("string").from(42)).toBe("42");
  });

  test("returns the boolean converter", () => {
    expect(DataTypes.factory("boolean").from("true")).toBe(true);
  });

  test("throws on an unknown type name", () => {
    expect(() => DataTypes.factory("date")).toThrow(ConfigError);
  });
});
