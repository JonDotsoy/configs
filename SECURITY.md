# Security Policy

## Reporting a vulnerability

Open an issue at https://github.com/JonDotsoy/configs/issues, or, for anything
sensitive, email hi@jon.soy directly instead of filing a public issue.

## Package capabilities

`hotconfigs` is a pluggable configuration library: some of its `Source`s read
from outside the process by design. This section documents which subpaths do
that, so a capability scanner's findings (e.g. Socket.dev's "Network access",
"File system access", or "Shell access" alerts) can be checked against what's
actually intentional.

| Subpath                    | Capability                                 | Notes |
| --------------------------- | ------------------------------------------- | ----- |
| `hotconfigs` (root)          | none                                        | `create()`, `load()`, descriptors (`string()`, `numeric()`, ...), `Store`, `envSource`, `ConfigError`. The only `Source` re-exported from root is `envSource`; every other source lives only under its own subpath below. |
| `hotconfigs/sources/fetch`   | **Network** (outbound HTTP via `fetch()`)    | `fetchSource()` polls/fetches a URL. |
| `hotconfigs/sources/sse`     | **Network** (outbound HTTP via `EventSource`/SSE) | `sseSource()` opens a long-lived Server-Sent Events connection. |
| `hotconfigs/sources/file`    | **File system** (`node:fs`, `fs.watch`)      | `fileSource()` reads and watches a local `.json`/`.env` file. |
| `hotconfigs/sources/shell`   | **Process execution** (spawns a subprocess)  | `shellSource()` runs a configured shell command and reads its output. |
| `hotconfigs/sources/env`     | none beyond `process.env`/a passed-in object | `envSource()` reads environment variables already available to the process. |
| `hotconfigs/sources/literal` | none                                         | `literalSource()` publishes a static, in-memory value. |
| `hotconfigs/sources/pull`    | whatever the caller's `pull` function does   | `pullSource()` is a thin polling wrapper around a caller-supplied async function (e.g. a secrets-manager SDK call); the capability is the caller's, not the library's. |
| `hotconfigs/sources/source`  | none                                         | `Source`, the base class every built-in source is built on; for writing a custom source. |
| `hotconfigs/node`            | **File system** (`node:fs`)                  | `file()`/`FileBlob` read a file's contents from disk. |
| `hotconfigs/react`           | none                                         | React bindings over the reactive `Store` primitive. |
| `hotconfigs/utils/metrics`   | none                                         | In-memory counters/histograms only. |

**Why the root entry point has no capability beyond the above:** `hotconfigs`
re-exports only `envSource` among all its sources; every other source —
including ones with a real external-access capability, like network
(`fetchSource`, `sseSource`), the file system (`fileSource`), and subprocess
execution (`shellSource`) — is re-exported only from its own
`hotconfigs/sources/*` subpath, not from the root. Importing `hotconfigs`
therefore never pulls in `fetch()`/`EventSource`/`node:fs`/
`node:child_process` usage unless the consumer also imports one of those
subpaths directly. This mirrors the project's existing
per-module build (see `CLAUDE.md`'s "Build: `tsc`, not a bundler"): `dist/`
ships one file per `src/*.ts` module, so a scanner that reads the published
tarball as a whole will still see `fetch.ts`/`sse.ts`/`shell.ts` in the
package — but a scanner or bundler that follows only the root entry point's
actual import graph will not.

## Supply-chain scanner findings

If a scanner (Socket.dev, npm audit, etc.) reports a "network access",
"file system access", or "shell access" finding against `hotconfigs`, check
the table above first: these are almost certainly the documented, intentional
capabilities of `fetchSource`/`sseSource`/`fileSource`/`shellSource`, not a
vulnerability. A finding against the root entry point specifically (`.`) that
isn't explained by the table is worth reporting as a bug.
