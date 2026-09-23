import { boolean, createConfigNode, numeric, string } from "./config.types.js";
import type { configs as ConfigsApi } from "./config.types.js";

export type {
  BooleanFieldOptions,
  BooleanFieldSchema,
  ConfigNode,
  CreateOptions,
  FieldSchema,
  FieldType,
  InferReadOnlyAccessors,
  InferShape,
  NumberFieldOptions,
  NumberFieldSchema,
  Parseable,
  PendingConfigNode,
  ReadOnlyStore,
  SchemaGroup,
  SchemaNode,
  SchemaShape,
  ShapeFieldOptions,
  StringFieldOptions,
  StringFieldSchema,
  UrlFieldOptions,
  UrlFieldSchema,
} from "./config.types.js";
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
export { boolean, ConfigDescriptor, numeric, shape, string, url } from "./config.types.js";
export { Store } from "./utils/store.js";
export { DataTypes } from "./utils/data-types.js";
export { DotEnv } from "./utils/dotenv.js";
export { ConfigError } from "./errors.js";

export const configs: ConfigsApi = {
  create: createConfigNode,
};

export const create: ConfigsApi["create"] = createConfigNode;

export default configs;
