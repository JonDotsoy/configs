# Probar el paquete publicado

Esta guía es una prueba sobre **el paquete ya publicado en npm**, no sobre el código
fuente del repo: valida que `@jondotsoy/configs` se instala e importa correctamente
desde **procesos reales de Node, Bun y Deno** — no solo desde `bun test` con
resolución por código fuente — y que el tipado publicado (`dist/**/*.d.ts`) resuelve
correctamente con `tsc --noEmit`. Se usa después de cada `npm publish` (smoke test de
lo que un consumidor nuevo recibe) o al recibir un reporte de un consumidor; también
sirve, con el flujo de tarball local descrito más abajo, para validar cambios antes de
publicarlos.

## Tabla de contenido

- [Sumario](#sumario)
- [Checklist de validación rápida](#checklist-de-validación-rápida)
- [Snippets a validar](#snippets-a-validar)
  - [Caso de uso base: core + subpath `sources/env` + tipado inferido](#caso-de-uso-base-core--subpath-sourcesenv--tipado-inferido)
  - [Caso de uso: verificación exhaustiva de exports (imports del repo)](#caso-de-uso-verificación-exhaustiva-de-exports-imports-del-repo)
  - [Comando de tipado (el que realmente ejercita `dist/`)](#comando-de-tipado-el-que-realmente-ejercita-dist)
- [Estrategia por entorno](#estrategia-por-entorno)
  - [Node](#node)
  - [Bun](#bun)
  - [Deno](#deno)
  - [Bundlers de navegador (`bun build --target browser` / Vite)](#bundlers-de-navegador-bun-build---target-browser--vite)
- [Antes de publicar](#antes-de-publicar)

## Sumario

Casos a probar en cada entorno:

- **Instalación real** de la última versión publicada en npm (`npm add @jondotsoy/configs`
  / `bun add @jondotsoy/configs` / `deno add npm:@jondotsoy/configs`), tal como lo haría
  un consumidor — no resolución desde `src/` ni desde el workspace del monorepo.
- **Import del core**: `import { configs, envSource, ... } from "@jondotsoy/configs"`.
- **Import de subpaths de `sources/*`**: cada entrada pública del mapa `exports` de
  `package.json` — hoy `./sources/env`, `./sources/fetch`, `./sources/sse`,
  `./sources/file`, `./sources/literal` — resuelve de forma independiente.
- **Caso de uso funcional**: `configs.create(...)` con un `envSource()` real, leyendo
  una variable de entorno y devolviendo el valor esperado (no solo que el import no
  explote).
- **Tipado**: los `.d.ts` publicados en `dist/` resuelven y type-checkean con
  `tsc --noEmit` (o `deno check` en Deno) usando el `tsconfig`/resolución que un
  consumidor real de ese entorno usaría — no el `tsconfig.json` interno del repo, que
  asume Bun y es más permisivo.
- **Ejecución en runtime**: además de tipar, el mismo snippet corre y produce el
  resultado esperado en Node, Bun y Deno.
- **Bundling para navegador** (`bun build --target browser` y Vite): el core y
  `sources/env` (que no tocan Node) deben bundlear limpio; `fileSource` (que usa
  `node:fs`) es Node-only y no debe reventar el build, pero sí hay que confirmar cómo
  cada bundler lo trata si termina incluido.

## Checklist de validación rápida

Para un smoke test express (por ejemplo justo después de un `npm publish`), sin
copiar cada snippet a mano — usar el [snippet base](#caso-de-uso-base-core--subpath-sourcesenv--tipado-inferido)
como `test.ts` en cada paso que lo pida:

- [ ] **Node** — `npm add @jondotsoy/configs` en un proyecto limpio, correr el
      snippet base con `node --experimental-strip-types test.ts` y tipar con
      [`tsc --noEmit --module nodenext --moduleResolution nodenext`](#comando-de-tipado-el-que-realmente-ejercita-dist)
      ([detalle](#node)).
- [ ] **Bun** — `bun add @jondotsoy/configs`, `bun run test.ts` y `bunx tsc --noEmit`
      con el `tsconfig.json` de Bun ([detalle](#bun)).
- [ ] **Deno** — `deno add npm:@jondotsoy/configs`, `deno check test.ts` y
      `deno run --allow-env test.ts` ([detalle](#deno)).
- [ ] **Bundler de navegador** — `bun build entry.ts --outdir out --target browser`
      y `vite build` sobre el caso limpio (`configs` + `literalSource`, sin
      `fileSource`); debe bundlear sin error en ambos ([detalle](#bundlers-de-navegador-bun-build---target-browser--vite)).
- [ ] **Subpaths** — al menos un import de `sources/*` (`envSource`, `fetchSource`,
      `sseSource`, `fileSource` o `literalSource`) resuelto desde su propio subpath,
      no solo desde la raíz.
- [ ] **`bun test`** en el repo, en verde, antes de subir la versión
      ([detalle](#antes-de-publicar)).

Cualquier ítem que falle es motivo para no publicar (o para revertir) hasta
entender la causa — ver la sección de cada entorno para el paso a paso completo.

## Snippets a validar

### Caso de uso base: core + subpath `sources/env` + tipado inferido

Este es el snippet de referencia que se reutiliza en los tres entornos (ver
[Estrategia por entorno](#estrategia-por-entorno)). Cubre import del core, import de
un subpath de `sources/*`, un `configs.create(...)` real con `envSource`, y que el
tipo de retorno de `.get()` se infiera correctamente (`number` porque hay `default`,
`string | null` porque no lo hay):

```ts
import { configs, envSource, mapKey } from "@jondotsoy/configs";
import { envSource as envSourceFromSubpath } from "@jondotsoy/configs/sources/env";

const cfg = await configs.create(
  {
    server: configs.create({
      port: { type: "number", default: 3000 },
      host: { type: "string" },
    }),
  },
  { sources: [envSource({ mapKey: mapKey.snakeCase() })] },
);

const port: number = cfg.server.port.get();
const host: string | null = cfg.server.host.get();
console.log(port, host, typeof envSourceFromSubpath);
```

Ejecutado con `SERVER_PORT=4000 SERVER_HOST=example.com`, `port` debe ser `4000` y
`host` `"example.com"`.

### Caso de uso: verificación exhaustiva de exports (imports del repo)

Para cubrir además `fetchSource`, `sseSource`, `literalSource`, `Source` y
`ConfigError` del core, y `fetchSource`/`sseSource` como subpaths, este fixture
runtime-agnóstico hace exactamente eso — copiarlo tal cual como `check-imports.mjs`
en cualquier entorno:

```js
// check-imports.mjs
import { configs, envSource, literalSource, mapKey, Source, ConfigError } from "@jondotsoy/configs";
import { envSource as envSourceFromSubpath } from "@jondotsoy/configs/sources/env";
import { fetchSource } from "@jondotsoy/configs/sources/fetch";
import { sseSource } from "@jondotsoy/configs/sources/sse";

function assert(cond, message) {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

assert(typeof configs.create === "function", "configs.create is a function");
assert(typeof envSource === "function", "envSource exported from root");
assert(typeof mapKey.snakeCase === "function", "mapKey.snakeCase exported from root");
assert(typeof literalSource === "function", "literalSource exported from root");
assert(typeof Source === "function", "Source exported from root");
assert(typeof ConfigError === "function", "ConfigError exported from root");
assert(typeof envSourceFromSubpath === "function", "envSource exported from /sources/env");
assert(typeof fetchSource === "function", "fetchSource exported from /sources/fetch");
assert(typeof sseSource === "function", "sseSource exported from /sources/sse");

const source = envSource({ mapKey: mapKey.snakeCase() });
const cfg = await configs.create(
  { server: configs.create({ port: { type: "number", summary: "HTTP port", default: 3000 } }) },
  { sources: [source] },
);

assert(cfg.server.port.get() === 4000, "cfg.server.port.get() reads SERVER_PORT=4000 via envSource");

await cfg.close();
console.log("ALL_CHECKS_PASSED");
```

### Comando de tipado (el que realmente ejercita `dist/`)

El mismo snippet base, tipado con la resolución de módulos que Node recomienda para
consumir un paquete ESM publicado — es lo que de verdad ejercita los `.d.ts` de
`dist/`, a diferencia del `tsconfig.json` interno del repo:

```sh
npx tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 test.ts
```

## Estrategia por entorno

Por defecto se instala **la última versión publicada en npm** — es la que de verdad
recibe un consumidor nuevo, y lo que hay que validar después de cada `npm publish`.

> Para validar cambios locales *antes* de publicar (todavía no están en npm), sustituir
> el paso de instalación por el flujo de tarball local:
>
> ```sh
> bun run build                    # genera dist/
> bun pm pack --destination /tmp   # genera /tmp/jondotsoy-configs-<version>.tgz
> ```
>
> y usar `npm i /tmp/jondotsoy-configs-<version>.tgz` / `bun add /tmp/....tgz` en vez
> de `npm add @jondotsoy/configs` / `bun add @jondotsoy/configs` en los pasos de abajo.
> Deno no soporta instalar un tarball local como paquete `npm:`; para probar un cambio
> sin publicar, usar `deno run` apuntando directo a un archivo `.js` de `dist/`.

### Node

1. Proyecto limpio e instalación de la última versión desde npm:

   ```sh
   mkdir -p /tmp/check-node && cd /tmp/check-node
   npm init -y
   npm add @jondotsoy/configs
   npm i -D typescript
   ```

2. Guardar el snippet base como `test.ts`.
3. Tipar con la resolución `nodenext` (ver [arriba](#comando-de-tipado-el-que-realmente-ejercita-dist)) — esto detecta problemas que `moduleResolution: bundler` deja pasar, como imports relativos sin extensión en los `.d.ts`.
4. Ejecutar en runtime para confirmar que además de tipar, corre:

   ```sh
   node --experimental-strip-types test.ts
   ```

Cubierto parcialmente en el repo vía `bun run test:cases` (engine `node`), que corre contra el `dist/` ya construido en el propio checkout — no instala la última versión de npm ni un tarball empaquetado, y solo valida runtime, no tipado.

### Bun

1. Proyecto limpio e instalación de la última versión desde npm:

   ```sh
   mkdir -p /tmp/check-bun && cd /tmp/check-bun
   bun init -y
   bun add @jondotsoy/configs
   bun add -d @types/bun typescript
   ```

2. `tsconfig.json` representativo de un proyecto Bun típico (sin esto, `tsc` falla por falta de tipos ambientales de Bun y de `lib: esnext` — esperado, no un bug del paquete):

   ```json
   {
     "compilerOptions": {
       "lib": ["ESNext"],
       "target": "ESNext",
       "module": "ESNext",
       "moduleResolution": "bundler",
       "types": ["bun"],
       "strict": true
     }
   }
   ```

3. Guardar el snippet base como `test.ts` y validar:

   ```sh
   bunx tsc --noEmit -p tsconfig.json
   bun run test.ts
   ```

Cubierto parcialmente en el repo vía `bun run test:cases` (engine `bun`) — corre contra el `dist/` ya construido en el propio checkout, no un tarball empaquetado ni la última versión de npm, y solo valida runtime, no tipado.

### Deno

1. Instalación de la última versión desde npm:

   ```sh
   mkdir -p /tmp/check-deno && cd /tmp/check-deno
   deno add npm:@jondotsoy/configs
   ```

2. Guardar el snippet base como `test.ts`, ajustando los imports a `npm:@jondotsoy/configs` / `npm:@jondotsoy/configs/sources/env` si no se usa un import map.
3. Tipar y ejecutar:

   ```sh
   deno check test.ts
   deno run --allow-env test.ts
   ```

`deno check` corre el propio type-checker de Deno (basado en TSC) contra los mismos `.d.ts` publicados — una tercera validación independiente de la de `nodenext`. Cubierto parcialmente en el repo vía `bun run test:cases` (engine `deno`) contra el `dist/` ya construido — solo runtime; `envSource()` sin `env` explícito lee todo `process.env`, por lo que Deno necesita `--allow-env` sin scope.

### Bundlers de navegador (`bun build --target browser` / Vite)

No forma parte de la matriz Node/Bun/Deno de arriba (ahí se ejecuta el paquete tal
cual, sin bundler de por medio) pero es relevante para consumidores que empaquetan la
app para el navegador. El punto flaco es `fileSource`/`DotEnv`, que importan
`node:fs`/`node:fs/promises` — ninguno de los dos bundlers falla el build por esto,
pero conviene saber qué hacen exactamente:

```sh
mkdir -p /tmp/check-browser && cd /tmp/check-browser
npm add @jondotsoy/configs
```

**Caso limpio** (`configs` + `literalSource`, sin ningún import de `sources/*` que
toque Node) — `entry.ts`:

```ts
import { configs, literalSource } from "@jondotsoy/configs";

const cfg = await configs.create(
  { server: configs.create({ port: { type: "number", default: 3000 } }) },
  { sources: [literalSource({ server: { port: 9090 } })] },
);
console.log(cfg.server.port.get());
```

```sh
bunx bun build entry.ts --outdir out --target browser
```

Bundlea sin error, y la función de `fileSource` (código muerto, nunca invocado) se
elimina del output gracias al tree-shaking (`"sideEffects": false` en
`package.json`) — `dist/configs.js` empaqueta core + todos los `sources/*` juntos en
un solo archivo, así que cualquier import desde la raíz pasa por ese archivo, sea cual
sea el export que realmente se use. Eso sí: tanto con este `entry.ts` como con el que
usaba `envSource`, Bun deja dos líneas muertas al principio del bundle —
`var {watch} = (() => ({}))(); var {readFile} = (() => ({}))();` — el shim con el que
reemplaza `node:fs`/`node:fs/promises` al no poder resolverlos para `--target
browser`. Son inofensivas mientras nada las llame (que es el caso aquí), pero
confirman que **qué export del root uses no cambia nada**: el shim se genera igual
porque `node:fs` está en el mismo archivo bundleado, tree-shaking aparte.

**Caso con `fileSource`** — mismo `entry.ts` pero importando y usando `fileSource`:

```ts
import { configs, fileSource } from "@jondotsoy/configs";

const cfg = await configs.create(
  { server: configs.create({ port: { type: "number", default: 3000 } }) },
  { sources: [fileSource({ path: "./config.json" })] },
);
```

- **`bun build --target browser`**: bundlea sin ningún error ni warning. Reemplaza
  `node:fs`/`node:fs/promises` por un objeto vacío (`{}`), así que `watch`/`readFile`
  quedan `undefined` — el build es "exitoso" pero `fileSource(...)` revienta en
  runtime con un `TypeError` al primer uso, en silencio hasta ese momento.
- **Vite** (`npx vite build`, con `entry.ts` importado desde un `index.html`): sí
  avisa en la consola de build — `Module "node:fs" has been externalized for browser
  compatibility` — y el tree-shaking de Rollup/Rolldown también termina eliminando
  todo lo no usado en el caso limpio. Pero si `fileSource` sí se usa, cae en el mismo
  problema que Bun: el módulo externalizado queda como `{}`, y el `TypeError` solo
  aparece en runtime.

**Caso con `fetchSource`** — a diferencia de `fileSource`, `fetchSource` solo usa el
`fetch()` global (sin ningún import de Node), así que debería ser genuinamente seguro
en el navegador. Probado importando desde la raíz y desde el subpath dedicado:

```ts
// (a) desde la raíz
import { configs, fetchSource } from "@jondotsoy/configs";

const cfg = await configs.create(
  { server: configs.create({ port: { type: "number", default: 3000 } }) },
  { sources: [fetchSource({ url: "https://example.com/config.json" })] },
);
console.log(cfg.server.port.get());
```

```ts
// (b) desde el subpath, sin pasar por dist/configs.js
import { fetchSource } from "@jondotsoy/configs/sources/fetch";

const source = fetchSource({ url: "https://example.com/config.json" });
```

Resultado con `bun build --target browser` y con `vite build`:

- **(a) desde la raíz**: bundlea limpio en ambos — el código de `fetchSource` en el
  output solo llama al `fetch()` global, nada de Node. Pero como sigue pasando por
  `dist/configs.js`, arrastra el mismo ruido que el caso limpio: Bun deja las dos
  líneas muertas de `watch`/`readFile`, y Vite sigue avisando de `node:fs`
  externalizado — ninguno de los dos por culpa de `fetchSource` en sí, sino porque
  `fileSource` vive en el mismo archivo.
- **(b) desde el subpath `sources/fetch`**: bundle sin ningún warning ni referencia a
  `node:fs` — con Bun, 4.72 KB contra los ~15 KB del caso (a); con Vite, sin ningún
  mensaje de externalización en la consola de build. `dist/sources/fetch.js` es un
  archivo separado que nunca importa `node:fs`, así que no hay nada que externalizar.

Conclusión práctica: **`fileSource`/`DotEnv` son Node-only**, `fetchSource` (y por la
misma razón `sseSource`, `envSource`, `literalSource`) son igual de seguros en el
navegador — ningún bundler de navegador impide usar `fileSource` en build-time; la
señal más temprana es el warning de Vite, y ese warning sale igual se use o no
`fileSource` mientras se importe algo desde la raíz `@jondotsoy/configs` (es
por-módulo, sobre `dist/configs.js` entero, no por lo que el consumidor realmente
use de ahí); Bun no avisa en ningún caso, solo deja el shim muerto. Dos formas de
evitarlo en código de navegador:

1. Importar desde la raíz y confiar en el tree-shaking cuando no se usa `fileSource`
   — el build queda limpio, pero el warning de Vite (o el shim de Bun) sigue
   apareciendo como ruido informativo.
2. Importar solo los subpaths que se necesiten (`./sources/env`, `./sources/fetch`,
   `./sources/sse`, `./sources/literal`) en vez de la raíz — cada uno es un bundle
   independiente que nunca toca `node:fs`, así que no hay ni warning ni shim.

## Antes de publicar

Como mínimo:

```sh
bun test
```

Si el cambio toca tipos públicos o algo en `src/sources/*`/`src/config.types.ts`,
sumar el chequeo manual de tipado en al menos Node (es el runtime con la resolución
de módulos más estricta) antes de subir la versión.
