import { describe, expect, spyOn, test } from "bun:test";
import { configs } from "../configs";
import { pullSource } from "./pull";

describe("pullSource", () => {
  test("calls `pull` immediately and publishes its result", async () => {
    let calls = 0;
    const source = pullSource<{ count: number }>({
      pull: () => ({ count: ++calls }),
      interval: 1000,
    });
    const store = await source.open();

    expect(calls).toBe(1);
    expect(store.get()).toEqual({ count: 1 });

    await source.close();
  });

  test("supports an async `pull`", async () => {
    const source = pullSource<{ ok: boolean }>({
      pull: async () => ({ ok: true }),
      interval: 1000,
    });
    const store = await source.open();

    expect(store.get()).toEqual({ ok: true });

    await source.close();
  });

  test("keeps calling `pull` on the given interval, updating the store each time", async () => {
    let calls = 0;
    const source = pullSource<{ count: number }>({
      pull: () => ({ count: ++calls }),
      interval: 5,
    });
    const store = await source.open();

    await Bun.sleep(30);

    expect(calls).toBeGreaterThan(1);
    expect(store.get()).toEqual({ count: calls });

    await source.close();
  });

  test("close() stops the polling", async () => {
    let calls = 0;
    const source = pullSource({
      pull: () => ({ count: ++calls }),
      interval: 5,
    });
    await source.open();
    await source.close();
    const callsAfterClose = calls;

    await Bun.sleep(30);

    expect(calls).toBe(callsAfterClose);
  });

  test("logs and closes with an empty store when the first `pull` throws", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const source = pullSource({
      pull: () => {
        throw new Error("boom");
      },
      interval: 1000,
    });
    const store = await source.open();

    expect(store.get()).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  test("a failure on a later round is logged and skipped, keeping polling alive", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;

    const source = pullSource<{ count: number }>({
      pull: () => {
        calls++;
        if (calls === 2) throw new Error("boom");
        return { count: calls };
      },
      interval: 5,
    });
    const store = await source.open();

    await Bun.sleep(35);

    expect(calls).toBeGreaterThan(2);
    expect(store.get()).not.toBeNull();
    expect(errorSpy).toHaveBeenCalled();

    await source.close();
    errorSpy.mockRestore();
  });

  describe("shape of the data returned by `pull`", () => {
    class MyInstance {
      constructor(public port: number) {}
    }

    test("a well-formed plain object resolves the matching field", async () => {
      const source = pullSource<{ port: number }>({
        pull: () => ({ port: 3000 }),
        interval: 1000,
      });
      const store = await source.open();
      expect(store.get()).toEqual({ port: 3000 });

      const cfg = await configs.create({ port: { type: "number" } }, { sources: [source] });
      expect(cfg.port.get()).toBe(3000);

      await cfg.close();
    });

    test("a well-formed class instance resolves the matching field", async () => {
      const source = pullSource<MyInstance>({
        pull: () => new MyInstance(3000),
        interval: 1000,
      });
      const store = await source.open();
      expect(store.get()).toBeInstanceOf(MyInstance);
      expect(store.get()).toEqual(new MyInstance(3000));

      const cfg = await configs.create({ port: { type: "number" } }, { sources: [source] });
      expect(cfg.port.get()).toBe(3000);

      await cfg.close();
    });

    test("a Proxy wrapping a well-formed object resolves the matching field", async () => {
      const target = { port: 3000 };
      const source = pullSource<{ port: number }>({
        pull: () => new Proxy(target, {}),
        interval: 1000,
      });
      const store = await source.open();
      expect(store.get()).toEqual({ port: 3000 });

      const cfg = await configs.create({ port: { type: "number" } }, { sources: [source] });
      expect(cfg.port.get()).toBe(3000);

      await cfg.close();
    });

    test("a Proxy with a custom `get` trap is read the same as a plain object", async () => {
      // `readNestedValue` does plain bracket access (`data[key]`), so a computed/lazy property
      // behind a `get` trap resolves exactly like an own property would.
      const source = pullSource<{ port: number }>({
        pull: () =>
          new Proxy({} as { port: number }, {
            get: (_target, prop) => (prop === "port" ? 3000 : undefined),
          }),
        interval: 1000,
      });

      const cfg = await configs.create({ port: { type: "number" } }, { sources: [source] });
      expect(cfg.port.get()).toBe(3000);

      await cfg.close();
    });

    test("a wrongly-cased key is published as-is but doesn't resolve the field", async () => {
      const source = pullSource<{ Port: number }>({
        pull: () => ({ Port: 3000 }),
        interval: 1000,
      });
      const store = await source.open();
      // pullSource does no validation — whatever `pull` returns is published verbatim.
      expect(store.get()).toEqual({ Port: 3000 });

      // configs.create looks up fields by exact key, so a mismatched case never resolves.
      const cfg = await configs.create({ port: { type: "number" } }, { sources: [source] });
      expect(cfg.port.get()).toBeNull();

      await cfg.close();
    });

    test("a wrongly-cased key falls back to the field's default instead of the mismatched value", async () => {
      const source = pullSource<{ Port: number }>({
        pull: () => ({ Port: 3000 }),
        interval: 1000,
      });

      const cfg = await configs.create(
        { port: { type: "number", default: 8080 } },
        { sources: [source] },
      );
      expect(cfg.port.get()).toBe(8080);

      await cfg.close();
    });

    test("a `pull` that throws leaves the field at its default instead of failing the config", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});

      const source = pullSource<{ port: number }>({
        pull: () => {
          throw new Error("boom");
        },
        interval: 1000,
      });

      const cfg = await configs.create(
        { port: { type: "number", default: 8080 } },
        { sources: [source] },
      );

      expect(cfg.port.get()).toBe(8080);
      expect(errorSpy).toHaveBeenCalledTimes(1);

      await cfg.close();
      errorSpy.mockRestore();
    });

    test("a `pull` that throws leaves the field `null` when there's no default", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});

      const source = pullSource<{ port: number }>({
        pull: () => {
          throw new Error("boom");
        },
        interval: 1000,
      });

      const cfg = await configs.create({ port: { type: "number" } }, { sources: [source] });

      expect(cfg.port.get()).toBeNull();
      expect(errorSpy).toHaveBeenCalledTimes(1);

      await cfg.close();
      errorSpy.mockRestore();
    });
  });
});
