# `create()`: el motor legado vs el nuevo `config-node.ts`

El repo tiene, a propósito, **dos implementaciones de `create()` sin relación entre sí**:

- **Legado** — `configs.create()` / `create()` exportado desde `src/configs.ts`, motor real en
  `src/config.types.ts` (`createConfigNode()` / `ConfigNodeState`). **`@deprecated`**.
- **Nueva** — `create()` exportado desde `src/config-node.ts`. Reescrita desde cero, sin compartir
  código ni tipos con la legada, con el objetivo explícito de minimizar la implementación.

Este documento compara el *approach* de cada una — no es una guía de uso (esa es el `README.md`) sino
una referencia para quien toque cualquiera de los dos motores y necesite saber en qué se parecen, en
qué no, y por qué.

## Tabla comparativa rápida

| Aspecto | Legado (`config.types.ts`) | Nuevo (`config-node.ts`) |
| --- | --- | --- |
| Nodo devuelto | `Proxy` sobre un objeto plano | Objeto plano, sin `Proxy` |
| Raíz expone | `.get()`/`.subscribe()`/`.listen()`/`.close()`/`[Symbol.asyncDispose]` + cada campo | **solo** cada campo (ningún método de agregación en la raíz) |
| Cálculo de campos | perezoso y cacheado (`fieldFor()`/`childNode()`, `Map`) | eager: recalcula **todo** el árbol en cada `sync()` |
| Resolución de un campo | `ConfigDescriptor.parse()` (async, se suscribe a un `Store<unknown>` en vivo) | `ConfigDescriptor.reduce()` (sync, recibe el raw ya resuelto) |
| Grupos anidados | `configs.create({...})` embebido — puede traer **sus propias `sources`**, independientes del padre | objeto plano anidado en el shape — **siempre comparte** las `sources` del `create()` raíz |
| `key` (path override) | soportado (`descriptor.key`) | **no soportado** — el path de resolución es siempre la ruta de anidamiento del shape |
| `freeze` | soportado (`wireDescriptorField` deja de escuchar tras el primer valor) | **no soportado** — cada `sync()` recalcula el campo igual, siempre |
| Actualizaciones en vivo | por campo, vía suscripción a cada `Store` de origen | por *todo el árbol*, vía `rawSource.listen(() => sync(...))` global |
| Cierre de fuentes | `.close()` en la raíz, recursivo sobre grupos embebidos | no expuesto — quien creó las `Source`s las cierra directamente |
| Shape legado (`{ type: "string", ... }`) | soportado, con warning de deprecación | no soportado — solo `ConfigDescriptor` (`string()`/`numeric()`/...) |
| Esquemas externos (`schema: z.object(...)`) sueltos como entrada de shape | soportado (`isBareParseable`) | no soportado directamente — hay que envolverlo en `shape({ schema })` |

## Arquitectura interna

### Legado: `Proxy` + estado cacheado por nodo

`createConfigNode()` construye un `ConfigNodeState` por nivel del árbol y lo envuelve en un
`Proxy` (`wrapNode()`). Cada acceso a una propiedad del shape pasa por el `get` trap del `Proxy`,
que decide en el momento si es un campo (`state.fieldFor(key)`) o un grupo anidado
(`state.childNode(key)`) y **cachea el resultado** (`fields`/`children`, ambos `Map`) — un campo
solo se construye la primera vez que se lee, y desde ahí el mismo `ConfigField` vive mientras el
nodo exista. Las actualizaciones en vivo llegan por campo: cada fuente abierta dispara
`refreshFields()`, que recorre `rawStores`/`fields`/`children` ya cacheados y solo toca lo que
cambió (comparando con `!==`).

Esto es lo que permite dos cosas que el nuevo motor no tiene: **`key`** (el campo puede declarar un
path de lectura distinto al de su posición en el árbol, resuelto vía `pathFor(descriptor.key, ...)`)
y **`freeze`** (`wireDescriptorField` deja de agregar el campo a `rawStores`, así que
`refreshFields()` ya no vuelve a tocarlo).

### Nuevo: recursión plana, sin `Proxy`, sin caché de "qué es cada key"

`create()` en `config-node.ts` no envuelve nada en un `Proxy`. `sync()` recorre el `shape`
recursivamente y, para cada key, decide con `isConfigDescriptor()` si es una hoja o un grupo
anidado — sin cachear esa decisión, porque el shape no cambia entre llamadas. Lo que sí se
reutiliza (para que un `Store` ya entregado a quien llamó a `create()` no se reemplace) es el
objeto de `Store`s en sí (`node[key]`), pasado por referencia en cada llamada recursiva y mutado
in place. **No hay estado por-campo aparte del propio `Store`**: no hay `Map` de campos, no hay
`readyPromise` por nodo, no hay distinción entre "nodo que posee su resolución" y "nodo que
comparte la del padre" — todo el árbol comparte las mismas `rawSources` del `create()` raíz,
siempre.

La consecuencia práctica: cualquier cambio en cualquier fuente dispara un `sync()` que **recalcula
el árbol completo**, no solo la rama afectada. Para el tamaño de shape típico de este paquete
(decenas de campos, no miles) es intrascendente en performance, y es justo el tipo de complejidad
que la nueva implementación decidió no cargar.

## Resolución de un campo: `parse()` vs `reduce()`

El legado resuelve un campo llamando a `descriptor.parse(rawStore, path)` — async, recibe un
`Store<unknown>` **en vivo** y se suscribe a él (`rawStore.listen(...)`) para recalcular el valor
cada vez que cambia, devolviendo `Promise<{ store: Store<T> }>`.

La nueva implementación fue el motivo por el que `ConfigDescriptor` ganó `.reduce(raw, path?)`
— **síncrono**, recibe el raw ya resuelto (no un `Store` para suscribirse) y devuelve
`{ store: ReadOnlyStore<T>, ready: Promise<ReadOnlyStore<T>> }` (`ready` es solo `store` envuelto
en una `Promise`, para quien migre desde el `await` de `.parse()`). `config-node.ts`'s `sync()`
llama a `.reduce(...)` en cada pasada, para cada campo, con el raw que él mismo mergeó desde
`rawSources` — la parte "en vivo" vive enteramente en `config-node.ts` (recalcular en cada
`sync()`), no en el descriptor.

`parse()` sigue existiendo — ahora implementado en términos de `reduce()` — y quedó marcado
`@deprecated`; sigue siendo lo único que usa el motor legado, que no fue tocado.

## Grupos anidados: sources independientes vs. sources siempre compartidas

En el legado, un grupo anidado es **otro `configs.create({...})` embebido** en el shape del padre.
Si ese `create()` interno recibió sus propias `options.sources`, resuelve **de forma
independiente** del árbol que lo contiene (`ownsResolution`); si no, comparte dinámicamente las
`rootStores` del padre (`ConfigNodeState.rootStores` getter). Esto es lo que permite el caso cubierto en `src/config.types.field-builders.spec.ts` bajo
`describe("a nested create() with its own sources scopes key lookups to those sources only")`.

En la nueva implementación, un grupo anidado es simplemente **un objeto plano** dentro del shape
(`{ server: { port: numeric() } }`, sin ningún `create()` de por medio) — no existe la noción de
"grupo con sources propias": todo el árbol, sin importar cuán anidado esté, se resuelve siempre
contra las mismas `options.sources` del `create()` raíz, buscando en cada fuente el path completo
anidado (`["server", "port"]`). No hay forma de que un subárbol lea de una fuente distinta a la del
resto — si se necesita eso, hay que usar el motor legado.

## Superficie del nodo devuelto

El legado devuelve, en la raíz **y en cada grupo anidado**, los métodos de `ConfigNode<S>`:
`shape`, `get()` (snapshot recursivo), `subscribe()`, `listen()`, `close()` y
`[Symbol.asyncDispose]()` — además de cada campo del shape. El nodo pendiente (antes de `await`)
añade `then()`.

La nueva implementación deliberadamente **no** expone ninguno de esos métodos de agregación: el
objeto devuelto por `create()` (y por cada grupo anidado dentro de él) solo tiene las keys del
shape, cada una resuelta a un `Store` (o a otro objeto anidado) — más `then()` mientras está
pendiente. No hay `.get()` de raíz (para leer el árbol completo hay que armar el objeto a mano
recorriendo cada `Store`), no hay `.subscribe()`/`.listen()` agregados, y no hay `.close()`: quien
crea las `Source`s es responsable de cerrarlas directamente (`source.close()`), `create()` no las
retiene más allá de necesitarlas para `sync()`.

## Tipos

Ambos infieren `T | null` sin `default` y `T` con `default` — misma regla, aplicada por separado en
cada motor (`InferField`/`HasDefault` en `config.types.ts`, `InferValue` en `config-node.ts`).
La diferencia de tipos que sí importa es la forma del nodo resultante:

- Legado: `ConfigNode<S>`/`PendingConfigNode<S>`, con cada campo como `ReadOnlyStore<T>` (interfaz
  mínima — nunca el `Store` real) y grupos anidados como `SchemaGroup<S>` (que a su vez es
  `PendingConfigNode<S>`, con su propio `then()`).
- Nuevo: `ConfigsNode<T>`/`ConfigsNodePending<T>`, con cada campo como `Store<T>` (la clase real,
  no una interfaz reducida) y grupos anidados como el mismo `InferConfigsNode<T>` recursivo, sin
  `then()` propio — solo el nodo raíz es `then`-able.

## Qué implementación usar

- **Código nuevo**: `create()` de `./config-node.js`. Es la que se sigue extendiendo.
- **Código existente que ya usa `configs.create()`/`load()`**: sigue funcionando — está deprecado,
  no eliminado — pero no recibe features nuevas (no va a ganar, por ejemplo, `reduce()`-based
  resolution ni ningún cambio de este documento). Migrar tiene sentido cuando el código no depende
  de lo que el nuevo motor no tiene: `key`, `freeze`, grupos anidados con `sources` propias, o los
  métodos de agregación en la raíz (`.get()`/`.subscribe()`/`.close()`).

## Ver también

- `README.md` — guía de uso pública (por ahora documenta el motor legado; pendiente de actualizar
  para el nuevo `create()`).
- `CHANGELOG.md`, sección `[Unreleased]` — historial de qué se agregó/deprecó en cada motor.
- `src/config-node.spec.ts` — cobertura de comportamiento y tipos del nuevo motor.
- `src/config.types.field-builders.spec.ts` — cobertura equivalente del motor legado.
