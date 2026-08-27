const QUOTES = ['"', "'", "`"] as const;
type Quote = (typeof QUOTES)[number];

/**
 * Scans `value` (which starts with `quote`) for its matching, unescaped closing quote — a `\`
 * before `quote` or another `\` skips over the pair without ending the value there (so `\'`
 * doesn't end a `'...'` value), matching motdotla/dotenv's `LINE` regex
 * (`'(?:\\'|[^'])*'`, and the `"`/`` ` `` equivalents). The backslash itself is **not** stripped
 * here — only `unescapeQuoted()` (double quotes only) processes escape sequences afterwards.
 * Returns `undefined` if the closing quote is never found.
 */
function extractQuoted(value: string, quote: Quote): string | undefined {
  let i = 1;
  while (i < value.length) {
    const char = value[i];
    if (char === "\\" && i + 1 < value.length) {
      i += 2;
      continue;
    }
    if (char === quote) return value.slice(1, i);
    i++;
  }
  return undefined;
}

/** Double-quoted values expand `\n`/`\r` to real newline/carriage-return characters; single- and backtick-quoted values are left exactly as written. */
function unescapeQuoted(content: string, quote: Quote): string {
  if (quote !== '"') return content;
  return content.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
}

/** Strips a trailing `# comment`, but only when the `#` is preceded by whitespace (or starts the value) — a bare `#` inside a value (`abc#def`) is left alone. */
function stripInlineComment(value: string): string {
  const match = value.match(/(^|\s)#/);
  if (!match) return value;
  return value.slice(0, match.index).trimEnd();
}

/** Parses one `KEY=VALUE` line, already known not to be blank or a whole-line comment. Returns `undefined` if it has no `=`. */
function parseLine(line: string): [key: string, value: string] | undefined {
  const eq = line.indexOf("=");
  if (eq === -1) return undefined;

  const key = line.slice(0, eq).trim();
  const rawValue = line.slice(eq + 1).trim();

  if (rawValue.length >= 2 && (QUOTES as readonly string[]).includes(rawValue[0]!)) {
    const quote = rawValue[0] as Quote;
    const quoted = extractQuoted(rawValue, quote);
    if (quoted !== undefined) return [key, unescapeQuoted(quoted, quote)];
  }

  return [key, stripInlineComment(rawValue)];
}

/**
 * Parses dotenv-formatted text (`KEY=VALUE` lines) into a flat string map, following
 * motdotla/dotenv's syntax (the reference implementation dotenv.org points to). Tolerates
 * whitespace around `=` (`FOO = bar`, `FOO= bar`, `FOO=bar`), a single-, double-, or
 * backtick-quoted value (quotes stripped; `\n`/`\r` expand to real newline/carriage-return
 * characters, but only inside double quotes), and a trailing `# comment` on an unquoted value.
 * Blank lines, whole-line `#` comments, and a line with no `=` are skipped.
 */
function parse(text: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const parsed = parseLine(line);
    if (!parsed) continue;

    const [key, value] = parsed;
    result[key] = value;
  }

  return result;
}

export const DotEnv = { parse };
