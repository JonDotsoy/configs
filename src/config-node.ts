import { isConfigDescriptor, type Descriptor } from "./config-descriptor.js";
import type { Source } from "./sources/source.js";
import { Store } from "./utils/store.js";

/**
 * `Symbol.for` (not a plain `Symbol()`) for the same reason `CONFIG_DESCRIPTOR_TAG` uses it (see
 * `./utils/config-descriptor-tag.ts`): `bun build` bundles each public entry point independently,
 * so a node built by one bundled copy of this module must still be recognized by another's.
 */
const CONFIGS_NODE_TAG = Symbol.for("@jondotsoy/configs/ConfigsNode");

/**
 * Non-generic stand-in for `ConfigsNodePending<S>` inside the `ConfigsShape` union — a generic
 * member here (even `ConfigsNodePending<any>`) becomes the contextual type TS propagates into a
 * nested `create(...)` call written inline as a shape property, widening every literal type
 * inside it (same reason `config.types.ts`'s own `SchemaGroupNode`/`ConfigDescriptorNode` markers
 * exist). `InferConfigsNode` still pattern-matches each entry's actual, fully-inferred type
 * against the real `ConfigsNodePending<infer S>`, not against this marker.
 */
interface ConfigsNodeMarker {
  readonly [CONFIGS_NODE_TAG]: true;
}

/** A shape entry is a leaf field descriptor, a nested group of more shape entries, or an embedded `create()` result. */
export interface ConfigsShape {
  [key: string]: Descriptor<any, any> | ConfigsNodeMarker | ConfigsShape;
}

export interface Options {
  sources?: Source<any>[];
}

/** Whether `value` is a node built by `create()` — tagged via `CONFIGS_NODE_TAG`, set on every returned node. */
export function isConfigsNode(value: unknown): value is ConfigsNodePending<ConfigsShape> {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[CONFIGS_NODE_TAG] === true;
}

type InferValue<D> = D extends Descriptor<infer V, infer O> ? (O extends { default: any } ? V : V | null) : never;

type InferConfigsNode<T extends ConfigsShape> = {
  [K in keyof T]: T[K] extends Descriptor<any, any>
    ? Store<InferValue<T[K]>>
    : T[K] extends ConfigsNodePending<infer S>
      ? ConfigsNode<S>
      : T[K] extends ConfigsShape
        ? InferConfigsNode<T[K]>
        : never;
};

export type ConfigsNode<T extends ConfigsShape> = InferConfigsNode<T>;

export type ConfigsNodePending<T extends ConfigsShape> = ConfigsNode<T> &
  ConfigsNodeMarker & {
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

/** A field's explicit `key` override (if set) is an absolute path, taken as-is instead of `entryPath`. */
function resolveFieldPath(descriptor: Descriptor<unknown, object>, entryPath: string[]): string[] {
  const explicitKey = descriptor.key;
  if (explicitKey === undefined) return entryPath;
  return Array.isArray(explicitKey) ? explicitKey : [explicitKey];
}

/**
 * Builds one field's own live `Store<T>`: seeded off `rawStore`'s current value via
 * `descriptor.start()`, then recomputed the same way every time `rawStore` changes — the
 * descriptor itself holds no `Store`; this is the only place one gets created for it. When the
 * descriptor also has an (optional) `reduce`, its promise is folded into `embeddedReady` (so
 * `create()`'s own readiness waits on it, same as a source's `open()`), and the `Store<T>` it
 * resolves to takes over as this field's value, staying live off its own updates.
 */
function buildField(
  descriptor: Descriptor<unknown, object>,
  rawStore: Store<unknown>,
  path: string[],
  embeddedReady: PromiseLike<unknown>[],
): Store<unknown> {
  const fieldStore = new Store<unknown>(descriptor.start(rawStore.get(), path));
  rawStore.listen((raw) => {
    const next = descriptor.start(raw, path);
    if (next !== fieldStore.get()) fieldStore.set(next);
  });

  const reducePromise = typeof descriptor.reduce === "function" ? descriptor.reduce(rawStore, path) : undefined;
  if (reducePromise) {
    embeddedReady.push(
      reducePromise.then((resultStore) => {
        fieldStore.set(resultStore.get());
        resultStore.listen((value) => fieldStore.set(value));
      }),
    );
  }

  return fieldStore;
}

/**
 * Recursively builds `shape` into a plain tree of `Store`s (leaves) and nested plain objects
 * (groups) — each leaf wired as its own independent `Source → KeyStore → FieldStore` chain:
 * `keyStore()` merges `rawSources` at that leaf's path (its own `key` override, if set, else its
 * position in the shape tree — see `resolveFieldPath()`), and `buildField()` turns that into the
 * field's own live, parsed `Store`. A leaf only recomputes when a source at its own path changes
 * — there's no whole-tree recompute sweep.
 *
 * An embedded `create()` result (`isConfigsNode(entry)`) is adopted as-is instead: it already
 * resolves independently, from its own `sources` — nothing here rewires it against `rawSources`
 * or `path`. Its own readiness is collected into `embeddedReady`, so the node embedding it can
 * still `await` it as part of its own `then()`.
 */
function buildNode(
  shape: ConfigsShape,
  path: string[],
  rawSources: Store<unknown>[],
  embeddedReady: PromiseLike<unknown>[],
): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) {
    const entry = shape[key]!;
    const entryPath = [...path, key];
    if (isConfigDescriptor(entry)) {
      const fieldPath = resolveFieldPath(entry, entryPath);
      node[key] = buildField(entry, keyStore(rawSources, fieldPath), fieldPath, embeddedReady);
    } else if (isConfigsNode(entry)) {
      embeddedReady.push(entry);
      node[key] = entry;
    } else {
      node[key] = buildNode(entry as ConfigsShape, entryPath, rawSources, embeddedReady);
    }
  }
  return node;
}

/**
 * Builds a live, plain (non-proxy) `Store` per leaf shape key — recursing into nested groups as
 * plain nested objects, and adopting an embedded `create()` result as-is (see `buildNode()`).
 * Each `options.sources` entry gets its own placeholder `Store`, wired up to every field's chain
 * from the very start: once that source's own `open()` resolves, its value — and every later
 * update — forwards into the placeholder, which ripples reactively through to just the fields
 * whose path it can resolve. The returned object is also `then`able: it resolves once every
 * source here, and every embedded node's own sources, have published their first snapshot.
 */
export function create<T extends ConfigsShape>(configShape: T, options: Options = {}): ConfigsNodePending<T> {
  const sources = options.sources ?? [];
  const rawSources = sources.map(() => new Store<unknown>(null));
  const embeddedReady: PromiseLike<unknown>[] = [];

  const node = buildNode(configShape, [], rawSources, embeddedReady) as ConfigsNode<T>;
  (node as Record<symbol, unknown>)[CONFIGS_NODE_TAG] = true;

  const ownReady = Promise.all(
    sources.map((source, index) =>
      source.open().then((opened) => {
        opened.subscribe((value) => rawSources[index]!.set(value));
      }),
    ),
  );

  const ready = Promise.all([ownReady, ...embeddedReady]).then(() => node);

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
