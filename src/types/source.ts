/** Passed to `start()`, mirroring a `ReadableStreamDefaultController`. */
export interface SourceControl<T> {
  /** Publishes a new full-tree snapshot. */
  set(value: T): void;
  /** Marks the source as done; no further `set()` calls are expected. */
  close(): void;
}

/** The object passed to `new Source(...)`, mirroring an `UnderlyingSource` for `ReadableStream`. */
export interface UnderlyingSource<T> {
  start(control: SourceControl<T>): void | Promise<void>;
  close?(): void | Promise<void>;
}
