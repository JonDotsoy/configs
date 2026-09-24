import { Source } from "./sources/source.js";
import { CONFIG_DESCRIPTOR_TAG } from "./utils/config-descriptor-tag.js";
import { Store, type Subscriber, type Unsubscribe } from "./utils/store.js";
import { tSync } from "./utils/t.js";
import { ConfigError } from "./errors.js";

export type FieldType = "string" | "number" | "boolean" | "url" | "shape";

interface BaseFieldSchema {
  summary?: string;
  required?: boolean;
  /** Freezes the field at its first resolved value: later source updates no longer reach `.get()`. */
  readonly?: boolean;
  /**
   * Overrides where this field reads from in each source's snapshot: an explicit path, checked
   * instead of the field's own position in the shape tree (its key, prefixed by every ancestor
   * group's own key). A single string is a one-segment path — `key: "PORT"` reads the source
   * snapshot's top-level `PORT`, ignoring how deeply the field is nested under `create()` groups.
   */
  key?: string | string[];
}

/**
 * Structural stand-in for a validation library's schema (zod, valibot, superstruct, ...): anything
 * exposing `parse(value: unknown): T`. Kept minimal on purpose so this package stays dependency-free
 * while still inferring `T` from whatever schema object a caller passes in.
 */
export interface Parseable<T> {
  parse(value: unknown): T;
}

/**
 * Split out generic (unlike the other `FieldSchema` members) purely so `default`'s type stays
 * tied to the same `T` as `schema` when a caller writes `ShapeFieldSchema<T>` directly, instead of
 * a hardcoded `unknown`. `FieldSchema` itself instantiates `T` as `unknown` (below) since it isn't
 * generic — same as every other `FieldSchema` member, a field's real value/default type comes from
 * matching the caller's own literal shape structurally (see `PrimitiveOfField`), not from this
 * declared type. `schema` itself is optional: a `"shape"` field with no `schema` is passed through
 * as-is (only checked for `typeof value === "object"`), for callers who just want a free-form object.
 *
 * @deprecated Write `shape({ schema, ... })` instead of `{ type: "shape", schema, ... }` — same
 * options, same inference, still fully supported, just no longer the recommended form.
 */
interface ShapeFieldSchema<T> extends BaseFieldSchema {
  type: "shape";
  schema?: Parseable<T>;
  default?: T;
}

/**
 * `{ schema: z.number() }` — the same as `{ type: "shape", schema: z.number() }`, minus the tag.
 * `schema` stays *required* here (unlike `ShapeFieldSchema`, where it's optional) specifically so
 * this doesn't become a "weak type" indistinguishable from any other object — a nested group
 * (`SchemaGroupNode`, just `{ shape }`) or an unrelated typo'd shape entry has no `schema` property
 * to match against, so it's never mistaken for this. `type?: never` (rather than leaving `type` out
 * of the interface) rejects an object that *does* carry a `type` — string/number/boolean/`"shape"`
 * fields keep going through their own tagged member instead of this one.
 */
interface UntaggedShapeFieldSchema<T> extends BaseFieldSchema {
  type?: never;
  schema: Parseable<T>;
  default?: T;
}

/** @deprecated Write `string({ ... })` instead of `{ type: "string", ... }` — same options, same inference, still fully supported, just no longer the recommended form. */
export type StringFieldSchema = BaseFieldSchema & { type: "string"; pattern?: RegExp; default?: string };
/** @deprecated Write `numeric({ ... })` instead of `{ type: "number", ... }` — same options, same inference, still fully supported, just no longer the recommended form. */
export type NumberFieldSchema = BaseFieldSchema & { type: "number"; default?: number };
/** @deprecated Write `boolean({ ... })` instead of `{ type: "boolean", ... }` — same options, same inference, still fully supported, just no longer the recommended form. */
export type BooleanFieldSchema = BaseFieldSchema & { type: "boolean"; default?: boolean };
/**
 * A `"url"` field parses a string value into a `URL` instance (and validates it's actually one), same as `numeric()` does for numbers.
 * @deprecated Write `url({ ... })` instead of `{ type: "url", ... }` — same options, same inference, still fully supported, just no longer the recommended form.
 */
export type UrlFieldSchema = BaseFieldSchema & { type: "url"; default?: URL };

/**
 * The object-literal shape a field entry normalizes to — still what every builder
 * (`string()`/`numeric()`/`boolean()`/`url()`/`shape()`) produces under the hood via
 * `ConfigDescriptor`, and still what `toFieldSchema()` returns either way, so this type itself
 * isn't deprecated. Writing one of its *tagged* members directly as an object literal
 * (`{ type: "string", ... }` and friends) is what's deprecated — see each member's own tag.
 */
export type FieldSchema =
  | StringFieldSchema
  | NumberFieldSchema
  | BooleanFieldSchema
  | UrlFieldSchema
  | ShapeFieldSchema<unknown>
  | UntaggedShapeFieldSchema<unknown>;

export type StringFieldOptions = Omit<StringFieldSchema, "type">;
export type NumberFieldOptions = Omit<NumberFieldSchema, "type">;
export type BooleanFieldOptions = Omit<BooleanFieldSchema, "type">;
export type UrlFieldOptions = Omit<UrlFieldSchema, "type">;
export type ShapeFieldOptions = Omit<ShapeFieldSchema<unknown>, "type">;

/**
 * What `string()`/`numeric()`/`boolean()` build. Carries its field `type` plus the exact `options`
 * object the caller passed in, generic over both `T` (the field's value type) and `O` (the caller's
 * own literal `options` type — inferred via a `const` type parameter on each builder, the same way
 * an inline `{ type: "number", default: 3000 }` object literal already preserves its own `default`
 * as a literal). `InferField` reads `HasDefault` off `O` directly, so `numeric()` narrows out `null`
 * exactly when the caller's own call included a `default`, same as the object-literal form.
 */
export class ConfigDescriptor<T, O extends object = object> {
  /** @internal Tags instances for `isConfigDescriptor` — see `CONFIG_DESCRIPTOR_TAG`'s doc. */
  readonly [CONFIG_DESCRIPTOR_TAG] = true;

  constructor(
    readonly type: FieldType,
    readonly options: O,
  ) {}

  /**
   * This field's explicit path override, if any (`options.key`) — exposed directly so a
   * `ConfigNode` can resolve this field's path itself (`key` as-is, or `[...basePath, key]`
   * without one) without reaching into `options`/a reconstructed `FieldSchema` to find it.
   */
  get key(): string | string[] | undefined {
    return (this.options as { key?: string | string[] }).key;
  }

  /**
   * Coerces/validates this field from `rawStore` — a `Store` already holding this field's own
   * merged raw value (or `undefined`/`null` when no source has it), built and kept live by
   * whichever `ConfigNode` owns the shape tree this descriptor sits in. The descriptor knows
   * nothing about `sources`, sibling fields, or where in the tree it lives — only its own
   * `options` (`default`, `pattern`, `required`, ...) and, for error messages, the `path` label
   * the caller passes in. The returned `store` stays live: it re-derives from `rawStore` on
   * every change, so a caller only needs to read/subscribe to it, never call `parse()` again for
   * the same field.
   */
  async parse(rawStore: Store<unknown>, path: string[] = []): Promise<{ store: Store<T> }> {
    const schema = toFieldSchema(this);
    const compute = (raw: unknown): T =>
      (raw === undefined || raw === null ? (schema.default !== undefined ? schema.default : null) : coerce(schema, raw, path)) as T;
    const store = new Store<T>(compute(rawStore.get()));
    rawStore.listen((raw) => {
      const next = compute(raw);
      if (next !== store.get()) store.set(next);
    });
    return { store };
  }
}

/**
 * Non-generic stand-in for `ConfigDescriptor<T, O>` inside the `SchemaNode` union — same reason
 * `SchemaGroupNode` stands in for `ConfigNode<S>`/`SchemaGroup<S>` there: a union member generic
 * over `any` becomes the contextual type TypeScript propagates into a nested `numeric(...)`/
 * `string(...)`/`boolean(...)` call written inline as a shape property, poisoning that call's own
 * `const O` inference. This plain marker carries no such poison; `InferField`/`InferReadOnlyAccessor`
 * still bind their own `ConfigDescriptor<infer T, infer O>` against each shape entry's actual,
 * fully-inferred type, not against this marker.
 */
interface ConfigDescriptorNode {
  readonly type: FieldType;
  readonly options: object;
}

/** Builds a `"string"` field descriptor — same options as `{ type: "string", ... }`, returned as a `ConfigDescriptor` instead of a plain object. */
export function string<const O extends StringFieldOptions = {}>(options?: O): ConfigDescriptor<string, O> {
  return new ConfigDescriptor("string", (options ?? {}) as O);
}

/** Builds a `"number"` field descriptor — same options as `{ type: "number", ... }`, returned as a `ConfigDescriptor` instead of a plain object. */
export function numeric<const O extends NumberFieldOptions = {}>(options?: O): ConfigDescriptor<number, O> {
  return new ConfigDescriptor("number", (options ?? {}) as O);
}

/** Builds a `"boolean"` field descriptor — same options as `{ type: "boolean", ... }`, returned as a `ConfigDescriptor` instead of a plain object. */
export function boolean<const O extends BooleanFieldOptions = {}>(options?: O): ConfigDescriptor<boolean, O> {
  return new ConfigDescriptor("boolean", (options ?? {}) as O);
}

/** Builds a `"url"` field descriptor — same options as `{ type: "url", ... }`, returned as a `ConfigDescriptor` instead of a plain object. Parses (and validates) a string value into a `URL` instance. */
export function url<const O extends UrlFieldOptions = {}>(options?: O): ConfigDescriptor<URL, O> {
  return new ConfigDescriptor("url", (options ?? {}) as O);
}

/**
 * Extracts a `shape()` call's value type straight off the caller's own `options` — same source
 * `{ type: "shape", schema: z.object(...) }` already infers from (see `InferSchemaType`/
 * `PrimitiveOfField` below) — rather than from a separately-inferred type parameter, since `O` alone
 * (captured via the `const` type parameter on `shape()`) already carries the caller's literal
 * `schema`, unwidened.
 */
type InferShapeOptionValue<O> = O extends { schema: infer Z } ? (Z extends { parse(value: unknown): infer R } ? R : unknown) : unknown;

/**
 * Builds a `"shape"` field descriptor — same options as `{ type: "shape", ... }`, returned as a
 * `ConfigDescriptor` instead of a plain object. Infers its value type from `schema`'s `parse`
 * return type, same as the object-literal form; omitting `schema` (`shape()` alone) infers `unknown`.
 */
export function shape<const O extends ShapeFieldOptions = {}>(
  options?: O,
): ConfigDescriptor<InferShapeOptionValue<O>, O> {
  return new ConfigDescriptor("shape", (options ?? {}) as O);
}

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

/**
 * A schema object used directly as a shape entry — `port: z.number()` instead of the explicit
 * `port: { type: "shape", schema: z.number() }`. Flattened to `Parseable<unknown>` here for the
 * same reason `ShapeFieldSchema` is flattened to `unknown` in `FieldSchema`: `SchemaNode` isn't
 * generic, so the real per-field type still comes from matching the caller's own literal type
 * structurally (see `PrimitiveOfField`/`InferField`), not from this declared member. `unknown`
 * rather than `any` avoids the literal-widening poisoning `SchemaGroupNode`'s doc above warns about.
 */
/**
 * A plain object used directly as a nested group's shape (`server: { port: numeric(...) } }`),
 * instead of wrapping it in `create({...})`. Recursive through `SchemaShape` — safe here (unlike
 * `SchemaGroupNode`/`ConfigDescriptorNode`'s `any`-avoidance concern above) since neither this alias
 * nor `SchemaShape` itself is generic, so nothing here ever resolves to `any`.
 */
export type SchemaNode = FieldSchema | SchemaGroupNode | Parseable<unknown> | ConfigDescriptorNode | SchemaShape;
/**
 * An index-signature `interface` rather than a `Record<string, SchemaNode>` type alias — the two
 * are structurally identical, but `Record<string, SchemaNode>` mutually recursing back into
 * `SchemaNode` (which now includes `SchemaShape` itself, for the plain-nested-shape shorthand)
 * makes TypeScript reject both aliases as circular; an interface's index signature is lazy the same
 * way an inline `{ [key: string]: SchemaNode }` object type already is.
 */
export interface SchemaShape {
  [key: string]: SchemaNode;
}

/** Extracts a schema's parsed output type from its `parse` method — `unknown` when it isn't shaped like a `Parseable`. */
type InferSchemaType<A> = A extends { parse(value: unknown): infer R } ? R : unknown;

type PrimitiveOfField<F extends FieldSchema> = F extends { type: "number" }
  ? number
  : F extends { type: "string" }
    ? string
    : F extends { type: "boolean" }
      ? boolean
      : F extends { type: "url" }
        ? URL
        : F extends { type: "shape"; schema: infer Z }
          ? InferSchemaType<Z>
          : F extends { type: "shape" }
            ? unknown
            : F extends { schema: infer Z }
              ? InferSchemaType<Z>
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
  : F extends ConfigDescriptor<infer T, infer O>
    ? (O extends { default: any } ? T : T | null)
    : F extends FieldSchema
      ? InferFieldValue<F>
      : F extends { parse(value: unknown): infer R }
        ? R | null
        : F extends SchemaShape
          ? InferShape<F>
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
  : F extends ConfigDescriptor<infer T, infer O>
    ? ReadOnlyStore<O extends { default: any } ? T : T | null>
    : F extends FieldSchema
      ? ReadOnlyStore<InferFieldValue<F>>
      : F extends { parse(value: unknown): infer R }
        ? ReadOnlyStore<R | null>
        : F extends SchemaShape
          ? SchemaGroup<F>
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

/**
 * A `"shape"` field that fails to parse doesn't take down the whole config tree by default — data
 * comes from sources outside this package's control, so a malformed value is logged via
 * `console.error` and the field resolves to `null`, same as a source that simply doesn't have it.
 * Only an explicit `required: true` escalates that failure into a thrown `ConfigError`.
 */
function shapeFailure(field: FieldSchema, error: ConfigError): unknown {
  if (field.required) throw error;
  console.error(error);
  return null;
}

function coerce(field: FieldSchema, raw: unknown, path: string[]): unknown {
  if (field.type === "shape") {
    if (!field.schema) {
      if (typeof raw !== "object" || raw === null) {
        return shapeFailure(
          field,
          new ConfigError(`Expected shape at "${path.join(".")}", got ${JSON.stringify(raw)}`),
        );
      }
      return raw;
    }
    const schema = field.schema;
    const [ok, err, result] = tSync(() => schema.parse(raw));
    if (ok) return result;
    const message = err instanceof Error ? err.message : String(err);
    return shapeFailure(field, new ConfigError(`Value at "${path.join(".")}" failed schema validation: ${message}`));
  }

  if (field.type === "url") {
    if (raw instanceof URL) return raw;
    if (typeof raw !== "string") typeMismatch(field, raw, path);
    try {
      return new URL(raw);
    } catch {
      throw new ConfigError(`Value at "${path.join(".")}" is not a valid URL: ${JSON.stringify(raw)}`);
    }
  }

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

function isConfigDescriptor(node: unknown): node is ConfigDescriptor<unknown, object> {
  return typeof node === "object" && node !== null && (node as Record<symbol, unknown>)[CONFIG_DESCRIPTOR_TAG] === true;
}

/**
 * Detects a plain object used directly as a nested group's shape (`server: { port: numeric(...) } }`)
 * instead of wrapping it in `create({...})`. Only a genuine plain-object shape entry qualifies: not
 * an embedded `create()` node, not a `ConfigDescriptor`, not a bare/untagged schema, and not an
 * explicit tagged `FieldSchema` (`type` present) — the same exclusions `toFieldSchema` already
 * applies, checked here so this kind of entry never reaches it.
 */
function isPlainShapeNode(node: unknown): node is SchemaShape {
  if (typeof node !== "object" || node === null) return false;
  if (isEmbeddedNode(node) || isConfigDescriptor(node) || isBareParseable(node as SchemaNode)) return false;
  if ("type" in node || "schema" in node) return false;
  const proto = Object.getPrototypeOf(node);
  return proto === Object.prototype || proto === null;
}

/**
 * Detects a bare schema object used directly as a shape entry (`port: z.number()`), as opposed to
 * an explicit `FieldSchema` (`port: { type: "shape", schema: z.number() }`). A `type` property
 * isn't a reliable discriminator by itself — many schema libraries' own instances (zod's included)
 * carry a `type` property of their own (e.g. `"number"`), which could collide with one of this
 * package's `FieldType`s. What's actually different is *shape*: an explicit `FieldSchema` is always
 * a plain object literal (`Object.prototype` or `null` as its prototype), while a schema library's
 * instance is built by a factory/class (`z.number()`, `v.number()`, ...) and so isn't.
 */
function isBareParseable(node: SchemaNode | undefined): node is Parseable<unknown> {
  if (typeof node !== "object" || node === null) return false;
  if (typeof (node as Parseable<unknown>).parse !== "function") return false;
  const proto = Object.getPrototypeOf(node);
  return proto !== Object.prototype && proto !== null;
}

let warnedAboutObjectLiteralFieldSchema = false;

/**
 * One-time, process-wide nudge off the deprecated `{ type: "...", ... }` object-literal field
 * form (still fully supported — see each `Field*Schema` type's own `@deprecated` tag) toward its
 * `ConfigDescriptor`-returning builder equivalent (`string()`/`numeric()`/`boolean()`/`url()`/
 * `shape()`). Fires at most once per process no matter how many literal fields, across however
 * many `create()` calls, actually use the old form — deprecation warnings are meant to be noticed
 * once, not repeated on every field resolution.
 */
function warnDeprecatedFieldSchema(): void {
  if (warnedAboutObjectLiteralFieldSchema) return;
  warnedAboutObjectLiteralFieldSchema = true;
  console.warn(
    '[@jondotsoy/configs] Defining a field as { type: "...", ... } is deprecated — use ' +
      "string()/numeric()/boolean()/url()/shape() instead. Still fully supported; this warning is shown once per process.",
  );
}

/**
 * @internal Test-only: clears the one-time flag above so a spec can assert the warning fires
 * again, independent of whichever other spec file already tripped it earlier in the same test
 * run. Not part of the public API — never re-exported from `configs.ts`.
 */
export function __resetDeprecatedFieldSchemaWarningForTests(): void {
  warnedAboutObjectLiteralFieldSchema = false;
}

/**
 * Normalizes a shape entry to a `FieldSchema`. Two shorthands both collapse to an explicit
 * `{ type: "shape", ... }`: a bare schema object (`port: z.number()`, see `isBareParseable`), and a
 * plain `FieldSchema`-shaped object that has `schema` but omits `type` entirely (`port: { schema:
 * z.number() }`) — the latter is only recognized when `type` is genuinely absent (an actual
 * `type: "string"`/`"number"`/`"boolean"`/`"shape"` object always passes through as itself, but logs
 * the deprecation warning above — unlike these two `type`-less shorthands, which aren't deprecated).
 * Only called for entries that aren't nested groups (checked separately via `isEmbeddedNode`), so a
 * `SchemaGroupNode` (no `schema` property) never reaches here.
 */
function toFieldSchema(node: SchemaNode | undefined): FieldSchema {
  if (isConfigDescriptor(node)) {
    return { type: node.type, ...(node.options as object) } as FieldSchema;
  }
  if (isBareParseable(node)) {
    return { type: "shape", schema: node };
  }
  if (typeof node === "object" && node !== null && !("type" in node) && "schema" in node) {
    return { ...(node as object), type: "shape" } as FieldSchema;
  }
  if (typeof node === "object" && node !== null && "type" in node) {
    warnDeprecatedFieldSchema();
  }
  return node as FieldSchema;
}

/** An explicit `key` override (if set) is taken as-is instead of `[...basePath, key]`. */
function pathFor(explicitKey: string | string[] | undefined, basePath: string[], key: string): string[] {
  if (explicitKey !== undefined) return Array.isArray(explicitKey) ? explicitKey : [explicitKey];
  return [...basePath, key];
}

/** A field's `key` (if set) is an explicit path, taken as-is instead of `[...basePath, key]`. */
function resolvePath(schema: FieldSchema, basePath: string[], key: string): string[] {
  return pathFor(schema.key, basePath, key);
}

/**
 * Resolves `field`'s value from `sources` (in priority order): the first source whose snapshot
 * has a value at `path` wins, coerced/validated via `coerce()`; falls back to `field.default`,
 * else `null`. Drives `ConfigNodeState.resolveField`, the synchronous engine behind every
 * legacy (non-`ConfigDescriptor`) field, live or not.
 */
function resolveFieldValue(field: FieldSchema, sources: Store<any>[], path: string[]): unknown {
  const raw = resolveRawValue(sources, path);
  if (raw === undefined) return field.default !== undefined ? field.default : null;
  return coerce(field, raw, path);
}

/**
 * The raw merge step alone, with no coercion/default applied: the first `source` whose snapshot
 * has a value at `path` wins, `undefined` when none do. This is what a `ConfigNode` hands a
 * `ConfigDescriptor` — as a live `Store` — for its own `parse()` to coerce/validate and default,
 * since the descriptor itself has no notion of `sources` or where else in the tree it lives.
 */
function resolveRawValue(sources: Store<any>[], path: string[]): unknown {
  for (const source of sources) {
    const raw = readNestedValue(source.get(), path);
    if (raw !== undefined && raw !== null) return raw;
  }
  return undefined;
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
  /** One raw-value `Store` per non-`readonly` `ConfigDescriptor`-backed field, handed to that descriptor's own `parse()` — see `wireDescriptorField`. */
  private readonly rawStores = new Map<string, Store<unknown>>();
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
    return resolveFieldValue(field, this.rootStores, path);
  }

  private refreshFields(): void {
    for (const [key, rawStore] of this.rawStores) {
      // Every `this.rawStores` entry is a ConfigDescriptor-backed field (see `wireDescriptorField`) — path via its own `.key`.
      const descriptor = this.shape[key] as ConfigDescriptor<any, object>;
      const path = pathFor(descriptor.key, this.basePath, key);
      const next = resolveRawValue(this.rootStores, path);
      if (next !== rawStore.get()) rawStore.set(next);
    }
    for (const [key, field] of this.fields) {
      const node = this.shape[key];
      // A ConfigDescriptor-backed field is driven by its own rawStore above, feeding the
      // descriptor's parse()-returned store, which mirrors onto `field` itself (see
      // `wireDescriptorField`) — recomputing it again here would just duplicate that.
      if (isConfigDescriptor(node)) continue;
      const schema = toFieldSchema(node);
      if (schema.readonly) continue;
      const path = resolvePath(schema, this.basePath, key);
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
      const node = this.shape[key];
      const schema = toFieldSchema(node);
      // A ConfigDescriptor exposes its own `.key` directly — resolved via that, not by first
      // building a full FieldSchema just to read `.key` back off it. A legacy (non-descriptor)
      // shape entry has no such surface of its own, so it still goes through `schema.key`.
      const path = isConfigDescriptor(node) ? pathFor(node.key, this.basePath, key) : resolvePath(schema, this.basePath, key);
      field = new ConfigField(this.resolveField(schema, path));
      this.fields.set(key, field);
      if (isConfigDescriptor(node)) this.wireDescriptorField(node, key, path, schema, field);
    }
    return field;
  }

  /**
   * This `ConfigNode`'s side of the split with `ConfigDescriptor.parse()`: builds the one raw
   * `Store` for `path` — merged from `this.rootStores`, no coercion/defaulting, kept live by
   * `refreshFields()` via `this.rawStores` (skipped for a `readonly` field, so it's built once
   * and never updated again) — and hands it to `descriptor.parse()`. The descriptor knows
   * nothing beyond that one `Store` and `path`; every subsequent value its own returned `store`
   * publishes (immediately, then on every live update) is mirrored onto `field` here.
   */
  private wireDescriptorField(
    descriptor: ConfigDescriptor<any, object>,
    key: string,
    path: string[],
    schema: FieldSchema,
    field: ConfigField<any>,
  ): void {
    const rawStore = new Store<unknown>(resolveRawValue(this.rootStores, path));
    if (!schema.readonly) this.rawStores.set(key, rawStore);
    descriptor.parse(rawStore, path).then(({ store }) => {
      store.subscribe((value) => {
        if (value !== field.get()) field._update(value);
        this.refreshSnapshot();
      });
    });
  }

  childNode(key: string): object {
    const cached = this.children.get(key);
    if (cached) return cached;

    const node = this.shape[key];

    if (isPlainShapeNode(node)) {
      // A plain-object shape used inline (no `create()` wrapper): always shares this node's
      // rootStores, same as a non-owning embedded group.
      const childState = new ConfigNodeState(node, this, [...this.basePath, key], [], false, this.closableSources);
      const result = createPendingNode(childState);
      this.children.set(key, result);
      return result;
    }

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
      if (isEmbeddedNode(node) || isPlainShapeNode(node)) {
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
        return isEmbeddedNode(shapeNode) || isPlainShapeNode(shapeNode) ? state.childNode(prop) : state.fieldFor(prop);
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
