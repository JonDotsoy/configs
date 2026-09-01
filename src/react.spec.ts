import { describe, expect, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { configs, Source } from "./configs";
import { Store } from "./utils/store";
import { useConfig } from "./react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Reader({ store, onRender }: { store: Store<number>; onRender: (value: number) => void }) {
  const value = useConfig(store);
  onRender(value);
  return null;
}

describe("useConfig", () => {
  test("returns the store's current value", () => {
    const store = new Store(1);
    const renders: number[] = [];

    act(() => {
      TestRenderer.create(React.createElement(Reader, { store, onRender: (v) => renders.push(v) }));
    });

    expect(renders).toEqual([1]);
  });

  test("re-renders when the store updates", () => {
    const store = new Store(1);
    const renders: number[] = [];

    act(() => {
      TestRenderer.create(React.createElement(Reader, { store, onRender: (v) => renders.push(v) }));
    });

    act(() => {
      store.set(2);
    });

    expect(renders).toEqual([1, 2]);
  });

  test("stops re-rendering after unmount", () => {
    const store = new Store(1);
    const renders: number[] = [];
    let renderer: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(React.createElement(Reader, { store, onRender: (v) => renders.push(v) }));
    });

    act(() => {
      renderer.unmount();
    });

    act(() => {
      store.set(2);
    });

    expect(renders).toEqual([1]);
  });
});

describe("useConfig with configs.create()", () => {
  test("reads cfg.foo immediately, without awaiting cfg, and catches up once its source resolves", async () => {
    let resolveStart: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const source = new Source<{ foo: boolean }>({
      async start(control) {
        await started;
        control.set({ foo: true });
        control.close();
      },
    });

    const cfg = configs.create({ foo: { type: "boolean", required: true } }, { sources: [source] });
    const renders: (boolean | null)[] = [];

    act(() => {
      TestRenderer.create(
        React.createElement(function Reader() {
          renders.push(useConfig(cfg.foo));
          return null;
        }),
      );
    });

    expect(renders).toEqual([null]);

    await act(async () => {
      resolveStart!();
      await cfg;
    });

    expect(renders).toEqual([null, true]);
  });
});
