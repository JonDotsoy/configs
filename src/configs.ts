import { createConfigNode } from "./config.types.js";
import type { configs as ConfigsApi, CreateOptions, PendingConfigNode, SchemaShape } from "./config.types.js";
import { envSource } from "./sources/env.js";

export type {
  ConfigNode,
  CreateOptions,
  InferReadOnlyAccessors,
  InferShape,
  PendingConfigNode,
  ReadOnlyStore,
  SchemaGroup,
  SchemaNode,
  SchemaShape,
} from "./config.types.js";
export type {
  BooleanFieldOptions,
  BooleanFieldSchema,
  ChoiceFieldOptions,
  FieldSchema,
  FieldType,
  NumberFieldOptions,
  NumberFieldSchema,
  Parseable,
  Parser,
  ShapeFieldOptions,
  StringFieldOptions,
  StringFieldSchema,
  UrlFieldOptions,
  UrlFieldSchema,
} from "./config-descriptor.js";
export type { SourceControl, UnderlyingSource } from "./types/index.js";
export type { DataType, DataTypeName } from "./utils/data-types.js";
export type { EnvSourceOptions, EnvKeyMapper } from "./sources/env.js";
export type { FetchSourceOptions, FetchedEvent } from "./sources/fetch.js";
export type { SseSourceOptions } from "./sources/sse.js";
export type { FileSourceOptions } from "./sources/file.js";
export type { PullSourceOptions } from "./sources/pull.js";
export type { ShellSourceOptions, ShellRunEvent } from "./sources/shell.js";

export { Source } from "./sources/source.js";
export { envSource, mapKey } from "./sources/env.js";
export { fetchSource } from "./sources/fetch.js";
export { sseSource } from "./sources/sse.js";
export { fileSource } from "./sources/file.js";
export { literalSource } from "./sources/literal.js";
export { pullSource } from "./sources/pull.js";
export { shellSource } from "./sources/shell.js";
export { boolean, choice, CONFIG_DESCRIPTOR_TAG, ConfigDescriptor, numeric, shape, string, url } from "./config-descriptor.js";
export { Store } from "./utils/store.js";
export { DataTypes } from "./utils/data-types.js";
export { DotEnv } from "./utils/dotenv.js";
export { ConfigError } from "./errors.js";

/** @deprecated Use `create()` from `./config-node.js` instead. */
export const configs: ConfigsApi = {
  create: createConfigNode,
};

export const create: ConfigsApi["create"] = createConfigNode;

/**
 * Same as `create()`, except it defaults `options.sources` to `[envSource()]` instead of `[]` —
 * so `load(shape)` (no `options` at all, or `options` with no `sources`) reads straight from
 * `process.env`. Passing an explicit `sources` array overrides that default entirely (it isn't
 * merged with `envSource()`) and `load()` then behaves exactly like `create()`.
 */
export function load<S extends SchemaShape>(shape: S, options: CreateOptions = {}): PendingConfigNode<S> {
  return createConfigNode(shape, { ...options, sources: options.sources ?? [envSource()] });
}

export default configs;
