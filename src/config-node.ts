import type { ConfigDescriptor } from "./config-descriptor.js";
import type { Source } from "./sources/source.js";
import { Store } from "./utils/store.js";

export type ConfigsShape = Record<string, ConfigDescriptor<any, any>>;

export interface Options {
  sources?: Source<any>[];
}

type InferValue<D> = D extends ConfigDescriptor<infer V, infer O> ? (O extends { default: any } ? V : V | null) : never;

type InferConfigsNode<T extends ConfigsShape> = {
  [K in keyof T]: Store<InferValue<T[K]>>;
};

export type ConfigsNode<T extends ConfigsShape> = InferConfigsNode<T>;

export type ConfigsNodePending<T extends ConfigsShape> = ConfigsNode<T> & {
  then<TResult1 = ConfigsNode<T>, TResult2 = never>(
    onfulfilled?: ((value: ConfigsNode<T>) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): PromiseLike<TResult1 | TResult2>;
};

function resolveRaw(rawSources: Store<unknown>[], key: string): unknown {
  for (const rawSource of rawSources) {
    const snapshot = rawSource.get();
    const raw = snapshot !== null && typeof snapshot === "object" ? (snapshot as Record<string, unknown>)[key] : undefined;
    if (raw !== undefined && raw !== null) return raw;
  }
  return undefined;
}

/**
 * Builds a live, plain (non-proxy) `Store` per shape key, resolved from `options.sources` in
 * priority order — the first source whose snapshot has a key wins, falling back to the
 * descriptor's own `default`, else `null`. The returned object is also `then`able: it resolves
 * once every source has published its first snapshot.
 */
export function create<T extends ConfigsShape>(configShape: T, options: Options = {}): ConfigsNodePending<T> {
  const sources = options.sources ?? [];
  const rawSources: Store<unknown>[] = [];
  const stores = {} as Record<string, Store<unknown>>;

  const sync = (): void => {
    for (const key of Object.keys(configShape)) {
      const descriptor = configShape[key]!;
      const raw = resolveRaw(rawSources, key);
      const value = raw === undefined ? ((descriptor.options as { default?: unknown }).default ?? null) : descriptor.parser(raw, [key]);
      const store = stores[key];
      if (store) {
        if (store.get() !== value) store.set(value);
      } else {
        stores[key] = new Store(value);
      }
    }
  };

  sync();

  const ready = Promise.all(sources.map((source) => source.open())).then((openedSources) => {
    rawSources.push(...openedSources);
    sync();
    for (const rawSource of openedSources) rawSource.listen(sync);
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
