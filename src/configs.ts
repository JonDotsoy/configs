import { create as createConfigsNode, type ConfigsNodePending, type ConfigsShape, type Options } from "./config-node.js";
import { envSource } from "./sources/env.js";

export type { ConfigsNode, ConfigsNodePending, ConfigsNodeReady, ConfigsShape, Options } from "./config-node.js";
export type {
  BooleanFieldOptions,
  ChoiceFieldOptions,
  DescriptorControl,
  DescriptorUnderlying,
  FieldType,
  ListFieldOptions,
  NumberFieldOptions,
  Parseable,
  Settled,
  ShapeFieldOptions,
  StringFieldOptions,
  UrlFieldOptions,
  WithDefault,
} from "./config-descriptor.js";
export type { SourceControl, UnderlyingSource } from "./types/index.js";
export type { ReadOnlyStore } from "./utils/store.js";
export type { DataType, DataTypeName } from "./utils/data-types.js";
export type { EnvSourceOptions, EnvKeyMapper } from "./sources/env.js";

export { envSource, mapKey } from "./sources/env.js";
export { boolean, choice, Descriptor, list, numeric, shape, string, url, isConfigDescriptor } from "./config-descriptor.js";
export { isConfigsNode } from "./config-node.js";
export { Store } from "./utils/store.js";
export { DataTypes } from "./utils/data-types.js";
export { DotEnv } from "./utils/dotenv.js";
export { ConfigError, ConfigValidationError } from "./errors.js";
export type { ConfigFieldError } from "./errors.js";

export const create: typeof createConfigsNode = createConfigsNode;

/**
 * Same as `create()`, except it defaults `options.sources` to `[envSource()]` instead of `[]` —
 * so `load(shape)` (no `options` at all, or `options` with no `sources`) reads straight from
 * `process.env`. Passing an explicit `sources` array overrides that default entirely (it isn't
 * merged with `envSource()`) and `load()` then behaves exactly like `create()`.
 */
export function load<S extends ConfigsShape>(shape: S, options: Options = {}): ConfigsNodePending<S> {
  return createConfigsNode(shape, { ...options, sources: options.sources ?? [envSource()] });
}
