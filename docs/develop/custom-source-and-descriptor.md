# Escribir un `Source` y un `Descriptor` propios

Este documento profundiza en los dos puntos de extensión de la librería —
`Source` (`src/sources/source.ts`) y `Descriptor` (`src/config-descriptor.ts`)
— más allá de lo que cubren las secciones "Writing a custom `Descriptor`" y
"`Source` — building a custom source" del README, que son necesariamente
breves por formar parte de una guía general de arranque. Es la referencia
para quien va a construir su propio `Source`/`Descriptor` a mano: el
contrato completo, los patrones reales que hacen falta en la práctica, y los
errores comunes al escribir uno. El código fuente sigue siendo la fuente de
verdad — en particular los seis builders de `config-descriptor.ts`
(`string()`, `numeric()`, `boolean()`, `url()`, `shape()`, `choice()`),
`file()` en `src/node.ts`, y los sources integrados en `src/sources/*.ts`
(`envSource`, `fetchSource`, `sseSource`, `fileSource`, `literalSource`) —
todos son ejemplos reales de ambos puntos de extensión hechos bien, y este
documento se apoya en ellos en vez de inventar sintaxis nueva. Ver también
[`docs/develop/lifecycle.md`](./lifecycle.md), que explica desde el lado de
`create()`/`load()` cuándo se llama cada pieza — este documento explica lo
mismo desde el lado de quien escribe el `Source`/`Descriptor`.

## Tabla de contenido

- [Los dos puntos de extensión, en una frase](#los-dos-puntos-de-extensión-en-una-frase)
- [`Source`: el contrato completo](#source-el-contrato-completo)
  - [`start(control)`](#startcontrol)
  - [`close()`](#close)
  - [`reduce(incoming, previous)`](#reduceincoming-previous)
  - [`metrics`](#metrics)
- [Patrones de `Source`](#patrones-de-source)
  - [Un valor único (`literalSource`)](#un-valor-único-literalsource)
  - [Un source que hace polling](#un-source-que-hace-polling)
  - [Un source que limpia una conexión/timer en `close()`](#un-source-que-limpia-una-conexióntimer-en-close)
  - [`reduce` con parches parciales vs. snapshots completos](#reduce-con-parches-parciales-vs-snapshots-completos)
- [`Descriptor`: el contrato completo](#descriptor-el-contrato-completo)
  - [`start(control)`](#startcontrol-1)
  - [Por qué no hay `reduce()` en `Descriptor`](#por-qué-no-hay-reduce-en-descriptor)
  - [`close()`](#close-1)
- [Patrones de `Descriptor`](#patrones-de-descriptor)
  - [Campo escalar con `parse`/`defaultValue`](#campo-escalar-con-parsedefaultvalue)
  - [Campo cuyo tipo no es un escalar plano](#campo-cuyo-tipo-no-es-un-escalar-plano)
  - [`WithDefault<O, T>` — el mismo tipado `T | null` / `T` que los builders integrados](#withdefaulto-t--el-mismo-tipado-t--null--t-que-los-builders-integrados)
  - [Escribir un `Descriptor` como objeto plano, sin `new Descriptor(...)`](#escribir-un-descriptor-como-objeto-plano-sin-new-descriptor)
- [`isConfigDescriptor()`: por qué es estructural y no `instanceof`](#isconfigdescriptor-por-qué-es-estructural-y-no-instanceof)
- [Errores comunes](#errores-comunes)

## Los dos puntos de extensión, en una frase

- **`Source`** decide *de dónde* viene el árbol de datos crudo de una
  configuración (env vars, un endpoint HTTP, SSE, un archivo, ...) — publica
  snapshots (`unknown`) hacia el motor de `create()`/`load()`, sin saber
  nada de campos ni de tipos.
- **`Descriptor`** decide *cómo* se calcula el valor tipado de un campo
  concreto a partir de ese dato crudo ya fusionado entre fuentes — sabe de
  parsing, defaults y tipos, pero nada de dónde vino el dato.

Ambos están modelados sobre el mismo patrón — `UnderlyingSource` de
`ReadableStream` — hasta el punto de compartir la forma exacta del
contrato: un `start(control)` que corre una vez y un `close()` opcional.
`Descriptor` es, literalmente, el mismo contrato de `Source` aplicado a un
campo en vez de a un árbol completo — con una diferencia deliberada: no
tiene `reduce()` (ver [más abajo](#por-qué-no-hay-reduce-en-descriptor)).

## `Source`: el contrato completo

```ts
export interface SourceControl<T> {
  set(value: T): void;
  close(): void;
}

export interface UnderlyingSource<T> {
  start(control: SourceControl<T>): void | Promise<void>;
  close?(): void | Promise<void>;
  reduce?(incoming: T, previous: T | null): T;
  metrics?: Record<string, Metric>;
}

new Source<T>(underlying: UnderlyingSource<T>): Source<T>
```

(`src/types/source.ts`, `src/sources/source.ts`.)

### `start(control)`

- Corre **exactamente una vez** por `Source`, disparado — todavía
  síncronamente dentro del `new Source(...)` que lo crea, pero envuelto en
  un `Promise.resolve().then(...)`, así que en la práctica corre en el
  primer microtask, antes de que nada que dependa de `source.open()` pueda
  observarlo.
- `control.set(value)` publica el siguiente snapshot **completo** del árbol
  — no un parche, salvo que la `Source` dé un `reduce` (ver abajo).
  Llamable cualquier cantidad de veces: una fuente estática como
  `literalSource`/`envSource` la llama una vez y cierra; una fuente en vivo
  como `sseSource`/`fileSource` (con `watch`) la llama de nuevo cada vez que
  hay un dato nuevo, indefinidamente.
- `source.open()` — lo que `create()` espera internamente para conectar
  esta fuente al árbol (ver la Fase 2 de
  [`lifecycle.md`](./lifecycle.md#fase-2--apertura-de-las-fuentes-ownready))
  — resuelve recién cuando la propia llamada a `start()` termina de correr
  (su valor de retorno, awaited si es una `Promise`). Esto **no** significa
  que la fuente ya tenga datos: un `start` que solo arma un `setInterval` y
  retorna de inmediato hace que `open()` resuelva casi al instante, con el
  `Store` interno todavía en `null` hasta el primer `control.set()`. Para
  que `open()` (y por lo tanto `await cfg` en el nodo) espere a tener el
  primer valor real, `start` debe quedarse en un `await` hasta que ese
  primer `control.set()` haya corrido — así lo hace `sseSource`, con una
  `Promise` que solo se resuelve tras el primer mensaje (ver
  [abajo](#reduce-con-parches-parciales-vs-snapshots-completos)).
- `close()` desde dentro de `start` — `control.close()` — es solo una
  señal semántica ("no se esperan más `set()`"); en la implementación actual
  no hace nada por sí sola más que documentar la intención. Nada impide
  llamar `control.set()` después, pero ningún `Source` integrado lo hace.

### `close()`

El `close()` que le pasás al constructor de `Source` (no `control.close()`)
es donde se libera lo que `start` haya dejado corriendo — un timer, una
conexión `fetch`/SSE en curso, un `fs.watch`. `Source.close()` (el método
público del `Source`, el que `create()` llama desde el `close()` del nodo)
llama ese hook **a lo sumo una vez**, sea que lo dispare el propio `start`
(vía `control.close()`), o una llamada externa — y es seguro llamarlo
cualquier cantidad de veces, antes o después de que `open()` resuelva.

### `reduce(incoming, previous)`

Cuando `start()` solo puede producir **parches parciales**, en vez de un
snapshot completo cada vez (el caso típico: un mensaje SSE, una línea de un
archivo que cambió), `reduce` es lo que decide cómo combinar ese parche con
lo último publicado. Cada `control.set(value)` pasa por `reduce(value,
previous)` antes de llegar al `Store` interno — `previous` es `null` antes
del primer `set()`. Sin `reduce`, cada `control.set()` reemplaza el árbol
entero.

### `metrics`

Opcional — un `Record<string, Metric>` (`CounterMetric`/`HistogramMetric`/
`GaugeMetric` de `src/utils/metric.ts`) que el `Source` bumpea desde adentro
de `start()`/`close()` y que queda expuesto tal cual en `source.metrics`
para quien quiera exportarlo (p. ej. a un endpoint Prometheus). Ver
`envSource`/`fetchSource`/`sseSource`/`fileSource` para el patrón — cada uno
arma sus propias métricas con una función `createMetrics()` local.

## Patrones de `Source`

### Un valor único (`literalSource`)

El caso más simple: publica una vez y cierra. `src/sources/literal.ts`
completo:

```ts
export function literalSource<T = unknown>(value: T): Source<T> {
  return new Source<T>({
    start(control) {
      control.set(value);
      control.close();
    },
  });
}
```

`envSource` sigue exactamente el mismo patrón (construye el árbol entero de
una pasada sobre `env`, `control.set(tree)`, `control.close()`) — ver
`src/sources/env.ts`.

### Un source que hace polling

El del README, con la forma real de la sección
["`Source` — building a custom source"](../../README.md#source--building-a-custom-source):

```ts
import { Source } from "@jondotsoy/configs";

function pollingSource(url: string, intervalMs: number): Source<{ port: number }> {
  let timer: ReturnType<typeof setInterval>;

  return new Source({
    async start(control) {
      const poll = async () => control.set((await (await fetch(url)).json()) as { port: number });
      await poll(); // primer valor antes de que open() resuelva
      timer = setInterval(poll, intervalMs);
    },
    close() {
      clearInterval(timer);
    },
  });
}
```

El `await poll()` antes de armar el `setInterval` es lo que hace que
`source.open()` (y por lo tanto `await cfg`) esperen a tener el primer
valor real en vez de resolver con el `Store` todavía vacío. `fetchSource`
hace lo mismo con su propio `pollingInterval`/`followCacheControl`, más
reintentos y `Cache-Control`/condicionales — ver `src/sources/fetch.ts`
para la versión productiva completa de este mismo patrón.

### Un source que limpia una conexión/timer en `close()`

`fileSource` (`src/sources/file.ts`) es el ejemplo real más completo: abre
un `fs.watch` **o** un `setInterval` de polling (según `options.watch`), y
libera lo que haya abierto en `close()`:

```ts
let watcher: FSWatcher | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;

return new Source<T>({
  async start(control) {
    await readOnce(); // primer valor antes de que open() resuelva
    if (!watchOption) { control.close(); return; }
    if (typeof watchOption === "object") {
      pollTimer = setInterval(() => void readOnce(), watchOption.interval);
      return;
    }
    watcher = watch(path, { persistent: false }, () => void readOnce());
  },
  close() {
    watcher?.close();
    clearInterval(pollTimer);
  },
});
```

`sseSource` (`src/sources/sse.ts`) es el ejemplo de limpiar una conexión en
vez de un timer: guarda un `AbortController` fuera de `start`, y `close()`
simplemente lo aborta (`abortController.abort()`), lo que a su vez hace
fallar el `fetch`/la lectura del stream que `start` tiene en curso.

### `reduce` con parches parciales vs. snapshots completos

- **Snapshot completo cada vez** (`envSource`, `literalSource`,
  `fileSource` sin `reduce`): no hace falta `reduce` — cada `control.set()`
  ya es el árbol entero, así que se reemplaza tal cual.
- **Parches parciales** (`sseSource`): cada mensaje SSE es, típicamente, un
  objeto con solo los campos que cambiaron. `sseSource` da un `reduce` que
  hace un merge superficial (`{ ...previous, ...patch }`) salvo que
  `overwrite: true` esté seteado:

  ```ts
  const defaultReduce = (patch: T, previous: T | null): T =>
    overwrite
      ? patch
      : ({ ...((previous as Record<string, unknown> | null) ?? {}), ...(patch as Record<string, unknown>) } as T);

  return new Source<T>({
    async start(control) {
      // ... por cada mensaje SSE válido:
      control.set(parsed as T);
    },
    reduce: reduce ?? defaultReduce,
    close() { abortController.abort(); },
  });
  ```

  `fileSource` también acepta un `reduce` opcional (sin uno propio por
  defecto — cada lectura reemplaza el árbol entero), pensado para el caso en
  que el archivo mismo solo contenga un delta y el consumidor quiera
  fusionarlo a mano con lo último leído.

Regla práctica: si `start()` alguna vez le pasa a `control.set()` algo que
no es "el árbol de configuración entero, tal cual debe quedar", hace falta
un `reduce` — de lo contrario cada publicación pisa por completo a la
anterior.

## `Descriptor`: el contrato completo

```ts
export interface DescriptorControl<T> {
  rawStore: ReadOnlyStore<unknown>;
  path: string[];
  set(value: T): void;
}

export interface DescriptorUnderlying<T, O extends object = object> {
  type: FieldType;
  options: O;
  start(control: DescriptorControl<T>): void | Promise<void>;
  close?(): Promise<void>;
}

new Descriptor<A, B, O>(underlying: DescriptorUnderlying<A, O>): Descriptor<A, B, O>
```

(`src/config-descriptor.ts`.) `A` es lo que `.get()` devuelve ahora mismo
(`T` o `T | null` según si hay `default` — ver `WithDefault<O, T>` más
abajo); `B` es el tipo ya resuelto del campo, siempre `T`, sin importar si
hay `default`.

### `start(control)`

Igual que en `Source`, pero a nivel de un solo campo en vez de un árbol
completo — y llamado por `create()`/`load()`, no por el propio
`Descriptor`:

- Corre **exactamente una vez** por campo, síncronamente, en el momento en
  que `create()` construye ese campo (Fase 1 en
  [`lifecycle.md`](./lifecycle.md#fase-1--construcción-síncrona-buildnodebuildfield))
  — antes de que ninguna fuente haya abierto.
- `control.rawStore` es el valor crudo en vivo de este campo, ya fusionado
  entre todas las `options.sources` según prioridad (el `Store` que arma
  `keyStore(rawSources, path)` en `config-node.ts`) — de solo lectura:
  `.get()`/`.subscribe()`/`.listen()`, nunca `.set()` desde acá (escribir el
  raw no es trabajo de este hook).
- `control.path` — el path resuelto de este campo (`["server", "port"]`,
  o lo que `key` haya dado) — solo sirve para etiquetar mensajes de error.
- `control.set(value)` publica el siguiente valor **tipado** del campo.
  Llamable síncronamente dentro de `start` (tick 0 — el campo ya tiene ese
  valor cuando `create()` retorna, sin `await`), y/o cualquier cantidad de
  veces después, desde donde sea: un callback de
  `control.rawStore.subscribe()`, un `setTimeout` propio, una promesa que
  resuelve más tarde — sin relación alguna con `rawStore` si `start` así lo
  decide.

`create()` nunca vuelve a tocar el `Store` del campo por su cuenta —
`control.set()` es la única forma en que cambia, para siempre.

### Por qué no hay `reduce()` en `Descriptor`

A diferencia de `Source`, `Descriptor` **no** tiene un hook `reduce`
separado — es deliberado. La reactividad completa de un `Descriptor` es
100% `control.rawStore.subscribe(...)`: el propio callback que se le pasa a
`subscribe` ya recibe el `raw` fusionado más reciente en cada disparo (tick
0 incluido) y puede hacer ahí mismo cualquier combinación que necesite —
correr `parse`, caer a un `defaultValue`, comparar contra el valor anterior
si hiciera falta. No hace falta un paso de reducción aparte porque, al
contrario que un `Source` (que puede recibir *parches* de su origen externo,
sin control sobre esa forma), un `Descriptor` siempre parte del mismo lugar:
un único `rawStore` ya resuelto para ese campo. Todo builder integrado
(`string()`, `numeric()`, `boolean()`, `url()`, `shape()`, `choice()`,
`file()`) sigue el mismo patrón de una sola línea:

```ts
start(control) {
  control.rawStore.subscribe((raw) => {
    control.set(raw === undefined || raw === null ? defaultValue : parse(raw, control.path));
  });
},
```

### `close()`

Opcional, mismo rol que en `Source`: libera lo que `start` haya dejado
corriendo (un timer propio, una suscripción externa). `create()`'s propio
`close()` llama el `close()` de cada campo una vez — `control` no ofrece
ningún mecanismo de limpieza propio, así que si `start` abre algo, es
responsabilidad de `start` dejarlo accesible desde `close`.

## Patrones de `Descriptor`

### Campo escalar con `parse`/`defaultValue`

La forma base — `parse`/`defaultValue` como `const`s locales, referenciadas
una sola vez desde el único `control.rawStore.subscribe(...)`, igual que
`string()`/`numeric()` por dentro:

```ts
import { Descriptor, create, type WithDefault } from "@jondotsoy/configs";
import { envSource } from "@jondotsoy/configs/sources/env";

function port<const O extends { key?: string | string[]; default?: number } = {}>(
  options?: O,
): Descriptor<WithDefault<O, number>, number> {
  const opts = (options ?? {}) as O;
  const parse = (raw: unknown, path: string[]): number => {
    const num = Number(raw);
    if (typeof raw !== "string" || raw.trim() === "" || Number.isNaN(num) || num <= 0) {
      throw new Error(`Expected a positive port number at "${path.join(".")}"`);
    }
    return num;
  };
  const defaultValue = opts.default !== undefined ? opts.default : (null as unknown as number);

  return new Descriptor<number, number>({
    type: "port",
    options: opts,
    start(control) {
      control.rawStore.subscribe((raw) => {
        control.set(raw === undefined || raw === null ? defaultValue : parse(raw, control.path));
      });
    },
  }) as Descriptor<WithDefault<O, number>, number>;
}

// PORT=3000
const cfg = await create({ port: port({ key: "PORT", default: 8080 }) }, { sources: [envSource()] });
cfg.port.get(); // 3000
```

### Campo cuyo tipo no es un escalar plano

El mismo esqueleto escala sin cambios a un tipo compuesto — `csv()` parsea
un string a `string[]` en vez de a un `number`, pero `parse`/`defaultValue`/
`start` son idénticos en forma:

```ts
function csv(options: { key?: string | string[]; default?: string[] } = {}) {
  const parse = (raw: unknown, path: string[]): string[] => {
    if (typeof raw !== "string") throw new Error(`Expected a comma-separated string at "${path.join(".")}"`);
    return raw.split(",").map((s) => s.trim());
  };
  const defaultValue = options.default ?? [];

  return new Descriptor({
    type: "csv",
    options,
    start(control) {
      control.rawStore.subscribe((raw) => {
        control.set(raw == null ? defaultValue : parse(raw, control.path));
      });
    },
  });
}
```

`file()` (`src/node.ts`) es el ejemplo real más elaborado de esta misma
receta con un tipo compuesto: su `FileBlob` resuelto envuelve bytes en
memoria más metadata (`location`, `size`, `type`, y métodos async como
`.text()`/`.json()`/`.bytes()`), pero el `start` que lo produce sigue siendo
el mismo `control.rawStore.subscribe((raw) => control.set(...))` de una
línea — solo cambia lo que hace el `parse` (`fileStart`) adentro.

Para algo que este esqueleto no cubre — un lookup async, un valor derivado
de más que el snapshot crudo, un timer propio independiente de la fuente —
`start(control)` puede hacer lo que necesite; nada en `create()` lo espera:
`control.set()` corre síncronamente (tick 0) y/o desde una continuación
`async` más tarde, en el propio horario de `start`:

```ts
function pollingDescriptor() {
  let timer: ReturnType<typeof setInterval> | undefined;
  return new Descriptor<number>({
    type: "poll",
    options: {},
    start(control) {
      control.rawStore.subscribe((raw) => control.set(Number(raw ?? 0))); // dispara también en tick 0
      timer = setInterval(() => control.set(Math.random()), 1000);
    },
    async close() {
      clearInterval(timer);
    },
  });
}
```

### `WithDefault<O, T>` — el mismo tipado `T | null` / `T` que los builders integrados

```ts
export type WithDefault<O, T> = O extends { default: any } ? T : T | null;
```

Es el helper que usa cada builder integrado para calcular su propio primer
parámetro de tipo de `Descriptor<A, B>`: `T` cuando `O` trae `default`, `T |
null` si no. Se exporta desde la raíz del paquete precisamente para que un
builder propio (como `port()`/`csv()` arriba, o `file()` en `src/node.ts`)
pueda calcular su propio `Descriptor<A, B>` de retorno con la misma regla,
sin reinventarla — el "cast final" (`as Descriptor<WithDefault<O, T>, T>`)
es el mismo patrón en los tres: `string()`, `numeric()`, `boolean()`,
`url()`, `shape()`, `choice()` lo hacen así, y `file()` en `src/node.ts` lo
mismo con `FileFieldValue<O>`.

Un `Descriptor` escrito a mano no está obligado a usarlo — un
`Descriptor<number, number>` fijo (sin `WithDefault`) también compila,
simplemente tipa `.get()` siempre como `number`, nunca `number | null`, sin
importar si `options.default` se dio o no. `WithDefault` solo hace falta
cuando se quiere que el tipo del campo reaccione a si el llamador pasó
`default`, igual que los builtins.

### Escribir un `Descriptor` como objeto plano, sin `new Descriptor(...)`

`isConfigDescriptor()` (ver [la sección siguiente](#isconfigdescriptor-por-qué-es-estructural-y-no-instanceof))
reconoce cualquier valor con un método `.start()`, no específicamente una
instancia de la clase `Descriptor`. Esto significa que un shape entry no
necesita pasar por `new Descriptor(...)` en absoluto — un objeto plano con
la forma correcta funciona igual:

```ts
function csvPlain(options: { key?: string | string[]; default?: string[] } = {}) {
  const defaultValue = options.default ?? [];
  return {
    type: "csv" as const,
    options,
    start(control: DescriptorControl<string[]>) {
      control.rawStore.subscribe((raw) => {
        control.set(
          raw == null
            ? defaultValue
            : typeof raw === "string"
              ? raw.split(",").map((s) => s.trim())
              : (() => { throw new Error(`Expected a comma-separated string at "${control.path.join(".")}"`); })(),
        );
      });
    },
  };
}
```

`create()` lo acepta exactamente igual que un `new Descriptor(...)` real —
la clase `Descriptor` es una conveniencia (guarda `type`/`options`, expone
`.key`/`.freeze`, envuelve `start`/`close`), no un requisito estructural.
Lo único que hace falta para que `isConfigDescriptor()` lo reconozca es la
propia función `start`.

## `isConfigDescriptor()`: por qué es estructural y no `instanceof`

```ts
export function isConfigDescriptor(node: unknown): node is Descriptor<unknown, unknown> {
  if (typeof node !== "object" || node === null) return false;
  return typeof (node as { start?: unknown }).start === "function";
}
```

La razón está en cómo se empaqueta esta librería: `bun build` compila cada
punto de entrada público (`.`, `./sources/env`, `./node`, ...) de forma
**independiente** — ver `scripts/build.ts` y el mapa `_buildEntripoint` de
`package.json`. Eso significa que `file()`, exportado desde el entry point
`./node`, termina con su propia copia bundleada de la clase `Descriptor`,
separada de la copia que usa `configs.ts` (el entry point `.`) para su
propio `isConfigDescriptor`. Un `instanceof Descriptor` comparando esas dos
copias — dos clases con el mismo nombre pero distinto origen de módulo —
daría `false` aunque el objeto sea, en todo sentido práctico, un
`Descriptor` real. Comprobar solo la presencia de `.start` como función
sobrevive a esa duplicación entre bundles, del mismo modo que lo hacía el
símbolo de registro `CONFIG_DESCRIPTOR_TAG` (ya eliminado) que esta
comprobación reemplazó. `.close` deliberadamente **no** se exige — es
opcional incluso en un `Descriptor` escrito a mano (`create()`'s propio
`close()` solo lo llama cuando está presente).

## Errores comunes

- **Olvidar suscribirse a `control.rawStore`.** Un `start` que llama
  `control.set()` una sola vez y nunca escucha `control.rawStore.subscribe(...)`
  ni arma nada propio (timer, promesa) deja el campo fijo **para siempre**
  — sin ningún error, sin ningún warning. No es un caso raro que "cae a
  algo": es literalmente el comportamiento documentado cuando `start` no
  deja nada más corriendo. Ver "`start(control)` is 100% in control of the
  field's value" en
  [`lifecycle.md`](./lifecycle.md#startcontrol-cuántas-veces-se-llama-y-qué-hace-cada-parte-de-control).

- **Un `start` que lanza síncronamente vs. uno que lanza desde
  `rawStore.subscribe()`, son caminos de fallo distintos.** Si `start`
  lanza una excepción **síncronamente**, dentro de la propia llamada
  durante la construcción del nodo (p. ej. un `options.default` inválido
  que el propio `parse` rechaza ahí mismo), la excepción sale síncronamente
  de `create()` mismo — muy raro en la práctica, porque
  `control.rawStore.get()` casi siempre es `null` en ese instante (ninguna
  fuente abrió todavía) y el `parse` no llega a correr contra un valor
  real. El caso típico — una fuente publica algo inválido — pasa en cambio
  por el callback de `control.rawStore.subscribe(...)`: esa excepción se
  lanza síncronamente dentro de la cadena `Source.control.set()` →
  `rawSources[i].set()` → `keyStore` → `subscribe()` → `parse()` lanza, la
  cual, para la primera publicación de una fuente, corre dentro del
  `.then()` que arma `ownReady` — así que ahí se convierte en un **rechazo
  de promesa**, que rechaza `await cfg`, no en una excepción que salga de
  `create()`. Una actualización *posterior* de una fuente en vivo, en
  cambio, lanza como excepción síncrona real desde quien haya llamado
  `control.set()` en esa fuente. Ver la sección "Errores durante el ciclo
  de vida" en
  [`lifecycle.md`](./lifecycle.md#errores-durante-el-ciclo-de-vida) para el
  detalle completo — sigue siendo la referencia autoritativa de este
  comportamiento.

- **Confundir `control.close()` (de `Source`) con `close()` del
  constructor.** `control.close()`, llamado desde dentro de `start`, es
  solo una señal ("no se esperan más `set()`") — no libera nada por sí
  sola. Lo que efectivamente limpia un timer, una conexión o un watcher es
  el `close()` que se le pasa al constructor de `Source`/`Descriptor`, que
  `create()` llama desde el `close()` del nodo (o, para `Source`, también
  se dispara si alguien llama `source.close()` directamente). Si `start`
  abre algo, tiene que dejarlo accesible desde ese `close()` propio —
  `control` no da ningún mecanismo de limpieza.

- **Esperar que `reduce` exista también en `Descriptor`.** No lo tiene, a
  propósito — ver [Por qué no hay `reduce()` en
  `Descriptor`](#por-qué-no-hay-reduce-en-descriptor) arriba. Toda
  combinación de valores para un campo va dentro del propio callback de
  `control.rawStore.subscribe(...)`.

- **Un `start` async cuyo `open()`/construcción del nodo resuelve antes de
  tener el primer dato real.** `source.open()` espera solo a que la
  llamada a `start()` termine de correr, no a que `control.set()` se haya
  llamado. Un `start` que arma un timer/watcher y retorna de inmediato (sin
  `await`ar un primer valor) hace que `open()` resuelva con el `Store`
  interno todavía en `null` — no es necesariamente un bug (`fileSource`,
  `pollingSource` arriba, evitan esto con un `await primeraLectura()` antes
  de armar el timer), pero es una decisión consciente: si el consumidor
  necesita que `await cfg` espere al primer valor real, `start` tiene que
  quedarse en un `await` hasta que ese primer `control.set()` corra.
