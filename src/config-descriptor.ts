import { CONFIG_DESCRIPTOR_TAG } from "./utils/config-descriptor-tag.js";
import { Store } from "./utils/store.js";
import { tSync } from "./utils/t.js";
import { ConfigError } from "./errors.js";

/**
 * Re-exported for anyone writing their own `ConfigDescriptor`-shaped object by hand instead of
 * constructing a real `new ConfigDescriptor(type, parser, options)` (see the README's "Writing a
 * custom ConfigDescriptor" section) — this is the one marker `isConfigDescriptor()` requires
 * alongside a callable `.reduce()`, set to `true`. A `Symbol.for()` registry symbol, not a plain
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

interface BaseFieldOptions {
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

export type StringFieldOptions = BaseFieldOptions & { pattern?: RegExp; default?: string };
export type NumberFieldOptions = BaseFieldOptions & { default?: number };
export type BooleanFieldOptions = BaseFieldOptions & { default?: boolean };
/** A `"url"` field parses a string value into a `URL` instance (and validates it's actually one), same as `numeric()` does for numbers. */
export type UrlFieldOptions = BaseFieldOptions & { default?: URL };
/**
 * `schema` is optional: a `"shape"` field with no `schema` is passed through as-is (only checked
 * for `typeof value === "object"`), for callers who just want a free-form object.
 */
export type ShapeFieldOptions = BaseFieldOptions & { schema?: Parseable<unknown>; default?: unknown };

/**
 * `choice()`'s options — `options` is the fixed, non-empty list of strings the field is allowed to
 * resolve to; `default`, when given, must itself be one of them (enforced structurally: `O["options"][number]`
 * is what `choice()` binds its return type's `T` to, so a mismatched `default` literal fails to typecheck).
 */
export interface ChoiceFieldOptions<T extends string = string> extends BaseFieldOptions {
  options: readonly T[];
  default?: T;
}

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
 * `const` type parameter on each builder, so `numeric({ default: 3000 })` preserves `3000` as a
 * literal rather than widening it to `number`). `InferConfigsNode` (`./config-node.js`) reads
 * whether `O` has a `default` directly, so `numeric()` narrows out `null` exactly when the
 * caller's own call included one.
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
   * This field's explicit path override, if any (`options.key`) — exposed directly so `create()`
   * (`./config-node.js`) can resolve this field's path itself (`key` as-is, or its own position in
   * the shape tree without one) without reaching into `options`/a reconstructed `FieldSchema` to
   * find it.
   */
  get key(): string | string[] | undefined {
    return (this.options as { key?: string | string[] }).key;
  }

  /**
   * Whether this field freezes at its first resolved value (`options.freeze`) — exposed directly,
   * same as `.key`. Currently declared but unused: no engine in this package acts on it.
   */
  get freeze(): boolean {
    return (this.options as { freeze?: boolean }).freeze === true;
  }

  /**
   * Given `rawStore` — already holding this field's merged raw value (or `undefined`/`null` when
   * no source has it) and kept live by whoever resolves it (e.g. one field's `Source → KeyStore`
   * chain in `create()`/`./config-node.js`) — returns a live `Store<T>` that recomputes on every
   * `rawStore` change: falling back to `options.default` when raw is missing, else running it
   * through this field's own `parser`. Synchronous — `rawStore` is expected to already exist, so
   * there's nothing to await; the returned store is already initialized off `rawStore`'s current
   * value.
   */
  reduce(rawStore: Store<unknown>, path: string[] = []): Store<T> {
    const compute = (raw: unknown): T => {
      const defaultValue = (this.options as { default?: T }).default;
      return raw === undefined || raw === null ? (defaultValue !== undefined ? defaultValue : (null as T)) : this.parser(raw, path);
    };
    const store = new Store<T>(compute(rawStore.get()));
    rawStore.listen((raw) => {
      const next = compute(raw);
      if (next !== store.get()) store.set(next);
    });
    return store;
  }
}

/** Builds a `"string"` field descriptor, returned as a `ConfigDescriptor<string, O>`. */
export function string<const O extends StringFieldOptions = {}>(options?: O): ConfigDescriptor<string, O> {
  const opts = (options ?? {}) as O;
  return new ConfigDescriptor("string", stringParser(opts), opts);
}

/** Builds a `"number"` field descriptor, returned as a `ConfigDescriptor<number, O>`. */
export function numeric<const O extends NumberFieldOptions = {}>(options?: O): ConfigDescriptor<number, O> {
  const opts = (options ?? {}) as O;
  return new ConfigDescriptor("number", numberParser(opts), opts);
}

/** Builds a `"boolean"` field descriptor, returned as a `ConfigDescriptor<boolean, O>`. */
export function boolean<const O extends BooleanFieldOptions = {}>(options?: O): ConfigDescriptor<boolean, O> {
  const opts = (options ?? {}) as O;
  return new ConfigDescriptor("boolean", booleanParser(opts), opts);
}

/** Builds a `"url"` field descriptor, returned as a `ConfigDescriptor<URL, O>`. Parses (and validates) a string value into a `URL` instance. */
export function url<const O extends UrlFieldOptions = {}>(options?: O): ConfigDescriptor<URL, O> {
  const opts = (options ?? {}) as O;
  return new ConfigDescriptor("url", urlParser(opts), opts);
}

/**
 * Extracts a `shape()` call's value type straight off the caller's own `options` (its `schema`'s
 * `parse` return type) rather than from a separately-inferred type parameter, since `O` alone
 * (captured via the `const` type parameter on `shape()`) already carries the caller's literal
 * `schema`, unwidened.
 */
type InferShapeOptionValue<O> = O extends { schema: infer Z } ? (Z extends { parse(value: unknown): infer R } ? R : unknown) : unknown;

/**
 * Builds a `"shape"` field descriptor, returned as a `ConfigDescriptor<T, O>` — infers its value
 * type from `schema`'s `parse` return type; omitting `schema` (`shape()` alone) infers `unknown`.
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
 * symbol alone doesn't prove the rest of the contract (`.key`, `.reduce()`) is actually there —
 * every builder (`string()`/`numeric()`/`boolean()`/`url()`/`shape()`, and `file()` from
 * `./node.js`) satisfies both by construction, since they all return a real `ConfigDescriptor`
 * instance, but this check doesn't take that on faith.
 */
export function isConfigDescriptor(node: unknown): node is ConfigDescriptor<unknown, object> {
  if (typeof node !== "object" || node === null) return false;
  if ((node as Record<symbol, unknown>)[CONFIG_DESCRIPTOR_TAG] !== true) return false;
  return typeof (node as { reduce?: unknown }).reduce === "function";
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

