---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

## Project

`hotconfigs` — a reactive, typed configuration library. No runtime
dependencies; every field is a live `Store` backed by pluggable
`Source`s (`env`, `fetch`, `sse`).

**Technology**: TypeScript, runs on and is built with Bun (no Node.js APIs
in `src/`). Distributed as ESM only. `dist/` is transpiled with `tsc`, not
bundled — one output module per `src/*.ts` module, no minification (see
"Build: `tsc`, not a bundler" below) — so no bundler is used to produce the
published package.

### Folder structure

```
src/
  configs.ts              # public API: re-exports create()/load() from config-node.ts, plus builders/sources
  config-node.ts           # create()/load()'s engine: ConfigsNode, ConfigsShape, isConfigsNode
  config-descriptor.ts      # Descriptor, string()/numeric()/boolean()/url()/choice()/shape()
  errors.ts                # ConfigError
  sources/
    source.ts           # Source base class (start/close contract)
    env.ts                   # envSource, mapKey (snakeCase/identity/camelCase/lookup strategies)
    fetch.ts                 # fetchSource
    sse.ts                    # sseSource
    file.ts                    # fileSource (.json/.env, live via fs.watch)
    literal.ts                 # literalSource (static value, publishes once)
    *.spec.ts                 # co-located bun:test specs
  types/                    # shared type-level helpers (schema, source, InferShape)
  utils/
    store.ts                 # Store<T> — the reactive primitive every field is built on
    data-types.ts             # field type/coercion helpers

scripts/
  build.ts                  # tsc (transpile, no bundle) + dist/package.json (entry points read from package.json "_buildEntripoint")

dist/                      # build output, gitignored — its own self-contained, publishable package.json
```

The root `package.json` is `"private": true` and has no `exports` of its
own; public entry points instead live in its `_buildEntripoint` map (`.` and
`./sources/{env,fetch,sse}`), each subpath pointing straight at its
`src/*.ts` source. `scripts/build.ts` reads that map to drive the `tsc`
build (see below) and derives `dist/package.json`'s own `exports` map from
it (the only `exports` map that actually gets published). Add a new public
module by adding both its `src/` file and its `_buildEntripoint` entry, not
just one.

### Build: `tsc`, not a bundler

`bun run build` (`scripts/build.ts`) runs `tsc -p tsconfig.build.json` to
produce `dist/` — a plain transpile, one `.js`/`.d.ts` pair per `src/*.ts`
module, mirroring `src/`'s own module graph exactly (no bundling, no
minification). This is deliberate: a bundler that packages each public
entry point (`.`, `./sources/env`, `./node`, ...) independently would inline
a separate copy of a shared class like `Descriptor` into every entry
point's own output, so an object built by one entry point's bundle could
fail `instanceof` against another entry point's copy of the same class.
With `tsc`, `Descriptor` (`config-descriptor.ts`) stays a single module,
imported by reference from everywhere else in the published package — which
is what makes `isConfigDescriptor()`'s `instanceof Descriptor` check
reliable (see "Every descriptor must be a real `Descriptor` instance"
below). The tradeoff: a published `dist/` is many small files instead of
one minified bundle per entry point.

### Internal imports use explicit `.js` extensions

Every relative import/export in `src/*.ts` (not the `.spec.ts` files) must
carry an explicit `.js` extension — e.g. `import { Source } from
"./sources/source.js"`, `from "../types/index.js"` for a directory import —
even though the file on disk is `.ts`. `tsc` in `moduleResolution: bundler`
(this repo's `tsconfig.json`) resolves that `.js` specifier against the real
`.ts` file, so nothing breaks locally. The reason is `bun run build:tsc`
(`tsc -p tsconfig.build.json`, which the top-level `bun run build` also
runs): it emits both `dist/**/*.js` and `dist/**/*.d.ts` with the same
relative specifiers written in the source, verbatim — no rewriting step. A
bare specifier (`from "./source"`) comes out just as bare in the emitted
output — which `moduleResolution: node16`/`nodenext` (what TypeScript
recommends for consuming a published ESM package from Node) cannot resolve,
and which Node/Bun's own ESM loader can't resolve at runtime either. Writing
the `.js` extension in `src/*.ts` is what makes both the emitted `.js` and
the published `.d.ts` resolve correctly. `.spec.ts` files aren't built into
`dist/`, so they're exempt.

### Every descriptor must be a real `Descriptor` instance

`isConfigDescriptor()` (`config-descriptor.ts`) checks `node instanceof
Descriptor` — not a structural check. A shape entry must be built via `new
Descriptor(...)` (directly, or through one of the built-in builders, which
all return one); a plain object with only a `.start()` method is no longer
recognized as a descriptor and `create()` treats it as a nested group
instead. This is only safe because of the `tsc`-based build above — see
"Build: `tsc`, not a bundler". A generic helper that only needs to read a
descriptor's own type parameters can rely on this and write a single-
parameter `T extends Descriptor<infer R>` (letting `Awaited`/`O` fall back
to their own declared defaults) instead of spelling out every parameter —
`config-node.ts`'s `InferPendingValue`/`ConfigsShape` do this; only
extracting the second (`Awaited`) parameter still needs the two-parameter
form, `Descriptor<any, infer R>`, since there's no way to skip the first
slot.

### Naming pattern: `Source`

The pluggable-input concept is named `Source`: base class `Source`, factory
functions `envSource()`/`fetchSource()`/`sseSource()`/`fileSource()`, options
types `EnvSourceOptions`/`FetchSourceOptions`/`SseSourceOptions`/`FileSourceOptions`,
folder `src/sources/`, and the `Options.sources` array passed to
`create()`.

When adding a new source, follow the existing shape:

- Factory function named `<name>Source()`, camelCase, returning `new Source<T>({ start, close?, reduce? })`.
- Its options type named `<Name>SourceOptions`.
- File lives at `src/sources/<name>.ts`, with a co-located `<name>.spec.ts`.
- `start(control)` pushes snapshots via `control.set(value)` (repeatable — a
  live source like `sseSource`/`fileSource` calls it more than once) and
  calls `control.close()` when done; an optional `close()` releases whatever
  `start` set up (timers, connections, watchers).
- If `start` only ever produces partial patches instead of whole-tree
  snapshots (like `sseSource`'s SSE messages), give it a `reduce(incoming,
  previous)` instead of accumulating manually — every `control.set(incoming)`
  runs through it (with `previous` `null` before the first call) and its
  return value is what actually gets published.
- Export both the factory and its options type from `src/configs.ts`, and add
  a matching `./sources/<name>` entry to `package.json`'s `_buildEntripoint`
  map so it's a public subpath.

### Keep the changelog up to date

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Whenever a change is user-facing (a new feature, a bug fix, a breaking
change, a deprecation), add an entry under an `## [Unreleased]` section at
the top of the file (create it above the newest version heading if it
doesn't exist yet), using the standard subheadings (`### Added`,
`### Changed`, `### Fixed`, `### Removed`, etc.). Do this as part of the same
change, not as a follow-up — a PR that changes behavior without touching the
`Unreleased` section is incomplete. Leave the version number and date to the
release process; don't invent one yourself.

### Before opening a PR

Run, from the repo root, and make sure it passes before pushing:

```sh
bun test
```

When opening the PR itself, use the matching template under
`.github/PULL_REQUEST_TEMPLATE/` — `bug_fix.md` for a fix,
`feature.md` for new functionality (pick via GitHub's `?template=`
query param, or `gh pr create --template`). Both share a `## Summary`
of what changed and a `## Test plan` checklist covering `bun test`,
`bunx tsc --noEmit -p tsconfig.json`, and `bun run smoke` — check off
what you ran, and note anything skipped instead of silently omitting it.
`.github/workflows/pr-test-plan.yaml` runs the whole test plan (including
`smoke`) on every PR and reflects each step's real outcome back onto
this checklist. `bun run smoke` (`scripts/smoke.ts`) builds and packs `dist/`, then
runs `smoke/smoke.donly` with `@jondotsoy/smoking --dependency <tarball>` (the
file declares no `dependency` of its own), so the cases exercise this
workspace's build, not the version currently on npm.

### Per-scenario engine coverage (`test/cases/`) — DEPRECATED

> **Deprecated.** `bun run test:cases`, `scripts/run-test-cases.ts` and
> `test/cases/` are superseded by `bun run smoke` (`smoke/smoke.donly`, see
> "Before opening a PR" above), which is what CI runs now. The suite is kept
> only for reference and will be removed: don't add new cases or manifest
> entries here — add a `case` to `smoke/smoke.donly` instead. The description
> below documents the legacy behavior.

`test/cases/` holds numbered, single-purpose scripts (`01-import-root.ts`,
`02-import-sources-subpaths.ts`, ...), each exercising one specific piece of
behavior — an import path, a source's happy/failure path, a lifecycle
detail. `test/cases/manifest.ts` registers every case and which engines
(`node`, `bun`, `deno`, `browser`) it's expected to run under; add both the
script and its manifest entry together.

`bun run test:cases` (`scripts/run-test-cases.ts`) builds `dist/`, packs it
with `npm pack` run *inside* `dist/` — the same tarball `npm publish ./dist`
would produce — and installs it with `npm install` into a scratch directory
unrelated to this repo's own `package.json`. Each case is copied into that
directory before running, so its `hotconfigs` imports can only
resolve through the installed `node_modules`, never through Node/Bun's own
self-reference (which would silently mask a packaging mistake — a missing
export, a stray or omitted file — by falling back to the workspace source).
node/bun/deno run the copied script directly with each runtime's own
binary; the browser engine bundles it with `Bun.build`, resolving
`hotconfigs` from that same scratch `node_modules`, into a small
page driven by Playwright's Chromium. A missing `node`/`bun`/`deno` binary
skips that engine's row instead of failing the run (override with
`NODE_BIN` / `BUN_BIN` / `DENO_BIN`).

Every run writes `test-cases-report/report.md`: one section per
case-and-engine combination, with the script's full source, the exact
command used to run/compile it, and its captured output — generated, not
hand-edited.

Because a case script must run unmodified under a browser page too, keep
new cases browser-safe by default (an explicit `env` object instead of
`process.env`, a `data:` URL instead of a live server, an unreachable
address instead of asserting on network internals) — mark a case
node/bun/deno-only in the manifest only when it genuinely needs a Node API
(`sources/file`'s `node:fs`, temp files on disk).

### Types-first development mode

> Historical note: the gotchas below were hit building `src/config.types.ts`,
> the legacy `configs.create()` engine — since deleted in favor of the
> current `create()`/`load()` engine in `src/config-node.ts`. The technique
> and the gotchas themselves still apply to any similarly-shaped public API
> reshape; only the specific file/type names below (`config.types.ts`,
> `ConfigNode`, `SchemaGroup`, ...) are no longer real files in this repo.

When reshaping a public API (e.g. a new `create()` return shape),
design the type surface before touching the runtime:

1. Write the new types in a standalone file, without editing the runtime
   module that will eventually implement them (it can stay
   empty/unchanged during this phase).
2. Update only the spec file's imports and `expectTypeOf(...)` assertions to
   match the new surface — leave its `expect(...)` runtime assertions as the
   target behavior to implement later.
3. Validate with `bunx tsc --noEmit -p tsconfig.json` only. Do **not** run
   `bun test` yet — the runtime isn't implemented, so those assertions are
   expected to fail until a later pass wires up the real `ConfigNode`.

This separates "does the API shape type-check and compose correctly" from
"does it work," and catches type-design mistakes (ambiguous overloads,
literal-widening through nested generic calls, self-referential `then()`
types) before they're tangled up with runtime bugs.

Gotchas hit doing this for `configs.create()`:

- **Don't name a new top-level file `src/types.ts`** while `src/types/`
  (a directory) exists — bare `"./types"` imports resolve to the file over
  the directory index project-wide, silently breaking every other file's
  `"../types"` import. Use a distinct name (e.g. `config.types.ts`).
- **A `Node<any>` (or `SchemaGroup<any>`) union member inside a shape's
  index-signature type poisons literal inference** for a nested generic
  call written inline as a shape property (e.g.
  `configs.create({ tls: configs.create({ key: { type: "string" } }) })`):
  the `any` becomes the contextual type TS propagates into that inner call,
  widening every `type: "string"` literal to `string`. Use a plain,
  non-generic marker interface (just enough to discriminate "this is a
  nested group") for the union member instead, and keep the fully generic
  type (`SchemaGroup<S>`) only for external-facing type expressions.
- **A "resolved" class must not itself be thenable** if its unresolved
  counterpart is: `ConfigNodeResolved extends ConfigNode` where `ConfigNode`
  implements `PromiseLike<ConfigNodeResolved<S> & ...>` makes
  `ConfigNodeResolved`'s own inherited `then()` resolve to itself — both the
  Promise spec (chaining-cycle) and TS's `Awaited<T>` reject that. Split a
  shared, non-thenable base class instead of one extending the other.

It builds and packs the current source on every run, but installs the
tarball into a temp dir cached across runs (`$TMPDIR/jondotsoy-configs-integration-cache`),
keyed by the tarball's sha256 — `npm install` only reruns when the packed
output actually changed.

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Unit tests use `bun test`. Specs live next to the module they cover as
`*.spec.ts` (e.g. `src/utils/store.spec.ts`).

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

Use `expectTypeOf` for compile-time type assertions — e.g. checking that a
config field narrows from `T | null` to `T` once a `default` is set, or that
`create(...)` returns the right accessor shape. It only checks types
and never runs at runtime, so it still needs a real `test()`/`expect()` to
make the file count as a test:

```ts
import { expectTypeOf, test } from "bun:test";
import { create, numeric } from "hotconfigs";

test("port narrows to number when a default is set", () => {
  const cfg = create({ port: numeric({ default: 3000 }) });
  expectTypeOf(cfg.port.get()).toEqualTypeOf<number>();
});
```

Integration tests exercise the latest built implementation, not source via
Bun's resolver. New ones are `case` blocks in `smoke/smoke.donly` (run with
`bun run smoke`). The legacy form — deprecated, don't add to it — is a single,
self-contained script under
`test/cases/` (e.g. `test/cases/16-shell-source-runs-command.ts`) that runs
unmodified end-to-end against the built `dist/` output, registered in
`test/cases/manifest.ts` with the engines (`node`/`bun`/`deno`/`browser`) it
must pass under. Run them with `bun run test:cases` (deprecated; see
"Per-scenario engine coverage" below).

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
