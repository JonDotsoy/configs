import { ConfigError } from "./errors";
import { Store } from "./utils/store";
import type { CreateOptions, FieldSchema, InferAccessors, SchemaGroup, SchemaShape } from "./types";
import type { InferShape } from "./types";

export type {
  ConfigGroupApi,
  CreateOptions,
  DataSourceControl,
  FieldSchema,
  FieldType,
  InferAccessors,
  InferShape,
  SchemaGroup,
  SchemaNode,
  SchemaShape,
  UnderlyingDataSource,
} from "./types";
export { DataSource } from "./datasources/datasource";
export { Store } from "./utils/store";
export { ConfigError } from "./errors";

function isConfigNode(node: unknown): node is SchemaGroup {
  return node instanceof ConfigNode;
}

function readNestedValue(data: unknown, path: string[]): unknown {
  let node = data;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

function typeMismatch(field: FieldSchema, value: unknown, path: string[]): never {
  throw new ConfigError(
    `Expected ${field.type} at "${path.join(".")}", got ${JSON.stringify(value)}`,
  );
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

function validate(field: FieldSchema, value: unknown, path: string[]): void {
  if (typeof value !== field.type) {
    typeMismatch(field, value, path);
  }
  if (field.type === "string" && field.pattern && !field.pattern.test(value as string)) {
    throw new ConfigError(
      `Value at "${path.join(".")}" does not match pattern ${field.pattern}`,
    );
  }
}

export class ConfigNode<S extends SchemaShape> implements SchemaGroup<S> {
  private readonly fields = new Map<string, ConfigField<any>>();

  constructor(
    readonly shape: S,
    /** One live store per datasource, in priority order — `rootStores[0]` wins for any field it has. */
    private readonly rootStores: Store<any>[],
    /** Static, lowest-priority fallback tree — checked after every store, before a field's own `default`. */
    private readonly defaultValues: unknown = null,
    readonly basePath: string[] = [],
  ) {
    // Any datasource updating (e.g. a Store-backed source re-firing) recomputes and pushes
    // fresh values into whichever fields have already been accessed.
    for (const store of rootStores) {
      store.listen(() => this.refreshFields());
    }
  }

  /**
   * First datasource (in priority order) that has this field wins; then `defaultValues`,
   * then the field's own `default`, else `null`.
   */
  private resolveField(field: FieldSchema, path: string[]): unknown {
    for (const store of this.rootStores) {
      const raw = readNestedValue(store.get(), path);
      if (raw !== undefined && raw !== null) {
        return coerce(field, raw, path);
      }
    }
    const fromDefaults = readNestedValue(this.defaultValues, path);
    if (fromDefaults !== undefined && fromDefaults !== null) {
      return coerce(field, fromDefaults, path);
    }
    return field.default !== undefined ? field.default : null;
  }

  private refreshFields(): void {
    for (const [key, field] of this.fields) {
      const schema = this.shape[key] as FieldSchema;
      const path = [...this.basePath, key];
      const next = this.resolveField(schema, path);
      if (next !== field.get()) {
        field._update(next);
      }
    }
  }

  private fieldFor(key: string): ConfigField<any> {
    let field = this.fields.get(key);
    if (!field) {
      const schema = this.shape[key] as FieldSchema;
      const path = [...this.basePath, key];
      field = new ConfigField(this.resolveField(schema, path));
      this.fields.set(key, field);
    }
    return field;
  }

  private childNode(key: string): ConfigNode<any> {
    const node = this.shape[key];
    if (!isConfigNode(node)) {
      throw new ConfigError(`"${key}" is not a nested config group`);
    }
    return new ConfigNode(node.shape, this.rootStores, this.defaultValues, [
      ...this.basePath,
      key,
    ]);
  }

  get(): InferShape<S> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(this.shape)) {
      const node = this.shape[key]!;
      if (isConfigNode(node)) {
        out[key] = this.childNode(key).get();
      } else {
        out[key] = this.resolveField(node, [...this.basePath, key]);
      }
    }
    return out as InferShape<S>;
  }

  set<K extends keyof S & string>(key: K, value: InferShape<S>[K]): void {
    const node = this.shape[key];
    if (!node || isConfigNode(node)) {
      throw new ConfigError(`Cannot set nested config group "${key}" directly`);
    }
    const path = [...this.basePath, key];
    validate(node, value, path);
    throw new ConfigError(`Cannot set "${path.join(".")}": config values are read-only`);
  }
}

/** A leaf config field, live as a `Store<T>`: `cfg.port.get()` reads the current value. Values are read-only, so `set()` always throws. */
export class ConfigField<T> extends Store<T> {
  override set(): void {
    throw new ConfigError("Cannot set a config field: config values are read-only");
  }

  /** Pushes a recomputed value when an upstream datasource changes, bypassing the public read-only `set()`. */
  _update(value: T): void {
    super.set(value);
  }
}

function wrap<S extends SchemaShape>(node: ConfigNode<S>): ConfigNode<S> & InferAccessors<S> {
  return new Proxy(node, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && Object.prototype.hasOwnProperty.call(target.shape, prop)) {
        const child = target.shape[prop]!;
        if (isConfigNode(child)) {
          return wrap((target as any).childNode(prop));
        }
        return (target as any).fieldFor(prop);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as ConfigNode<S> & InferAccessors<S>;
}

/** Nested-group form: synchronous, no datasources of its own — inherits the parent's resolved values when embedded. */
export function create<S extends SchemaShape>(shape: S): ConfigNode<S> & InferAccessors<S>;
/**
 * Root form: opens every datasource. For each field, the first datasource (in array order) whose
 * snapshot has that field wins; a field missing everywhere falls back to its `default`, else `null`.
 */
export function create<S extends SchemaShape>(
  shape: S,
  options: CreateOptions,
): Promise<ConfigNode<S> & InferAccessors<S>>;
export function create<S extends SchemaShape>(
  shape: S,
  options?: CreateOptions,
): (ConfigNode<S> & InferAccessors<S>) | Promise<ConfigNode<S> & InferAccessors<S>> {
  if (options === undefined) {
    return wrap(new ConfigNode(shape, []));
  }
  const datasources = options.datasources ?? [];
  return Promise.all(datasources.map((source) => source.open())).then((stores) => {
    return wrap(new ConfigNode(shape, stores, options.defaultValues ?? null));
  });
}

export const configs = {
  create,
};

export default configs;
