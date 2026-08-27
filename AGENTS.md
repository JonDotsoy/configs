---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

## Project

`@jondotsoy/configs` — a reactive, typed configuration library. No runtime
dependencies; every field is a live `Store` backed by pluggable
`DataSource`s (`env`, `fetch`, `sse`).

**Technology**: TypeScript, runs on and is built with Bun (no Node.js APIs,
no bundler other than `bun build`). Distributed as ESM only.

### Folder structure

```
src/
  configs.ts              # public API: configs.create(), ConfigNode, ConfigField
  errors.ts                # ConfigError
  datasources/
    datasource.ts           # DataSource base class (start/close contract)
    env.ts                   # envDataSource, envKeyToPath
    fetch.ts                 # fetchDataSource
    sse.ts                    # sseDataSource
    file.ts                    # fileDataSource (.json/.env, live via fs.watch)
    *.spec.ts                 # co-located bun:test specs
  types/                    # shared type-level helpers (schema, datasource, InferShape)
  utils/
    store.ts                 # Store<T> — the reactive primitive every field is built on
    data-types.ts             # field type/coercion helpers

scripts/
  build.sh                  # bun build (entry points read from package.json "exports")
  manual-pack-test.ts       # bun run test:pack — see "Before opening a PR" below

dist/                      # build output, gitignored, published via "files"/"exports"
```

Public entry points live in `package.json`'s `exports` map (`.` and
`./datasources/{env,fetch,sse}`); each condition carries an `_entryPoint`
pointing at its `src/*.ts` source, which `scripts/build.sh` reads to drive
`bun build`. Add a new public module by adding both its `src/` file and its
`exports` entry (with `_entryPoint`), not just one.

### Before opening a PR

Run both, from the repo root, and make sure they pass before pushing:

```sh
bun test
bun run test:pack
```

`bun test` runs the unit specs. `bun run test:pack` builds the package,
packs it with `bun pm pack`, installs the tarball into a scratch temp
directory like a real consumer would, verifies every import path
(`@jondotsoy/configs` and each `datasources/*` subpath) actually resolves
and works, and checks that no stray file leaked into the tarball beyond
`dist/**` and the files npm/bun always include (`package.json`, `README.md`,
`LICENSE`).

### Cross-runtime integration suite

`test/integration/runtime-imports.ts` verifies the packed tarball actually
imports and works under Node LTS, Node latest, Bun latest, and Deno latest —
not just under Bun via source resolution like the unit specs do. It isn't
part of the default `bun test` sweep (its filename has no `.test`/`.spec`),
so run it explicitly, pointing each env var at a runtime binary (any of the
four may be omitted — that runtime is skipped, not failed):

```sh
NODE_LST_BIN=/path/to/node-lts \
NODE_LATEST_BIN=/path/to/node-latest \
BUN_LATEST_BIN=/path/to/bun \
DENO_LATEST_BIN=/path/to/deno \
bun run test:integration
```

### Types-first development mode

When reshaping a public API (e.g. a new `configs.create()` return shape),
design the type surface before touching the runtime:

1. Write the new types in a standalone file (e.g. `src/config.types.ts`),
   without editing the runtime module (`configs.ts` can stay empty/unchanged
   during this phase).
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

Use `bun test` to run tests. Specs live next to the module they cover as
`*.spec.ts` (e.g. `src/utils/store.spec.ts`).

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

Use `expectTypeOf` for compile-time type assertions — e.g. checking that a
config field narrows from `T | null` to `T` once a `default` is set, or that
`configs.create(...)` returns the right accessor shape. It only checks types
and never runs at runtime, so it still needs a real `test()`/`expect()` to
make the file count as a test:

```ts
import { expectTypeOf, test } from "bun:test";

test("port narrows to number when a default is set", () => {
  const cfg = configs.create({ port: { type: "number", default: 3000 } });
  expectTypeOf(cfg.port.get()).toEqualTypeOf<number>();
});
```

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
