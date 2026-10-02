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

  test("subscribe calls the subscriber's returned cleanup when it unsubscribes", () => {
    const s = store.create<number>(0);
    let cleanups = 0;

    const unsub = s.subscribe(() => {
      return () => {
        cleanups++;
      };
    });

    expect(cleanups).toBe(0);
    unsub();
    expect(cleanups).toBe(1);
  });

  test("subscribe does not call cleanup before the subscriber unsubscribes", () => {
    const s = store.create<number>(0);
    let cleanups = 0;

    const unsub = s.subscribe(() => {
      return () => {
        cleanups++;
      };
    });

    s.set(1);
    s.set(2);

    expect(cleanups).toBe(0);
    unsub();
  });

  test("subscribe tolerates a subscriber that returns nothing", () => {
    const s = store.create<number>(0);

    const unsub = s.subscribe(() => {});

    expect(() => unsub()).not.toThrow();
  });

  test("subscribe does not double-call cleanup when unsubscribed twice", () => {
    const s = store.create<number>(0);
    let cleanups = 0;

    const unsub = s.subscribe(() => {
      return () => {
        cleanups++;
      };
    });

    unsub();
    unsub();

    expect(cleanups).toBe(1);
  });

  test("subscribe calls each independent subscriber's own cleanup", () => {
    const s = store.create<number>(0);
    const cleaned: string[] = [];

    const unsubA = s.subscribe(() => () => cleaned.push("a"));
    const unsubB = s.subscribe(() => () => cleaned.push("b"));

    unsubA();
    expect(cleaned).toEqual(["a"]);

    unsubB();
    expect(cleaned).toEqual(["a", "b"]);
  });

  test("listen calls the subscriber's returned cleanup when it unsubscribes", () => {
    const s = store.create<number>(0);
    let cleanups = 0;

    const unsub = s.listen(() => {
      return () => {
        cleanups++;
      };
    });

    s.set(1);
    expect(cleanups).toBe(0);

    unsub();
    expect(cleanups).toBe(1);
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

  test("one store's subscribe callback can drive another store's value", () => {
    const store1 = store.create<number>(1);
    const store2 = store.create<number>(2);

    store2.subscribe((val) => {
      store1.set(10 + val);
    });

    expect(store1.get()).toBe(12);
    expect(store2.get()).toBe(2);

    store2.set(3);

    expect(store1.get()).toBe(13);
    expect(store2.get()).toBe(3);
  });

  test("one store's listen callback can drive another store's value", () => {
    const store1 = store.create<number>(1);
    const store2 = store.create<number>(2);

    store2.listen((val) => {
      store1.set(10 + val);
    });

    expect(store1.get()).toBe(1);
    expect(store2.get()).toBe(2);

    store2.set(3);

    expect(store1.get()).toBe(13);
    expect(store2.get()).toBe(3);
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

test("subscribe supports `using` for automatic unsubscribe", () => {
  const s = new Store(1);
  const seen: number[] = [];
  {
    using _unsub = s.subscribe((v) => {
      seen.push(v);
    });
    s.set(2);
  }
  s.set(3);
  expect(seen).toEqual([1, 2]);
});

test("listen supports `using` for automatic unsubscribe", () => {
  const s = new Store(1);
  const seen: number[] = [];
  {
    using _unsub = s.listen((v) => {
      seen.push(v);
    });
    s.set(2);
  }
  s.set(3);
  expect(seen).toEqual([2]);
});
