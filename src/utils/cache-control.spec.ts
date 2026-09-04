import { describe, expect, test } from "bun:test";
import { parseCacheControl } from "./cache-control.js";

describe("parseCacheControl", () => {
  test("returns an empty object for a null/missing header", () => {
    expect(parseCacheControl(null)).toEqual({});
    expect(parseCacheControl(undefined)).toEqual({});
    expect(parseCacheControl("")).toEqual({});
  });

  test("parses max-age", () => {
    expect(parseCacheControl("max-age=60")).toEqual({ maxAge: 60 });
  });

  test("parses no-store and no-cache", () => {
    expect(parseCacheControl("no-store")).toEqual({ noStore: true });
    expect(parseCacheControl("no-cache")).toEqual({ noCache: true });
  });

  test("parses multiple comma-separated directives together", () => {
    expect(parseCacheControl("public, max-age=120, must-revalidate")).toEqual({ maxAge: 120 });
  });

  test("ignores directives it doesn't recognize", () => {
    expect(parseCacheControl("private, must-revalidate")).toEqual({});
  });

  test("ignores a non-numeric or negative max-age", () => {
    expect(parseCacheControl("max-age=abc")).toEqual({});
    expect(parseCacheControl("max-age=-5")).toEqual({});
  });

  test("is case-insensitive on directive names", () => {
    expect(parseCacheControl("Max-Age=30, No-Store")).toEqual({ maxAge: 30, noStore: true });
  });
});
