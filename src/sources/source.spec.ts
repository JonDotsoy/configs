import { describe, expect, test } from "bun:test";
import { Source } from "./source";

describe("Source reduce", () => {
  test("publishes control.set(value) as-is when no reduce is given", async () => {
    const source = new Source<number>({
      start(control) {
        control.set(1);
        control.close();
      },
    });
    const store = await source.open();

    expect(store.get()).toBe(1);
  });

  test("runs every control.set(incoming) through reduce before publishing it", async () => {
    const source = new Source<number>({
      start(control) {
        control.set(1);
        control.set(2);
        control.set(3);
        control.close();
      },
      reduce: (incoming, previous) => (previous ?? 0) + incoming,
    });
    const store = await source.open();

    expect(store.get()).toBe(6);
  });

  test("passes null as previous on the first control.set() call", async () => {
    const previousValues: (number | null)[] = [];
    const source = new Source<number>({
      start(control) {
        control.set(1);
        control.set(2);
        control.close();
      },
      reduce: (incoming, previous) => {
        previousValues.push(previous);
        return incoming;
      },
    });
    await source.open();

    expect(previousValues).toEqual([null, 1]);
  });

  test("merges a partial patch onto the accumulated value, like sseSource does", async () => {
    const source = new Source<Record<string, unknown>>({
      start(control) {
        control.set({ port: 3000 });
        control.set({ host: "localhost" });
        control.close();
      },
      reduce: (patch, previous) => ({ ...(previous ?? {}), ...patch }),
    });
    const store = await source.open();

    expect(store.get()).toEqual({ port: 3000, host: "localhost" });
  });
});
