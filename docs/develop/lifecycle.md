# Ciclo de vida de un nodo y sus `FieldStore`

Este documento explica, paso a paso, qué hace realmente `create()`/`load()`
(`src/config-node.ts`) desde que se llama hasta que el nodo se cierra: cuándo
se construye cada `Store` de campo (el "`FieldStore`"), cuándo se llama
`start(control)` de cada `Descriptor`, cuándo el nodo queda "listo"
(`then()`), y qué limpia `close()`. Es la referencia interna para quien vaya a
tocar `config-node.ts`/`config-descriptor.ts`, o a escribir un `Descriptor`
a mano — el código fuente sigue siendo la fuente de verdad, esto es el mapa
para no tener que reconstruirlo leyendo todo de cero.

## Tabla de contenido

- [Resumen en una frase](#resumen-en-una-frase)
- [Los actores](#los-actores)
- [Fase 1 — Construcción síncrona (`buildNode`/`buildField`)](#fase-1--construcción-síncrona-buildnodebuildfield)
- [Fase 2 — Apertura de las fuentes (`ownReady`)](#fase-2--apertura-de-las-fuentes-ownready)
- [Fase 3 — Vida en vivo](#fase-3--vida-en-vivo)
- [`then()`: qué significa que el nodo esté "listo"](#then-qué-significa-que-el-nodo-esté-listo)
- [Fase 4 — Cierre (`close()`)](#fase-4--cierre-close)
- [`start(control)`: cuántas veces se llama, y qué hace cada parte de `control`](#startcontrol-cuántas-veces-se-llama-y-qué-hace-cada-parte-de-control)
- [Grupos anidados y nodos `create()` embebidos](#grupos-anidados-y-nodos-create-embebidos)
- [Ejemplo con timings reales](#ejemplo-con-timings-reales)
- [Errores durante el ciclo de vida](#errores-durante-el-ciclo-de-vida)

## Resumen en una frase

`create()` devuelve el nodo **de inmediato, ya usable de forma síncrona**
(cada campo con el valor que su propio `start(control)` haya publicado
síncronamente — típicamente `options.default`, ya que ninguna fuente ha
abierto todavía), y desde ese mismo instante dispara, en paralelo, la
apertura de cada `Source` — el nodo se vuelve reactivo a medida que esas
fuentes van publicando, sin que el consumidor tenga que esperar nada para
empezar a leer `.get()`.

## Los actores

| Pieza | Dónde vive | Rol |
|---|---|---|
| `Source<T>` | `src/sources/source.ts` | Abre una vez (`start(control)`), publica snapshots (`control.set()`) en su propio `Store` interno, cierra con `close()`. |
| `rawSources[i]` | `create()` | Un `Store<unknown>` placeholder por cada `options.sources[i]` — arranca en `null`, se conecta al `Store` real de esa fuente recién cuando `source.open()` resuelve. |
| `keyStore(rawSources, path)` | `config-node.ts` | Por cada campo: mira `path` en cada `rawSources[i]` **en orden de prioridad** (el primero que tenga el valor gana) y expone eso como un `Store<unknown>` — el "raw" del campo. |
| `Descriptor<Pending, Awaited>` | `config-descriptor.ts` | Un único hook, `start(control): void \| Promise<void>` — **exactamente el mismo contrato que `Source`'s propio `start(control)`** — más un `close(): Promise<void>` opcional. `Pending` es lo que `.get()` devuelve antes de que el nodo termine de resolver (`T` o `T \| null` sin `default`, ver `WithDefault`); `Awaited` es lo que `.get()` devuelve una vez el nodo se resuelve (`T` con `default` **o** `required: true`, ver `Settled`). |
| `DescriptorControl<T>` | `config-descriptor.ts` | Lo que `start` recibe: `.rawStore` (el raw en vivo de ese campo, solo lectura), `.path` (para mensajes de error) y `.set(value)` (publica el siguiente valor del campo — síncrono en tick 0, o cualquier cantidad de veces después). |
| `FieldStore` | `config-node.ts` (`buildField`) | El `Store<T>` que el consumidor lee vía `configs.campo.get()`. Lo crea y posee `buildField()` — el `Descriptor` nunca guarda un `Store` propio; solo escribe en él a través de `control.set()`. |
| `ConfigsNodePending<T>` | `config-node.ts` | Lo que `create()` devuelve: el nodo ya usable + `.then()` + `.close()`. |

## Fase 1 — Construcción síncrona (`buildNode`/`buildField`)

Todo esto ocurre **en el mismo tick**, antes de que cualquier `Promise` haya
tenido chance de resolver — ni siquiera una fuente que resuelve
"inmediatamente" (su `start()` corre en un microtask, ver Fase 2) ha
publicado nada todavía:

1. `create(shape, { sources })` crea un `Store<unknown>` placeholder por cada
   fuente (`rawSources`), todos arrancando en `null`.
2. `buildNode()` recorre el `shape` recursivamente. Por cada campo hoja
   (`isConfigDescriptor(entry)` es `true`):
   a. Resuelve su `path` — su posición de anidamiento en el shape, o su
      `key` explícito si lo tiene (`resolveFieldPath`).
   b. Arma su `rawStore` con `keyStore(rawSources, path)` — un `Store` que
      mira ese `path` en cada `rawSources[i]` (en orden) y se re-suscribe a
      los `rawSources` para recalcular cuando cualquiera cambie.
   c. Llama `buildField(descriptor, rawStore, path)`, que:
      - Crea el `FieldStore`, arrancando en `null`: `new Store<unknown>(null)`.
      - Arma el `control` de ese campo: `{ rawStore, path, set: (value) =>
        fieldStore.set(value) }`.
      - Llama `descriptor.start(control)` — **exactamente una vez**. Todo lo
        que `start` haga con `control.set()`, ahora o más tarde, es la única
        forma en que ese `FieldStore` cambia — `buildField()` no vuelve a
        tocarlo por su cuenta.
   d. Registra un "closer" para este campo (`entry.close()`, si existe) en
      `closers` (ver Fase 4).
3. Un valor del shape que no es un descriptor ni un nodo `create()` embebido
   se trata como grupo anidado: `buildNode()` recursa sobre él con el mismo
   `path` extendido, compartiendo los mismos `rawSources`.
4. El resultado (`node`) ya es un objeto plano con un `Store` real por cada
   campo hoja — **usable de inmediato**, sin `await` ni `Proxy`. Si el
   `start` de un campo llamó `control.set(...)` síncronamente (como hace
   cada builder integrado, típicamente con `options.default` ya que
   ninguna fuente ha abierto aún), ese es su valor desde ya; si no llamó
   nada todavía, el campo lee `null` hasta que lo haga.

## Fase 2 — Apertura de las fuentes (`ownReady`)

En paralelo a la Fase 1 (de hecho, arranca justo después, todavía
síncronamente dentro de `create()`):

```ts
const ownReady = Promise.all(
  sources.map((source, index) =>
    source.open().then((opened) => {
      opened.subscribe((value) => rawSources[index]!.set(value));
    }),
  ),
);
```

`source.open()` espera a que el propio `start(control)` de esa `Source`
termine de correr (ver `src/sources/source.ts`) y devuelve su `Store`
interno. En cuanto eso resuelve, `opened.subscribe(...)` conecta ese `Store`
al `rawSources[index]` placeholder — `subscribe` (a diferencia de `listen`)
dispara inmediatamente con el valor actual, así que el primer snapshot de la
fuente entra sin esperar un cambio posterior.

Cada vez que `rawSources[index]` cambia, todo `keyStore` que lo mira
recalcula su propio valor (comparando el primero, en orden de prioridad, que
tenga el `path` del campo) — y si cambió, dispara sus propios `listen()`, lo
que a su vez dispara cualquier `control.rawStore.subscribe()` que el `start`
de ese campo haya registrado en la Fase 1 (ver Fase 3).

## Fase 3 — Vida en vivo

`create()` no orquesta ninguna "segunda fase" para los campos — no hay nada
equivalente al `open()` de una `Source` que el nodo espere por su cuenta. La
reactividad de cada campo es enteramente cosa de lo que su propio
`start(control)` haya hecho con `control` en la Fase 1:

- Si `start` llamó `control.rawStore.subscribe(...)`, ese callback ya
  disparó una vez de inmediato (tick 0, con el `rawStore` de ese momento) y
  vuelve a dispararse en cualquier cambio posterior de `rawStore`
  (típicamente porque una fuente publicó un valor nuevo — ver Fase 2),
  pudiendo llamar `control.set()` de nuevo cada vez.
- Si `start` programó algo propio (un `setTimeout`, una promesa que
  resuelve más tarde, una suscripción externa), eso puede llamar
  `control.set()` en cualquier momento, sin relación con `rawStore` en
  absoluto.
- Si `start` no hizo ninguna de las dos cosas — llamó `control.set()` una
  vez y ya — el campo queda fijo en ese valor para siempre.

La cadena típica (cuando `start` sí escucha `rawStore`, como hace cada
builder integrado) es:

```
Source.control.set(value)
  → rawSources[i].set(value)
    → keyStore recalcula (si el path cambió)
      → control.rawStore.listen() del campo se dispara
        → control.set(next) → fieldStore.set(next)
```

Nada de esto vuelve a llamar `start()` — **`start()` corre exactamente una
vez por campo, siempre**. Todo lo que pasa después es código que ese mismo
`start` dejó corriendo (un listener, un timer, una promesa pendiente).

## `then()`: qué significa que el nodo esté "listo"

```ts
const ready = Promise.all([ownReady, ...embeddedReady]).then(() => node);
```

`await configs` (o `configs.then(...)`) resuelve cuando **cada `Source` propia
abrió** (Fase 2) **y cada nodo `create()` embebido abrió las suyas** (ver
"Grupos anidados..." más abajo) — `embeddedReady` ya no incluye nada por
campo: `start(control)` no tiene ninguna promesa de "listo" que el nodo
pueda esperar, a propósito (ver el resumen: "sin esperar a nadie"). Por eso,
si `start()` de un campo hace algo asíncrono y llama `control.set()` recién
más tarde, `await configs` puede resolver **antes** de que ese campo tenga su
valor "real" — el campo sigue siendo legible en todo momento (parte en
`null` o lo que `start` haya puesto síncronamente), simplemente puede seguir
cambiando después de que `then()` ya resolvió.

El objeto al que resuelve (`node`) es el mismo árbol de `Store`s de siempre,
pero **sin** `then`/`close` — para volver a llamarlos hay que quedarse con la
referencia que `create()` devolvió, no con el resultado de `await`earla.

## Fase 4 — Cierre (`close()`)

```ts
close(): Promise<void> {
  return Promise.all([...closers.map((close) => close()), ...sources.map((source) => source.close())]).then(() => undefined);
}
```

`configs.close()` corre, todo en paralelo, en una sola llamada:

- El `close()` de cada `Descriptor` de campo (`closers`, armados en la Fase
  1) — no-op si ese `Descriptor` no dio uno. Es responsabilidad de `start`
  dejar todo lo necesario (un timer, una suscripción externa) accesible
  desde `close` — `control` no ofrece ningún mecanismo de limpieza propio.
- El `close()` de cada nodo `create()` embebido (que a su vez repite este
  mismo proceso, recursivamente, sobre sus propias fuentes/campos).
- El `close()` de cada `Source` propia de este nodo (`options.sources`) —
  cierra su conexión/timer/watcher interno.

Es seguro llamarlo en cualquier momento (antes o después de que `then()`
resuelva) y más de una vez — `Source.close()` ya es idempotente por su
cuenta, y `Promise.all` sobre closers que ya resolvieron no vuelve a
ejecutarlos.

## `start(control)`: cuántas veces se llama, y qué hace cada parte de `control`

| Parte | Cuántas veces / cuándo |
|---|---|
| `descriptor.start(control)` (la llamada en sí) | **Exactamente 1**, por campo, síncronamente en `buildField()`, durante la Fase 1 — antes de que cualquier fuente haya abierto. |
| `control.set(value)` | Tantas veces como el propio `start` decida llamarla — nada más la invoca. Puede llamarse dentro de `start` mismo, síncronamente (tick 0), y/o cualquier cantidad de veces después (un listener, un timer, una promesa). |
| `control.rawStore.get()`/`.listen()`/`.subscribe()` | Lectura libre en cualquier momento — es un `ReadOnlyStore`, `start` nunca puede escribirle directamente (solo mediante su propio `control.set()`, que va al `FieldStore`, no al raw). |

`start` nunca se re-invoca — toda la reactividad del campo vive en lo que esa
única llamada dejó armado. **Sin ningún `control.rawStore.subscribe()` ni
ninguna otra fuente de `control.set()` futura, el campo queda fijo para
siempre** — no es un caso raro que "cae a algo", es literalmente lo que pasa
si `start` no arma nada más. Ver
[`src/config-node.spec.ts`](../../src/config-node.spec.ts), describe
`create — start(control) is 100% in control of the field's value`, para los
cuatro casos: sin llamar `control.set()` nunca (siempre `null`), llamándolo
una vez sin escuchar `rawStore` (fijo en ese valor), escuchando `rawStore`
con una transformación propia (reactivo), y un `start` que combina las tres
cosas — un seed a través de `control.rawStore.subscribe()` (que dispara de
inmediato con el valor actual, tick 0) y un `setTimeout` propio,
independiente de la fuente.

## Grupos anidados y nodos `create()` embebidos

- **Grupo anidado** (`{ server: { port: numeric() } }`): un objeto plano
  dentro del shape. `buildNode()` recursa sobre él con el mismo `path`
  extendido y las mismas `rawSources` — comparte el ciclo de vida completo
  del nodo padre, no tiene su propio `then()`/`close()`.
- **Nodo `create()` embebido** (`{ server: { tls: create({...}, {
  sources: [...] }) } }`): `isConfigsNode(entry)` lo detecta y **se adopta
  tal cual** — no se rewired contra las `rawSources` del padre. Tiene su
  propio ciclo de vida completo (sus propias fuentes, su propio `then()`),
  pero el padre:
  - encola su promesa (`entry`, que es *thenable*) en su propio
    `embeddedReady`, así que `await` sobre el padre también espera a que el
    hijo abra sus propias fuentes;
  - encola `entry.close()` en sus propios `closers`, así que `padre.close()`
    también cierra al hijo (y, en cascada, las fuentes del hijo).

## Ejemplo con timings reales

Extraído de `src/config-node.spec.ts` (describe `create — start(control) is
100% in control of the field's value`):

```ts
// Descriptor: siembra síncronamente con options.default (aquí, 3000, pasado
// como argumento en vez de vivir en options), se queda escuchando
// control.rawStore (para la actualización real de la fuente) y además
// programa su propio override, sin relación con la fuente.
function delayed(defaultValue: number, overrideAfterMs: number, overrideValue: number) {
  const parse = (raw: unknown) => (raw == null ? defaultValue : Number(raw));
  return new Descriptor<number>({
    type: "delayed",
    options: {},
    start(control) {
      control.rawStore.subscribe((raw) => control.set(parse(raw)));
      setTimeout(() => control.set(overrideValue), overrideAfterMs);
    },
  });
}

const source = new Source<{ value?: string }>({
  start(control) {
    setTimeout(() => control.set({ value: "2000" }), 20);
  },
});

const configs = create({ value: delayed(3000, 40, 4000) }, { sources: [source] });

configs.value.get(); // 3000 — Fase 1: start() corrió, subscribe() disparó de inmediato con rawStore.get() === null
// ... ~30ms después
configs.value.get(); // 2000 — Fase 3: la fuente publicó, el subscribe() de start() lo propagó
// ... ~50ms después
configs.value.get(); // 4000 — Fase 3: el setTimeout propio de start() disparó su propio control.set()
```

Línea de tiempo:

```
t=0ms    create() devuelve el nodo. start() ya corrió (una vez). subscribe() disparó de
         inmediato contra rawStore.get() === null. value = 3000
t=20ms   la Source publica "2000" → rawStore cambia → el subscribe() de start() lo propaga → value = 2000
t=40ms   el setTimeout propio de start() dispara → control.set(4000) → value = 4000
```

## Errores durante el ciclo de vida

- Un `start(control)` que **lanza** de forma síncrona, dentro de la propia
  llamada en la Fase 1 (p. ej. `options.default` es inválido y el propio
  `parse` de ese builder lo rechaza ahí mismo), hace que la excepción salga
  síncronamente de `create()` mismo — en la práctica esto es raro, ya que
  `control.rawStore.get()` casi siempre es `null` en ese instante (ninguna
  fuente ha abierto) y el `parse` no llega a correr contra un valor real.
- El caso típico — una fuente publica un valor inválido — pasa por el
  `control.rawStore.subscribe(...)` que `start` registró: la excepción se
  lanza **síncronamente** dentro de esa cadena de `.set()` (`Source.control
  .set()` → `rawSources[i].set()` → `keyStore` → `control.rawStore.subscribe()`
  → `parse()` lanza), la cual — para la primera publicación de una fuente —
  ocurre dentro del `.then()` de `source.open()` que arma `ownReady` (Fase
  2). Eso convierte ese `.then()` en una promesa rechazada, lo que rechaza
  `ownReady`, `ready`, y por lo tanto `await configs` — con el mismo
  `ConfigError` que `parse` lanzó. Ver "`create()` — parser failures" en
  `config-node.spec.ts`.
- Para una publicación **posterior** (una fuente que actualiza en vivo,
  fuera de su apertura inicial), la misma excepción se lanza síncronamente
  desde quien haya llamado `control.set()` en esa fuente (p. ej. el
  `push()` de un test) — no como un rechazo de promesa, sino como una
  excepción síncrona real desde ese punto de la pila.
- Un `Store` que sí llegó a resolver (`.get()` ya devuelve el valor
  esperado) sigue siendo legible aunque `await configs` termine rechazando: el
  rechazo afecta al `then()` del nodo completo, no a los `Store`s
  individuales ya construidos.
