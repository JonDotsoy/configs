const WHITESPACE = new Set([" ", "\t", "\f"]);

function isWhitespace(char: string): boolean {
  return WHITESPACE.has(char);
}

/**
 * Joins backslash-continued physical lines into logical lines: a line ending in an odd number of
 * trailing backslashes continues onto the next physical line — the trailing `\` and the line
 * break are discarded, and any leading whitespace on the continuation line is discarded too and
 * isn't part of the value, matching the `java.util.Properties` line-continuation rule.
 */
function joinContinuations(text: string): string[] {
  const rawLines = text.split(/\r\n|\r|\n/);
  const logical: string[] = [];
  let current = "";
  let continuing = false;

  for (const rawLine of rawLines) {
    const line = continuing ? rawLine.replace(/^[ \t\f]+/, "") : rawLine;
    const trailingBackslashes = line.match(/\\*$/)?.[0].length ?? 0;

    if (trailingBackslashes % 2 === 1) {
      current += line.slice(0, -1);
      continuing = true;
      continue;
    }

    current += line;
    logical.push(current);
    current = "";
    continuing = false;
  }
  if (continuing) logical.push(current);

  return logical;
}

/**
 * Decodes Java `Properties` escape sequences (`\t`, `\n`, `\r`, `\f`, `\uXXXX`, and `\` followed
 * by any other character resolving to that character literally — which covers `\\`, `\ `, `\=`,
 * `\:`, `\#`, `\!`). An unrecognized `\uXXXX` (fewer than 4 hex digits) is left as a literal `u`,
 * dropping only the backslash.
 */
function decodeEscapes(raw: string): string {
  let result = "";

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (char !== "\\") {
      result += char;
      continue;
    }

    const next = raw[i + 1];
    if (next === undefined) {
      result += "\\";
      break;
    }

    switch (next) {
      case "t":
        result += "\t";
        i++;
        break;
      case "n":
        result += "\n";
        i++;
        break;
      case "r":
        result += "\r";
        i++;
        break;
      case "f":
        result += "\f";
        i++;
        break;
      case "u": {
        const hex = raw.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          result += String.fromCharCode(parseInt(hex, 16));
          i += 5;
        } else {
          result += "u";
          i += 1;
        }
        break;
      }
      default:
        result += next;
        i++;
    }
  }

  return result;
}

/**
 * Splits one logical (continuation-joined) line into its raw (still-escaped) key and value,
 * following the `java.util.Properties` rule: the key ends at the first unescaped `=`, `:`, or
 * whitespace character; that character (and, for `=`/`:`, any whitespace surrounding it) is the
 * separator and isn't part of either the key or the value. A line with no separator is a key with
 * an empty value. Returns `undefined` for a blank line (after leading whitespace is stripped).
 */
function splitKeyValue(line: string): [key: string, value: string] | undefined {
  let i = 0;
  while (i < line.length && isWhitespace(line[i]!)) i++;
  if (i >= line.length) return undefined;

  let keyEnd = -1;
  let j = i;
  while (j < line.length) {
    const char = line[j]!;
    if (char === "\\") {
      j += 2;
      continue;
    }
    if (char === "=" || char === ":" || isWhitespace(char)) {
      keyEnd = j;
      break;
    }
    j++;
  }

  if (keyEnd === -1) {
    return [decodeEscapes(line.slice(i)), ""];
  }

  const rawKey = line.slice(i, keyEnd);
  let k = keyEnd;
  while (k < line.length && isWhitespace(line[k]!)) k++;
  if (k < line.length && (line[k] === "=" || line[k] === ":")) {
    k++;
    while (k < line.length && isWhitespace(line[k]!)) k++;
  }

  return [decodeEscapes(rawKey), decodeEscapes(line.slice(k))];
}

/** Sets `value` at the dotted `path` inside `target`, creating intermediate objects as needed — same nesting rule `envSource`'s `mapKey` results follow. */
function setPath(target: Record<string, unknown>, path: string[], value: string): void {
  let node = target;
  for (const segment of path.slice(0, -1)) {
    const next = node[segment];
    if (typeof next !== "object" || next === null) {
      node[segment] = {};
    }
    node = node[segment] as Record<string, unknown>;
  }
  node[path[path.length - 1]!] = value;
}

/**
 * Parses `java.util.Properties`-formatted text into a nested string-tree, splitting each key on
 * `.` into a path (`"game.initial-score"` => `{ game: { "initial-score": ... } }`), the same
 * hierarchy convention Spring Boot's `application.properties` and most other properties-based
 * config tools use. Every value is a string, same as `DotEnv.parse` — a shape's descriptors do
 * the type coercion.
 *
 * Follows the `java.util.Properties` plain-text syntax: a key/value pair is separated by the
 * first unescaped `=`, `:`, or plain whitespace, with whitespace around `=`/`:` ignored; blank
 * lines and lines starting (after leading whitespace) with `#` or `!` are comments; a trailing
 * unescaped `\` continues the value onto the next line, discarding the line break and the next
 * line's leading whitespace; and `\t`, `\n`, `\r`, `\f`, `\uXXXX`, and `\` followed by any other
 * character (`\\`, `\ `, `\=`, `\:`, `\#`, `\!`, ...) are unescaped in both keys and values.
 */
function parse(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const logicalLine of joinContinuations(text)) {
    const trimmed = logicalLine.replace(/^[ \t\f]+/, "");
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;

    const parsed = splitKeyValue(logicalLine);
    if (!parsed) continue;

    const [key, value] = parsed;
    if (key === "") continue;

    setPath(result, key.split("."), value);
  }

  return result;
}

export const Properties = { parse };
