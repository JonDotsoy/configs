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
export type { DataSourceControl, UnderlyingDataSource } from "./types";
export type { DataType, DataTypeName } from "./utils/data-types";
export type { EnvDataSourceOptions, EnvKeyMapper } from "./datasources/env";
export type { FetchDataSourceOptions } from "./datasources/fetch";
export type { SseDataSourceOptions } from "./datasources/sse";
export type { FileDataSourceOptions } from "./datasources/file";

export { ConfigNode, ConfigNodeResolved } from "./config.types";
export { DataSource } from "./datasources/datasource";
export { envDataSource, envKeyToPath } from "./datasources/env";
export { fetchDataSource } from "./datasources/fetch";
export { sseDataSource } from "./datasources/sse";
export { fileDataSource } from "./datasources/file";
export { Store } from "./utils/store";
export { DataTypes } from "./utils/data-types";
export { DotEnv } from "./utils/dotenv";
export { ConfigError } from "./errors";

export const configs: ConfigsApi = {
  create: createConfigNode,
};

export default configs;
