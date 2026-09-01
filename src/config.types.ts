import { Source } from "./sources/source.js";
import { Store, type Subscriber, type Unsubscribe } from "./utils/store.js";
import { ConfigError } from "./errors.js";

export type FieldType = "string" | "number" | "boolean";

interface BaseFieldSchema {
  summary?: string;
  required?: boolean;
  /** Freezes the field at its first resolved value: later source updates no longer reach `.get()`. */
  readonly?: boolean;
}

export type FieldSchema =
  | (BaseFieldSchema & { type: "string"; pattern?: RegExp; default?: string })
  | (BaseFieldSchema & { type: "number"; default?: number })
  | (BaseFieldSchema & { type: "boolean"; default?: boolean });

export interface CreateOptions {
  sources?: Source<any>[];
  /**
   * Static, lowest-priority fallback tree — checked after every source, before a field's own `default`.
   * @deprecated No longer read by `configs.create()`.
   */
  defaultValues?: unknown;
}

/**
 * Discriminates a nested group from a leaf field inside a `SchemaShape`. Deliberately not generic
 * (unlike `SchemaGroup<S>` below): a generic member here — even `SchemaGroup<any>` — becomes the
 * contextual type TypeScript propagates into a nested `configs.create(...)` call written inline as
 * a shape property, and `any` there widens every literal `type: "string"` inside it to `string`,
 * breaking every field's inferred type. This plain marker carries no such poison.
 */
interface SchemaGroupNode {
  readonly shape: SchemaShape;
}

export type SchemaNode = FieldSchema | SchemaGroupNode;
export type SchemaShape = Record<string, SchemaNode>;

type PrimitiveOfField<F extends FieldSchema> = F extends { type: "number" }
  ? number
  : F extends { type: "string" }
    ? string
    : F extends { type: "boolean" }
      ? boolean
      : never;

/**
 * A field only ever resolves to `null` when no source has it and it has no `default` — data comes
 * from async sources that may simply have nothing, so `required` documents intent but can't be enforced
 * at runtime and doesn't affect this type.
 */
type HasDefault<F extends FieldSchema> = F extends { default: any } ? true : false;

type InferFieldValue<F extends FieldSchema> = HasDefault<F> extends true
  ? PrimitiveOfField<F>
  : PrimitiveOfField<F> | null;

type InferField<F extends SchemaNode> = F extends ConfigNode<infer S>
  ? InferShape<S>
  : F extends FieldSchema
    ? InferFieldValue<F>
    : never;

export type InferShape<S extends SchemaShape> = {
  [K in keyof S]: InferField<S[K]>;
};

/** A read-only view of a `Store<T>`: exposes `get`/`subscribe`/`listen` but never `set`. */
export interface ReadOnlyStore<T> {
  get(): T;
  /** Calls `subscriber` immediately with the current value, then on every subsequent update. */
  subscribe(subscriber: Subscriber<T>): Unsubscribe;
  /** Calls `subscriber` only on subsequent updates, not with the current value. */
  listen(subscriber: Subscriber<T>): Unsubscribe;
}

type InferReadOnlyAccessor<F extends SchemaNode> = F extends ConfigNode<infer S>
  ? SchemaGroup<S>
  : F extends FieldSchema
    ? ReadOnlyStore<InferFieldValue<F>>
    : never;

/** Shape of the live proxy returned by `configs.create()`: a leaf field is a read-only `ReadOnlyStore<T>`, a nested group is a `SchemaGroup`. */
export type InferReadOnlyAccessors<S extends SchemaShape> = {
  [K in keyof S]: InferReadOnlyAccessor<S[K]>;
};

/**
 * A resolved config node: a plain, read-only object exposing every shape key as a live field
 * (`ReadOnlyStore<T>`) or nested-group accessor, plus a snapshot (`get`/`subscribe`/`listen`) and
 * lifecycle (`close`) surface. There is no `set`: a `ConfigNode` — and every field on it — is
 * always read-only, so that isn't a method that can fail at runtime, it's a method that doesn't
 * exist. Not thenable either — `configs.create()`'s return value already exposes this same shape
 * synchronously (see the module doc on reading a field before its source resolves), and awaiting
 * it further would only add a redundant chaining step. A thenable whose own `then()` resolved to
 * itself would also be a chaining cycle, both at runtime per the Promise spec and in TypeScript's
 * `Awaited<T>`, which rejects the type outright — one more reason this shape stays plain.
 */
export type ConfigNode<S extends SchemaShape> = {
  readonly shape: S;
  /** Snapshot of every field's current value, recursing into nested groups. */
  get(): InferShape<S>;
  /** Calls `subscriber` immediately with the current snapshot (per `get()`), then again on every subsequent change to it. */
  subscribe(subscriber: Subscriber<InferShape<S>>): Unsubscribe;
  /** Calls `subscriber` only on a subsequent change to the snapshot, not with the current one. */
  listen(subscriber: Subscriber<InferShape<S>>): Unsubscribe;
  /** Closes every source backing this config tree, including nested groups' own. A no-op for a nested-form group of its own. */
  close(): Promise<void>;
  /** Enables `await using s = await configs.create(...)`: disposal closes the config tree. */
  [Symbol.asyncDispose](): Promise<void>;
} & InferReadOnlyAccessors<S>;

/**
 * `configs.create()`'s return value: the same `ConfigNode<S>` shape — synchronous and read-only,
 * with every field already live (see the module doc) — plus `then()`, so it can also be
 * `await`ed once every source has published its first snapshot, yielding a plain `ConfigNode<S>`
 * (no longer thenable, per the note on `ConfigNode`). A nested group (`configs.create(shape)`
 * with no `options`) never needs awaiting: it shares its parent's already-resolved values unless
 * given sources of its own.
 */
export type PendingConfigNode<S extends SchemaShape> = ConfigNode<S> & {
  then<TResult1 = ConfigNode<S>, TResult2 = never>(
    onfulfilled?: ((value: ConfigNode<S>) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): PromiseLike<TResult1 | TResult2>;
};

/**
 * A nested config group embedded in a parent shape: either shares the parent's resolved values,
 * or — when created with its own `sources` — resolves independently of it. Always the same
 * `PendingConfigNode` shape as a root-form `configs.create()` call, since it's built the same way
 * and stays independently awaitable.
 */
export type SchemaGroup<S extends SchemaShape = SchemaShape> = PendingConfigNode<S>;

// ---------------------------------------------------------------------------
// Runtime helpers: field coercion/validation
// ---------------------------------------------------------------------------

function readNestedValue(data: unknown, path: string[]): unknown {
  let node = data;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

function typeMismatch(field: FieldSchema, value: unknown, path: string[]): never {
  throw new ConfigError(`Expected ${field.type} at "${path.join(".")}", got ${JSON.stringify(value)}`);
}

function validate(field: FieldSchema, value: unknown, path: string[]): void {
  if (typeof value !== field.type) {
    typeMismatch(field, value, path);
  }
  if (field.type === "string" && field.pattern && !field.pattern.test(value as string)) {
    throw new ConfigError(`Value at "${path.join(".")}" does not match pattern ${field.pattern}`);
  }
}

function coerce(field: FieldSchema, raw: unknown, path: string[]): unknown {
  let value: unknown = raw;

  if (field.type === "number" && typeof value !== "number") {
    const num = Number(value);
    if (typeof value !== "string" || value.trim() === "" || Number.isNaN(num)) {
      typeMismatch(field, raw, path);
    }
    value = num;
  } else if (field.type === "boolean" && typeof value !== "boolean") {
    if (value === "true" || value === "1") value = true;
    else if (value === "false" || value === "0") value = false;
    else typeMismatch(field, raw, path);
  } else if (field.type === "string" && typeof value !== "string") {
    typeMismatch(field, raw, path);
  }

  validate(field, value, path);
  return value;
}

/** Structural equality for plain trees of primitives/nested objects — what `InferShape<S>` produces. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/** A leaf config field, live as a `Store<T>`: read-only — `set()` always throws. */
class ConfigField<T> extends Store<T> {
  override set(): void {
    throw new ConfigError("Cannot set a config field: config values are read-only");
  }

  /** Pushes a recomputed value when an upstream source changes, bypassing the public read-only `set()`. */
  _update(value: T): void {
    super.set(value);
  }
}

/** Maps a shape-embedded public proxy (returned by `configs.create()`) back to the engine behind it. */
const stateOf = new WeakMap<object, ConfigNodeState<any>>();

function isEmbeddedNode(value: unknown): value is object {
  return typeof value === "object" && value !== null && stateOf.has(value);
}

function collectEmbeddedStates(shape: SchemaShape): ConfigNodeState<any>[] {
  const result: ConfigNodeState<any>[] = [];
  for (const key of Object.keys(shape)) {
    const state = stateOf.get(shape[key] as object);
    if (state) result.push(state);
  }
  return result;
}

/**
 * The engine behind a `ConfigNode`/`PendingConfigNode` proxy: resolves fields from `rootStores`
 * (in priority order), caches field/child-group instances, and recomputes them live as
 * `rootStores` change. A nested group embedded in a parent (via `configs.create(shape)` with no
 * `options`) shares its parent's `rootStores` — dynamically, via `parent`, so it stays correct even if the
 * child was created (and cached fields from it) before the parent's own sources had opened; one
 * created with its own `sources` (root form) resolves independently, tracked via `ownsResolution`.
 */
class ConfigNodeState<S extends SchemaShape> {
  private ownRootStores: Store<any>[] = [];
  private readonly fields = new Map<string, ConfigField<any>>();
  private readonly children = new Map<string, object>();
  private snapshotStore: Store<InferShape<S>> | undefined;
  readonly readyPromise: Promise<void>;

  constructor(
    readonly shape: S,
    /** The node this shares its `rootStores` with, when it doesn't own its own resolution. `undefined` at the root. */
    private readonly parent: ConfigNodeState<any> | undefined,
    private readonly basePath: string[],
    private readonly ownSources: Source<any>[],
    readonly ownsResolution: boolean,
    /** The sources this node's (or an ancestor's) `close()` actually closes. */
    private readonly closableSources: Source<any>[],
  ) {
    const embeddedReady = collectEmbeddedStates(shape).map((state) => state.readyPromise);

    if (ownsResolution) {
      const opened = Promise.all(ownSources.map((source) => source.open())).then((stores) => {
        this.ownRootStores = stores;
        this.wireLiveUpdates();
        // Catches up any field/snapshot Store already read (and cached) before `rootStores`
        // resolved — `wireLiveUpdates()` only reacts to source changes from here on, so anything
        // read while still pending needs one explicit refresh against the now-final stores. This
        // cascades into every already-cached descendant that shares this resolution, however many
        // levels deep, since a nested group's own fields can be read (and cached) just as early.
        this.refreshFields();
      });
      this.readyPromise = Promise.all([opened, ...embeddedReady]).then(() => undefined);
    } else {
      this.readyPromise = Promise.all(embeddedReady).then(() => undefined);
    }
  }

  /**
   * This node's own resolution's sources, or — for a node embedded without sources of its own —
   * a live read through to whichever ancestor's `ownRootStores` it shares. A getter rather than a
   * value copied at construction: the copy would go stale the moment that ancestor's own sources
   * open (`ownRootStores` is reassigned wholesale, not mutated in place).
   */
  private get rootStores(): Store<any>[] {
    if (this.ownsResolution || !this.parent) return this.ownRootStores;
    return this.parent.rootStores;
  }

  /** Only an owning node's stores actually change over time; a sharing node's live updates come from that ancestor's `refreshFields()` cascade instead. */
  private wireLiveUpdates(): void {
    for (const rootStore of this.ownRootStores) {
      rootStore.listen(() => this.refreshFields());
    }
  }

  private resolveField(field: FieldSchema, path: string[]): unknown {
    for (const rootStore of this.rootStores) {
      const raw = readNestedValue(rootStore.get(), path);
      if (raw !== undefined && raw !== null) {
        return coerce(field, raw, path);
      }
    }
    return field.default !== undefined ? field.default : null;
  }

  private refreshFields(): void {
    for (const [key, field] of this.fields) {
      const schema = this.shape[key] as FieldSchema;
      if (schema.readonly) continue;
      const path = [...this.basePath, key];
      const next = this.resolveField(schema, path);
      if (next !== field.get()) field._update(next);
    }
    for (const child of this.children.values()) {
      const childState = stateOf.get(child);
      // An owning child resolves independently — already covered by its own `opened` chain.
      if (childState && !childState.ownsResolution) childState.refreshFields();
    }
    this.refreshSnapshot();
  }

  private refreshSnapshot(): void {
    if (!this.snapshotStore) return;
    const next = this.get();
    if (!deepEqual(next, this.snapshotStore.get())) this.snapshotStore.set(next);
  }

  fieldFor(key: string): ConfigField<any> {
    let field = this.fields.get(key);
    if (!field) {
      const schema = this.shape[key] as FieldSchema;
      const path = [...this.basePath, key];
      field = new ConfigField(this.resolveField(schema, path));
      this.fields.set(key, field);
    }
    return field;
  }

  childNode(key: string): object {
    const cached = this.children.get(key);
    if (cached) return cached;

    const node = this.shape[key];
    const embeddedState = stateOf.get(node as object);
    if (!embeddedState) {
      throw new ConfigError(`"${key}" is not a nested config group`);
    }

    let result: object;
    if (embeddedState.ownsResolution) {
      // Owns its own sources: resolves independently, unaffected by this node's rootStores.
      result = node as object;
    } else {
      // Shares this node's rootStores (live, via `parent` — see the `rootStores` getter), at the
      // sub-path for `key`.
      const childState = new ConfigNodeState(
        embeddedState.shape,
        this,
        [...this.basePath, key],
        [],
        false,
        this.closableSources,
      );
      result = createPendingNode(childState);
    }
    this.children.set(key, result);
    return result;
  }

  get(): InferShape<S> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(this.shape)) {
      const node = this.shape[key];
      if (isEmbeddedNode(node)) {
        out[key] = (this.childNode(key) as { get(): unknown }).get();
      } else {
        out[key] = this.fieldFor(key).get();
      }
    }
    return out as InferShape<S>;
  }

  private ensureSnapshotStore(): Store<InferShape<S>> {
    if (!this.snapshotStore) this.snapshotStore = new Store(this.get());
    return this.snapshotStore;
  }

  subscribe(subscriber: Subscriber<InferShape<S>>): Unsubscribe {
    return this.ensureSnapshotStore().subscribe(subscriber);
  }

  listen(subscriber: Subscriber<InferShape<S>>): Unsubscribe {
    return this.ensureSnapshotStore().listen(subscriber);
  }

  async close(): Promise<void> {
    await Promise.all([
      ...this.closableSources.map((source) => source.close()),
      ...collectEmbeddedStates(this.shape).map((state) => state.close()),
    ]);
  }
}

/** Wraps plain object `node` in a `Proxy` exposing every shape key as a live field/child-group accessor. */
function wrapNode<T extends object>(node: T, state: ConfigNodeState<any>): T {
  const proxy = new Proxy(node, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && Object.prototype.hasOwnProperty.call(state.shape, prop)) {
        const shapeNode = (state.shape as Record<string, unknown>)[prop];
        return isEmbeddedNode(shapeNode) ? state.childNode(prop) : state.fieldFor(prop);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
  stateOf.set(proxy as object, state);
  return proxy;
}

/** The plain `get`/`subscribe`/`listen`/`close` surface shared by every node, resolved or pending — there is no `set`, a `ConfigNode` is always read-only. */
function baseNodeMethods<S extends SchemaShape>(
  state: ConfigNodeState<S>,
): Omit<ConfigNode<S>, keyof InferReadOnlyAccessors<S>> {
  return {
    shape: state.shape,
    get: () => state.get(),
    subscribe: (subscriber: Subscriber<InferShape<S>>) => state.subscribe(subscriber),
    listen: (subscriber: Subscriber<InferShape<S>>) => state.listen(subscriber),
    close: () => state.close(),
    [Symbol.asyncDispose]: () => state.close(),
  } as unknown as Omit<ConfigNode<S>, keyof InferReadOnlyAccessors<S>>;
}

/** A resolved node: the plain `ConfigNode<S>` shape, wrapped for live field access — no `then`. */
function createResolvedNode<S extends SchemaShape>(state: ConfigNodeState<S>): ConfigNode<S> {
  return wrapNode(baseNodeMethods(state) as object, state) as ConfigNode<S>;
}

/**
 * `configs.create()`'s return value: the plain `ConfigNode<S>` shape, plus `then()` — resolving
 * once every source has published its first snapshot, into a plain `ConfigNode<S>` with no `then`
 * of its own (see the note on `ConfigNode` for why a resolved node deliberately isn't thenable).
 */
function createPendingNode<S extends SchemaShape>(state: ConfigNodeState<S>): PendingConfigNode<S> {
  const node = {
    ...baseNodeMethods(state),
    then<TResult1 = ConfigNode<S>, TResult2 = never>(
      onfulfilled?: ((value: ConfigNode<S>) => TResult1 | PromiseLike<TResult1>) | undefined | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined | null,
    ): PromiseLike<TResult1 | TResult2> {
      return state.readyPromise.then(() => createResolvedNode(state)).then(onfulfilled, onrejected as any);
    },
  };
  return wrapNode(node as object, state) as PendingConfigNode<S>;
}

/**
 * Nested-group form (no `options`): synchronous, no sources of its own — inherits the
 * parent's resolved values when embedded, unless `options` gives it its own.
 *
 * Root form (`options` given): opens every source. Returns synchronously as a `PendingConfigNode`
 * and is awaitable — for each field, the first source (in array order) whose snapshot has
 * that field wins; a field missing everywhere falls back to the field's own `default`, else `null`.
 */
export function createConfigNode<S extends SchemaShape>(
  shape: S,
  options?: CreateOptions,
): PendingConfigNode<S> {
  const ownSources = options?.sources ?? [];
  const ownsResolution = options !== undefined;
  const state = new ConfigNodeState<S>(shape, undefined, [], ownSources, ownsResolution, ownSources);
  return createPendingNode(state);
}

/** The type of the `configs` namespace object. */
export interface configs {
  create<S extends SchemaShape>(shape: S, options?: CreateOptions): PendingConfigNode<S>;
}
