import type { DataSource } from "../datasources/datasource";
import type { Store } from "../utils/store";

export type FieldType = "string" | "number" | "boolean";

interface BaseFieldSchema {
  summary?: string;
  required?: boolean;
}

export type FieldSchema =
  | (BaseFieldSchema & { type: "string"; pattern?: RegExp; default?: string })
  | (BaseFieldSchema & { type: "number"; default?: number })
  | (BaseFieldSchema & { type: "boolean"; default?: boolean });

export interface CreateOptions {
  datasources?: DataSource<any>[];
  /** Static, lowest-priority fallback tree — checked after every datasource, before a field's own `default`. */
  defaultValues?: unknown;
}

/** Structural marker matched by `ConfigNode`, kept separate to avoid a type cycle with `../configs`. */
export interface SchemaGroup<S extends SchemaShape = SchemaShape> {
  readonly shape: S;
}

export type SchemaNode = FieldSchema | SchemaGroup;
export type SchemaShape = Record<string, SchemaNode>;

type PrimitiveOfField<F extends FieldSchema> = F extends { type: "number" }
  ? number
  : F extends { type: "string" }
    ? string
    : F extends { type: "boolean" }
      ? boolean
      : never;

/**
 * A field only ever resolves to `null` when no datasource has it and it has no `default` — data comes
 * from async sources that may simply have nothing, so `required` documents intent but can't be enforced
 * at runtime and doesn't affect this type.
 */
type HasDefault<F extends FieldSchema> = F extends { default: any } ? true : false;

type InferFieldValue<F extends FieldSchema> = HasDefault<F> extends true
  ? PrimitiveOfField<F>
  : PrimitiveOfField<F> | null;

type InferField<F extends SchemaNode> = F extends SchemaGroup<infer S>
  ? InferShape<S>
  : F extends FieldSchema
    ? InferFieldValue<F>
    : never;

export type InferShape<S extends SchemaShape> = {
  [K in keyof S]: InferField<S[K]>;
};

/** Public surface of a nested config group, kept separate from `ConfigNode` to avoid a type cycle. */
export interface ConfigGroupApi<S extends SchemaShape> extends SchemaGroup<S> {
  get(): InferShape<S>;
  set<K extends keyof S & string>(key: K, value: InferShape<S>[K]): void;
  /** Closes every datasource backing this config tree. A no-op for a nested-form group of its own. */
  close(): Promise<void>;
}

type InferAccessor<F extends SchemaNode> = F extends SchemaGroup<infer S>
  ? ConfigGroupApi<S> & InferAccessors<S>
  : F extends FieldSchema
    ? Store<InferFieldValue<F>>
    : never;

/** Shape of the live proxy returned by `configs.create()`: a leaf field is a live `Store<T>`, a nested group is a config group. */
export type InferAccessors<S extends SchemaShape> = {
  [K in keyof S]: InferAccessor<S[K]>;
};
