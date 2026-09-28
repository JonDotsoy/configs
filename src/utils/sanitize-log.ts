import { containsSensitiveWord } from "./sensitive.js";

/** Replaces a sensitive value in a log line — distinct from `config-descriptor.ts`'s own `"***"` (a different subsystem's own established format), kept as its own constant here. */
export const MASK = "****";

const FLAG_EQUALS_PATTERN = /^(--?[A-Za-z][\w-]*)=(.*)$/;
const HEADER_PATTERN = /^([A-Za-z][\w-]*)\s*:\s*(.+)$/;
const FLAG_PATTERN = /^--?[A-Za-z][\w-]*$/;

/** Strips a flag's leading `-`/`--` so `--api-key`/`-key` can be checked against `SENSITIVE_WORDS` by name alone. */
function flagName(flag: string): string {
  return flag.replace(/^-{1,2}/, "");
}

/**
 * Masks a header-style value (`"Bearer xxx"`, `"xxx"`) — a value with a scheme prefix (space-
 * separated, e.g. `Authorization: Bearer <token>`) keeps the scheme and masks only the last token
 * (`"Bearer ****"`); a bare value is masked outright (`"****"`).
 */
function maskHeaderValue(value: string): string {
  const words = value.split(" ");
  if (words.length <= 1) return MASK;
  return [...words.slice(0, -1), MASK].join(" ");
}

/**
 * Masks sensitive values out of a CLI argument list before it's logged (`shellSource`'s own
 * `console.error` calls) — never mutates the array a caller passed to `shellSource`/`onRun`, which
 * still gets the real, unmasked `args`; this is only for what ends up in a log line. Three shapes
 * are recognized, each checked against `SENSITIVE_WORDS` (`./sensitive.js`) by flag/header name,
 * case-insensitive:
 *
 * - A flag and its value as two separate elements — `["--key", "1234"]` → `["--key", "****"]`.
 * - A flag with an inline value — `["--key=1234"]` → `["--key=****"]`.
 * - A header-style single argument, as passed to e.g. `curl -H` — `["Authorization: Bearer xxx"]`
 *   → `["Authorization: Bearer ****"]` (see `maskHeaderValue`), `["token: xxx"]` → `["token: ****"]`.
 *
 * Anything else (including an unrecognized flag/header name) passes through unchanged.
 */
export function maskSensitiveArgs(args: readonly string[]): string[] {
  const result = [...args];

  for (let i = 0; i < result.length; i++) {
    const arg = result[i]!;

    const eq = FLAG_EQUALS_PATTERN.exec(arg);
    if (eq && containsSensitiveWord(flagName(eq[1]!))) {
      result[i] = `${eq[1]}=${MASK}`;
      continue;
    }

    const header = HEADER_PATTERN.exec(arg);
    if (header && containsSensitiveWord(header[1]!)) {
      result[i] = `${header[1]}: ${maskHeaderValue(header[2]!)}`;
      continue;
    }

    if (FLAG_PATTERN.test(arg) && containsSensitiveWord(flagName(arg)) && i + 1 < result.length) {
      result[i + 1] = MASK;
    }
  }

  return result;
}

/**
 * Masks sensitive parts of `url` before it's logged (`fetchSource`'s own `console.error` calls):
 *
 * - Every query parameter whose name matches `SENSITIVE_WORDS` (`./sensitive.js`, case-insensitive,
 *   e.g. `token`, `api_key`) has its value replaced with `"****"`.
 * - A Basic-auth password embedded in the URL's own userinfo (`https://user:pass@host/...`) is
 *   always masked, regardless of name — there's no parameter name to check it against, and a
 *   password sitting right in the URL is exactly the kind of thing this function exists to hide.
 *   The username is left as-is: it's routing/identity information, not the secret itself.
 *
 * Every other part of the URL passes through unchanged. `url` that fails to parse as a `URL` (a
 * relative path with no base, say) is returned as `String(url)`, unmodified — there's nothing here
 * to inspect.
 */
export function maskSensitiveUrl(url: string | URL): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return String(url);
  }

  if (parsed.password) parsed.password = MASK;

  const keys = new Set(parsed.searchParams.keys());
  for (const key of keys) {
    if (containsSensitiveWord(key)) parsed.searchParams.set(key, MASK);
  }
  return parsed.toString();
}
