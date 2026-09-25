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
/**
 * A `"url"` field parses a string value into a `URL` instance (and validates it's actually one),
 * same as `numeric()` does for numbers. `base` resolves a relative value against it (as `new
 * URL(raw, base)` would) instead of requiring an absolute URL; omitting it falls back to the
 * environment's `location` (e.g. a browser's `window.location`) when one is globally available,
 * so a relative value still resolves there without needing `base` set explicitly.
 */
export type UrlFieldOptions = BaseFieldOptions & { default?: URL; base?: string | URL };
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
 * The field's **pending** type — what `.get()` returns on the live `Store` before `create()`'s
 * node has settled (see `Descriptor`'s own `Pending`/`Awaited` type parameters): `T` when `O`
 * carries a `default`, otherwise `T | null`. `required: true` deliberately does **not** narrow
 * this one — a required field with no default can genuinely still be `null` at this exact moment
 * (no source has opened yet, or the value just hasn't arrived), `required` only guarantees
 * something once the node is done resolving (see `Settled`, used for `Descriptor`'s `Awaited`
 * parameter instead). This is what each built-in field builder (`string()`/`numeric()`/...) plugs
 * into `Descriptor`'s own `Pending` type parameter, so the "does this field have a default" check
 * happens once, right where the builder already knows `O`. Exported so a hand-written field
 * builder (e.g. `file()` in `./node.js`) can compute its own `Descriptor<Pending, Awaited>` return
 * type the same way.
 */
export type WithDefault<O, T> = O extends { default: any } ? T : T | null;

/**
 * The field's **awaited** type — what `.get()` returns once `create()`'s node has actually settled
 * (its `then()`/`await` fulfills): `T` when `O` carries a `default` **or** `required: true`,
 * otherwise `T | null`. A field with neither can genuinely resolve to `null` forever (no source
 * has it, or ever will publish it) — but a `required` field without a `default` is guaranteed, by
 * `create()`'s own `requiredChecks` sweep (`./config-node.js`), to either settle on a real value or
 * reject the awaited node instead, so it never actually surfaces `null` in the awaited shape. This
 * is what each built-in field builder plugs into `Descriptor`'s own `Awaited` type parameter (see
 * `WithDefault` for the counterpart `Pending` parameter).
 */
export type Settled<O, T> = O extends { default: any } ? T : O extends { required: true } ? T : T | null;

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
  /**
   * Reports a failure for this field without tearing down the tree — `create()` (`./config-node.js`)
   * collects every field's own errors by path instead of surfacing only the first one. Prefer this
   * over throwing directly from `start()`/a `rawStore` subscriber: a thrown error works too (`create()`
   * catches it), but `control.error()` is the sanctioned way to report one.
   */
  error(error: ConfigError): void;
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
 * What `string()`/`numeric()`/`boolean()` build. Two type parameters, one per state a field's
 * `Store` actually goes through: `Pending` is what `.get()` is typed to return on the live `Store`
 * exposed by a still-unresolved `create()` node — `T | null` unless `O` carries a `default` (see
 * `WithDefault`); `required: true` alone does not narrow this one, since a required field can
 * still genuinely be `null` at that exact moment. `Awaited` is what `.get()` is typed to return
 * once `create()`'s node has settled (its `then()`/`await` fulfills) — `T | null` unless `O`
 * carries a `default` **or** `required: true` (see `Settled`), since a required field is
 * guaranteed by then to either hold a real value or have already rejected the awaited node.
 * `config-node.ts`'s `ConfigsNode<T>`/`ConfigsNodeReady<T>` read `Pending`/`Awaited` back off this
 * class to type a field's `Store` differently before and after `await`. Each built-in builder
 * computes both explicitly from its own `O` and passes them in directly — `Descriptor` itself
 * performs no inference from `default`/`required`, it only carries whatever the builder computed.
 * `numeric()` returns `Descriptor<number | null, number>` with neither `default` nor `required`,
 * or `Descriptor<number, number>` with either one. See `DescriptorUnderlying` for the constructor
 * shape.
 */
export class Descriptor<Pending, Awaited = Pending, O extends object = object> {
  readonly type: FieldType;
  readonly options: O;
  private readonly startFn: (control: DescriptorControl<Pending>) => void | Promise<void>;
  private readonly closeFn?: () => Promise<void>;

  constructor(underlying: DescriptorUnderlying<Pending, O>) {
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
   * Whether this field must resolve to a value (`options.required`) — exposed directly, same as
   * `.key`/`.freeze`. `create()` (`./config-node.js`) is what actually acts on this: once every
   * source has settled, a `required` field still resolved to `null` is reported as a missing-value
   * error, uniformly across every built-in field type (a parse failure for `shape()`/`file()` still
   * escalates to `control.error()` on its own, per-value, regardless of `required`).
   */
  get required(): boolean {
    return (this.options as { required?: boolean }).required === true;
  }

  /**
   * Runs the constructor's own `start` against `control` — `create()` (`./config-node.js`) calls
   * this exactly once per field, right when it builds the field's `Store`, and never again. Every
   * update the field will ever see comes from what `start` itself does with `control` — see
   * `DescriptorUnderlying`'s own doc. Whatever `start` returns (`void` or a `Promise<void>`) is
   * discarded here — same as `Source`'s own `start`, nothing awaits it.
   */
  start(control: DescriptorControl<Pending>): void {
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

/**
 * Shared `start(control)` body for every built-in field type: falls back to `defaultValue` when raw
 * is undefined/null, otherwise runs `parse`. A `parse` that throws (`typeMismatch`, `choiceParser`,
 * `urlParser`, `shapeParser`/`shapeFailure` with `required: true`) doesn't propagate out of the
 * `rawStore` subscriber — it's caught here and forwarded to `control.error()`, so one field's failure
 * never tears down the rest of the tree. `file()` (`./node.js`) reuses this too.
 */
export function subscribeParsed<T>(control: DescriptorControl<T>, defaultValue: T, parse: (raw: unknown, path: string[]) => T): void {
  control.rawStore.subscribe((raw) => {
    if (raw === undefined || raw === null) {
      control.set(defaultValue);
      return;
    }
    try {
      control.set(parse(raw, control.path));
    } catch (err) {
      control.error(err instanceof ConfigError ? err : new ConfigError(err instanceof Error ? err.message : String(err)));
    }
  });
}

/**
 * Builds a `"string"` field descriptor, returned as `Descriptor<Pending, Awaited>` where both are
 * computed from `O` up front and passed in explicitly: `Descriptor<string | null, string | null>`
 * with neither `default` nor `required`, `Descriptor<string, string>` with a `default`, or
 * `Descriptor<string | null, string>` with `required: true` alone (see `WithDefault`/`Settled`).
 */
export function string<const O extends StringFieldOptions = {}>(options?: O): Descriptor<WithDefault<O, string>, Settled<O, string>> {
  const opts = (options ?? {}) as O;
  const parse = stringParser(opts);
  const defaultValue = opts.default !== undefined ? opts.default : (null as unknown as string);

  return new Descriptor<string, string, O>({
    type: "string",
    options: opts,
    start(control) {
      subscribeParsed(control, defaultValue, parse);
    },
  }) as Descriptor<WithDefault<O, string>, Settled<O, string>>;
}

/**
 * Builds a `"number"` field descriptor, returned as `Descriptor<Pending, Awaited>` where both are
 * computed from `O` up front and passed in explicitly: `Descriptor<number | null, number | null>`
 * with neither `default` nor `required`, `Descriptor<number, number>` with a `default`, or
 * `Descriptor<number | null, number>` with `required: true` alone (see `WithDefault`/`Settled`).
 */
export function numeric<const O extends NumberFieldOptions = {}>(options?: O): Descriptor<WithDefault<O, number>, Settled<O, number>> {
  const opts = (options ?? {}) as O;
  const parse = numberParser(opts);
  const defaultValue = opts.default !== undefined ? opts.default : (null as unknown as number);

  return new Descriptor<number, number, O>({
    type: "number",
    options: opts,
    start(control) {
      subscribeParsed(control, defaultValue, parse);
    },
  }) as Descriptor<WithDefault<O, number>, Settled<O, number>>;
}

/**
 * Builds a `"boolean"` field descriptor, returned as `Descriptor<Pending, Awaited>` where both are
 * computed from `O` up front and passed in explicitly: `Descriptor<boolean | null, boolean | null>`
 * with neither `default` nor `required`, `Descriptor<boolean, boolean>` with a `default`, or
 * `Descriptor<boolean | null, boolean>` with `required: true` alone (see `WithDefault`/`Settled`).
 */
export function boolean<const O extends BooleanFieldOptions = {}>(options?: O): Descriptor<WithDefault<O, boolean>, Settled<O, boolean>> {
  const opts = (options ?? {}) as O;
  const parse = booleanParser(opts);
  const defaultValue = opts.default !== undefined ? opts.default : (null as unknown as boolean);

  return new Descriptor<boolean, boolean, O>({
    type: "boolean",
    options: opts,
    start(control) {
      subscribeParsed(control, defaultValue, parse);
    },
  }) as Descriptor<WithDefault<O, boolean>, Settled<O, boolean>>;
}

/**
 * Builds a `"url"` field descriptor, returned as `Descriptor<Pending, Awaited>` where both are
 * computed from `O` up front and passed in explicitly: `Descriptor<URL | null, URL | null>` with
 * neither `default` nor `required`, `Descriptor<URL, URL>` with a `default`, or
 * `Descriptor<URL | null, URL>` with `required: true` alone (see `WithDefault`/`Settled`). Parses
 * (and validates) a string value into a `URL` instance.
 */
export function url<const O extends UrlFieldOptions = {}>(options?: O): Descriptor<WithDefault<O, URL>, Settled<O, URL>> {
  const opts = (options ?? {}) as O;
  const parse = urlParser(opts);
  const defaultValue = opts.default !== undefined ? opts.default : (null as unknown as URL);

  return new Descriptor<URL, URL, O>({
    type: "url",
    options: opts,
    start(control) {
      subscribeParsed(control, defaultValue, parse);
    },
  }) as Descriptor<WithDefault<O, URL>, Settled<O, URL>>;
}

/**
 * Extracts a `shape()` call's value type straight off the caller's own `options` (its `schema`'s
 * `parse` return type) rather than from a separately-inferred type parameter, since `O` alone
 * (captured via the `const` type parameter on `shape()`) already carries the caller's literal
 * `schema`, unwidened.
 */
type InferShapeOptionValue<O> = O extends { schema: infer Z } ? (Z extends { parse(value: unknown): infer R } ? R : unknown) : unknown;

/**
 * Builds a `"shape"` field descriptor, returned as `Descriptor<Pending, Awaited>` where both are
 * computed from `O` up front and passed in explicitly: `Descriptor<V | null, V | null>` with
 * neither `default` nor `required`, `Descriptor<V, V>` with a `default`, or `Descriptor<V | null,
 * V>` with `required: true` alone (see `WithDefault`/`Settled`) — `V` is inferred from `schema`'s
 * `parse` return type; omitting `schema` (`shape()` alone) infers `V` as `unknown`.
 */
export function shape<const O extends ShapeFieldOptions = {}>(
  options?: O,
): Descriptor<WithDefault<O, InferShapeOptionValue<O>>, Settled<O, InferShapeOptionValue<O>>> {
  type V = InferShapeOptionValue<O>;
  const opts = (options ?? {}) as O;
  const parse = shapeParser<V>(opts as { schema?: Parseable<V>; required?: boolean }, "shape");
  const rawDefault = (opts as { default?: V }).default;
  const defaultValue = rawDefault !== undefined ? rawDefault : (null as unknown as V);

  return new Descriptor<V, V, O>({
    type: "shape",
    options: opts,
    start(control) {
      subscribeParsed(control, defaultValue, parse);
    },
  }) as Descriptor<WithDefault<O, V>, Settled<O, V>>;
}

/**
 * Builds a `"choice"` field descriptor — resolves only to one of the strings listed in
 * `options.options`, rejecting (per the same log-or-throw rule as `shape()`'s `required`, see
 * `typeMismatch`) anything else. `V` is inferred from `options.options` itself (via the `const`
 * type parameter), and both `Descriptor<Pending, Awaited>` type parameters are computed from `O`
 * up front and passed in explicitly, so `choice({ options: ["a", "b"] })` resolves to
 * `Descriptor<"a" | "b" | null, "a" | "b" | null>` rather than the widened `string`,
 * `Descriptor<"a" | "b", "a" | "b">` with a `default`, or `Descriptor<"a" | "b" | null, "a" |
 * "b">` with `required: true` alone (see `WithDefault`/`Settled`).
 */
export function choice<const O extends ChoiceFieldOptions<string>>(
  options: O,
): Descriptor<WithDefault<O, O["options"][number]>, Settled<O, O["options"][number]>> {
  type V = O["options"][number];
  const parse = choiceParser(options);
  const defaultValue = options.default !== undefined ? options.default : (null as unknown as V);

  return new Descriptor<V, V, O>({
    type: "choice",
    options,
    start(control) {
      subscribeParsed(control, defaultValue, parse);
    },
  }) as Descriptor<WithDefault<O, V>, Settled<O, V>>;
}

/**
 * A real `instanceof Descriptor` check — every descriptor accepted anywhere in this package must
 * now actually be built via `new Descriptor(...)` (or one of the built-in builders, which all
 * return one). This used to be a structural check (only `.start` being a function) because `bun
 * build` bundled each public entry point (`.`, `./node`, ...) independently, so a `Descriptor`
 * built by one entry point's own bundled copy of this module (e.g. `file()` from `./node`) would
 * fail `instanceof` against another entry point's separately-bundled copy of the same class (e.g.
 * `configs.ts`'s own `isConfigDescriptor`). Now that `scripts/build.ts` transpiles `dist/` with
 * `tsc` instead of bundling (see its own doc comment), `Descriptor` is a single module imported by
 * reference everywhere in the published package, so `instanceof` is reliable again — a
 * hand-written, plain-object descriptor (no longer supported) would fail this check even if it had
 * a `.start` method of its own.
 */
export function isConfigDescriptor(node: unknown): node is Descriptor<unknown> {
  return node instanceof Descriptor;
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
export function urlParser(options: UrlFieldOptions): (raw: unknown, path: string[]) => URL {
  const base = options.base ?? (globalThis as { location?: { href: string } }).location?.href;
  return (raw, path) => {
    if (raw instanceof URL) return raw;
    if (typeof raw !== "string") typeMismatch("url", raw, path);
    try {
      return base === undefined ? new URL(raw) : new URL(raw, base);
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
