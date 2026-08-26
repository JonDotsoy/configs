import { describe, expect, expectTypeOf, test } from "bun:test";
import { Store, store } from "./store";

describe("store", () => {
  test("get/set round-trip a value", () => {
    const s = store.create<number>(0);

    expect(s.get()).toBe(0);
    s.set(3);
    expect(s.get()).toBe(3);

    expectTypeOf(s.get()).toEqualTypeOf<number>();
  });

  test("subscribe fires immediately with the current value", () => {
    const s = store.create<number>(0);
    const seen: number[] = [];

    const unsub = s.subscribe((value) => {
      seen.push(value);
    });

    expect(seen).toEqual([0]);
    unsub();
  });

  test("subscribe fires again on every set", () => {
    const s = store.create<number>(0);
    const seen: number[] = [];

    const unsub = s.subscribe((value) => {
      seen.push(value);
    });

    s.set(3);
    s.set(5);

    expect(seen).toEqual([0, 3, 5]);
    unsub();
  });

  test("unsubscribe stops further notifications", () => {
    const s = store.create<number>(0);
    const seen: number[] = [];

    const unsub = s.subscribe((value) => {
      seen.push(value);
    });
    unsub();

    s.set(3);

    expect(seen).toEqual([0]);
  });

  test("listen does not fire with the current value", () => {
    const s = store.create<number>(0);
    const seen: number[] = [];

    const unsub = s.listen((value) => {
      seen.push(value);
    });

    expect(seen).toEqual([]);
    unsub();
  });

  test("listen fires on subsequent set calls", () => {
    const s = store.create<number>(0);
    const seen: number[] = [];

    const unsub = s.listen((value) => {
      seen.push(value);
    });

    s.set(3);
    s.set(7);

    expect(seen).toEqual([3, 7]);
    unsub();
  });

  test("unsubscribe on listen stops further notifications", () => {
    const s = store.create<number>(0);
    const seen: number[] = [];

    const unsub = s.listen((value) => {
      seen.push(value);
    });
    unsub();

    s.set(3);

    expect(seen).toEqual([]);
  });

  test("supports multiple independent subscribers", () => {
    const s = store.create<number>(0);
    const a: number[] = [];
    const b: number[] = [];

    const unsubA = s.subscribe((value) => a.push(value));
    const unsubB = s.listen((value) => b.push(value));

    s.set(1);

    expect(a).toEqual([0, 1]);
    expect(b).toEqual([1]);

    unsubA();
    unsubB();
  });

  test("Store.onMount fires mount only when the first subscriber is added", () => {
    const s = store.create<number>(0);
    let mounts = 0;
    Store.onMount(s, () => {
      mounts++;
    });

    const unsubA = s.subscribe(() => {});
    expect(mounts).toBe(1);

    const unsubB = s.listen(() => {});
    expect(mounts).toBe(1);

    unsubA();
    unsubB();
  });

  test("Store.onMount fires its cleanup only when the last subscriber is removed", () => {
    const s = store.create<number>(0);
    let unmounts = 0;
    Store.onMount(s, () => {
      return () => {
        unmounts++;
      };
    });

    const unsubA = s.subscribe(() => {});
    const unsubB = s.listen(() => {});

    unsubA();
    expect(unmounts).toBe(0);

    unsubB();
    expect(unmounts).toBe(1);
  });

  test("removing an unrelated subscriber twice does not double-fire the cleanup", () => {
    const s = store.create<number>(0);
    let unmounts = 0;
    Store.onMount(s, () => {
      return () => {
        unmounts++;
      };
    });

    const unsub = s.subscribe(() => {});
    unsub();
    unsub();

    expect(unmounts).toBe(1);
  });

  test("Store.onMount runs the callback on mount and its cleanup on unmount", () => {
    const s = store.create<number>(0);
    const events: string[] = [];

    Store.onMount(s, () => {
      events.push("mount");
      return () => {
        events.push("unmount");
      };
    });

    expect(events).toEqual([]);

    const unsub = s.subscribe(() => {});
    expect(events).toEqual(["mount"]);

    unsub();
    expect(events).toEqual(["mount", "unmount"]);
  });

  test("Store.onMount tolerates a callback that returns nothing", () => {
    const s = store.create<number>(0);
    let mounts = 0;

    Store.onMount(s, () => {
      mounts++;
    });

    const unsub = s.subscribe(() => {});
    unsub();

    expect(mounts).toBe(1);
  });

  test("Store.onMount cycles across repeated mount/unmount", () => {
    const s = store.create<number>(0);
    const events: string[] = [];

    Store.onMount(s, () => {
      events.push("mount");
      return () => events.push("unmount");
    });

    s.subscribe(() => {})();
    s.subscribe(() => {})();

    expect(events).toEqual(["mount", "unmount", "mount", "unmount"]);
  });

  test("unsubscribing Store.onMount runs pending cleanup and stops further wiring", () => {
    const s = store.create<number>(0);
    const events: string[] = [];

    const unsubOnMount = Store.onMount(s, () => {
      events.push("mount");
      return () => events.push("unmount");
    });

    const unsub = s.subscribe(() => {});
    expect(events).toEqual(["mount"]);

    unsubOnMount();
    expect(events).toEqual(["mount", "unmount"]);

    unsub();
    expect(events).toEqual(["mount", "unmount"]);
  });

  test("works with non-primitive values", () => {
    const s = store.create<{ count: number }>({ count: 0 });

    expect(s.get()).toEqual({ count: 0 });
    s.set({ count: 42 });
    expect(s.get()).toEqual({ count: 42 });
  });
});

describe("store.computed", () => {
  test("derives its value from the source via the selector", () => {
    const systemStore = store.create({ server: { port: 3000, host: "127.0.0.1" } });
    const port = store.computed(systemStore, (value) => value.server.port);

    expect(port.get()).toBe(3000);

    expectTypeOf(port).toEqualTypeOf<Store<number>>();
  });

  test("updates when the source changes, once it has a subscriber", () => {
    const systemStore = store.create({ server: { port: 3000, host: "127.0.0.1" } });
    const port = store.computed(systemStore, (value) => value.server.port);

    const seen: number[] = [];
    const unsub = port.subscribe((value) => seen.push(value));

    systemStore.set({ server: { port: 4000, host: "127.0.0.1" } });

    expect(seen).toEqual([3000, 4000]);
    expect(port.get()).toBe(4000);

    unsub();
  });

  test("mounts the source store only while the computed store has subscribers", () => {
    const systemStore = store.create({ server: { port: 3000, host: "127.0.0.1" } });
    const port = store.computed(systemStore, (value) => value.server.port);

    let a = 0;
    store.onMount(systemStore, () => {
      a++;
      return () => {
        a--;
      };
    });

    expect(a).toBe(0);

    const unsubListen = port.listen(() => {});
    expect(a).toBe(1);

    const unsubSubscribe = port.subscribe(() => {});
    expect(a).toBe(1);

    unsubListen();
    unsubSubscribe();

    expect(a).toBe(0);
  });

  test("re-mounts the source on a second round of subscribers", () => {
    const systemStore = store.create({ server: { port: 3000, host: "127.0.0.1" } });
    const port = store.computed(systemStore, (value) => value.server.port);

    let a = 0;
    store.onMount(systemStore, () => {
      a++;
      return () => {
        a--;
      };
    });

    port.subscribe(() => {})();
    expect(a).toBe(0);

    port.subscribe(() => {})();
    expect(a).toBe(0);
  });
});
