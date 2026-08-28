import { createConfigNode } from "./config.types.js";
import type { configs as ConfigsApi } from "./config.types.js";

export type {
  CreateOptions,
  FieldSchema,
  FieldType,
  InferReadOnlyAccessors,
  InferShape,
  ReadOnlyStore,
  SchemaGroup,
  SchemaNode,
  SchemaShape,
} from "./config.types.js";
export type { SourceControl, UnderlyingSource } from "./types/index.js";
export type { DataType, DataTypeName } from "./utils/data-types.js";
export type { EnvSourceOptions, EnvKeyMapper } from "./sources/env.js";
export type { FetchSourceOptions } from "./sources/fetch.js";
export type { SseSourceOptions } from "./sources/sse.js";
export type { FileSourceOptions } from "./sources/file.js";

export { ConfigNode, ConfigNodeResolved } from "./config.types.js";
export { Source } from "./sources/source.js";
export { envSource, mapKey } from "./sources/env.js";
export { fetchSource } from "./sources/fetch.js";
export { sseSource } from "./sources/sse.js";
export { fileSource } from "./sources/file.js";
export { literalSource } from "./sources/literal.js";
export { Store } from "./utils/store.js";
export { DataTypes } from "./utils/data-types.js";
export { DotEnv } from "./utils/dotenv.js";
export { ConfigError } from "./errors.js";

export const configs: ConfigsApi = {
  create: createConfigNode,
};

export default configs;
