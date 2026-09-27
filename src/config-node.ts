import { isConfigDescriptor, type Descriptor, type DescriptorControl } from "./config-descriptor.js";
import { ConfigError, ConfigValidationError, type ConfigFieldError } from "./errors.js";
import type { Source } from "./sources/source.js";
import { Store } from "./utils/store.js";

/**
 * `Symbol.for` (not a plain `Symbol()`): `bun build` bundles each public entry point
 * independently, so a node built by one bundled copy of this module must still be recognized by
 * another's — a registry symbol survives that duplication (same reason `isConfigDescriptor()`, in
 * `./config-descriptor.js`, checks structurally instead of `instanceof Descriptor`).
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

/** A field's exposed type is already encoded in `Descriptor`'s own first type parameter — see `WithDefault` in `./config-descriptor.js`. */
type InferValue<D> = D extends Descriptor<infer A, any> ? A : never;

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
    /**
     * Releases everything this node opened: every own `options.sources` entry (`Source.close()`),
     * every field descriptor's own `close` (`Descriptor.close()`), and every embedded `create()`
     * result's own `close()` in turn. Safe to call whether or not the node has finished opening
     * yet, and any number of times.
     */
    close(): Promise<void>;
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
function resolveFieldPath(descriptor: Descriptor<unknown, unknown>, entryPath: string[]): string[] {
  const explicitKey = descriptor.key;
  if (explicitKey === undefined) return entryPath;
  return Array.isArray(explicitKey) ? explicitKey : [explicitKey];
}

/**
 * Builds one field's own live `Store<T>` and hands control of it entirely to
 * `descriptor.start(control)` — same shape as `Source`'s own `start(control)` contract. The
 * descriptor itself holds no `Store`; this is the only place one gets created for it, and
 * `start()` is called exactly once, synchronously, right here. Whatever `start` does with
 * `control.set(...)` — once synchronously (tick 0, before this function even returns), later via
 * `control.rawStore.listen(...)`, after an `await`, from a timer, ... — is the field's entire
 * lifetime; nothing else in this engine ever calls `.set()` on this `Store`.
 */
function buildField(
  descriptor: Descriptor<unknown, unknown>,
  rawStore: Store<unknown>,
  path: string[],
  reportError: (path: string[], error: unknown) => void,
  requiredChecks: (() => void)[],
): Store<unknown> {
  const fieldStore = new Store<unknown>(null);
  const control: DescriptorControl<unknown> = {
    rawStore,
    path,
    set: (value) => fieldStore.set(value),
    error: (error) => reportError(path, error),
  };
  try {
    descriptor.start(control);
  } catch (err) {
    // A hand-written descriptor that throws instead of calling control.error() directly — same
    // aggregation either way.
    reportError(path, err);
  }
  if (descriptor.required) {
    requiredChecks.push(() => {
      if (fieldStore.get() === null) reportError(path, new ConfigError(`Missing required value at "${path.join(".")}"`));
    });
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
  closers: (() => Promise<void>)[],
  reportError: (path: string[], error: unknown) => void,
  requiredChecks: (() => void)[],
): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) {
    const entry = shape[key]!;
    const entryPath = [...path, key];
    if (isConfigDescriptor(entry)) {
      const fieldPath = resolveFieldPath(entry, entryPath);
      node[key] = buildField(entry, keyStore(rawSources, fieldPath), fieldPath, reportError, requiredChecks);
      closers.push(() => (typeof entry.close === "function" ? entry.close() : Promise.resolve()));
    } else if (isConfigsNode(entry)) {
      // Inherit the embedded node's own errors instead of letting its rejection short-circuit
      // Promise.all — its paths get prefixed with this embed's own position in the tree.
      embeddedReady.push(
        entry.then(
          () => {},
          (err) => {
            if (err instanceof ConfigValidationError) {
              for (const fieldError of err.errors) reportError([...entryPath, ...fieldError.path], fieldError.error);
            } else {
              reportError(entryPath, err);
            }
          },
        ),
      );
      closers.push(() => entry.close());
      node[key] = entry;
    } else {
      node[key] = buildNode(entry as ConfigsShape, entryPath, rawSources, embeddedReady, closers, reportError, requiredChecks);
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
 * source here, and every embedded node's own sources, have published their first snapshot. It's
 * also `close`able: releases every own source, every field descriptor's own `close`, and every
 * embedded node's own `close`, in one call.
 */
export function create<T extends ConfigsShape>(configShape: T, options: Options = {}): ConfigsNodePending<T> {
  const sources = options.sources ?? [];
  const rawSources = sources.map(() => new Store<unknown>(null));
  const embeddedReady: PromiseLike<unknown>[] = [];
  const closers: (() => Promise<void>)[] = [];
  const requiredChecks: (() => void)[] = [];

  // Every field error across the whole tree, by path — first error per path wins. `settled` flips
  // once `ready` has resolved or rejected; a later error (a live source pushing a bad value after
  // the node already resolved) has nowhere left to surface, so it's only logged from then on.
  const fieldErrors = new Map<string, ConfigFieldError>();
  let settled = false;
  function reportError(path: string[], error: unknown): void {
    const configError = error instanceof ConfigError ? error : new ConfigError(error instanceof Error ? error.message : String(error));
    if (settled) {
      console.error(configError);
      return;
    }
    const key = path.join(".");
    if (!fieldErrors.has(key)) fieldErrors.set(key, { path, error: configError });
  }

  const node = buildNode(configShape, [], rawSources, embeddedReady, closers, reportError, requiredChecks) as ConfigsNode<T>;
  (node as Record<symbol, unknown>)[CONFIGS_NODE_TAG] = true;

  // Synchronous (tick 0) level: a descriptor may have already called control.error() (or thrown)
  // during its own start(), independent of any source — every source's raw value is still `null`
  // at this exact point (every `Source` defers its own `start()` by at least one microtask, even a
  // fully static one like `literalSource`, so a field can never see real source data this early).
  // The missing-`required` check only runs here too when there's nothing to wait on at all: with no
  // sources configured, a field can never resolve later either, so "still null now" already means
  // "missing, permanently" — with any source configured, that same check is deferred to `ready`
  // instead, since a field's `null` right now says nothing about what a source is about to supply.
  if (sources.length === 0) {
    for (const check of requiredChecks) check();
  }
  if (fieldErrors.size > 0) {
    throw new ConfigValidationError([...fieldErrors.values()]);
  }

  const ownReady = Promise.all(
    sources.map((source, index) =>
      source.open().then((opened) => {
        opened.subscribe((value) => rawSources[index]!.set(value));
      }),
    ),
  );

  const ready = Promise.all([ownReady, ...embeddedReady]).then(
    () => {
      for (const check of requiredChecks) check();
      settled = true;
      if (fieldErrors.size > 0) throw new ConfigValidationError([...fieldErrors.values()]);
      return node;
    },
    (err) => {
      settled = true;
      throw err;
    },
  );

  return Object.assign({ ...node }, {
    then<TResult1 = ConfigsNode<T>, TResult2 = never>(
      onfulfilled?: ((value: ConfigsNode<T>) => TResult1 | PromiseLike<TResult1>) | undefined | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined | null,
    ): PromiseLike<TResult1 | TResult2> {
      // `node` (not `this`) is what resolves: `this` also carries `then`, so resolving to it would
      // make the Promise machinery treat it as thenable again and re-invoke `then` recursively.
      return ready.then(() => node).then(onfulfilled, onrejected as any);
    },
    close(): Promise<void> {
      return Promise.all([...closers.map((close) => close()), ...sources.map((source) => source.close())]).then(() => undefined);
    },
  }) as ConfigsNodePending<T>;
}
