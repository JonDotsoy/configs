import { isConfigDescriptor, type ConfigDescriptor } from "./config-descriptor.js";
import type { Source } from "./sources/source.js";
import { Store } from "./utils/store.js";

/** A shape entry is either a leaf field descriptor, or a nested group of more shape entries. */
export interface ConfigsShape {
  [key: string]: ConfigDescriptor<any, any> | ConfigsShape;
}

export interface Options {
  sources?: Source<any>[];
}

type InferValue<D> = D extends ConfigDescriptor<infer V, infer O> ? (O extends { default: any } ? V : V | null) : never;

type InferConfigsNode<T extends ConfigsShape> = {
  [K in keyof T]: T[K] extends ConfigDescriptor<any, any> ? Store<InferValue<T[K]>> : T[K] extends ConfigsShape ? InferConfigsNode<T[K]> : never;
};

export type ConfigsNode<T extends ConfigsShape> = InferConfigsNode<T>;

export type ConfigsNodePending<T extends ConfigsShape> = ConfigsNode<T> & {
  then<TResult1 = ConfigsNode<T>, TResult2 = never>(
    onfulfilled?: ((value: ConfigsNode<T>) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): PromiseLike<TResult1 | TResult2>;
};

/** Walks `path` into `snapshot`, one key at a time; `undefined` if any segment is missing or not an object. */
function readPath(snapshot: unknown, path: string[]): unknown {
  let node = snapshot;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * One field's raw value, live: the first `rawSources` entry (in priority order) whose snapshot
 * has `path` wins. `rawSources` is a fixed array of per-source placeholder `Store`s (see
 * `create()`) — this subscribes to every one of them up front, so it reacts the moment a source
 * actually opens and starts forwarding into its placeholder, with no rewiring needed later.
 */
function keyStore(rawSources: Store<unknown>[], path: string[]): Store<unknown> {
  const compute = (): unknown => {
    for (const rawSource of rawSources) {
      const raw = readPath(rawSource.get(), path);
      if (raw !== undefined && raw !== null) return raw;
    }
    return undefined;
  };
  const store = new Store<unknown>(compute());
  for (const rawSource of rawSources) {
    rawSource.listen(() => {
      const next = compute();
      if (next !== store.get()) store.set(next);
    });
  }
  return store;
}

/**
 * Recursively builds `shape` into a plain tree of `Store`s (leaves) and nested plain objects
 * (groups) — each leaf wired as its own independent `Source → KeyStore → FieldStore` chain:
 * `keyStore()` merges `rawSources` at that leaf's path, and `descriptor.reduce()` turns that into
 * the field's own live, parsed `Store`. A leaf only recomputes when a source at its own path
 * changes — there's no whole-tree recompute sweep.
 */
function buildNode(shape: ConfigsShape, path: string[], rawSources: Store<unknown>[]): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) {
    const entry = shape[key]!;
    const entryPath = [...path, key];
    node[key] = isConfigDescriptor(entry)
      ? entry.reduce(keyStore(rawSources, entryPath), entryPath)
      : buildNode(entry as ConfigsShape, entryPath, rawSources);
  }
  return node;
}

/**
 * Builds a live, plain (non-proxy) `Store` per leaf shape key — recursing into nested groups as
 * plain nested objects. Each `options.sources` entry gets its own placeholder `Store`, wired up
 * to every field's chain from the very start (see `buildNode()`/`keyStore()`): once that source's
 * own `open()` resolves, its value — and every later update — forwards into the placeholder,
 * which ripples reactively through to just the fields whose path it can resolve. The returned
 * object is also `then`able: it resolves once every source has published its first snapshot.
 */
export function create<T extends ConfigsShape>(configShape: T, options: Options = {}): ConfigsNodePending<T> {
  const sources = options.sources ?? [];
  const rawSources = sources.map(() => new Store<unknown>(null));

  const node = buildNode(configShape, [], rawSources) as ConfigsNode<T>;

  const ready = Promise.all(
    sources.map((source, index) =>
      source.open().then((opened) => {
        opened.subscribe((value) => rawSources[index]!.set(value));
      }),
    ),
  ).then(() => node);

  return Object.assign({ ...node }, {
    then<TResult1 = ConfigsNode<T>, TResult2 = never>(
      onfulfilled?: ((value: ConfigsNode<T>) => TResult1 | PromiseLike<TResult1>) | undefined | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined | null,
    ): PromiseLike<TResult1 | TResult2> {
      // `node` (not `this`) is what resolves: `this` also carries `then`, so resolving to it would
      // make the Promise machinery treat it as thenable again and re-invoke `then` recursively.
      return ready.then(() => node).then(onfulfilled, onrejected as any);
    },
  }) as ConfigsNodePending<T>;
}
