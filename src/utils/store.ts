/** Return `Unsubscribe` for cleanup run when this subscriber unsubscribes; any other return value is ignored. */
export type Subscriber<T> = (value: T) => unknown;
export type Unsubscribe = (() => void) & Disposable;

/** Wraps `fn` so it can also be used with `using unsub = store.subscribe(...)`. */
const disposable = (fn: () => void): Unsubscribe => Object.assign(fn, { [Symbol.dispose]: fn });
export type EventListener = () => void;

/** A read-only view of a `Store<T>`: exposes `get`/`subscribe`/`listen` but never `set`. */
export interface ReadOnlyStore<T> {
  get(): T;
  /** Calls `subscriber` immediately with the current value, then on every subsequent update. */
  subscribe(subscriber: Subscriber<T>): Unsubscribe;
  /** Calls `subscriber` only on subsequent updates, not with the current value. */
  listen(subscriber: Subscriber<T>): Unsubscribe;
}

export class Store<T> {
  private value: T;
  private readonly subscribers = new Set<Subscriber<T>>();
  private readonly cleanups = new Map<Subscriber<T>, () => void>();
  private readonly mountListeners = new Set<EventListener>();
  private readonly unmountListeners = new Set<EventListener>();

  constructor(initial: T) {
    this.value = initial;
  }

  get(): T {
    return this.value;
  }

  set(next: T): void {
    this.value = next;
    for (const subscriber of this.subscribers) {
      this.runSubscriber(subscriber, this.value);
    }
  }

  /** Calls `subscriber` immediately with the current value, then on every subsequent `set`. */
  subscribe(subscriber: Subscriber<T>): Unsubscribe {
    this.addSubscriber(subscriber);
    this.runSubscriber(subscriber, this.value);
    return disposable(() => this.removeSubscriber(subscriber));
  }

  /** Calls `subscriber` only on subsequent `set` calls, not with the current value. */
  listen(subscriber: Subscriber<T>): Unsubscribe {
    this.addSubscriber(subscriber);
    return disposable(() => this.removeSubscriber(subscriber));
  }

  /** Runs `subscriber` and stores its returned cleanup, if any, to run on unsubscribe. */
  private runSubscriber(subscriber: Subscriber<T>, value: T): void {
    const cleanup = subscriber(value);
    if (typeof cleanup === "function") this.cleanups.set(subscriber, cleanup as () => void);
  }

  /** Fires once a first subscriber is registered (via `subscribe` or `listen`). */
  private onMount(listener: EventListener): Unsubscribe {
    this.mountListeners.add(listener);
    return disposable(() => {
      this.mountListeners.delete(listener);
    });
  }

  /** Fires once the last subscriber is removed. */
  private onUnmount(listener: EventListener): Unsubscribe {
    this.unmountListeners.add(listener);
    return disposable(() => {
      this.unmountListeners.delete(listener);
    });
  }

  private addSubscriber(subscriber: Subscriber<T>): void {
    const wasEmpty = this.subscribers.size === 0;
    if (wasEmpty) {
      // Mount side effects (e.g. `computed`'s source subscription) may call `set()`
      // before `subscriber` is registered, so it doesn't receive a duplicate emission.
      for (const listener of this.mountListeners) listener();
    }
    this.subscribers.add(subscriber);
  }

  private removeSubscriber(subscriber: Subscriber<T>): void {
    if (!this.subscribers.delete(subscriber)) return;
    const cleanup = this.cleanups.get(subscriber);
    this.cleanups.delete(subscriber);
    cleanup?.();
    if (this.subscribers.size === 0) {
      for (const listener of this.unmountListeners) listener();
    }
  }

  /**
   * Runs `callback` on mount; if it returns a function, that function runs on unmount.
   * Returns an unsubscribe that tears down the wiring (running any pending cleanup first).
   */
  static onMount<T>(store: Store<T>, callback: () => void | (() => void)): Unsubscribe {
    let cleanup: void | (() => void);

    const unsubMount = store.onMount(() => {
      cleanup = callback();
    });
    const unsubUnmount = store.onUnmount(() => {
      cleanup?.();
      cleanup = undefined;
    });

    return disposable(() => {
      cleanup?.();
      cleanup = undefined;
      unsubMount();
      unsubUnmount();
    });
  }
}

function create<T>(initial: T): Store<T> {
  return new Store(initial);
}

/**
 * Derives a read-through `Store<R>` from `source` via `selector`. It only subscribes to
 * `source` while it has subscribers of its own, so mounting/unmounting the computed store
 * mounts/unmounts `source` in turn.
 */
function computed<T, R>(source: Store<T>, selector: (value: T) => R): Store<R> {
  const result = new Store<R>(selector(source.get()));
  Store.onMount(result, () => {
    return source.subscribe((value) => {
      result.set(selector(value));
    });
  });
  return result;
}

export const store = { create, computed, onMount: Store.onMount };

export default store;
