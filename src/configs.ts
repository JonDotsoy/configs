import { createConfigNode } from "./config.types";
import type { configs as ConfigsApi } from "./config.types";

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
} from "./config.types";
export type { SourceControl, UnderlyingSource } from "./types";
export type { DataType, DataTypeName } from "./utils/data-types";
export type { EnvSourceOptions, EnvKeyMapper } from "./sources/env";
export type { FetchSourceOptions } from "./sources/fetch";
export type { SseSourceOptions } from "./sources/sse";
export type { FileSourceOptions } from "./sources/file";

export { ConfigNode, ConfigNodeResolved } from "./config.types";
export { Source } from "./sources/source";
export { envSource, mapKey } from "./sources/env";
export { fetchSource } from "./sources/fetch";
export { sseSource } from "./sources/sse";
export { fileSource } from "./sources/file";
export { Store } from "./utils/store";
export { DataTypes } from "./utils/data-types";
export { DotEnv } from "./utils/dotenv";
export { ConfigError } from "./errors";

export const configs: ConfigsApi = {
  create: createConfigNode,
};

export default configs;
