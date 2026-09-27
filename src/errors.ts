export class ConfigError extends Error {}

/** One field's own failure, tied to its path in the shape tree. */
export interface ConfigFieldError {
  readonly path: string[];
  readonly error: ConfigError;
}

/**
 * `create()`'s own aggregate error: every field-level failure across the whole tree (parse
 * failures reported via `control.error()`, and missing `required` values), collected by path
 * instead of surfacing only the first one. Extends `ConfigError` so existing `toThrow(ConfigError)`
 * assertions keep working unchanged.
 */
export class ConfigValidationError extends ConfigError {
  readonly errors: readonly ConfigFieldError[];

  constructor(errors: ConfigFieldError[]) {
    super(ConfigValidationError.formatMessage(errors));
    this.errors = errors;
  }

  private static formatMessage(errors: ConfigFieldError[]): string {
    return [
      `Invalid configuration — ${errors.length} field(s) failed:`,
      ...errors.map((e) => `  - "${e.path.join(".")}": ${e.error.message}`),
    ].join("\n");
  }
}
