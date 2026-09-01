import { describe, expect, expectTypeOf, test } from "bun:test";
import { t } from "./t";

describe("t", () => {
  test("resolves [true, null, result] for a fulfilled promise", async () => {
    const [ok, err, result] = await t(Promise.resolve(42));

    expect(ok).toBe(true);
    expect(err).toBeNull();
    expect(result).toBe(42);
  });

  test("resolves [false, err, null] for a rejected promise", async () => {
    const error = new Error("boom");
    const [ok, err, result] = await t(Promise.reject(error));

    expect(ok).toBe(false);
    expect(err).toBe(error);
    expect(result).toBeNull();
  });

  test("resolves [true, null, result] for a sync function returning a value", async () => {
    const [ok, err, result] = await t(() => 7);

    expect(ok).toBe(true);
    expect(err).toBeNull();
    expect(result).toBe(7);
  });

  test("resolves [false, err, null] for a sync function that throws", async () => {
    const error = new Error("sync boom");
    const [ok, err, result] = await t(() => {
      throw error;
    });

    expect(ok).toBe(false);
    expect(err).toBe(error);
    expect(result).toBeNull();
  });

  test("resolves [true, null, result] for an async function that resolves", async () => {
    const [ok, err, result] = await t(async () => "done");

    expect(ok).toBe(true);
    expect(err).toBeNull();
    expect(result).toBe("done");
  });

  test("resolves [false, err, null] for an async function that rejects", async () => {
    const error = new Error("async boom");
    const [ok, err, result] = await t(async () => {
      throw error;
    });

    expect(ok).toBe(false);
    expect(err).toBe(error);
    expect(result).toBeNull();
  });

  test("propagates a thrown non-Error value as-is", async () => {
    const [ok, err, result] = await t(() => {
      throw "just a string";
    });

    expect(ok).toBe(false);
    expect(err).toBe("just a string");
    expect(result).toBeNull();
  });

  test("narrows result to T and err to null on the success branch", async () => {
    const tuple = await t(() => "hello");

    if (tuple[0]) {
      expectTypeOf(tuple[2]).toEqualTypeOf<string>();
      expectTypeOf(tuple[1]).toEqualTypeOf<null>();
    }
  });

  test("narrows result to null on the failure branch", async () => {
    const tuple = await t(() => "hello");

    if (!tuple[0]) {
      expectTypeOf(tuple[2]).toEqualTypeOf<null>();
    }
  });

  test("destructured ok/err/data narrow the same way as the tuple form", async () => {
    const [ok, err, data] = await t<string>(() => "hello");

    if (ok) {
      expectTypeOf(data).toEqualTypeOf<string>();
      expectTypeOf(err).toEqualTypeOf<null>();
    } else {
      expectTypeOf(data).toEqualTypeOf<null>();
      expectTypeOf(err).toEqualTypeOf<unknown>();
    }
  });
});
