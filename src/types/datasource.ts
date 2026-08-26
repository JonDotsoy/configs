/** Passed to `start()`, mirroring a `ReadableStreamDefaultController`. */
export interface DataSourceControl<T> {
  /** Publishes a new full-tree snapshot. */
  set(value: T): void;
  /** Marks the source as done; no further `set()` calls are expected. */
  close(): void;
}

/** The object passed to `new DataSource(...)`, mirroring an `UnderlyingSource` for `ReadableStream`. */
export interface UnderlyingDataSource<T> {
  start(control: DataSourceControl<T>): void | Promise<void>;
  close?(): void | Promise<void>;
}
