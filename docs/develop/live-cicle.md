# Ciclo de vida de un nodo y sus `FieldStore`

Este documento explica, paso a paso, qué hace realmente `create()`/`load()`
(`src/config-node.ts`) desde que se llama hasta que el nodo se cierra: cuándo
se construye cada `Store` de campo (el "`FieldStore`"), cuándo se llama
`start()`/`reduce()` de cada `Descriptor`, cuándo el nodo queda "listo"
(`then()`), y qué limpia `close()`. Es la referencia interna para quien vaya a
tocar `config-node.ts`/`config-descriptor.ts`, o a escribir un `Descriptor`
a mano — el código fuente sigue siendo la fuente de verdad, esto es el mapa
para no tener que reconstruirlo leyendo todo de cero.

## Tabla de contenido

- [Resumen en una frase](#resumen-en-una-frase)
- [Los actores](#los-actores)
- [Fase 1 — Construcción síncrona (`buildNode`/`buildField`)](#fase-1--construcción-síncrona-buildnodebuildfield)
- [Fase 2 — Apertura de las fuentes (`ownReady`)](#fase-2--apertura-de-las-fuentes-ownready)
- [Fase 3 — Resolución de `reduce()` (`embeddedReady`)](#fase-3--resolución-de-reduce-embeddedready)
- [Fase 4 — Vida en vivo](#fase-4--vida-en-vivo)
- [`then()`: qué significa que el nodo esté "listo"](#then-qué-significa-que-el-nodo-esté-listo)
- [Fase 5 — Cierre (`close()`)](#fase-5--cierre-close)
- [`start()` vs `reduce()`: cuántas veces se llama cada uno](#start-vs-reduce-cuántas-veces-se-llama-cada-uno)
- [Grupos anidados y nodos `create()` embebidos](#grupos-anidados-y-nodos-create-embebidos)
- [Ejemplo con timings reales](#ejemplo-con-timings-reales)
- [Errores durante el ciclo de vida](#errores-durante-el-ciclo-de-vida)

## Resumen en una frase

`create()` devuelve el nodo **de inmediato, ya usable de forma síncrona**
(cada campo con su valor por defecto o el que ya haya síncronamente
disponible), y desde ese mismo instante dispara, en paralelo, la apertura de
cada `Source` y la resolución del `reduce()` de cada `Descriptor` — el nodo
se vuelve reactivo a medida que esas piezas van resolviendo, sin que el
consumidor tenga que esperar nada para empezar a leer `.get()`.

## Los actores

| Pieza | Dónde vive | Rol |
|---|---|---|
| `Source<T>` | `src/sources/source.ts` | Abre una vez (`start(control)`), publica snapshots (`control.set()`) en su propio `Store` interno, cierra con `close()`. |
| `rawSources[i]` | `create()` | Un `Store<unknown>` placeholder por cada `options.sources[i]` — arranca en `null`, se conecta al `Store` real de esa fuente recién cuando `source.open()` resuelve. |
| `keyStore(rawSources, path)` | `config-node.ts` | Por cada campo: mira `path` en cada `rawSources[i]` **en orden de prioridad** (el primero que tenga el valor gana) y expone eso como un `Store<unknown>` — el "raw" del campo. |
| `Descriptor<T>` | `config-descriptor.ts` | `start(raw, path): T` (síncrono, una vez) + `reduce(rawStore, path): Promise<Store<T>> \| undefined` (la **única** fuente de reactividad — sin uno, el campo nunca se actualiza) + `close(): Promise<void>` opcional. |
| `reduceFromStart(parse, defaultValue)` | `config-descriptor.ts` (exportado) | El `reduce` que usan todos los builders integrados: re-ejecuta `parse` en cada cambio de `rawStore`. Cualquier `Descriptor` hecho a mano puede reusarlo para tener el mismo comportamiento "vivo" sin escribirlo a mano. |
| `FieldStore` | `config-node.ts` (`buildField`) | El `Store<T>` que el consumidor lee vía `cfg.campo.get()`. Lo crea y posee `buildField()` — el `Descriptor` nunca guarda un `Store` propio. |
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
   c. Llama `buildField(descriptor, rawStore, path, embeddedReady)`, que:
      - Crea el `FieldStore`: `new Store(descriptor.start(rawStore.get(), path))`.
        **Esta es la única vez que `start()` se llama** — con
        `rawStore.get()` casi siempre `null` en este punto (ninguna fuente
        ha abierto todavía), así que lo normal es que el valor inicial sea
        `options.default` (o `null` sin uno).
      - Llama `descriptor.reduce(rawStore, path)` — también una sola vez.
        Si devuelve una `Promise` (el `Descriptor` tenía su propio `reduce`,
        o uno construido con `reduceFromStart`), esa promesa se encola en
        `embeddedReady` (ver Fase 3). **Si devuelve `undefined` (no se pasó
        ningún `reduce` al constructor), no se encola nada — ese campo
        queda fijo para siempre en el valor que `start()` acaba de sembrar.**
   d. Registra un "closer" para este campo (`entry.close()`, si existe) en
      `closers` (ver Fase 5).
3. Un valor del shape que no es un descriptor ni un nodo `create()` embebido
   se trata como grupo anidado: `buildNode()` recursa sobre él con el mismo
   `path` extendido, compartiendo los mismos `rawSources`.
4. El resultado (`node`) ya es un objeto plano con un `Store` real por cada
   campo hoja — **usable de inmediato**, sin `await` ni `Proxy`.

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
tenga el `path` del campo) — y si cambió, dispara sus propios `listen()`.

## Fase 3 — Resolución de `reduce()` (`embeddedReady`)

`descriptor.reduce(rawStore, path)` se llamó ya en la Fase 1. Su resultado
decide todo lo que sigue:

- **Si devuelve una `Promise<Store<T>>`** (el `Descriptor` le dio un
  `reduce` propio al constructor — a mano, o vía `reduceFromStart`),
  `buildField()` la encadena así:

  ```ts
  reducePromise.then((resultStore) => {
    fieldStore.set(resultStore.get());
    resultStore.listen((value) => fieldStore.set(value));
  });
  ```

  En cuanto resuelve: el `FieldStore` adopta **de una** el valor que
  `resultStore` tenga en ese instante (que puede ya reflejar una fuente que
  abrió rapidísimo), y desde ahí queda escuchando `resultStore` — cualquier
  `resultStore.set(...)` futuro se refleja en el `FieldStore` que el
  consumidor lee. Todo builder integrado (`string()`, `numeric()`, ...) usa
  `reduceFromStart(parse, defaultValue)` para este `reduce`: construye un
  `Store` con `parse(rawStore.get())` y lo mantiene vivo re-ejecutando
  `parse` en cada `rawStore.listen()` — la misma función que `start` usa,
  reutilizada como su propio "recompute".

- **Si devuelve `undefined`** (no se pasó ningún `reduce`), no hay nada que
  encadenar — **el campo se queda para siempre en el valor que `start()`**
  sembró en la Fase 1, sin importar qué publique la fuente después. `reduce`
  es lo único que puede actualizar un campo; omitirlo no cae a ningún
  comportamiento por defecto.

**La promesa de `reduce()` de cada campo (cuando la hay) se encola en
`embeddedReady`** — es la pieza que hace que `await cfg` no resuelva hasta
que todo campo con `reduce` (no solo las fuentes) esté listo. Un campo sin
`reduce` no aporta nada a `embeddedReady` — no retrasa ni afecta el `then()`
del nodo.

## Fase 4 — Vida en vivo

Una vez que la Fase 2 y la Fase 3 resolvieron por primera vez, el nodo queda
en régimen permanente: cualquier `Source` que siga publicando (un
`control.set()` posterior, un SSE, un `fs.watch`, un timer propio dentro de
un `reduce` a medida) dispara la misma cadena:

```
Source.control.set(value)
  → rawSources[i].set(value)
    → keyStore recalcula (si el path cambió)
      → resultStore.set(next)   (dentro del reduce que el Descriptor haya dado)
        → fieldStore.set(next)  (vía el listen() que Fase 3 dejó armado)
```

Esta cadena **solo existe si el campo tiene un `reduce`** — es lo que
`resultStore` es. Sin `reduce`, no hay `resultStore`, no hay `listen()`
armado en la Fase 3, y por lo tanto nada de esto ocurre nunca: el `Source`
puede seguir publicando indefinidamente sin que ese campo se entere.

Nada de esto vuelve a llamar `start()` — **`start()` corre exactamente una
vez por campo, siempre**. Toda actualización posterior sale del `Store` que
`reduce()` resolvió. Si ese `Store` no escucha nada (un `reduce` que solo
toma un snapshot puntual sin `rawStore.listen(...)`), el campo queda fijo en
ese valor para siempre — ver
[`src/config-node.spec.ts`](../../src/config-node.spec.ts), describe `create
— a custom Descriptor's own reduce() timing vs. its source's`, test *"if
reduce()'s own Store doesn't stay live off rawStore..."*.

## `then()`: qué significa que el nodo esté "listo"

```ts
const ready = Promise.all([ownReady, ...embeddedReady]).then(() => node);
```

`await cfg` (o `cfg.then(...)`) resuelve cuando **las dos fases asíncronas
terminaron su primera vuelta**: cada `Source` propia abrió (Fase 2) *y* cada
campo (y cada nodo `create()` embebido) resolvió su `reduce()` al menos una
vez (Fase 3). No implica que nada vaya a dejar de cambiar después — un
`liveTestSource`, un SSE o el propio `reduce` de un `Descriptor` pueden
seguir publicando indefinidamente; `then()` solo marca "la primera vuelta ya
pasó, los valores ya no son solo el default".

El objeto al que resuelve (`node`) es el mismo árbol de `Store`s de siempre,
pero **sin** `then`/`close` — para volver a llamarlos hay que quedarse con la
referencia que `create()` devolvió, no con el resultado de `await`earla.

## Fase 5 — Cierre (`close()`)

```ts
close(): Promise<void> {
  return Promise.all([...closers.map((close) => close()), ...sources.map((source) => source.close())]).then(() => undefined);
}
```

`cfg.close()` corre, todo en paralelo, en una sola llamada:

- El `close()` de cada `Descriptor` de campo (`closers`, armados en la Fase
  1) — no-op si ese `Descriptor` no dio uno.
- El `close()` de cada nodo `create()` embebido (que a su vez repite este
  mismo proceso, recursivamente, sobre sus propias fuentes/campos).
- El `close()` de cada `Source` propia de este nodo (`options.sources`) —
  cierra su conexión/timer/watcher interno.

Es seguro llamarlo en cualquier momento (antes o después de que `then()`
resuelva) y más de una vez — `Source.close()` ya es idempotente por su
cuenta, y `Promise.all` sobre closers que ya resolvieron no vuelve a
ejecutarlos.

## `start()` vs `reduce()`: cuántas veces se llama cada uno

| Método | Cuántas veces | Cuándo |
|---|---|---|
| `descriptor.start(raw, path)` | **Exactamente 1**, por campo | Síncronamente, en `buildField()`, durante la Fase 1 — antes de que cualquier fuente haya abierto. |
| `descriptor.reduce(rawStore, path)` | **Exactamente 1**, por campo | Inmediatamente después de `start()`, también en la Fase 1. Si el `Descriptor` no recibió un `reduce` en su constructor, esta llamada devuelve `undefined` **síncronamente** (no una `Promise`) — no hay nada más que llamar. |
| El `Store` que `reduce()` resuelve (si lo hay) | Tantas veces como haga `.set()` | Cualquier momento posterior — típicamente porque escucha `rawStore` (reactividad "normal", vía `reduceFromStart`), pero puede ser cualquier otra fuente de cambio (un timer propio, otra suscripción). |

`start` nunca se re-invoca — toda la reactividad "de ahí en más" vive dentro
del `Store` que `reduce` produjo, si es que produjo alguno. **Sin `reduce`,
no hay ninguna otra actualización**: el campo se queda para siempre en lo
que `start()` sembró — no es un caso raro que "cae a algo", es literalmente
la única opción cuando no hay `reduce`. Ver
[`src/config-node.spec.ts`](../../src/config-node.spec.ts), describe `create
— a custom Descriptor's own reduce() timing vs. its source's`, test *"a
Descriptor built with only start() (no reduce in the constructor) never
updates, even once its source opens"*, y el test que sí combina ambos: un
`Descriptor` cuyo `reduce` sigue en vivo al `rawStore` (recibe la
actualización de la fuente) **y además** programa su propia actualización
posterior, independiente de la fuente.

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
    hijo abra;
  - encola `entry.close()` en sus propios `closers`, así que `padre.close()`
    también cierra al hijo (y, en cascada, las fuentes del hijo).

## Ejemplo con timings reales

Extraído de `src/config-node.spec.ts` (describe `create — a custom
Descriptor's own reduce() timing vs. its source's`):

```ts
// Descriptor: start() cae al default; reduce() se queda escuchando rawStore
// (para la actualización real de la fuente) y además programa su propio
// override, sin relación con la fuente.
function delayed(defaultValue: number, overrideAfterMs: number, overrideValue: number) {
  const parse = (raw: unknown) => (raw == null ? defaultValue : Number(raw));
  return new Descriptor<number>({
    type: "delayed",
    options: { default: defaultValue },
    start: parse,
    async reduce(rawStore) {
      const store = new Store(parse(rawStore.get()));
      rawStore.listen((raw) => store.set(parse(raw)));
      setTimeout(() => store.set(overrideValue), overrideAfterMs);
      return store;
    },
  });
}

const source = new Source<{ value?: string }>({
  start(control) {
    setTimeout(() => control.set({ value: "2000" }), 20);
  },
});

const cfg = create({ value: delayed(3000, 40, 4000) }, { sources: [source] });

cfg.value.get(); // 3000 — Fase 1: start() corrió con rawStore.get() === null
// ... ~30ms después
cfg.value.get(); // 2000 — Fase 4: la fuente publicó, rawStore.listen() de reduce() lo propagó
// ... ~50ms después
cfg.value.get(); // 4000 — Fase 4: el setTimeout propio de reduce() disparó su propio store.set()
```

Línea de tiempo:

```
t=0ms    create() devuelve el nodo. start() ya corrió (una vez). value = 3000
t=0ms    reduce() ya corrió (una vez), devolvió su Promise<Store<number>>
t≈0ms    la Promise de reduce() resuelve (microtask) → FieldStore adopta el Store de reduce
t=20ms   la Source publica "2000" → rawStore cambia → el listen() de reduce lo propaga → value = 2000
t=40ms   el setTimeout propio de reduce() dispara → store.set(4000) → value = 4000
```

## Errores durante el ciclo de vida

- Un `start()`/`reduce()` que **lanza** de forma síncrona (p. ej. un
  `numeric()` con un raw inválido) se comporta distinto según de dónde
  venga: si pasa dentro de `start()` en la Fase 1, la excepción sale
  síncronamente de `create()` mismo — pero como en ese punto `rawStore.get()`
  casi siempre es `null` (ninguna fuente abrió aún), en la práctica esto solo
  se dispara cuando el valor inválido viene del propio `options.default`.
  El caso típico — una fuente que publica un valor inválido — pasa por el
  `reduce` que el builder armó con `reduceFromStart` (que internamente vuelve
  a llamar el mismo `parse` que `start` usa), y ahí una excepción se propaga
  como el *rechazo* de la promesa de `reduce()`, que a su vez hace fallar
  `ready` (y por lo tanto el `await cfg`) con ese error — ver "`create()` —
  parser failures" en `config-node.spec.ts`.
- Un `Store` que sí llegó a resolver (`.get()` ya devuelve el valor
  esperado) sigue siendo legible aunque `await cfg` termine rechazando: el
  rechazo afecta al `then()` del nodo completo, no a los `Store`s
  individuales ya construidos.
