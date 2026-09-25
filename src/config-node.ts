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

/** Reads `path` out of the first `rawSource` snapshot that has it, in priority order. */
function resolveRaw(rawSources: Store<unknown>[], path: string[]): unknown {
  for (const rawSource of rawSources) {
    let node: unknown = rawSource.get();
    for (const key of path) {
      if (node === null || typeof node !== "object") {
        node = undefined;
        break;
      }
      node = (node as Record<string, unknown>)[key];
    }
    if (node !== undefined && node !== null) return node;
  }
  return undefined;
}

/**
 * Recomputes `shape` into `node` in place (reusing every already-built `Store`/nested node, so
 * live references handed out earlier stay valid), one level of `path` deeper per nested group.
 */
function sync(shape: ConfigsShape, path: string[], rawSources: Store<unknown>[], node: Record<string, unknown>): void {
  for (const key of Object.keys(shape)) {
    const entry = shape[key]!;
    const entryPath = [...path, key];
    if (isConfigDescriptor(entry)) {
      const raw = resolveRaw(rawSources, entryPath);
      const value = entry.reduce(raw, entryPath).store.get();
      const store = node[key];
      if (store instanceof Store) {
        if (store.get() !== value) store.set(value);
      } else {
        node[key] = new Store(value);
      }
    } else {
      const child = (node[key] as Record<string, unknown> | undefined) ?? {};
      node[key] = child;
      sync(entry as ConfigsShape, entryPath, rawSources, child);
    }
  }
}

/**
 * Builds a live, plain (non-proxy) `Store` per leaf shape key — recursing into nested groups as
 * plain nested objects — resolved from `options.sources` in priority order — the first source
 * whose snapshot has a field wins, falling back to the field's own `default`, else `null`. The
 * returned object is also `then`able: it resolves once every source has published its first
 * snapshot.
 */
export function create<T extends ConfigsShape>(configShape: T, options: Options = {}): ConfigsNodePending<T> {
  const sources = options.sources ?? [];
  const rawSources: Store<unknown>[] = [];
  const stores: Record<string, unknown> = {};

  sync(configShape, [], rawSources, stores);

  const ready = Promise.all(sources.map((source) => source.open())).then((openedSources) => {
    rawSources.push(...openedSources);
    sync(configShape, [], rawSources, stores);
    for (const rawSource of openedSources) rawSource.listen(() => sync(configShape, [], rawSources, stores));
  });

  const node = stores as unknown as ConfigsNode<T>;

  return Object.assign({ ...stores }, {
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
