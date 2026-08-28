import { Store } from "../utils/store.js";
import type { SourceControl, UnderlyingSource } from "../types/index.js";

/**
 * A read-only, async config source modeled after `ReadableStream`: `start(control)` runs once,
 * pushing whole-tree snapshots via `control.set(value)` and signaling `control.close()` when done.
 * `open()` resolves once `start()` itself finishes running, with the live `Store` it populated.
 * With `reduce`, every `control.set(value)` runs `value` (and the last published value) through it
 * first, so `start()` can hand it partial patches instead of whole snapshots.
 */
export class Source<T = unknown> {
  private readonly store = new Store<T | null>(null);
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private readonly startPromise: Promise<void>;

  constructor(private readonly underlying: UnderlyingSource<T>) {
    const control: SourceControl<T> = {
      // Silently dropped once closed — `close()` can race a still-running `start()` (e.g. an
      // external close while a fetch is in flight), and that shouldn't make `open()` reject.
      set: (value: T) => {
        if (this.closed) return;
        const next = this.underlying.reduce ? this.underlying.reduce(value, this.store.get()) : value;
        this.store.set(next);
      },
      close: () => {
        void this.close();
      },
    };

    this.startPromise = Promise.resolve()
      .then(() => underlying.start(control))
      .then(() => undefined);
    // `open()` no one awaits must not surface as an unhandled rejection.
    this.startPromise.catch(() => {});
  }

  async open(): Promise<Store<T | null>> {
    await this.startPromise;
    return this.store;
  }

  /**
   * Closes the source: runs its `close()` hook (if any) at most once, whether triggered from
   * within `start()` (via `control.close()`) or from the outside. Safe to call any number of
   * times, before or after `open()` — every call resolves once the same underlying close settles.
   */
  close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      this.closePromise = Promise.resolve(this.underlying.close?.()).then(
        () => undefined,
        () => undefined,
      );
    }
    return this.closePromise;
  }
}
