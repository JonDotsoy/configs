# @jondotsoy/configs

Ship your config to your apps, fast. Configuration isn't just static values
read once at boot anymore — feature flags, remote toggles, and settings
served over HTTP or SSE change at runtime to turn features on and off or
adjust app behavior without a redeploy. `@jondotsoy/configs` is built for
that: every field is a live `Store` you subscribe to, so your app reacts
the moment a source pushes a new value.

- **Reactive configs** — every field is a live `Store`; subscribe to it and get notified whenever an upstream source changes.
- **Lightweight** — no dependencies, just a thin layer over plain objects and stores.
- **Typed with TS check** — schemas are statically checked, so `cfg.port.get()` is inferred as `number | null` (or `number` when a `default` is set), not `any`.

```ts
import { create, choice, numeric, string, boolean } from "@jondotsoy/configs";
import { envSource } from "@jondotsoy/configs/sources/env";
import { fetchSource } from "@jondotsoy/configs/sources/fetch";
import { pullSource } from "@jondotsoy/configs/sources/pull";
import { file } from "@jondotsoy/configs/node";

// HOST=localhost PORT=3000 → { server: { host: "localhost", port: "3000" } }
// server.tls.cert/.key are read eagerly from disk, decoded into FileBlobs
// LOG_LEVEL=warn → app log verbosity, restricted to one of a fixed set of levels
// GET https://example.com/features → { experimental: { home: { promotionalDialog: true } },
//   ui: { menuOrientation: "vertical", sidebarCollapsed: true } } (polled every 30s)
// secretsManager.getSecretValue("prod/db") → { host, port, user, password } — your AWS/GCP/Vault
// SDK client of choice, re-pulled every 5m so a rotated secret reaches the config tree
const cfg = await create(
  {
    logLevel: choice({
      summary: "app log verbosity",
      options: ["debug", "info", "warn", "error"],
      default: "info",
      key: "LOG_LEVEL",
    }),
    server: {
      // freeze: true — host/port are read once at boot; changing them at runtime
      // wouldn't rebind the already-listening server anyway.
      host: string({ summary: "bind host", default: "localhost", key: "HOST", freeze: true }),
      port: numeric({ summary: "HTTP port", default: 3000, key: "PORT", freeze: true }),
      tls: {
        cert: file({ summary: "TLS certificate", default: new URL("file:///etc/ssl/certs/server.pem") }),
        key: file({ summary: "TLS private key", default: new URL("file:///etc/ssl/private/server-key.pem") }),
      },
    },
    features: create(
      {
        experimental: {
          home: {
            promotionalDialog: boolean({ summary: "show the promotional dialog", default: false }),
          },
        },
        ui: {
          menuOrientation: string({
            summary: "main menu orientation",
            default: "horizontal",
            pattern: /^(horizontal|vertical)$/,
          }),
          sidebarCollapsed: boolean({ summary: "collapse the sidebar by default", default: false }),
        },
      },
      { sources: [fetchSource({ url: "https://example.com/features", pollingInterval: 30_000 })] },
    ),
    database: create(
      {
        host: string({ summary: "db host" }),
        port: numeric({ summary: "db port", default: 5432 }),
        user: string({ summary: "db user" }),
        password: string({ summary: "db password" }),
      },
      { sources: [pullSource({ pull: () => secretsManager.getSecretValue("prod/db"), interval: 5 * 60_000 })] },
    ),
  },
  { sources: [envSource()] },
);

console.log(`listening on ${cfg.server.host.get()}:${cfg.server.port.get()}`);
// listening on localhost:3000

console.log(`log level: ${cfg.logLevel.get()}`);
// log level: info

// React to changes
cfg.features.experimental.home.promotionalDialog.subscribe((enabled) => {
  console.log(`promotional dialog ${enabled ? "enabled" : "disabled"}`);
});

cfg.features.ui.menuOrientation.subscribe((orientation) => {
  renderMenu({ orientation, collapsed: cfg.features.ui.sidebarCollapsed.get() });
});

// secretsManager rotates prod/db periodically; each pull's fresh password
// reopens the connection pool instead of silently swapping credentials
// underneath one already open.
cfg.database.password.subscribe((password) => {
  reconnectPool({ host: cfg.database.host.get(), port: cfg.database.port.get(), user: cfg.database.user.get(), password });
});

console.log(await cfg.server.tls.cert.get()?.text());
// -----BEGIN CERTIFICATE-----...
```

## Table of contents

- [Install](#install)
- [Guide](#guide)
  - [Field types](#field-types)
  - [Writing a custom `ConfigDescriptor`](#writing-a-custom-configdescriptor)
  - [Nested groups](#nested-groups)
  - [`key` — reading a field from an explicit path](#key--reading-a-field-from-an-explicit-path)
  - [`load` — `create()` that defaults to `envSource()`](#load--create-that-defaults-to-envsource)
  - [TypeScript inference](#typescript-inference)
    - [Shape fields](#shape-fields)
  - [`Source` — building a custom source](#source--building-a-custom-source)
  - [`envSource` — environment variables](#envsource--environment-variables)
  - [`fetchSource` — a JSON endpoint over HTTP](#fetchsource--a-json-endpoint-over-http)
  - [`sseSource` — live updates over Server-Sent Events](#ssesource--live-updates-over-server-sent-events)
  - [`fileSource` — a local `.json` or `.env` file](#filesource--a-local-json-or-env-file)
  - [`pullSource` — calling a function on an interval](#pullsource--calling-a-function-on-an-interval)
  - [`shellSource` — running a command](#shellsource--running-a-command)
  - [`literalSource` — a static value](#literalsource--a-static-value)
  - [Reacting to changes — restarting a periodic task](#reacting-to-changes--restarting-a-periodic-task)
  - [`useConfig` — reading a field in React](#useconfig--reading-a-field-in-react)
  - [Closing a config tree](#closing-a-config-tree)
- [Documentation](#documentation)

## Install

```sh
npm install @jondotsoy/configs
```

## Guide

### Field types

A field's `type` is `"string"`, `"number"`, `"boolean"`, `"url"`, `"choice"`, or `"shape"`. The first
three coerce and validate primitives (numeric/boolean-ish strings, an optional `pattern` for
strings). `"url"` parses a string into a `URL` instance, throwing a `ConfigError` if it isn't a
valid one. `"choice"` accepts only one of a fixed list of strings, rejecting anything else.
`"shape"` hands the raw value to a `schema` you provide — anything with a `parse(value: unknown): T`
method, which is exactly the shape `zod`, `valibot`, and most other validation libraries already
export — so there's no dependency on any specific one.

> [!WARNING]
> **Writing a field as an object literal — `{ type: "string", ... }` and friends — is
> deprecated.** It still works exactly as documented below (nothing breaks, nothing is removed),
> but it now logs a one-time `console.warn` and its `Field*Schema` types carry `@deprecated` tags.
> Use `string()`, `numeric()`, `boolean()`, `url()`, `choice()`, or `shape()` instead — same
> options, same inference, just without repeating `type` yourself. See the next section.

```ts
import { create, shape } from "@jondotsoy/configs";
import { z } from "zod";

const cfg = await create(
  {
    jwt: shape({ schema: z.object({ issuer: z.string(), ttl: z.number() }) }),
  },
  { sources: [/* ... */] },
);

// cfg.jwt.get() is typed as { issuer: string; ttl: number } | null — inferred from `schema.parse`'s
// return type, no manual annotation needed.
```

`string()`, `numeric()`, `boolean()`, `url()`, `choice()`, and `shape()` are the **recommended** way
to write the field schemas above, superseding the object-literal form — `numeric({ default: 3000
})` is exactly `{ type: "number", default: 3000 }`, just without repeating `type` yourself. Each
returns a `ConfigDescriptor` instance (also exported, for anyone writing a `numeric(...):
ConfigDescriptor<number>` helper of their own) instead of a plain object, but it resolves and
infers identically either way. They accept the same options as their object-literal form
(`summary`, `required`, `freeze`, `default`, `key`, `pattern` for `string()`, `options` for
`choice()`, and `schema` for `shape()`):

```ts
import { create, boolean, choice, numeric, shape, string, url } from "@jondotsoy/configs";
import { z } from "zod";

const cfg = await create(
  {
    port: numeric({ summary: "HTTP port", default: 3000 }),
    host: string({ summary: "bind host", pattern: /^[\w.-]+$/, default: "localhost" }),
    debug: boolean({ summary: "enable verbose logging", default: false }),
    databaseUrl: url({ summary: "database connection string" }),
    logLevel: choice({ summary: "log verbosity", options: ["debug", "info", "warn", "error"], default: "info" }),
    jwt: shape({ schema: z.object({ issuer: z.string(), ttl: z.number() }) }),
  },
  { sources: [/* ... */] },
);

// cfg.databaseUrl.get() is typed as URL | null — a valid URL string is parsed into an instance,
// an invalid one throws a ConfigError.
// cfg.logLevel.get() is typed as "debug" | "info" | "warn" | "error" — narrowed by the `default`,
// and rejecting (via ConfigError) any value outside `options`.
// cfg.jwt.get() is typed as { issuer: string; ttl: number } | null — inferred from `schema.parse`'s
// return type.
```

A value that fails to parse doesn't take down the whole config tree by default — data comes from
sources outside this package's control, so a `schema.parse` failure (or, with no `schema`, any
non-object value) is logged via `console.error` and the field resolves to `null`, same as a source
that simply doesn't have it. Set `required: true` to escalate that failure into a thrown
`ConfigError` instead:

```ts
const cfg = await create(
  { jwt: shape({ schema: z.object({ issuer: z.string() }), required: true }) },
  { sources: [/* a source publishing an invalid jwt throws instead of logging */] },
);
```

`schema` itself is optional — `shape()` alone just passes the raw value through
as-is, rejecting (per the same log-or-throw rule above) anything that isn't an object:

```ts
const cfg = await create({ metadata: shape() }, { sources: [/* ... */] });
// cfg.metadata.get() is typed as unknown | null
```

A schema can also be used directly as a shape entry, skipping `shape({ schema })`:

```ts
const cfg = await create({ port: z.number() }, { sources: [/* ... */] });
// cfg.port.get() is typed as number | null — same as { port: shape({ schema: z.number() }) }
```

This shorthand has no room for `summary`/`required`/`freeze`/`default` — so a bad value here
always logs and resolves to `null`. Reach for `shape({ schema, ... })` when you need `required: true`
(or any of the others).

`type` can also just be omitted — `{ schema: z.number() }` behaves exactly like
`shape({ schema: z.number() })`, `required` included:

```ts
const cfg = await create(
  { port: { schema: z.number(), required: true } },
  { sources: [/* ... */] },
);
// same as { port: shape({ schema: z.number(), required: true }) }
```

Neither of these two type-less shorthands (a bare schema, or `{ schema }` with no `type`) is
affected by the deprecation above — only the *tagged* object-literal form (`{ type: "...", ... }`)
is deprecated, since that's the one `string()`/`numeric()`/`boolean()`/`url()`/`shape()` replace.

### Writing a custom `ConfigDescriptor`

`string()`, `numeric()`, `boolean()`, `url()`, `choice()`, and `shape()` all build the same kind of
object — a `ConfigDescriptor` — and that's the whole extension point: any shape entry that's a
`ConfigDescriptor` gets the same treatment from `create()`/`load()`, whether it came from one of
these builders or you built it yourself.

**The role `create()` plays**, for every `ConfigDescriptor`-backed field, regardless of who built
it: it works out the field's path (its own nesting in the shape tree, or `.key` when set — see
[`key`](#key--reading-a-field-from-an-explicit-path) above), builds one `Store` holding whatever
raw value the sources currently publish there (merged across sources, re-resolved live as they
change), and hands that `Store` to the descriptor's `parse(rawStore, path)`. `create()` never
inspects the raw value itself past that merge — coercing it into whatever the field's `.get()`
should return is entirely the descriptor's job. What `parse()` returns (`Promise<{ store }>`)
becomes the field: `.get()`/`.subscribe()`/`.listen()` all read from that `store`.

The simplest way to build one is `new ConfigDescriptor(type, parser, options)` directly — `type`
is just a label (any string; only the built-ins' own labels are special), `parser` is a
`(raw: unknown, path: string[]) => T` function doing the actual coercion/validation (throw a
`ConfigError` to reject a value), and `options` is a plain object that can carry a `key` (same
`string | string[]` explicit-path override every built-in field type accepts) plus a `default`
used whenever no source has the field. This already gets you everything `numeric()`/`string()`/etc.
get for free — including a field that's correct the moment it's first read, no different from a
built-in one:

```ts
import { ConfigDescriptor, create, type Parser } from "@jondotsoy/configs";
import { envSource } from "@jondotsoy/configs/sources/env";

function csv(options: { key?: string | string[]; default?: string[] } = {}) {
  const parseCsv: Parser<string[]> = (raw, path) => {
    if (typeof raw !== "string") throw new Error(`Expected a comma-separated string at "${path.join(".")}"`);
    return raw.split(",").map((s) => s.trim());
  };
  return new ConfigDescriptor("csv", parseCsv, options);
}

// ALLOWED_ORIGINS=a.com, b.com, c.com
const cfg = await create(
  { allowedOrigins: csv({ key: "ALLOWED_ORIGINS", default: [] }) },
  { sources: [envSource()] },
);

cfg.allowedOrigins.get();
// ["a.com", "b.com", "c.com"]
```

You don't need to extend the class or reach for `CONFIG_DESCRIPTOR_TAG` for this — `new
ConfigDescriptor(...)` already carries the internal tag `create()` uses to recognize it, same as
every built-in field type.

The tag itself (`CONFIG_DESCRIPTOR_TAG`, also exported) is only there for the rarer case of
writing the whole thing by hand instead of constructing the class — say, to avoid importing it
across an unusual bundling setup. The contract is the same three things: the tag symbol set to
`true`, a `key` if you need one, and a `parse(rawStore, path?)` method returning `Promise<{ store
}>` yourself:

```ts
import { CONFIG_DESCRIPTOR_TAG, Store, create } from "@jondotsoy/configs";
import { envSource } from "@jondotsoy/configs/sources/env";

function csv(options: { key?: string | string[] } = {}) {
  const parse = (raw: unknown) => (typeof raw === "string" ? raw.split(",").map((s) => s.trim()) : []);

  return {
    [CONFIG_DESCRIPTOR_TAG]: true as const,
    key: options.key,
    async parse(rawStore: Store<unknown>) {
      const store = new Store<string[]>(parse(rawStore.get()));
      rawStore.listen((raw) => store.set(parse(raw)));
      return { store };
    },
  };
}
```

The one thing this hand-written form gives up: a plain object like this has no synchronous
`parser` `create()` can call directly, so — unlike `new ConfigDescriptor(...)` above — the field
reads `null` until this `parse()`'s own promise settles (usually within a microtask, so it's
already resolved by the time you'd normally read it, but a bare `.get()` called immediately after
`create()` can still see the placeholder). Prefer `.subscribe()` over a one-off `.get()` right
after `create()` if you go this route — it fires again the moment the real value lands.

### Nested groups

A shape property can be a plain object instead of wrapping it in `create({...})` — it's treated as
an implicit nested group, sharing the parent's sources exactly like `server: create({...})` with no
`options` does:

```ts
import { create, numeric, string } from "@jondotsoy/configs";
import { envSource, mapKey } from "@jondotsoy/configs/sources/env";

// SERVER_PORT=3000 SERVER_HOST=localhost
const cfg = await create(
  {
    server: {
      port: numeric({ summary: "HTTP port", default: 3000 }),
      host: string({ summary: "bind host", default: "localhost" }),
    },
  },
  { sources: [envSource({ mapKey: mapKey.snakeCase() })] },
);

cfg.server.port.get();
// 3000
```

This is just a shorthand for `server: create({ port: numeric(...), host: string(...) })` — it never
carries `sources` of its own (there's no `options` argument to give it any), so, like any
non-owning nested group, it always resolves against whatever sources the enclosing `create()` call
was given.

### `key` — reading a field from an explicit path

By default a field reads from its own position in the shape tree — `server.port`'s path is
`["server", "port"]`. Set `key` (a string, or a `string[]` for a multi-segment path) to read from an
explicit path instead, bypassing the field's nesting entirely. This is what lets a flat `envSource()`
(the identity mapping, `"PORT" => ["PORT"]`) feed a nested shape directly:

```ts
import { create, numeric, string } from "@jondotsoy/configs";
import { envSource } from "@jondotsoy/configs/sources/env";

// PORT=3000 HOST=localhost
const cfg = await create(
  {
    server: {
      port: numeric({ summary: "HTTP port", default: 3000, key: "PORT" }),
      host: string({ summary: "bind host", default: "localhost", key: "HOST" }),
    },
  },
  { sources: [envSource()] },
);

cfg.server.port.get();
// 3000 — read from the source's top-level "PORT", not "server.port"
```

`key` also works on a top-level (non-nested) field — it's only useful there to alias a field to a
differently-named source key. Combined with `url()`, this is a common way to pull a connection
string straight out of an env var into a nested group:

```ts
import { create, url } from "@jondotsoy/configs";
import { envSource } from "@jondotsoy/configs/sources/env";

// DATABASE_URL=postgres://user:pass@localhost:5432/app
const cfg = await create(
  {
    datasource: {
      uri: url({ key: "DATABASE_URL" }),
    },
  },
  { sources: [envSource()] },
);

cfg.datasource.uri.get()?.hostname;
// "localhost"
```

### `load` — `create()` that defaults to `envSource()`

`load(shape, options?)` is identical to `create(shape, options?)`, except its `options.sources`
defaults to `[envSource()]` instead of `[]`. Reaching for env vars is common enough that
`load(shape)` alone — no `options` at all — reads straight from `process.env`:

```ts
import { load, numeric } from "@jondotsoy/configs";

// PORT=8080
const cfg = await load({
  server: {
    port: numeric({ key: "PORT" }),
  },
});

cfg.server.port.get();
// 8080
```

Passing an explicit `sources` array overrides the `envSource()` default entirely — it isn't merged
with it — so `load()` then behaves exactly like `create()`:

```ts
import { load, numeric } from "@jondotsoy/configs";
import { fetchSource } from "@jondotsoy/configs/sources/fetch";

const cfg = await load(
  { promoService: numeric({ default: 0 }) },
  { sources: [fetchSource({ url: "https://example.com/features" })] },
);
// same as create({ promoService: numeric({ default: 0 }) }, { sources: [fetchSource(...)] })
```

### TypeScript inference

Every field's type is derived from its schema literal — `type: "number"` gives you a `number`,
`{ schema: z.object(...) }` gives you whatever `schema.parse` returns — with no manual annotation.
The only thing that changes whether `null` is in the type is **whether the field has a `default`**:

```ts
const cfg = await create({ port: numeric() }, { sources: [/* ... */] });
const port = cfg.port.get();
//    ^? const port: number | null

const cfg2 = await create({ port: numeric({ default: 3000 }) }, { sources: [/* ... */] });
const port2 = cfg2.port.get();
//    ^? const port2: number
```

`required: true` does **not** narrow the type — it only escalates a runtime failure (a value that
fails validation) into a thrown `ConfigError`. Data comes from sources this package doesn't
control, so a `required` field with no `default` can still end up with nothing from any source and
resolve to `null` — the type stays `T | null` to reflect that honestly, `required` or not:

```ts
const cfg = await create({ port: numeric({ required: true }) }, { sources: [/* ... */] });
const port = cfg.port.get();
//    ^? const port: number | null   (required doesn't remove `null` — only `default` does)
```

Combine `required: true` with a `default` to get a non-`null` type *and* a hard failure on bad
data instead of a silent fallback:

```ts
const cfg = await create(
  { port: numeric({ required: true, default: 3000 }) },
  { sources: [/* a source publishing an invalid port throws instead of falling back */] },
);
const port = cfg.port.get();
//    ^? const port: number
```

`await`ing `create(...)` isn't what changes the type either — `create(...)`'s return value
(`PendingConfigNode`) already exposes every field with its fully inferred type, synchronously,
before any source has resolved; `await` only waits for the first snapshot to land, then resolves
to a plain `ConfigNode` with the same field types (see [Field types](#field-types) for how a field
without `type` — a bare `schema` — is inferred, and [Closing a config tree](#closing-a-config-tree)
for what `await`ing actually buys you):

```ts
const pending = create({ port: numeric({ default: 3000 }) }, { sources: [/* ... */] });
pending.port.get();
//      ^? number  (already available before awaiting)

const cfg = await pending;
cfg.port.get();
//  ^? number  (same type, now backed by the first resolved snapshot)
```

A nested group (`server: create({ port: numeric() })` embedded in a parent shape) infers
the same way, recursively — `cfg.server.port.get()` is `number | null` unless `server`'s `port`
has a `default`.

#### Shape fields

A `"shape"` field's type isn't declared anywhere — it's extracted from whatever `schema` you pass,
by inferring `schema.parse`'s return type. The same `default`-drives-`null` rule from above still
applies: no `default` means the type is `T | null` (a bad or missing value resolves to `null` at
runtime — see [Field types](#field-types)), a `default` means the type is `T`:

```ts
import { create, shape } from "@jondotsoy/configs";
import { z } from "zod";

const cfg = await create(
  { jwt: shape({ schema: z.object({ issuer: z.string(), ttl: z.number() }) }) },
  { sources: [/* ... */] },
);
const jwt = cfg.jwt.get();
//    ^? const jwt: { issuer: string; ttl: number } | null

const cfg2 = await create(
  {
    jwt: shape({
      schema: z.object({ issuer: z.string(), ttl: z.number() }),
      default: { issuer: "auth0", ttl: 3600 },
    }),
  },
  { sources: [/* ... */] },
);
const jwt2 = cfg2.jwt.get();
//    ^? const jwt2: { issuer: string; ttl: number }
```

`schema` only needs to be `Parseable<T>` — an object exposing `parse(value: unknown): T` — so
inference works the same with `zod`, `valibot`, or a hand-rolled validator; the package itself has
no dependency on any of them. It comes from `schema.parse`'s return type, not from the value you
pass into `parse()`, so a schema whose `parse` narrows or transforms (e.g. a zod `.transform(...)`)
is inferred as its output type:

```ts
const parity = { parse: (value: unknown) => (Number(value) % 2 === 0 ? "even" : "odd") };
const cfg = await create({ n: shape({ schema: parity }) }, { sources: [/* ... */] });
const n = cfg.n.get();
//    ^? const n: "even" | "odd" | null
```

Omitting `schema` entirely (`shape()` alone) passes the raw value through untyped — the field is
`unknown`, whether or not a source ever has it. `unknown | null` collapses to `unknown` in
TypeScript, so there's no `| null` to see in the type here, unlike every other field:

```ts
const cfg = await create({ metadata: shape() }, { sources: [/* ... */] });
const metadata = cfg.metadata.get();
//    ^? const metadata: unknown
```

Both type-less shorthands for a shape field — a bare schema used directly (`port: z.number()`) and
`{ schema: z.number() }` with no `type` — infer identically to `shape({ schema: z.number() })`.
The bare-schema shorthand just has no room for `default`, so it's always `T | null`:

```ts
const cfg = await create({ port: z.number() }, { sources: [/* ... */] });
const port = cfg.port.get();
//    ^? const port: number | null   (no `default` slot on this shorthand)

const cfg2 = await create({ port: { schema: z.number(), default: 3000 } }, { sources: [/* ... */] });
const port2 = cfg2.port.get();
//    ^? const port2: number   (untagged form still has `default`/`required`, so this narrows)
```

### `Source` — building a custom source

The building block behind `envSource`, `fetchSource`, `sseSource`, `fileSource`, `pullSource`,
`shellSource`, and `literalSource`. It takes an
object with `start(control)` and an optional `close()`, mirroring `ReadableStream`'s
`UnderlyingSource`: `start` runs once and pushes snapshots via `control.set(value)`, while `close`
— called from within `start` via `control.close()`, or from the outside via the `Source`'s own
`close()` — is where you release whatever `start` set up, like a timer or an in-flight request.

```ts
import { Source } from "@jondotsoy/configs";

function pollingSource(url: string, intervalMs: number): Source<{ port: number }> {
  let timer: ReturnType<typeof setInterval>;

  return new Source({
    async start(control) {
      const poll = async () => control.set((await (await fetch(url)).json()) as { port: number });
      await poll();
      timer = setInterval(poll, intervalMs);
    },
    close() {
      clearInterval(timer);
    },
  });
}
```

An optional `reduce(incoming, previous)` runs every `control.set(incoming)` call through it (along
with the last published value, `null` before the first `set()`) instead of publishing `incoming`
as-is — so a source whose `start()` only ever produces a partial patch (like `sseSource`, which
hands `control.set` one SSE message at a time) can publish the merged result without keeping its
own accumulator variable around:

```ts
import { Source } from "@jondotsoy/configs";

const source = new Source<{ port?: number; host?: string }>({
  start(control) {
    control.set({ port: 3000 });   // -> reduce({ port: 3000 }, null)
    control.set({ host: "x" });    // -> reduce({ host: "x" }, { port: 3000 })
  },
  reduce: (patch, previous) => ({ ...(previous ?? {}), ...patch }),
});
// published: { port: 3000, host: "x" }
```

### `envSource` — environment variables

Reads `process.env` (or any object you pass as `env`) into the config tree. `mapKey` decides how
each key maps to a path; the default is the identity mapping, `"FOO_TAR" => ["FOO_TAR"]`.

**Options (`EnvSourceOptions`):**

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `env` | `Record<string, string \| undefined>` | `process.env` | The env vars to read. |
| `prefix` | `string` | — | Only keys starting with `prefix` are included; the prefix is stripped before `mapKey` runs. |
| `suffix` | `string` | — | Only keys ending with `suffix` are included; the suffix is stripped before `mapKey` runs. |
| `mapKey` | `EnvKeyMapper` | identity mapping (`"FOO_TAR" => ["FOO_TAR"]`) | Maps each (already prefix/suffix-trimmed) key to a path into the config tree. |

```ts
import { envSource } from "@jondotsoy/configs/sources/env";

// APP_PORT=3000 OTHER_VAR=x → { port: "3000" } (prefix stripped, OTHER_VAR excluded)
const source = envSource({ prefix: "APP_", mapKey: (key) => [key.toLowerCase()] });
```

Built-in strategies live under the `mapKey` namespace, each a factory returning an `EnvKeyMapper`:

- **`mapKey.snakeCase(options?)`** — splits a `SCREAMING_SNAKE_CASE` key into a lowercase nested
  path on `separator` (default `"_"`): `"FOO_TAR" => ["foo", "tar"]`. Pass a different `separator`
  (e.g. `"__"`) to keep a single underscore inside a segment from splitting it:
  `mapKey.snakeCase({ separator: "__" })` maps `"API_KEY_V2__ENABLED"` to
  `["api_key_v2", "enabled"]` instead of splitting on every `_`.
- **`mapKey.identity()`** — passes each key through unchanged, as a single-segment path:
  `"FOO_TAR" => ["FOO_TAR"]`. Same as omitting `mapKey`, spelled out explicitly.
- **`mapKey.camelCase()`** — maps a key to a single camelCase segment instead of nesting it:
  `"FOO_TAR" => ["fooTar"]`.
- **`mapKey.lookup(table, fallback?)`** — maps specific keys to explicit paths via a
  `Record<string, string[]>` lookup table; a key not in `table` falls back to `fallback` (default:
  the identity mapping). Handy when most keys follow no consistent naming, or when a few need an
  exception to whatever strategy the rest use.

```ts
import { envSource, mapKey } from "@jondotsoy/configs/sources/env";

// SERVER_PORT=3000 SERVER_HOST=localhost → { server: { port: "3000", host: "localhost" } }
const source = envSource({ mapKey: mapKey.snakeCase() });

// PORT=3000 HOST=localhost → { server: { port: "3000" }, HOST: "localhost" }
const source2 = envSource({ mapKey: mapKey.lookup({ PORT: ["server", "port"] }) });
```

You can also pass your own `EnvKeyMapper` instead of a built-in strategy — it's just a
`(key: string) => string[]` function:

```ts
import { envSource } from "@jondotsoy/configs/sources/env";

const source = envSource({
  mapKey: (key) => (key === "PORT" ? ["server", "port"] : [key]),
});
```

### `fetchSource` — a JSON endpoint over HTTP

Fetches a JSON snapshot from `url` (with `method` and `headers`, if needed). Only JSON is
supported — a non-JSON `Content-Type` still gets a fallback parse attempt. `attempts` retries the
download on a network error or a non-`ok` response (default `1`, no retry). If the download never
succeeds, or the body isn't valid JSON, it logs a `console.error` and leaves the store empty
instead of throwing.

`pollingInterval` controls whether `fetchSource` keeps re-fetching `url` over time. **It's off by
default** (`false`): `fetchSource` fetches `url` exactly once and closes, same as if the option
were never set. Pass a number of milliseconds to turn polling on — `fetchSource` then keeps
fetching `url` on that interval (each round still retried up to `attempts` times), updating the
store on every successful fetch, until the `Source` is closed. A failed round after the first one
is logged and skipped, without closing the source or stopping the polling.

Two options let the server drive that polling instead of a fixed interval:

- `followCacheControl` reads the response's `Cache-Control` header to decide when to fetch again:
  `max-age=<seconds>` schedules the next round that many seconds out, `no-store`/`no-cache`
  schedules it immediately, and a response without either falls back to `pollingInterval` for that
  round. Set alone (`pollingInterval` left `false`), it starts polling purely off what the server
  reports.
- `useConditionalRequests` — **on by default** — sends every round after the first as a
  conditional GET, echoing the previous response's `ETag`/`Last-Modified` back as
  `If-None-Match`/`If-Modified-Since`. A `304 Not Modified` reply is accepted and skipped, leaving
  the store at its last published value instead of overwriting it with an empty body. Set it to
  `false` to always send a plain, unconditional GET.

They combine: a `304`'s own `Cache-Control` header still drives `followCacheControl`'s next delay.

**Options (`FetchSourceOptions<T>`):**

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | `string \| URL` | *required* | The endpoint to fetch. |
| `method` | `string` | `"GET"` | HTTP method for the request. |
| `headers` | `RequestInit["headers"]` | — | Request headers, passed through to `fetch` as-is. |
| `body` | `RequestInit["body"]` | — | Request body, passed through to `fetch` as-is (e.g. a JSON string, `FormData`, `Blob`). |
| `signal` | `AbortSignal` | — | Aborts the in-flight fetch (and stops retrying it) when it fires. Covers a single round only — with `pollingInterval` set, later rounds still run; close the `Source` itself to stop polling entirely. |
| `mode` | `RequestInit["mode"]` | — | Passed through to `fetch` as-is. |
| `cache` | `RequestInit["cache"]` | — | Passed through to `fetch` as-is. |
| `redirect` | `RequestInit["redirect"]` | — | Passed through to `fetch` as-is. |
| `credentials` | `HttpFetchCredentials` | — | Sets the `Authorization` header up front instead of adding it to `headers` yourself: `{ basic: { username, password } }` sends `Basic <base64>`; `{ bearer: { token } }` sends `Bearer <token>`. |
| `attempts` | `number` | `1` (no retry) | Attempts to download the data before giving up, on a network error or a non-`ok` response. |
| `bodyParser` | `(response: Response) => Promise<T>` | `(res) => res.json()` | Turns the fetched `Response` into `T`. |
| `acceptStatus` | `(statusCode: number) => boolean` | 2xx: `(status) => status >= 200 && status < 300` | Decides whether a response's status code counts as accepted. A rejected status stops retrying immediately, same as a `bodyParser` failure. |
| `pollingInterval` | `number \| false` | `false` (off) | Milliseconds between fetches. `false` fetches `url` once and closes; a number keeps fetching on that interval (each round retried up to `attempts` times) until the `Source` is closed. |
| `followCacheControl` | `boolean` | `false` | Follows the response's `Cache-Control` header to decide when to fetch again, instead of (or as a fallback for) `pollingInterval`. `max-age=<seconds>` schedules the next fetch that many seconds out; `no-store`/`no-cache` schedules it immediately. Can be set alone to start polling purely off what the server reports. |
| `useConditionalRequests` | `boolean` | `true` (on) | Sends a conditional GET on every round after the first, echoing the previous response's `ETag`/`Last-Modified` back as `If-None-Match`/`If-Modified-Since`. A `304 Not Modified` reply is accepted and skipped, leaving the store unchanged. Set to `false` for a plain, unconditional GET every round. |
| `treePath` | `string[]` | `[]` (whole body) | Selects a subtree of the fetched body to use as the config tree, e.g. `["containers", "settings"]`. Applied on every round, including polled ones. Same behavior as `fileSource`'s option of the same name. |
| `reduce` | `(incoming: T, previous: T \| null) => T` | publishes `incoming` as-is (full replace) | Combines each successful fetch with the previously published value instead of replacing it outright. Especially useful with `pollingInterval`, when a later round's response is a partial update. Receives the `treePath`-selected body. |

```ts
import { fetchSource } from "@jondotsoy/configs/sources/fetch";
import { Temporal } from "temporal-polyfill";

const source = fetchSource<{ port: number }>({
  url: "https://config-service.internal/app",
  method: "GET",
  headers: { authorization: `Bearer ${process.env.CONFIG_TOKEN}` },
  attempts: 3,
  // Off by default — pass a number of milliseconds to poll instead of fetching once.
  pollingInterval: Temporal.Duration.from({ seconds: 30 }).total("milliseconds"),
});
```

```ts
import { fetchSource } from "@jondotsoy/configs/sources/fetch";

// each round only returns the fields that changed — merge into what's already there
const source = fetchSource<Record<string, unknown>>({
  url: "https://config-service.internal/app/changes",
  pollingInterval: 30_000,
  reduce: (incoming, previous) => ({ ...(previous ?? {}), ...incoming }),
});
```

```ts
import { fetchSource } from "@jondotsoy/configs/sources/fetch";

const source = fetchSource<{ port: number }>({
  url: "https://config-service.internal/app",
  credentials: { bearer: { token: process.env.CONFIG_TOKEN! } },
  acceptStatus: (status) => status === 200,
});
```

```ts
import { fetchSource } from "@jondotsoy/configs/sources/fetch";

// let the server drive the polling cadence instead of a fixed interval; useConditionalRequests
// is on by default, so a 304 costs no bandwidth and doesn't touch the store
const source = fetchSource<{ port: number }>({
  url: "https://config-service.internal/app",
  followCacheControl: true,
  pollingInterval: 60_000, // fallback for a round whose response has no Cache-Control
});
```

### `sseSource` — live updates over Server-Sent Events

Connects to an SSE endpoint (`url`, `method`, `headers`). Every message tries to parse as JSON and,
if it's a plain object, is applied as a **patch** on top of what was already received — fields add
up and overwrite, the tree is never replaced wholesale by default. Set `overwrite: true` (or pass
a custom `reduce`) to replace the tree wholesale with each message instead:

**Options (`SseSourceOptions`):** the same request-shaping surface as `fetchSource`, minus
`bodyParser` and `pollingInterval` (a persistent connection, not a repeated request), plus
`attempts` retries only the initial connection — once the stream is open, a dropped connection
closes the source rather than reconnecting.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | `string \| URL` | *required* | The SSE endpoint to connect to. |
| `method` | `string` | `"GET"` | HTTP method for the request. |
| `headers` | `RequestInit["headers"]` | — | Request headers, passed through to `fetch` as-is. |
| `body` | `RequestInit["body"]` | — | Request body, passed through to `fetch` as-is (e.g. a JSON string, `FormData`, `Blob`). |
| `signal` | `AbortSignal` | — | Aborts the connection (and stops retrying it) when it fires. Independent of the `Source`'s own `close()`, which also aborts the connection. |
| `mode` | `RequestInit["mode"]` | — | Passed through to `fetch` as-is. |
| `cache` | `RequestInit["cache"]` | — | Passed through to `fetch` as-is. |
| `redirect` | `RequestInit["redirect"]` | — | Passed through to `fetch` as-is. |
| `credentials` | `HttpFetchCredentials` | — | Sets the `Authorization` header up front instead of adding it to `headers` yourself: `{ basic: { username, password } }` sends `Basic <base64>`; `{ bearer: { token } }` sends `Bearer <token>`. |
| `attempts` | `number` | `1` (no retry) | Attempts to establish the connection before giving up. |
| `acceptStatus` | `(statusCode: number) => boolean` | 2xx: `(status) => status >= 200 && status < 300` | Decides whether a response's status code counts as accepted. |
| `reduce` | `(incoming: T, previous: T \| null) => T` | shallow patch-merge (see below) | Combines each parsed message with the tree accumulated so far. Overrides the default patch-merge (and `overwrite`) entirely — a custom `reduce` must do its own merging if that's still wanted. |
| `overwrite` | `boolean` | `false` | Replaces the tree wholesale with each parsed message instead of shallow patch-merging it. Ignored when `reduce` is set. |

```ts
import { sseSource } from "@jondotsoy/configs/sources/sse";

const source = sseSource<{ port?: number; host?: string }>({
  url: "https://config-service.internal/app/events",
});

// message: {"port":3000}       => Store<{ port: 3000 }>
// message: {"host":"10.0.0.1"} => Store<{ port: 3000, host: "10.0.0.1" }>
```

```ts
import { sseSource } from "@jondotsoy/configs/sources/sse";

// each message is a full snapshot, not a patch — replace instead of merging
const source = sseSource<{ port: number }>({
  url: "https://config-service.internal/app/events",
  overwrite: true,
});

// message: {"port":3000}       => Store<{ port: 3000 }>
// message: {"host":"10.0.0.1"} => Store<{ host: "10.0.0.1" }>  (port is gone)
```

```ts
import { sseSource } from "@jondotsoy/configs/sources/sse";

const source = sseSource<{ port?: number; host?: string }>({
  url: "https://config-service.internal/app/events",
  credentials: { bearer: { token: process.env.CONFIG_TOKEN! } },
  attempts: 3,
});
```

A message that isn't valid JSON, or doesn't parse to a plain object, is logged via
`console.error` and skipped — it never resets what was already received.

Opening the source waits for the first message (so the `Store` you get back already has data,
not `null`), then keeps the connection alive in the background, applying further messages as
patches until the resource closes the stream.

### `fileSource` — a local `.json` or `.env` file

Reads a config tree from `path`, parsed by its extension: `.json` or `.env` (matched by extension,
or by the bare `.env` filename itself — a `.env` file always parses to a flat string map, one
entry per `KEY=VALUE` line, blank lines and `#`-comments skipped; anything else is parsed as JSON).
`watch` defaults to `true`: the file is re-read and the store updated live on every change, using
`fs.watch` under the hood; `watch: false` reads it once. Pass `watch: { interval: <ms> }` instead
to poll the file on a timer and re-read it unconditionally rather than relying on `fs.watch` —
useful where `fs.watch` doesn't fire reliably (e.g. some network mounts, containers, or editors
that write via rename). A missing file or a parse failure (including on a later watched or polled
change) is logged via `console.error` and leaves the store empty instead of throwing — a parse
error on a later change keeps the last good value instead.

`fileSource(path, options?)` takes `path` (a `string` or a `file:` `URL`, e.g.
`new URL("./config.json", import.meta.url)`) as its first argument, and the following as its
second (`FileSourceOptions`):

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `watch` | `boolean \| { interval: number }` | `true` | Republishes the config tree whenever the file changes on disk, via `fs.watch`. `false` reads it once and closes. `{ interval: <ms> }` polls the file every `interval` milliseconds and re-reads it unconditionally, instead of using `fs.watch`. |
| `treePath` | `string[]` | `[]` (whole file) | Selects a subtree of the parsed file to use as the config tree, e.g. `["containers", "settings"]`. |
| `format` | `"json" \| "env"` | detected from `path`'s extension (`.env`, `"json"` otherwise) | Picks which built-in parser to use, overriding extension-based detection. Ignored once `parser` is set. |
| `parser` | `(buffer: Uint8Array) => unknown` | decodes as UTF-8 and parses per `format`/detected format | Overrides the default parsing entirely — receives the file's raw bytes and returns the parsed tree, so `fileSource` can support formats it doesn't parse itself (like YAML). |
| `reduce` | `(incoming: T, previous: T \| null) => T` | publishes `incoming` as-is (full replace) | Combines each read with the previously published value instead of replacing it outright. Especially useful with `watch`, when a later read is a partial update. Receives the `treePath`-selected tree. |

```ts
import { fileSource } from "@jondotsoy/configs/sources/file";

const source = fileSource<{ port: number; host: string }>("./config.json");
// config.json: { "port": 3000, "host": "localhost" }
```

`format` picks the built-in parser explicitly (`"json"` or `"env"`) instead of relying on `path`'s
extension — handy for an extensionless path:

```ts
const source = fileSource("./config", { format: "env" });
```

`watch: { interval: <ms> }` polls the file instead of using `fs.watch`, for filesystems (e.g. some
network mounts) where `fs.watch` doesn't fire reliably:

```ts
import { fileSource } from "@jondotsoy/configs/sources/file";

const source = fileSource<{ port: number }>("./config.json", {
  watch: { interval: 2000 },
});
```

`parser` overrides the default parsing entirely: it receives the file's raw bytes and its return
value is used as the parsed tree, so `fileSource` can support formats it doesn't parse itself
(like YAML) without a hard dependency on a YAML library. `format` is ignored once `parser` is set:

```ts
import { fileSource } from "@jondotsoy/configs/sources/file";
import YAML from "yaml";

const source = fileSource("./config.yaml", {
  parser: (bytes) => YAML.parse(new TextDecoder().decode(bytes)),
});
```

`treePath` selects a subtree of the parsed file to use as the config tree instead of the whole
thing, e.g. to pull just `containers.settings` out of a larger file shared with other tools:

```ts
import { fileSource } from "@jondotsoy/configs/sources/file";

// file.json: { "containers": { "settings": { "port": 3000 } }, "metadata": {...} }
const source = fileSource<{ port: number }>("./file.json", {
  treePath: ["containers", "settings"],
});
```

`reduce` combines each read with the previously published value instead of replacing it
outright — handy with `watch` (the default) when the file is only ever appended to with partial
updates rather than rewritten as a full snapshot each time:

```ts
import { fileSource } from "@jondotsoy/configs/sources/file";

const source = fileSource<Record<string, unknown>>("./config.json", {
  reduce: (incoming, previous) => ({ ...(previous ?? {}), ...incoming }),
});
```

### `pullSource` — calling a function on an interval

Calls `pull` and publishes whatever it returns as the next snapshot — once immediately, then again
every `interval` milliseconds until the `Source` is closed. `pull` can be sync or async, so it's a
general-purpose escape hatch for any input that isn't already covered by a built-in source (a
database query, a cloud secrets manager, a gRPC call, ...). A `pull` failure is logged via
`console.error` and swallowed instead of thrown: on the first call this leaves the store empty
(same as `fetchSource`); on a later call it's skipped, keeping the last good value and the polling
running.

**Options (`PullSourceOptions<T>`):**

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `pull` | `() => T \| Promise<T>` | *required* | Called on every round to produce a fresh snapshot. May be sync or async. |
| `interval` | `number` | *required* | Milliseconds between calls to `pull`. |

```ts
import { pullSource } from "@jondotsoy/configs/sources/pull";
import { Temporal } from "temporal-polyfill";

const source = pullSource<{ port: number }>({
  pull: async () => fetchPortFromSomewhere(),
  interval: Temporal.Duration.from({ seconds: 30 }).total("milliseconds"),
});
```

### `shellSource` — running a command

Runs `args` as a child process (via `node:child_process`'s `spawn`) and publishes its parsed stdout as the next
snapshot — handy for pulling config out of a CLI you already trust, like `gh auth token` or a
company-internal secrets tool. By default it decodes stdout as UTF-8 and parses it as JSON, runs
once, and closes; a rejected exit code or a stdout that fails to parse is logged via
`console.error` and swallowed instead of thrown, same as `fetchSource`.

**Options (`ShellSourceOptions<T>`):**

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `cwd` | `string` | current process's cwd | Working directory for the spawned process. |
| `env` | `Record<string, string \| undefined>` | current process's own env | Environment variables for the spawned process. |
| `signal` | `AbortSignal` | — | Kills the in-flight run (and stops retrying it) when it fires. Only covers a single round — with `pollingInterval` set, later rounds still run. |
| `attempts` | `number` | `1` | Runs to attempt before giving up. |
| `stdoutParser` | `(stdout: string) => T \| Promise<T>` | `JSON.parse` | Turns the process's stdout (decoded as UTF-8) into `T`. |
| `acceptExitCode` | `(exitCode: number) => boolean` | `(exitCode) => exitCode === 0` | Decides whether an exit code counts as accepted. |
| `treePath` | `string[]` | `[]` (whole output) | Selects a subtree of the parsed stdout to use as the config tree, same as `fetchSource`'s `treePath`. |
| `pollingInterval` | `number \| false` | `false` | Milliseconds between runs. `false` runs `args` once and closes; a number keeps re-running on that interval (each round retried up to `attempts` times) until the `Source` is closed. |
| `reduce` | `(incoming: T, previous: T \| null) => T` | publishes `incoming` as-is (full replace) | Combines each run's output with the previously published value instead of replacing it outright. Especially useful with `pollingInterval`. |
| `onRun` | `(event: ShellRunEvent) => void` | — | Called once per run (including every polled run) with timing and outcome data. |

```ts
import { shellSource } from "@jondotsoy/configs/sources/shell";

const source = shellSource<{ token: string; expires_at: string }>([
  "gh",
  "auth",
  "token",
  "--format",
  "json",
]);
```

`pollingInterval` keeps re-running `args` — useful for a token that needs periodic refreshing:

```ts
import { shellSource } from "@jondotsoy/configs/sources/shell";

const source = shellSource<{ token: string }>(["gh", "auth", "token", "--format", "json"], {
  pollingInterval: 5 * 60_000, // refresh every 5 minutes
});
```

`stdoutParser` overrides the default JSON parsing — for a command that prints a bare value:

```ts
import { shellSource } from "@jondotsoy/configs/sources/shell";

const source = shellSource<string>(["git", "rev-parse", "HEAD"], {
  stdoutParser: (stdout) => stdout.trim(),
});
```

### `literalSource` — a static value

Publishes a plain, already-in-hand value as a snapshot immediately, then closes. No I/O, no
options — just wraps `value` in a `Source` so it can sit in a `sources` array alongside the rest.
Handy as a static fallback tree (put it last so real sources win), a hardcoded default for a
single environment, or a stand-in source in a test.

**Options:** none — `literalSource(value)` takes only the value to publish, as its single argument.

```ts
import { configs, numeric, string } from "@jondotsoy/configs";
import { envSource, mapKey } from "@jondotsoy/configs/sources/env";
import { literalSource } from "@jondotsoy/configs/sources/literal";

const cfg = await configs.create(
  {
    port: numeric({ required: true }),
    host: string({ required: true }),
  },
  {
    sources: [
      envSource({ mapKey: mapKey.snakeCase() }),
      literalSource({ port: 3000, host: "localhost" }), // fallback if env vars are unset
    ],
  },
);
```

### Reacting to changes — restarting a periodic task

Because every field is a live `Store`, `.subscribe()` is the hook point for keeping something
else in sync with the config — for example, restarting a `setInterval` job whenever its period
changes. This only really happens at runtime with a live source like `sseSource`; an
`envSource` resolves once and never changes:

```ts
import { configs, numeric } from "@jondotsoy/configs";
import { sseSource } from "@jondotsoy/configs/sources/sse";

async function cleanupTempFiles() {
  // ...
}

const cfg = await configs.create(
  {
    service: configs.create({
      cleanupIntervalMs: numeric({ summary: "cleanup interval", default: 60_000 }),
    }),
  },
  { sources: [sseSource({ url: "https://config-service.internal/app/events" })] },
);

let timer: ReturnType<typeof setInterval> | undefined;

const unsubscribe = cfg.service.cleanupIntervalMs.subscribe((intervalMs) => {
  clearInterval(timer);
  timer = setInterval(cleanupTempFiles, intervalMs);
  return () => clearInterval(timer); // runs when `unsubscribe()` is called, not on the next change
});
```

`subscribe` fires immediately with the current value (starting the first timer) and again on every
subsequent change — `clearInterval(timer)` cancels the previous one before `setInterval` starts the
new one, so there's never more than one timer running for this field. The callback's returned
cleanup only fires once, when `unsubscribe()` itself is called, so it's the right place to stop the
last timer for good — it's not a substitute for the `clearInterval` at the top of the callback.

### ⚛️ `useConfig` — reading a field in React

`@jondotsoy/configs/react` exports a `useConfig(store)` hook that subscribes a component to any
field (or nested group) and re-renders it on every update. React is a peer dependency — the hook
only needs it if you actually import this subpath, so it's never pulled into apps that don't use
React:

```tsx
import { configs, boolean } from "@jondotsoy/configs";
import { useConfig } from "@jondotsoy/configs/react";

const cfg = configs.create({ bannerIsActive: boolean({ default: false }) });

function App() {
  const bannerIsActive = useConfig(cfg.bannerIsActive);

  return bannerIsActive ? <Banner /> : null;
}
```

### Closing a config tree

`configs.create(...)` results (and their nested groups) expose `close()`, which closes every
source backing them — for `sseSource`, this aborts the live connection instead of leaving
it open in the background:

```ts
import { configs, numeric } from "@jondotsoy/configs";
import { sseSource } from "@jondotsoy/configs/sources/sse";

const source = sseSource({ url: "https://config-service.internal/app/events" });
const serverConfigs = await configs.create({ port: numeric() }, { sources: [source] });

await serverConfigs.close();
```

It also implements `Symbol.asyncDispose`, so `await using` closes it automatically at the end of
the scope — including when the scope throws:

```ts
import { configs, numeric } from "@jondotsoy/configs";
import { sseSource } from "@jondotsoy/configs/sources/sse";

async function run() {
  await using serverConfigs = await configs.create(
    { port: numeric() },
    { sources: [sseSource({ url: "https://config-service.internal/app/events" })] },
  );

  console.log(serverConfigs.port.get());
  // closed automatically here, no explicit serverConfigs.close() needed
}
```

## Documentation

Further guides live under [`docs/`](./docs):

- [`docs/getting-starter/features.md`](./docs/getting-starter/features.md) —
  portability: isomorphism, and browser/Node.js/Bun support notes.
- [`docs/examples/`](./docs/examples) — runnable-shaped snippets for common
  ways to wire up `@jondotsoy/configs`: a Kubernetes `ConfigMap` reload, a
  `.env`-plus-JSON overlay, a React feature-flag poll, and verifying
  Google-signed JWTs against rotating keys.
- [`docs/develop/check-package.md`](./docs/develop/check-package.md) —
  validating the published package against real Node, Bun, and Deno
  processes.
