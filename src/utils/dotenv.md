# `.env` syntax

The syntax `DotEnv.parse` ([dotenv.ts](./dotenv.ts)) implements. There's no official RFC for
the `.env` format — [dotenv.org's own docs](https://www.dotenv.org/docs/security/env.html) note
it's "purposefully simple" and point readers to
[motdotla/dotenv](https://github.com/motdotla/dotenv) (the reference implementation the ecosystem
converged on) for the actual syntax rules. This document follows that: it's the same syntax,
described precisely enough to implement against. Every value comes out as a `string` — there's no
number/boolean coercion, that's the config field's job (`type: "number"`, etc.), not the parser's.

## Rules

1. Input is split into lines on `\n` or `\r\n`.
2. Each line is trimmed before anything else, so leading/trailing whitespace around the whole
   line never matters.
3. A line that's empty after trimming is skipped.
4. A line whose trimmed form starts with `#` is a whole-line comment and is skipped.
5. Any other line must contain `=`; the **first** `=` on the line splits it into a key and a raw
   value. A line with no `=` is skipped — it never throws.
6. The key is everything before that `=`, trimmed. The raw value is everything after it, trimmed
   — so whitespace on either side of `=` is always optional and ignored:
   `FOO=bar`, `FOO =bar`, `FOO= bar`, and `FOO = bar` all produce the same `{ FOO: "bar" }`.
7. If the raw value starts with `"`, `'`, or `` ` ``, it's a **quoted value**: everything up to
   the next matching quote is the value, quotes stripped — **except** a `\` immediately before
   that same quote character (or before another `\`) doesn't end it there, so `\'` inside a
   `'...'` value doesn't close it early. Unlike a plain "look for the next quote" scan, this
   mirrors motdotla/dotenv's `LINE` regex (`'(?:\\'|[^'])*'`, and the `"`/`` ` `` equivalents).
   Anything on the line after the closing quote (e.g. a trailing comment) is discarded.
   - Whitespace **inside** the quotes is preserved: `FOO=" some value "` → `{ FOO: " some value " }`.
   - A `#` inside a quoted value is **not** a comment — it's part of the value.
   - **The backslash used to escape a quote is *not* itself removed** — `'it\'s fine'` parses to
     the literal string `it\'s fine` (backslash and all), not `it's fine`. This matches
     motdotla/dotenv exactly: escaping only affects where the quoted value *ends*, not what ends
     up in it.
   - **Exception**: inside **double-quoted** values only, `\n` and `\r` *are* replaced with a
     real newline / carriage-return character — this is the one escape sequence dotenv expands.
     Single- and backtick-quoted values never get this treatment.
   - If the closing quote is never found, the value falls back to being treated as unquoted (rule
     8) over the *entire* raw value, opening quote included.
8. Otherwise (or on the fallback above), the raw value is **unquoted**: a trailing `# comment` is
   stripped, but only when the `#` is preceded by whitespace (or is the very first character) —
   a `#` glued to the rest of the value (`abc#def`) is left alone, since it's ambiguous with a
   value that legitimately contains one.
9. A key repeated on a later line overwrites the value from an earlier one — the last line for a
   given key wins.
10. The `=` splitting (rule 5) only ever looks at the *first* `=`; a value containing further `=`
    signs keeps them literally: `URL=https://example.com?a=1&b=2` → `{ URL: "https://example.com?a=1&b=2" }`.

## Not supported

These are deliberately out of scope — a line using them either parses to something more literal
than you might expect (per the rules above) or is skipped outright, never an error:

- Multi-line / heredoc values (motdotla/dotenv's own docs recommend `\n`-escaping inside a
  double-quoted value instead, per rule 7).
- Variable expansion or interpolation (`FOO=${OTHER}`, `FOO=$OTHER`) — kept as a literal string.
  (motdotla/dotenv doesn't do this either; it requires the separate `dotenv-expand` package.)
- An `export ` prefix (`export FOO=bar`) — parses as key `"export FOO"`, not `"FOO"`.

## Examples

| Line | Parses to |
| --- | --- |
| `FOO=true` | `{ FOO: "true" }` |
| `FOO = true` | `{ FOO: "true" }` |
| `FOO= true` | `{ FOO: "true" }` |
| `FOO = true # comment` | `{ FOO: "true" }` |
| `FOO="true"` | `{ FOO: "true" }` |
| `FOO='true'` | `{ FOO: "true" }` |
| `` FOO=`true` `` | `{ FOO: "true" }` |
| `FOO=` | `{ FOO: "" }` |
| `FOO=abc#def` | `{ FOO: "abc#def" }` (no space before `#`) |
| `FOO="not #a comment"` | `{ FOO: "not #a comment" }` (quoted: `#` is literal) |
| `FOO=" some value "` | `{ FOO: " some value " }` (whitespace preserved inside quotes) |
| `OTHER='it\'s fine'` | `{ OTHER: "it\\'s fine" }` (`\'` doesn't close the quote, but the `\` stays) |
| `` JSON=`{"foo": "bar"}` `` | `{ JSON: "{\"foo\": \"bar\"}" }` (backticks for a value with mixed quotes) |
| `FOO="line1\nline2"` | `{ FOO: "line1\nline2" }` (real newline — double quotes only) |
| `FOO='line1\nline2'` | `{ FOO: "line1\\nline2" }` (single quotes: `\n` stays literal) |
| `URL=https://example.com?a=1&b=2` | `{ URL: "https://example.com?a=1&b=2" }` |
| `# a comment` | *(skipped)* |
| `not a valid line` | *(skipped — no `=`)* |
| `` *(blank line)* | *(skipped)* |

## API

```ts
import { DotEnv } from "@jondotsoy/configs";

DotEnv.parse("FOO = true # comment\nBAR=baz\n");
// => { FOO: "true", BAR: "baz" }
```

See [dotenv.spec.ts](./dotenv.spec.ts) for the full behavior as executable tests.
