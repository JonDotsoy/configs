import { CONFIG_DESCRIPTOR_TAG } from "./utils/config-descriptor-tag.js";
import { Store } from "./utils/store.js";
import { tSync } from "./utils/t.js";
import { ConfigError } from "./errors.js";

/**
 * Re-exported for anyone writing their own `Descriptor`-shaped object by hand instead of
 * constructing a real `new Descriptor({ type, options, start, reduce? })` (see the README's
 * "Writing a custom Descriptor" section) — this is the one marker `isConfigDescriptor()` requires
 * alongside a callable `.start()`, set to `true`. A `Symbol.for()` registry symbol, not a plain
 * `Symbol()` — see its own module doc for why.
 */
export { CONFIG_DESCRIPTOR_TAG } from "./utils/config-descriptor-tag.js";

/**
 * The built-in labels get their own literals (kept for autocomplete/documentation); the trailing
 * `(string & {})` still accepts any other string unchanged — `Descriptor.type` is otherwise
 * purely informational once a `start` is supplied directly (see the README's "Writing a
 * custom `Descriptor`" section), so a custom field type isn't restricted to this package's own set.
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
 * What `new Descriptor(...)` takes: `type`/`options` are purely descriptive (read by `.key`,
 * `.freeze`, `.options.default`, ...); `start` is this field's synchronous parser, run against one
 * already-resolved raw value every time it changes — the engine (`create()`, in `./config-node.js`)
 * owns building and live-updating the field's own `Store`, calling `start` again on every raw
 * change instead of `start` managing a `Store` itself. `reduce`, when given, is an optional async
 * escape hatch: it receives the field's live raw `Store` directly and resolves to the `Store<T>`
 * that then takes over as this field's value — its promise is folded into `create()`'s own
 * readiness, same as a source's `open()`. `close`, when given, releases whatever `start`/`reduce`
 * set up (a connection, a timer, ...) — `create()`'s own `close()` (`./config-node.js`) calls every
 * field's `close` once, same as `Source.close()` does for its own `underlying.close`.
 */
export interface DescriptorUnderlying<T, O extends object = object> {
  type: FieldType;
  options: O;
  start?: Parser<T>;
  reduce?(rawStore: Store<unknown>, path: string[]): Promise<Store<T>>;
  close?(): Promise<void>;
}

/** What `string()`/`numeric()`/`boolean()` build. See `DescriptorUnderlying` for the constructor shape. */
export class Descriptor<T, O extends object = object> {
  /** @internal Tags instances for `isConfigDescriptor` — see `CONFIG_DESCRIPTOR_TAG`'s doc. */
  readonly [CONFIG_DESCRIPTOR_TAG] = true;

  readonly type: FieldType;
  readonly options: O;
  private readonly startFn: Parser<T>;
  private readonly reduceFn?: (rawStore: Store<unknown>, path: string[]) => Promise<Store<T>>;
  private readonly closeFn?: () => Promise<void>;

  constructor(underlying: DescriptorUnderlying<T, O>) {
    this.type = underlying.type;
    this.options = underlying.options;
    this.startFn = underlying.start ?? ((raw) => raw as T);
    this.reduceFn = underlying.reduce;
    this.closeFn = underlying.close;
  }

  /**
   * This field's explicit path override, if any (`options.key`) — exposed directly so `create()`
   * (`./config-node.js`) can resolve this field's path itself (`key` as-is, or its own position in
   * the shape tree without one) without reaching into `options` to find it.
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
   * Computes this field's value off one already-resolved raw value: falls back to `options.default`
   * when raw is missing, else runs it through this field's own `start`. Synchronous, and called
   * again by `create()` every time the field's raw value changes — this descriptor holds no `Store`
   * of its own.
   */
  start(raw: unknown, path: string[] = []): T {
    const defaultValue = (this.options as { default?: T }).default;
    return raw === undefined || raw === null ? (defaultValue !== undefined ? defaultValue : (null as T)) : this.startFn(raw, path);
  }

  /**
   * The optional async hook passed as `reduce` to the constructor, if any — `undefined` when this
   * descriptor doesn't have one, in which case `create()` relies on `.start()` alone.
   */
  reduce(rawStore: Store<unknown>, path: string[] = []): Promise<Store<T>> | undefined {
    return this.reduceFn?.(rawStore, path);
  }

  /**
   * Releases whatever `start`/`reduce` set up, via the constructor's own `close`, if any — a no-op
   * otherwise. `create()`'s own `close()` (`./config-node.js`) calls this once per field.
   */
  close(): Promise<void> {
    return Promise.resolve(this.closeFn?.());
  }
}

/** Builds a `"string"` field descriptor, returned as a `Descriptor<string, O>`. */
export function string<const O extends StringFieldOptions = {}>(options?: O): Descriptor<string, O> {
  const opts = (options ?? {}) as O;
  return new Descriptor({ type: "string", options: opts, start: stringParser(opts) });
}

/** Builds a `"number"` field descriptor, returned as a `Descriptor<number, O>`. */
export function numeric<const O extends NumberFieldOptions = {}>(options?: O): Descriptor<number, O> {
  const opts = (options ?? {}) as O;
  return new Descriptor({ type: "number", options: opts, start: numberParser(opts) });
}

/** Builds a `"boolean"` field descriptor, returned as a `Descriptor<boolean, O>`. */
export function boolean<const O extends BooleanFieldOptions = {}>(options?: O): Descriptor<boolean, O> {
  const opts = (options ?? {}) as O;
  return new Descriptor({ type: "boolean", options: opts, start: booleanParser(opts) });
}

/** Builds a `"url"` field descriptor, returned as a `Descriptor<URL, O>`. Parses (and validates) a string value into a `URL` instance. */
export function url<const O extends UrlFieldOptions = {}>(options?: O): Descriptor<URL, O> {
  const opts = (options ?? {}) as O;
  return new Descriptor({ type: "url", options: opts, start: urlParser(opts) });
}

/**
 * Extracts a `shape()` call's value type straight off the caller's own `options` (its `schema`'s
 * `parse` return type) rather than from a separately-inferred type parameter, since `O` alone
 * (captured via the `const` type parameter on `shape()`) already carries the caller's literal
 * `schema`, unwidened.
 */
type InferShapeOptionValue<O> = O extends { schema: infer Z } ? (Z extends { parse(value: unknown): infer R } ? R : unknown) : unknown;

/**
 * Builds a `"shape"` field descriptor, returned as a `Descriptor<T, O>` — infers its value
 * type from `schema`'s `parse` return type; omitting `schema` (`shape()` alone) infers `unknown`.
 */
export function shape<const O extends ShapeFieldOptions = {}>(
  options?: O,
): Descriptor<InferShapeOptionValue<O>, O> {
  const opts = (options ?? {}) as O;
  return new Descriptor({
    type: "shape",
    options: opts,
    start: shapeParser<InferShapeOptionValue<O>>(opts as { schema?: Parseable<InferShapeOptionValue<O>>; required?: boolean }, "shape"),
  });
}

/**
 * Builds a `"choice"` field descriptor — resolves only to one of the strings listed in
 * `options.options`, rejecting (per the same log-or-throw rule as `shape()`'s `required`, see
 * `typeMismatch`) anything else. `T` is inferred from `options.options` itself (via the `const`
 * type parameter), so `choice({ options: ["a", "b"] })` resolves to `Descriptor<"a" | "b", O>`
 * rather than the widened `string`.
 */
export function choice<const O extends ChoiceFieldOptions<string>>(
  options: O,
): Descriptor<O["options"][number], O> {
  return new Descriptor({ type: "choice", options, start: choiceParser(options) });
}

/**
 * A genuine `Descriptor` needs both markers to count as one: the `CONFIG_DESCRIPTOR_TAG`
 * symbol alone doesn't prove the rest of the contract (`.key`, `.start()`) is actually there —
 * every builder (`string()`/`numeric()`/`boolean()`/`url()`/`shape()`, and `file()` from
 * `./node.js`) satisfies both by construction, since they all return a real `Descriptor`
 * instance, but this check doesn't take that on faith.
 */
export function isConfigDescriptor(node: unknown): node is Descriptor<unknown, object> {
  if (typeof node !== "object" || node === null) return false;
  if ((node as Record<symbol, unknown>)[CONFIG_DESCRIPTOR_TAG] !== true) return false;
  return typeof (node as { start?: unknown }).start === "function";
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
