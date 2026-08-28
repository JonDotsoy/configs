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
  /**
   * When present, every `control.set(incoming)` call runs `incoming` through `reduce` (along with
   * the last published value, `null` before the first `set()`) instead of publishing it as-is —
   * so a source that only ever hands `start()` a partial patch, like an SSE message, can publish
   * the merged result without keeping its own accumulator variable around.
   */
  reduce?(incoming: T, previous: T | null): T;
}
