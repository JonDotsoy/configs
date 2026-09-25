import { CONFIG_DESCRIPTOR_TAG } from "./utils/config-descriptor-tag.js";
import { Store, type ReadOnlyStore } from "./utils/store.js";
import { tSync } from "./utils/t.js";
import { ConfigError } from "./errors.js";

/**
 * Re-exported for anyone writing their own `ConfigDescriptor`-shaped object by hand instead of
 * constructing a real `new ConfigDescriptor(type, parser, options)` (see the README's "Writing a
 * custom ConfigDescriptor" section) — this is the one marker `isConfigDescriptor()` requires
 * alongside a callable `.parse()`, set to `true`. A `Symbol.for()` registry symbol, not a plain
 * `Symbol()` — see its own module doc for why.
 */
export { CONFIG_DESCRIPTOR_TAG } from "./utils/config-descriptor-tag.js";

/**
 * The built-in labels get their own literals (kept for autocomplete/documentation); the trailing
 * `(string & {})` still accepts any other string unchanged — `ConfigDescriptor.type` is otherwise
 * purely informational once a `parser` is supplied directly (see the README's "Writing a custom
 * `ConfigDescriptor`" section), so a custom field type isn't restricted to this package's own set.
 */
export type FieldType = "string" | "number" | "boolean" | "url" | "shape" | "file" | "choice" | (string & {});

interface BaseFieldSchema {
  summary?: string;
  required?: boolean;
  /** Freezes the field at its first resolved value: later source updates no longer reach `.get()`. */
  freeze?: boolean;
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

/**
 * Same shape as `ShapeFieldSchema<T>` — schema-based coercion, `schema` optional — tagged `"file"`
 * instead: what `file()` (`./node.js`) builds via `ConfigDescriptor`, so its `.type` reads "file"
 * (a `file()` field, not a generic shape) while going through the exact same schema-based
 * coercion path, `shapeParser()`.
 */
interface FileFieldSchema<T> extends BaseFieldSchema {
  type: "file";
  schema?: Parseable<T>;
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
  | UntaggedShapeFieldSchema<unknown>
  | FileFieldSchema<unknown>;

/**
 * `choice()`'s options — `options` is the fixed, non-empty list of strings the field is allowed to
 * resolve to; `default`, when given, must itself be one of them (enforced structurally: `O["options"][number]`
 * is what `choice()` binds its return type's `T` to, so a mismatched `default` literal fails to typecheck).
 */
export interface ChoiceFieldOptions<T extends string = string> extends BaseFieldSchema {
  options: readonly T[];
  default?: T;
}

export type StringFieldOptions = Omit<StringFieldSchema, "type">;
export type NumberFieldOptions = Omit<NumberFieldSchema, "type">;
export type BooleanFieldOptions = Omit<BooleanFieldSchema, "type">;
export type UrlFieldOptions = Omit<UrlFieldSchema, "type">;
export type ShapeFieldOptions = Omit<ShapeFieldSchema<unknown>, "type">;

/**
 * Coerces/validates one already-resolved raw value into `T`, throwing/logging per whatever rules
 * the descriptor that built this closure captured from its own `options` (a `required` shape
 * throws on failure instead of logging, a `string` checks its own `pattern`, ...). `path` is only
 * ever used to label an error message — it carries no information back into the parser.
 */
export type Parser<T> = (raw: unknown, path: string[]) => T;

/**
 * What `string()`/`numeric()`/`boolean()` build. Carries its field `type`, its own `parser` (e.g.
 * `stringParser()`), and the exact `options` object the caller passed in, generic over both `T`
 * (the field's value type) and `O` (the caller's own literal `options` type — inferred via a
 * `const` type parameter on each builder, the same way an inline `{ type: "number", default: 3000
 * }` object literal already preserves its own `default` as a literal). `InferField` reads
 * `HasDefault` off `O` directly, so `numeric()` narrows out `null` exactly when the caller's own
 * call included a `default`, same as the object-literal form.
 */
export class ConfigDescriptor<T, O extends object = object> {
  /** @internal Tags instances for `isConfigDescriptor` — see `CONFIG_DESCRIPTOR_TAG`'s doc. */
  readonly [CONFIG_DESCRIPTOR_TAG] = true;

  constructor(
    readonly type: FieldType,
    readonly parser: Parser<T>,
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
   * Whether this field freezes at its first resolved value (`options.freeze`) — exposed directly,
   * same as `.key`, so a `ConfigNode` can decide whether to keep feeding this field's raw `Store`
   * new values without reaching into `options` itself. The descriptor only ever declares the flag;
   * building the actual immutable store once it's set is the `ConfigNode`'s job (see
   * `wireDescriptorField` in `./config.types.js`).
   */
  get freeze(): boolean {
    return (this.options as { freeze?: boolean }).freeze === true;
  }

  /**
   * Runs this field's own `parser` against `rawStore` — a `Store` already holding this field's
   * merged raw value (or `undefined`/`null` when no source has it), built and kept live by
   * whichever `ConfigNode` owns the shape tree this descriptor sits in. The descriptor knows
   * nothing about `sources`, sibling fields, or where in the tree it lives — only its own
   * `parser`/`options.default` and, for error messages, the `path` label the caller passes in.
   * The returned `store` stays live: it re-derives from `rawStore` on every change, so a caller
   * only needs to read/subscribe to it, never call `parse()` again for the same field.
   *
   * @deprecated Use `.reduce()` instead — synchronous, and takes the already-merged raw value
   * directly instead of a live `Store<unknown>` to subscribe to.
   */
  async parse(rawStore: Store<unknown>, path: string[] = []): Promise<{ store: Store<T> }> {
    const store = new Store<T>(this.reduce(rawStore.get(), path).store.get());
    rawStore.listen((raw) => {
      const next = this.reduce(raw, path).store.get();
      if (next !== store.get()) store.set(next);
    });
    return { store };
  }

  /**
   * Synchronous counterpart to `.parse()`: computes this field's value straight from `raw` — the
   * merged raw value from wherever a caller resolves it from `sources` (or `undefined`/`null` when
   * none has it) — falling back to `options.default` when `raw` is missing, else running it
   * through this field's own `parser`. `store` is that value, already resolved; `ready` is the
   * same store, wrapped in a `Promise` so a caller migrating off `.parse()`'s `await`ed shape
   * doesn't have to change how it reads the result. Neither is kept live — a caller re-invokes
   * `reduce()` with a fresh `raw` whenever the input changes (see `create()` in `./config-node.js`).
   */
  reduce(raw: unknown, path: string[] = []): { store: ReadOnlyStore<T>; ready: Promise<ReadOnlyStore<T>> } {
    const defaultValue = (this.options as { default?: T }).default;
    const value = raw === undefined || raw === null ? (defaultValue !== undefined ? defaultValue : (null as T)) : this.parser(raw, path);
    const store = new Store<T>(value);
    return { store, ready: Promise.resolve(store) };
  }
}

/** Builds a `"string"` field descriptor — same options as `{ type: "string", ... }`, returned as a `ConfigDescriptor` instead of a plain object. */
export function string<const O extends StringFieldOptions = {}>(options?: O): ConfigDescriptor<string, O> {
  const opts = (options ?? {}) as O;
  return new ConfigDescriptor("string", stringParser(opts), opts);
}

/** Builds a `"number"` field descriptor — same options as `{ type: "number", ... }`, returned as a `ConfigDescriptor` instead of a plain object. */
export function numeric<const O extends NumberFieldOptions = {}>(options?: O): ConfigDescriptor<number, O> {
  const opts = (options ?? {}) as O;
  return new ConfigDescriptor("number", numberParser(opts), opts);
}

/** Builds a `"boolean"` field descriptor — same options as `{ type: "boolean", ... }`, returned as a `ConfigDescriptor` instead of a plain object. */
export function boolean<const O extends BooleanFieldOptions = {}>(options?: O): ConfigDescriptor<boolean, O> {
  const opts = (options ?? {}) as O;
  return new ConfigDescriptor("boolean", booleanParser(opts), opts);
}

/** Builds a `"url"` field descriptor — same options as `{ type: "url", ... }`, returned as a `ConfigDescriptor` instead of a plain object. Parses (and validates) a string value into a `URL` instance. */
export function url<const O extends UrlFieldOptions = {}>(options?: O): ConfigDescriptor<URL, O> {
  const opts = (options ?? {}) as O;
  return new ConfigDescriptor("url", urlParser(opts), opts);
}

/**
 * Extracts a `shape()` call's value type straight off the caller's own `options` — same source
 * `{ type: "shape", schema: z.object(...) }` already infers from (see `InferSchemaType`/
 * `PrimitiveOfField` in `./config.types.js`) — rather than from a separately-inferred type
 * parameter, since `O` alone (captured via the `const` type parameter on `shape()`) already
 * carries the caller's literal `schema`, unwidened.
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
  const opts = (options ?? {}) as O;
  return new ConfigDescriptor(
    "shape",
    shapeParser<InferShapeOptionValue<O>>(opts as { schema?: Parseable<InferShapeOptionValue<O>>; required?: boolean }, "shape"),
    opts,
  );
}

/**
 * Builds a `"choice"` field descriptor — resolves only to one of the strings listed in
 * `options.options`, rejecting (per the same log-or-throw rule as `shape()`'s `required`, see
 * `typeMismatch`) anything else. `T` is inferred from `options.options` itself (via the `const`
 * type parameter), so `choice({ options: ["a", "b"] })` resolves to `ConfigDescriptor<"a" | "b", O>`
 * rather than the widened `string`.
 */
export function choice<const O extends ChoiceFieldOptions<string>>(
  options: O,
): ConfigDescriptor<O["options"][number], O> {
  return new ConfigDescriptor("choice", choiceParser(options), options);
}

/**
 * A genuine `ConfigDescriptor` needs both markers to count as one: the `CONFIG_DESCRIPTOR_TAG`
 * symbol alone doesn't prove the rest of the contract (`.key`, `.parse()`) is actually there —
 * every builder (`string()`/`numeric()`/`boolean()`/`url()`/`shape()`, and `file()` from
 * `./node.js`) satisfies both by construction, since they all return a real `ConfigDescriptor`
 * instance, but this check doesn't take that on faith.
 */
export function isConfigDescriptor(node: unknown): node is ConfigDescriptor<unknown, object> {
  if (typeof node !== "object" || node === null) return false;
  if ((node as Record<symbol, unknown>)[CONFIG_DESCRIPTOR_TAG] !== true) return false;
  return typeof (node as { parse?: unknown }).parse === "function";
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
export function isBareParseable(node: unknown): node is Parseable<unknown> {
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
 * Only ever called for a legacy (non-`ConfigDescriptor`) shape entry — `./config.types.js` checks
 * `isConfigDescriptor()`/`isEmbeddedNode()` first and never reaches here for either, since a real
 * descriptor resolves through its own `.parser`/`.parse()` instead.
 */
export function toFieldSchema(node: unknown): FieldSchema {
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

function typeMismatch(type: FieldType, value: unknown, path: string[]): never {
  throw new ConfigError(`Expected ${type} at "${path.join(".")}", got ${JSON.stringify(value)}`);
}

/**
 * A `"shape"`/`"file"` field that fails to parse doesn't take down the whole config tree by
 * default — data comes from sources outside this package's control, so a malformed value is
 * logged via `console.error` and the field resolves to `null`, same as a source that simply
 * doesn't have it. Only an explicit `required: true` escalates that failure into a thrown
 * `ConfigError`. Exported so any field type whose `Parser<T>` needs this same rule (e.g. `file()`'s
 * own `fileParser`, in `./node.js`) doesn't have to reimplement it.
 */
export function shapeFailure(required: boolean | undefined, error: ConfigError): unknown {
  if (required) throw error;
  console.error(error);
  return null;
}

/** `string()`'s own `Parser<string>` — the coercion/validation rules a `"string"` field applies, including its own `pattern`. */
export function stringParser(options: StringFieldOptions): Parser<string> {
  return (raw, path) => {
    if (typeof raw !== "string") typeMismatch("string", raw, path);
    if (options.pattern && !options.pattern.test(raw)) {
      throw new ConfigError(`Value at "${path.join(".")}" does not match pattern ${options.pattern}`);
    }
    return raw;
  };
}

/** `numeric()`'s own `Parser<number>` — a numeric-looking string is coerced, anything else is rejected. */
export function numberParser(_options: NumberFieldOptions): Parser<number> {
  return (raw, path) => {
    if (typeof raw === "number") return raw;
    const num = Number(raw);
    if (typeof raw !== "string" || raw.trim() === "" || Number.isNaN(num)) typeMismatch("number", raw, path);
    return num;
  };
}

/** `boolean()`'s own `Parser<boolean>` — `"true"`/`"1"` and `"false"`/`"0"` are coerced, anything else is rejected. */
export function booleanParser(_options: BooleanFieldOptions): Parser<boolean> {
  return (raw, path) => {
    if (typeof raw === "boolean") return raw;
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    typeMismatch("boolean", raw, path);
  };
}

/** `url()`'s own `Parser<URL>` — a string is parsed (and validated) into a `URL` instance; an already-`URL` value passes through as-is. */
export function urlParser(_options: UrlFieldOptions): Parser<URL> {
  return (raw, path) => {
    if (raw instanceof URL) return raw;
    if (typeof raw !== "string") typeMismatch("url", raw, path);
    try {
      return new URL(raw);
    } catch {
      throw new ConfigError(`Value at "${path.join(".")}" is not a valid URL: ${JSON.stringify(raw)}`);
    }
  };
}

/** `choice()`'s own `Parser<T>` — rejects anything not present in `options.options`. */
export function choiceParser<T extends string>(options: { options: readonly T[] }): Parser<T> {
  return (raw, path) => {
    if (typeof raw !== "string" || !options.options.includes(raw as T)) {
      throw new ConfigError(
        `Expected one of ${JSON.stringify(options.options)} at "${path.join(".")}", got ${JSON.stringify(raw)}`,
      );
    }
    return raw as T;
  };
}

/**
 * `shape()`'s (and `file()`'s, from `./node.js`) own `Parser<T>` — hands the raw value to
 * `options.schema.parse` when one is given, otherwise passes any object value through as-is;
 * either way, a failure resolves to `null` (logged) or throws, per `options.required` (see
 * `shapeFailure`). `typeLabel` is only used to name the field's own type in an error message —
 * `shape()` passes `"shape"`, `file()` passes `"file"`.
 */
export function shapeParser<T>(options: { schema?: Parseable<T>; required?: boolean }, typeLabel: FieldType): Parser<T> {
  return (raw, path) => {
    if (!options.schema) {
      if (typeof raw !== "object" || raw === null) {
        return shapeFailure(
          options.required,
          new ConfigError(`Expected ${typeLabel} at "${path.join(".")}", got ${JSON.stringify(raw)}`),
        ) as T;
      }
      return raw as T;
    }
    const schema = options.schema;
    const [ok, err, result] = tSync(() => schema.parse(raw));
    if (ok) return result;
    const message = err instanceof Error ? err.message : String(err);
    return shapeFailure(options.required, new ConfigError(`Value at "${path.join(".")}" failed schema validation: ${message}`)) as T;
  };
}

