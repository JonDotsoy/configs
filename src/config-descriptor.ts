import { Store, type ReadOnlyStore } from "./utils/store.js";
import { tSync } from "./utils/t.js";
import { ConfigError } from "./errors.js";

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
 * The field's not-yet-resolved value type: `T` when `O` carries a `default`, otherwise `T | null`
 * — a field with no default can still resolve to `null` (no source has it yet, or ever will ever
 * publish it). This is what each built-in field builder (`string()`/`numeric()`/...) plugs into
 * `Descriptor`'s own first type parameter, so the "does this field have a default" check happens
 * once, right where the builder already knows `O`, instead of downstream in `create()`'s own type
 * inference. Exported so a hand-written field builder (e.g. `file()` in `./node.js`) can compute
 * its own `Descriptor<A, B>` return type the same way.
 */
export type WithDefault<O, T> = O extends { default: any } ? T : T | null;

/**
 * What `start(control)` gets, modeled directly after `Source`'s own `SourceControl` — same shape,
 * same rules: `control.set(value)` publishes this field's next value, callable synchronously
 * inside `start` itself (tick 0 — the field already has that value by the time `create()` returns,
 * no `await` needed) or any time later (a `rawStore.subscribe()` callback, a `setTimeout`, a
 * resolved `fetch()`, ...). The field's `Store` is 100% owned by whatever `start` does with `control.set` —
 * nothing else can update it. `rawStore` is this field's own live raw value, merged across sources
 * (read-only: `.get()`/`.subscribe()`/`.listen()`, no `.set()` — writing raw values isn't this
 * hook's job). `path` is only ever used to label an error message.
 */
export interface DescriptorControl<T> {
  rawStore: ReadOnlyStore<unknown>;
  path: string[];
  set(value: T): void;
}

/**
 * What `new Descriptor(...)` takes: `type`/`options` are purely descriptive (read by `.key`,
 * `.freeze`, `.options.default`, ...). `start(control)` runs exactly once, synchronously, when the
 * field is built — same contract as `Source`'s own `start(control)` (see `sources/source.ts`,
 * `UnderlyingSource.start`), down to the return type: `void` covers the common synchronous case,
 * `Promise<void>` lets `start` use `async`/`await` internally, but nothing in `create()` ever
 * awaits it — a field is never blocked on its own `start` finishing. `start(control)` is the
 * **only** place this field's value ever comes from: nothing updates it on its behalf. A `start`
 * that never subscribes to `control.rawStore` at all leaves the field static forever; every
 * built-in field type (`string()`/`numeric()`/...) writes its own `start` as a single
 * `control.rawStore.subscribe(...)` call — it fires immediately with the current raw value (tick
 * 0) and again on every later change, precisely so it stays live. `close`, when given,
 * releases whatever `start` set up (a connection, a timer,
 * ...) — `create()`'s own `close()` (`./config-node.js`) calls every field's `close` once, same as
 * `Source.close()` does for its own `underlying.close`.
 */
export interface DescriptorUnderlying<T, O extends object = object> {
  type: FieldType;
  options: O;
  start(control: DescriptorControl<T>): void | Promise<void>;
  close?(): Promise<void>;
}

/**
 * What `string()`/`numeric()`/`boolean()` build. Two type parameters, mirroring a field's own two
 * states: `A` is what `.get()` actually returns right now — `T | null` for a field with no
 * `default` (nothing may have resolved it yet, or ever will), or `T` once one is set. `B` is the
 * field's *resolved* type once it does have a value — always `T`, regardless of `default` — so a
 * generic helper written against `Descriptor<A, B>` can recover the underlying value type without
 * re-deriving it from `A`'s own nullability. `numeric()` returns `Descriptor<number | null,
 * number>` with no `default`, or `Descriptor<number, number>` with one — see `WithDefault`, which
 * every built-in builder uses to compute its own `A`. See `DescriptorUnderlying` for the
 * constructor shape.
 */
export class Descriptor<A, B = A, O extends object = object> {
  readonly type: FieldType;
  readonly options: O;
  private readonly startFn: (control: DescriptorControl<A>) => void | Promise<void>;
  private readonly closeFn?: () => Promise<void>;

  constructor(underlying: DescriptorUnderlying<A, O>) {
    this.type = underlying.type;
    this.options = underlying.options;
    this.startFn = underlying.start;
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
   * Runs the constructor's own `start` against `control` — `create()` (`./config-node.js`) calls
   * this exactly once per field, right when it builds the field's `Store`, and never again. Every
   * update the field will ever see comes from what `start` itself does with `control` — see
   * `DescriptorUnderlying`'s own doc. Whatever `start` returns (`void` or a `Promise<void>`) is
   * discarded here — same as `Source`'s own `start`, nothing awaits it.
   */
  start(control: DescriptorControl<A>): void {
    void this.startFn(control);
  }

  /**
   * Releases whatever `start` set up, via the constructor's own `close`, if any — a no-op
   * otherwise. `create()`'s own `close()` (`./config-node.js`) calls this once per field.
   */
  close(): Promise<void> {
    return Promise.resolve(this.closeFn?.());
  }
}

/** Builds a `"string"` field descriptor, returned as a `Descriptor<string | null, string>` (or `Descriptor<string, string>` with a `default`). */
export function string<const O extends StringFieldOptions = {}>(options?: O): Descriptor<WithDefault<O, string>, string> {
  const opts = (options ?? {}) as O;
  const parse = stringParser(opts);
  const defaultValue = opts.default !== undefined ? opts.default : (null as unknown as string);

  return new Descriptor<string, string, O>({
    type: "string",
    options: opts,
    start(control) {
      control.rawStore.subscribe((raw) => {
        control.set(raw === undefined || raw === null ? defaultValue : parse(raw, control.path));
      });
    },
  }) as Descriptor<WithDefault<O, string>, string>;
}

/** Builds a `"number"` field descriptor, returned as a `Descriptor<number | null, number>` (or `Descriptor<number, number>` with a `default`). */
export function numeric<const O extends NumberFieldOptions = {}>(options?: O): Descriptor<WithDefault<O, number>, number> {
  const opts = (options ?? {}) as O;
  const parse = numberParser(opts);
  const defaultValue = opts.default !== undefined ? opts.default : (null as unknown as number);

  return new Descriptor<number, number, O>({
    type: "number",
    options: opts,
    start(control) {
      control.rawStore.subscribe((raw) => {
        control.set(raw === undefined || raw === null ? defaultValue : parse(raw, control.path));
      });
    },
  }) as Descriptor<WithDefault<O, number>, number>;
}

/** Builds a `"boolean"` field descriptor, returned as a `Descriptor<boolean | null, boolean>` (or `Descriptor<boolean, boolean>` with a `default`). */
export function boolean<const O extends BooleanFieldOptions = {}>(options?: O): Descriptor<WithDefault<O, boolean>, boolean> {
  const opts = (options ?? {}) as O;
  const parse = booleanParser(opts);
  const defaultValue = opts.default !== undefined ? opts.default : (null as unknown as boolean);

  return new Descriptor<boolean, boolean, O>({
    type: "boolean",
    options: opts,
    start(control) {
      control.rawStore.subscribe((raw) => {
        control.set(raw === undefined || raw === null ? defaultValue : parse(raw, control.path));
      });
    },
  }) as Descriptor<WithDefault<O, boolean>, boolean>;
}

/** Builds a `"url"` field descriptor, returned as a `Descriptor<URL | null, URL>` (or `Descriptor<URL, URL>` with a `default`). Parses (and validates) a string value into a `URL` instance. */
export function url<const O extends UrlFieldOptions = {}>(options?: O): Descriptor<WithDefault<O, URL>, URL> {
  const opts = (options ?? {}) as O;
  const parse = urlParser(opts);
  const defaultValue = opts.default !== undefined ? opts.default : (null as unknown as URL);

  return new Descriptor<URL, URL, O>({
    type: "url",
    options: opts,
    start(control) {
      control.rawStore.subscribe((raw) => {
        control.set(raw === undefined || raw === null ? defaultValue : parse(raw, control.path));
      });
    },
  }) as Descriptor<WithDefault<O, URL>, URL>;
}

/**
 * Extracts a `shape()` call's value type straight off the caller's own `options` (its `schema`'s
 * `parse` return type) rather than from a separately-inferred type parameter, since `O` alone
 * (captured via the `const` type parameter on `shape()`) already carries the caller's literal
 * `schema`, unwidened.
 */
type InferShapeOptionValue<O> = O extends { schema: infer Z } ? (Z extends { parse(value: unknown): infer R } ? R : unknown) : unknown;

/**
 * Builds a `"shape"` field descriptor, returned as a `Descriptor<V | null, V>` (or
 * `Descriptor<V, V>` with a `default`), where `V` is inferred from `schema`'s `parse` return type;
 * omitting `schema` (`shape()` alone) infers `V` as `unknown`.
 */
export function shape<const O extends ShapeFieldOptions = {}>(
  options?: O,
): Descriptor<WithDefault<O, InferShapeOptionValue<O>>, InferShapeOptionValue<O>> {
  type V = InferShapeOptionValue<O>;
  const opts = (options ?? {}) as O;
  const parse = shapeParser<V>(opts as { schema?: Parseable<V>; required?: boolean }, "shape");
  const rawDefault = (opts as { default?: V }).default;
  const defaultValue = rawDefault !== undefined ? rawDefault : (null as unknown as V);

  return new Descriptor<V, V, O>({
    type: "shape",
    options: opts,
    start(control) {
      control.rawStore.subscribe((raw) => {
        control.set(raw === undefined || raw === null ? defaultValue : parse(raw, control.path));
      });
    },
  }) as Descriptor<WithDefault<O, V>, V>;
}

/**
 * Builds a `"choice"` field descriptor — resolves only to one of the strings listed in
 * `options.options`, rejecting (per the same log-or-throw rule as `shape()`'s `required`, see
 * `typeMismatch`) anything else. `V` is inferred from `options.options` itself (via the `const`
 * type parameter), so `choice({ options: ["a", "b"] })` resolves to `Descriptor<"a" | "b" | null,
 * "a" | "b">` rather than the widened `string`, or `Descriptor<"a" | "b", "a" | "b">` with a
 * `default`.
 */
export function choice<const O extends ChoiceFieldOptions<string>>(
  options: O,
): Descriptor<WithDefault<O, O["options"][number]>, O["options"][number]> {
  type V = O["options"][number];
  const parse = choiceParser(options);
  const defaultValue = options.default !== undefined ? options.default : (null as unknown as V);

  return new Descriptor<V, V, O>({
    type: "choice",
    options,
    start(control) {
      control.rawStore.subscribe((raw) => {
        control.set(raw === undefined || raw === null ? defaultValue : parse(raw, control.path));
      });
    },
  }) as Descriptor<WithDefault<O, V>, V>;
}

/**
 * Structural, not `instanceof Descriptor`: `bun build` bundles each public entry point (`.`,
 * `./node`, ...) independently, so a `Descriptor` built by one entry point's own bundled copy of
 * this module (e.g. `file()` from `./node`) would fail an `instanceof` check against another entry
 * point's separately-bundled copy of the same class (e.g. `configs.ts`'s own
 * `isConfigDescriptor`). Checking for the one method every real `Descriptor` always has —
 * `.start()` — survives that duplication, the same way the deprecated, now-removed
 * `CONFIG_DESCRIPTOR_TAG` registry symbol used to. `.close()` is deliberately not required here:
 * it's optional even on a hand-written descriptor (`create()`'s own `close()`, in
 * `./config-node.js`, only calls it when present).
 */
export function isConfigDescriptor(node: unknown): node is Descriptor<unknown, unknown> {
  if (typeof node !== "object" || node === null) return false;
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
 * `ConfigError`. Exported so any field type whose `start` needs this same rule (e.g. `file()`'s
 * own `fileStart`, in `./node.js`) doesn't have to reimplement it.
 */
export function shapeFailure(required: boolean | undefined, error: ConfigError): unknown {
  if (required) throw error;
  console.error(error);
  return null;
}

/** `string()`'s own parser — the coercion/validation rules a `"string"` field applies, including its own `pattern`. */
export function stringParser(options: StringFieldOptions): (raw: unknown, path: string[]) => string {
  return (raw, path) => {
    if (typeof raw !== "string") typeMismatch("string", raw, path);
    if (options.pattern && !options.pattern.test(raw)) {
      throw new ConfigError(`Value at "${path.join(".")}" does not match pattern ${options.pattern}`);
    }
    return raw;
  };
}

/** `numeric()`'s own parser — a numeric-looking string is coerced, anything else is rejected. */
export function numberParser(_options: NumberFieldOptions): (raw: unknown, path: string[]) => number {
  return (raw, path) => {
    if (typeof raw === "number") return raw;
    const num = Number(raw);
    if (typeof raw !== "string" || raw.trim() === "" || Number.isNaN(num)) typeMismatch("number", raw, path);
    return num;
  };
}

/** `boolean()`'s own parser — `"true"`/`"1"` and `"false"`/`"0"` are coerced, anything else is rejected. */
export function booleanParser(_options: BooleanFieldOptions): (raw: unknown, path: string[]) => boolean {
  return (raw, path) => {
    if (typeof raw === "boolean") return raw;
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    typeMismatch("boolean", raw, path);
  };
}

/** `url()`'s own parser — a string is parsed (and validated) into a `URL` instance; an already-`URL` value passes through as-is. */
export function urlParser(_options: UrlFieldOptions): (raw: unknown, path: string[]) => URL {
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

/** `choice()`'s own parser — rejects anything not present in `options.options`. */
export function choiceParser<T extends string>(options: { options: readonly T[] }): (raw: unknown, path: string[]) => T {
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
 * `shape()`'s (and `file()`'s, from `./node.js`) own parser — hands the raw value to
 * `options.schema.parse` when one is given, otherwise passes any object value through as-is;
 * either way, a failure resolves to `null` (logged) or throws, per `options.required` (see
 * `shapeFailure`). `typeLabel` is only used to name the field's own type in an error message —
 * `shape()` passes `"shape"`, `file()` passes `"file"`.
 */
export function shapeParser<T>(options: { schema?: Parseable<T>; required?: boolean }, typeLabel: FieldType): (raw: unknown, path: string[]) => T {
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
