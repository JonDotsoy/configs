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
 * The engine behind a `ConfigNode`/`ConfigNodeResolved`: resolves fields from `rootStores` (in
 * priority order), caches field/child-group instances, and recomputes them live as `rootStores`
 * change. A nested group embedded in a parent (via `configs.create(shape)` with no `options`)
 * shares its parent's `rootStores`; one created with its own `sources` (root form) resolves
 * independently, tracked via `ownsResolution`.
 */
class ConfigNodeState<S extends SchemaShape> {
  private rootStores: Store<any>[];
  private readonly fields = new Map<string, ConfigField<any>>();
  private readonly children = new Map<string, object>();
  private snapshotStore: Store<InferShape<S>> | undefined;
  readonly readyPromise: Promise<void>;

  constructor(
    readonly shape: S,
    rootStores: Store<any>[],
    private readonly basePath: string[],
    private readonly ownSources: Source<any>[],
    readonly ownsResolution: boolean,
    /** The sources this node's (or an ancestor's) `close()` actually closes. */
    private readonly closableSources: Source<any>[],
  ) {
    this.rootStores = rootStores;

    const embeddedReady = collectEmbeddedStates(shape).map((state) => state.readyPromise);

    if (ownsResolution) {
      const opened = Promise.all(ownSources.map((source) => source.open())).then((stores) => {
        this.rootStores = stores;
        this.wireLiveUpdates();
      });
      this.readyPromise = Promise.all([opened, ...embeddedReady]).then(() => undefined);
    } else {
      this.wireLiveUpdates();
      this.readyPromise = Promise.all(embeddedReady).then(() => undefined);
    }
  }

  private wireLiveUpdates(): void {
    for (const rootStore of this.rootStores) {
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
      // Shares this node's already-live rootStores, at the sub-path for `key`.
      const childState = new ConfigNodeState(
        embeddedState.shape,
        this.rootStores,
        [...this.basePath, key],
        [],
        false,
        this.closableSources,
      );
      result = wrapNode(new ConfigNode(childState));
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

  set(key: string): never {
    const node = this.shape[key];
    if (!node) throw new ConfigError(`Unknown field "${key}"`);
    throw new ConfigError(`Cannot set "${[...this.basePath, key].join(".")}": config values are read-only`);
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

/** Wraps `instance` in a `Proxy` exposing every shape key as a live field/child-group accessor. */
function wrapNode<T extends ConfigNodeCore<any>>(instance: T): T {
  const state = instance._state;
  const proxy = new Proxy(instance as unknown as object, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && Object.prototype.hasOwnProperty.call(state.shape, prop)) {
        const node = (state.shape as Record<string, unknown>)[prop];
        return isEmbeddedNode(node) ? state.childNode(prop) : state.fieldFor(prop);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
  stateOf.set(proxy as object, state);
  return proxy;
}

/**
 * Shared, non-thenable base behind both `ConfigNode` and `ConfigNodeResolved`: a resolved node
 * must not itself be thenable (awaiting a thenable whose `then()` resolves to itself is a
 * chaining cycle, both at runtime per the Promise spec and in TypeScript's `Awaited<T>`, which
 * rejects the type outright with a "referenced directly or indirectly in the fulfillment
 * callback of its own `then` method" error) — so `then()` lives only on `ConfigNode`, added by a
 * sibling subclass rather than inherited.
 */
class ConfigNodeCore<S extends SchemaShape> {
  constructor(readonly _state: ConfigNodeState<S>) {}

  get shape(): S {
    return this._state.shape;
  }

  /** Snapshot of every field's current value, recursing into nested groups. */
  get(): InferShape<S> {
    return this._state.get();
  }

  /** Always throws: config values are read-only. */
  set<K extends keyof S & string>(key: K, _value: InferShape<S>[K]): void {
    this._state.set(key);
  }

  /** Calls `subscriber` immediately with the current snapshot (per `get()`), then again on every subsequent change to it. */
  subscribe(subscriber: Subscriber<InferShape<S>>): Unsubscribe {
    return this._state.subscribe(subscriber);
  }

  /** Calls `subscriber` only on a subsequent change to the snapshot, not with the current one. */
  listen(subscriber: Subscriber<InferShape<S>>): Unsubscribe {
    return this._state.listen(subscriber);
  }

  /** Closes every source backing this config tree, including nested groups' own. A no-op for a nested-form group of its own. */
  close(): Promise<void> {
    return this._state.close();
  }

  /** Enables `await using s = await configs.create(...)`: disposal closes the config tree. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

/** A `ConfigNode` once every source behind it has published its first snapshot. Synchronous only — no longer thenable. */
export class ConfigNodeResolved<S extends SchemaShape> extends ConfigNodeCore<S> {}

/**
 * `configs.create()`'s return value: synchronous and read-only, but also a `PromiseLike` —
 * awaiting it resolves once every source has published its first snapshot, yielding a
 * `ConfigNodeResolved`. A nested group (`configs.create(shape)` with no `options`) never needs
 * awaiting: it shares its parent's already-resolved values unless given sources of its own.
 */
export class ConfigNode<S extends SchemaShape>
  extends ConfigNodeCore<S>
  implements PromiseLike<ConfigNodeResolved<S> & InferReadOnlyAccessors<S>>
{
  /**
   * `ConfigNodeResolved` is a sibling class, not a subclass (see the note on `ConfigNodeCore`),
   * so it fails a plain `instanceof ConfigNode` check. Custom `Symbol.hasInstance` widens that
   * check to "any `ConfigNodeCore`" instead, which both classes satisfy — without giving
   * `ConfigNodeResolved` a real `then()` and reintroducing the chaining cycle.
   */
  static override [Symbol.hasInstance](instance: unknown): boolean {
    return instance instanceof ConfigNodeCore;
  }

  then<TResult1 = ConfigNodeResolved<S> & InferReadOnlyAccessors<S>, TResult2 = never>(
    onfulfilled?:
      | ((
          value: ConfigNodeResolved<S> & InferReadOnlyAccessors<S>,
        ) => TResult1 | PromiseLike<TResult1>)
      | undefined
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this._state.readyPromise
      .then(() => wrapNode(new ConfigNodeResolved(this._state)) as ConfigNodeResolved<S> & InferReadOnlyAccessors<S>)
      .then(onfulfilled, onrejected as any);
  }
}

/**
 * A nested config group embedded in a parent shape: either shares the parent's resolved values,
 * or — when created with its own `sources` — resolves independently of it.
 */
export type SchemaGroup<S extends SchemaShape = SchemaShape> = ConfigNode<S> & InferReadOnlyAccessors<S>;

/**
 * Nested-group form (no `options`): synchronous, no sources of its own — inherits the
 * parent's resolved values when embedded, unless `options` gives it its own.
 *
 * Root form (`options` given): opens every source. Returns synchronously as a `ConfigNode`
 * and is awaitable — for each field, the first source (in array order) whose snapshot has
 * that field wins; a field missing everywhere falls back to the field's own `default`, else `null`.
 */
export function createConfigNode<S extends SchemaShape>(
  shape: S,
  options?: CreateOptions,
): ConfigNode<S> & InferReadOnlyAccessors<S> {
  const ownSources = options?.sources ?? [];
  const ownsResolution = options !== undefined;
  const state = new ConfigNodeState<S>(shape, [], [], ownSources, ownsResolution, ownSources);
  return wrapNode(new ConfigNode(state)) as ConfigNode<S> & InferReadOnlyAccessors<S>;
}

/** The type of the `configs` namespace object. */
export interface configs {
  create<S extends SchemaShape>(
    shape: S,
    options?: CreateOptions,
  ): ConfigNode<S> & InferReadOnlyAccessors<S>;
}
