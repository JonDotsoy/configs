# Portability: isomorphism and per-runtime support

`hotconfigs` is built to run wherever your app runs — no
dependencies, distributed as pure ESM. This guide summarizes which parts of
the package are isomorphic and what to expect when using it from the
browser, Node.js, and Bun.

## Table of contents

- [Isomorphism](#isomorphism)
- [Browser support](#browser-support)
- [Node.js support](#nodejs-support)
- [Bun support](#bun-support)
- [See also](#see-also)

## Isomorphism

The core of the package is runtime-agnostic: `create`, `Source`,
`envSource`, `fetchSource`, `sseSource`, and `literalSource` don't depend on
any Node.js-specific API, so they run the same in the browser, Node.js,
Bun, or Deno.

The only exception is **`fileSource`** (and `DotEnv`), which reads from the
local filesystem via `node:fs`/`node:fs/promises`
(`src/sources/file.ts:1-2`) — by design, it's Node-only and doesn't make
sense outside an environment with a filesystem.

## Browser support

The core plus `envSource`, `fetchSource`, `sseSource`, and `literalSource`
bundle cleanly with `bun build --target browser` and with Vite.
`fetchSource` in particular only uses the global `fetch()`, so it's just as
safe in the browser as in any other runtime.

`fileSource` does bundle (no bundler fails the build over this), but it
blows up at runtime with a `TypeError` on first use, because `node:fs` ends
up externalized/shimmed as an empty object. If your browser code doesn't
import `fileSource`, tree-shaking removes it from the output.

To avoid any noise (Vite's "Module node:fs has been externalized" warning,
or the dead shim Bun leaves behind) even if you don't use `fileSource`,
import by subpath instead of the root:

```ts
import { fetchSource } from "hotconfigs/sources/fetch";

const source = fetchSource({ url: "https://example.com/config.json" });
```

Each subpath (`./sources/env`, `./sources/fetch`, `./sources/sse`,
`./sources/literal`) is an independent bundle that never touches
`node:fs`.

## Node.js support

```sh
npm install hotconfigs
```

```ts
import { create, numeric } from "hotconfigs";
import { envSource, mapKey } from "hotconfigs/sources/env";

const configs = await create(
  { server: { port: numeric({ default: 3000 }) } },
  { sources: [envSource({ mapKey: mapKey.snakeCase() })] },
);

console.log(configs.server.port.get());
```

The types published in `dist/**/*.d.ts` are meant for `nodenext`
resolution, which is what TypeScript recommends for consuming a published
ESM package from Node:

```sh
npx tsc --noEmit --module nodenext --moduleResolution nodenext test.ts
```

This flow is covered by the repo's `bun run test:cases` suite (see
[`docs/develop/check-package.md`](../develop/check-package.md) for the
manual validation checklist).

## Bun support

Bun is the runtime the package itself is developed and tested on (see
`CLAUDE.md`), so support is first-class.

```sh
bun add hotconfigs
```

```ts
import { create, numeric } from "hotconfigs";
import { envSource, mapKey } from "hotconfigs/sources/env";

const configs = await create(
  { server: { port: numeric({ default: 3000 }) } },
  { sources: [envSource({ mapKey: mapKey.snakeCase() })] },
);

console.log(configs.server.port.get());
```

With a typical Bun project `tsconfig.json` (`moduleResolution: "bundler"`,
`types: ["bun"]`), `bunx tsc --noEmit` type-checks correctly against the
published `.d.ts` files. This flow is covered by `bun run test:cases`
(engine `bun`).

## See also

For the exhaustive per-environment validation guide (checklist, full
snippets, and the exact details of what each bundler does), see
[`docs/develop/check-package.md`](../develop/check-package.md).
