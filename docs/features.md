# Features

Lista de features de `@jondotsoy/configs`, agrupadas por área. Para una
guía de uso ver el [`README.md`](../README.md); para el detalle interno de
cada pieza, el código fuente en `src/` está fuertemente comentado.

## Table of contents

- [`create()` / `load()`](#create--load)
- [Descriptores de campo (`Descriptor`)](#descriptores-de-campo-descriptor)
- [Sources](#sources)
- [`file()` — campo respaldado por disco](#file--campo-respaldado-por-disco)
- [React](#react)
- [Utilidades](#utilidades)

## `create()` / `load()`

El punto de entrada público (`src/config-node.ts`, re-exportado desde
`src/configs.ts`):

- **`create(shape, options?)`** — construye un árbol de configuración a
  partir de un `shape` de descriptores. Devuelve un objeto plano (sin
  `Proxy`) con un `Store` en vivo por cada campo hoja — no hay `.get()` en
  la raíz, solo en cada campo.
- **Reactivo por campo, no por árbol** — cada campo hoja es su propia
  cadena `Source → KeyStore → FieldStore`: cambia solo lo que depende de
  la fuente que acaba de publicar, sin recorrer/recalcular el resto del
  shape.
- **`then`-able** — el objeto que devuelve `create()` puede `await`earse:
  resuelve una vez que cada `Source` en `options.sources` publicó su
  primer snapshot, a un objeto plano equivalente (ya sin `then`/`close`).
  Los campos son legibles de forma síncrona incluso antes de ese `await`
  (parten en su `default`, o en `null`).
- **`close`-able** — el objeto que devuelve `create()` (la referencia
  original, antes de `await`earla) expone `.close(): Promise<void>`:
  cierra cada `Source` propio (`Source.close()`), el `.close()` propio de
  cada descriptor de campo (`Descriptor.close()`) y el `.close()` de cada
  nodo `create()` embebido, todo en una sola llamada.
- **Grupos anidados** — un valor del shape puede ser:
  - un **objeto plano** (`{ server: { port: numeric() } }`), que comparte
    las `sources` del `create()` que lo contiene; o
  - **otro `create()` embebido** (`{ server: { tls: create({...}, {
    sources: [...] }) } }`), que resuelve de forma completamente
    independiente contra sus propias `sources` — nunca contra las del
    padre. `isConfigsNode(value)` distingue un nodo embebido de un
    objeto plano en runtime.
- **`load(shape, options?)`** — igual que `create()`, pero
  `options.sources` por defecto es `[envSource()]` en vez de `[]`, así que
  `load(shape)` a secas lee directo de `process.env`. Pasar un `sources`
  explícito reemplaza ese default por completo (no se combina con
  `envSource()`).
- **`key` — path explícito** — cualquier descriptor puede declarar
  `key: "PORT"` (o `key: ["a", "b"]`) para leer desde un path absoluto en
  el snapshot de cada fuente, en vez de su propia posición de anidamiento
  en el shape.
- **Tipado derivado del shape** — `cfg.port.get()` se infiere como
  `number | null` sin `default`, o `number` con uno — sin anotación
  manual, ni para grupos anidados ni para campos embebidos.

## Descriptores de campo (`Descriptor`)

`src/config-descriptor.ts` — el bloque de construcción de cada campo:

- **`Descriptor<T, O>`** — la clase base. Expone `.key`, `.start(raw,
  path?)` (síncrono: cae a `options.default` cuando no hay valor, o corre
  el `start` propio del campo — es `create()` quien crea y mantiene vivo
  el `Store` del campo, volviendo a llamar `.start()` en cada cambio), un
  `.reduce(rawStore, path?)` opcional que devuelve `Promise<Store<T>>`
  para campos que solo pueden resolverse de forma asíncrona, y un
  `.close()` (siempre presente, no-op si el constructor no dio `close`)
  que `create()` llama una vez por campo desde el `.close()` del nodo.
  Extensible a mano (`new Descriptor({ type, options, start, reduce?,
  close? })`, o el contrato completo vía `CONFIG_DESCRIPTOR_TAG` +
  `.start()` — **deprecado**, preferir siempre `new Descriptor(...)`).
- **`string(options?)`** — coerción a `string`; `pattern` opcional
  (`RegExp`) para validar el valor.
- **`numeric(options?)`** — coerciona un string numérico (o `number`
  directo) a `number`; rechaza cualquier otra cosa.
- **`boolean(options?)`** — coerciona `"true"`/`"1"` y `"false"`/`"0"` (o
  un `boolean` directo) a `boolean`.
- **`url(options?)`** — parsea un `string` a `URL`, validándolo; un
  `URL` ya construido pasa sin cambios.
- **`choice(options)`** — solo acepta uno de los `options.options`
  (`readonly T[]`) dados; el tipo se infiere como la unión literal de esas
  opciones.
- **`shape(options?)`** — delega en un `schema` externo (`{ parse(value):
  T }` — zod, valibot, cualquier librería con esa forma, o ninguna). Sin
  `schema`, pasa cualquier objeto tal cual, tipado `unknown`.
- **Opciones comunes a todos**: `summary`, `default`, `required`
  (escala una validación fallida a `ConfigError` en vez de solo loguearla
  y resolver a `null`), `key` (ver arriba). `freeze` sigue declarado por
  compatibilidad pero actualmente no tiene efecto.
- **`isConfigDescriptor(value)`** — type guard exportado para reconocer un
  descriptor real (built-in o hecho a mano).

## Sources

`src/sources/*.ts` — cada uno construye un `Source<T>` (la clase base,
también exportada, modelada como `ReadableStream`: `start(control)` publica
snapshots vía `control.set(value)`, `close()` libera lo que `start` haya
reservado):

- **`envSource(options?)`** — lee `process.env` (o un `env` explícito).
  `mapKey` decide cómo cada key mapea a un path (`snakeCase`, `camelCase`,
  `identity`, o una tabla `lookup`); `prefix`/`suffix` filtran qué keys
  entran.
- **`fetchSource(options)`** — descarga JSON de una URL. `pollingInterval`
  prende el polling (apagado por defecto); `followCacheControl` y
  `useConditionalRequests` (on por defecto) dejan que el propio servidor
  dicte el ritmo. `attempts` reintenta, `credentials` arma el header
  `Authorization`, `treePath` selecciona un subárbol del body.
- **`sseSource(options)`** — se conecta a un endpoint Server-Sent Events;
  cada mensaje se aplica como *patch* sobre lo ya recibido por defecto
  (`overwrite: true`, o un `reduce` propio, para reemplazar en vez de
  mezclar).
- **`fileSource(path, options?)`** — lee un archivo local `.json` o
  `.env`. `watch: true` (default) lo re-lee en vivo vía `fs.watch`;
  `watch: { interval }` hace polling en vez de `fs.watch`. `parser`
  permite soportar formatos propios (YAML, etc.).
- **`pullSource(options)`** — llama a una función `pull` (sync o async)
  de inmediato y luego cada `interval` ms — el escape hatch genérico para
  cualquier fuente que no tenga un `Source` dedicado (una query a DB, un
  secrets manager, gRPC...).
- **`shellSource(args, options?)`** — corre un comando (`node:child_process`
  `spawn`) y publica su stdout parseado (JSON por defecto,
  `stdoutParser` para otro formato). `pollingInterval` lo vuelve a correr
  periódicamente.
- **`literalSource(value)`** — publica un valor ya en memoria una sola
  vez y se cierra. Sin I/O ni opciones — útil como fallback estático o en
  tests.
- **Todas las fuentes con polling** (`fetchSource`, `shellSource`) y las
  que parsean patches (`sseSource`, `fileSource`, `fetchSource`) aceptan
  un `reduce(incoming, previous)` propio para combinar cada publicación
  con la anterior, en vez de reemplazar el árbol entero.
- **Métricas** — varias fuentes (`envSource`, otras) exponen `.metrics`
  (`src/utils/metric.ts`: `GaugeMetric`, `CounterMetric`,
  `HistogramMetric`) para instrumentación.

## `file()` — campo respaldado por disco

`src/node.ts`, subpath `@jondotsoy/configs/node` (Node-only, usa
`node:fs`):

- **`file(options?)`** — decodifica el valor crudo de una fuente (o un
  `default`) en un `FileBlob`: texto o base64, inferido o forzado vía
  `format`. Un `default` tipo `URL` (`file:`) se lee de disco de forma
  eager al llamar a `file()`.
- **`FileBlob`** — `.text()`, `.json()`, `.bytes()`, `.arrayBuffer()`,
  `.stream()`, `.formData()`, `.size`, `.type` (mimetype inferido de la
  extensión de `.location`), `.location` (siempre seteado — un `URL`
  dado tal cual, o un archivo temporal con el contenido decodificado).
- **`required: true`** en `file()` estrecha el tipo de `.get()` a
  `FileBlob` (nunca `null`) — a nivel de tipos, no garantiza el valor en
  runtime.

## React

`src/react.ts`, subpath `@jondotsoy/configs/react` (React como peer
dependency — solo se necesita si se importa este subpath):

- **`useConfig(store)`** — hook que suscribe un componente a cualquier
  `Store`/`ReadOnlyStore` (un campo, o un grupo anidado) vía
  `useSyncExternalStore`, re-renderizando en cada cambio.

## Utilidades

- **`Store<T>`** (`src/utils/store.ts`) — la primitiva reactiva detrás de
  cada campo: `.get()`, `.set()`, `.subscribe()` (dispara con el valor
  actual y en cada cambio), `.listen()` (solo cambios futuros).
- **`DataTypes`** (`src/utils/data-types.ts`) — helpers de
  tipo/coerción de datos.
- **`DotEnv.parse(text)`** (`src/utils/dotenv.ts`) — parser de formato
  `.env` (comentarios, comillas, backticks multilínea) usado internamente
  por `fileSource`.
- **`ConfigError`** (`src/errors.ts`) — el error que lanza cualquier
  descriptor cuando un valor falla su validación y el campo es
  `required: true`.
