/**
 * Words (case-insensitive substring match) that mark a config path, CLI flag, or header name as
 * carrying a secret — shared between `config-descriptor.ts` (masking an unparseable field's raw
 * value in a `ConfigError`) and `sanitize-log.ts` (masking a `shellSource`/`fetchSource` log line),
 * so both stay in sync instead of drifting into two separate lists.
 */
export const SENSITIVE_WORDS = ["key", "secret", "password", "token", "credential", "auth"] as const;

/** Whether `text` contains one of `SENSITIVE_WORDS`, case-insensitive. */
export function containsSensitiveWord(text: string): boolean {
  const lower = text.toLowerCase();
  return SENSITIVE_WORDS.some((word) => lower.includes(word));
}
