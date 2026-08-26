import { ConfigError } from "../errors";
import { Store } from "../utils/store";
import type { DataSourceControl, UnderlyingDataSource } from "../types";

/**
 * A read-only, async config source modeled after `ReadableStream`: `start(control)` runs once,
 * pushing whole-tree snapshots via `control.set(value)` and signaling `control.close()` when done.
 * `open()` resolves once `start()` itself finishes running, with the live `Store` it populated.
 */
export class DataSource<T = unknown> {
  private readonly store = new Store<T | null>(null);
  private closed = false;
  private readonly startPromise: Promise<void>;

  constructor(underlying: UnderlyingDataSource<T>) {
    const control: DataSourceControl<T> = {
      set: (value: T) => {
        if (this.closed) {
          throw new ConfigError("Cannot set a value on a closed DataSource");
        }
        this.store.set(value);
      },
      close: () => {
        if (this.closed) return;
        this.closed = true;
        void Promise.resolve(underlying.close?.());
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
}
