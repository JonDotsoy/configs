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
| Cálculo de campos | perezoso y cacheado (`fieldFor()`/`childNode()`, `Map`) | eager: todo el árbol se construye una vez, al llamar a `create()` — sin `Map` de caché, porque no hace falta decidir nada dos veces |
| Resolución de un campo | `ConfigDescriptor.parse()` (async, se suscribe a un `Store<unknown>` en vivo) | `ConfigDescriptor.reduce()` (sync, recibe un `Store<unknown>` — la `KeyStore` de ese campo — y se suscribe a ella igual que `parse()`) |
| Grupos anidados | `configs.create({...})` embebido — puede traer **sus propias `sources`**, independientes del padre, o compartir las del padre, según reciba `options` o no | objeto plano → comparte las `sources` del `create()` raíz; **otro `create()` embebido** → resuelve con sus propias `sources`, detectado vía `isConfigsNode()` |
| `key` (path override) | soportado (`descriptor.key`) | **no soportado** — el path de resolución es siempre la ruta de anidamiento del shape |
| `freeze` | soportado (`wireDescriptorField` deja de escuchar tras el primer valor) | **no soportado** — cada campo se queda suscrito a su `KeyStore` para siempre |
| Actualizaciones en vivo | por campo, vía suscripción a cada `Store` de origen | por campo también, pero vía una cadena `Source → KeyStore → FieldStore` propia de cada campo — sin recorrer el resto del árbol |
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

### Nuevo: sin `Proxy`, un pipeline reactivo por campo (`Source → KeyStore → FieldStore`)

`create()` en `config-node.ts` no envuelve nada en un `Proxy`, y tampoco recorre el árbol completo
de nuevo cada vez que algo cambia. En su lugar, cada `Source` en `options.sources` recibe, al
llamar a `create()`, un `Store<unknown>`
*placeholder* propio (arrancando en `null`) — y `buildNode()` cablea, para cada campo hoja del
shape, una cadena de tres pasos construida **una sola vez**, de forma completamente síncrona:

1. **`Source`**: cada `Source` de `options.sources` ya sabe resolver su propio `Store<T | null>`
   en vivo vía `source.open()` (ver `src/sources/source.ts`) — nada nuevo que construir ahí.
2. **`KeyStore`** (`keyStore()`): un `Store<unknown>` por campo que, para su propio `path` de
   anidamiento, recorre los *placeholders* en orden de prioridad y se queda con el primero que
   tenga un valor ahí — recalculando cada vez que **cualquiera** de esos placeholders cambia
   (`rawSource.listen(...)`).
3. **`FieldStore`** (`descriptor.reduce(keyStore, path)`): el `Store<T>` final del campo — se
   suscribe a su propia `KeyStore` y aplica `default`/`parser` en cada cambio (ver la sección de
   abajo).

Cuando la promesa de un `source.open()` resuelve, el valor que ya tenía (y cada valor que publique
después) se reenvía al placeholder de esa fuente vía `opened.subscribe(...)` — lo que dispara, en
cascada y de forma puramente síncrona, justo los `KeyStore`s y `FieldStore`s cuyo `path` esa fuente
puede resolver. Un cambio en `server.tls.cert` nunca recalcula `port`: no hay ningún recorrido
"global" del shape — cada campo es, literalmente, su propia cadena reactiva independiente.

Sí se sigue reutilizando lo mismo de siempre para que un `Store` ya entregado a quien llamó a
`create()` no se reemplace nunca: `buildNode()` construye el objeto de campos/grupos una única vez
y ese mismo objeto (y cada `Store` dentro de él) es lo que `then()` termina resolviendo — no hay
una "segunda pasada" que reconstruya nada.

## Resolución de un campo: `parse()` vs `reduce()`

El legado resuelve un campo llamando a `descriptor.parse(rawStore, path)` — async, recibe un
`Store<unknown>` **en vivo** y se suscribe a él (`rawStore.listen(...)`) para recalcular el valor
cada vez que cambia, devolviendo `Promise<{ store: Store<T> }>`.

`ConfigDescriptor` ganó `.reduce(rawStore, path?)` — misma idea que `parse()` (recibe un
`Store<unknown>` en vivo, se suscribe a él, recalcula en cada cambio), pero **síncrona**: devuelve
directamente el `Store<T>` ya inicializado con el valor actual de `rawStore`, sin ninguna
`Promise` de por medio — no hay nada que esperar, porque `rawStore` ya existe en el momento en que
se llama a `reduce()`. `parse()` sigue existiendo, pero ahora es un shim trivial sobre `reduce()`
(`return { store: this.reduce(rawStore, path) }`) y quedó marcado `@deprecated`; sigue siendo lo
único que usa el motor legado, que no fue tocado.

En `config-node.ts`, el `Store<unknown>` que cada campo le pasa a `.reduce()` es exactamente su
propia `KeyStore` — así que "reactivo" no es una metáfora: literalmente es el mismo mecanismo de
suscripción de `Store` (`.listen()`) encadenado tres veces (fuente → `KeyStore` → `FieldStore`),
sin ningún `sync()`/recompute manual en el medio.

## Grupos anidados: sources independientes vs. sources siempre compartidas

En el legado, un grupo anidado es **otro `configs.create({...})` embebido** en el shape del padre.
Si ese `create()` interno recibió sus propias `options.sources`, resuelve **de forma
independiente** del árbol que lo contiene (`ownsResolution`); si no, comparte dinámicamente las
`rootStores` del padre (`ConfigNodeState.rootStores` getter). Esto es lo que permite el caso cubierto en `src/config.types.field-builders.spec.ts` bajo
`describe("a nested create() with its own sources scopes key lookups to those sources only")`.

En la nueva implementación hay **dos formas** de anidar, y se distinguen por si el valor del shape
es un objeto plano o el resultado de `create()`:

- **Objeto plano** (`{ server: { port: numeric() } }`, sin ningún `create()` de por medio) —
  siempre comparte las `options.sources` del `create()` raíz, buscando en cada fuente el path
  completo anidado (`["server", "port"]"`). Es la forma sin superficie propia: no expone `then()`
  ni ningún método de agregación — es literalmente el mismo objeto plano que cualquier otro nivel
  del árbol.
- **Otro `create()` embebido** (`{ server: { tls: create({ cert: string() }, { sources: [...] })
  } }`) — equivalente al caso de "sources propias" del legado: `buildNode()` lo detecta vía
  `isConfigsNode()` (una función exportada que comprueba un `Symbol.for()` marcador puesto en todo
  nodo que `create()` devuelve) y lo **adopta tal cual**, sin reconstruirlo ni tocar su `path` —
  sigue resolviendo únicamente contra sus propias `sources`, nunca contra las del padre. El
  `then()` del padre también espera la resolución de cada nodo embebido (`embeddedReady` en
  `buildNode()`/`create()`), igual que el legado agrega el `readyPromise` de cada grupo embebido
  al suyo propio (`collectEmbeddedStates` en `config.types.ts`).

La diferencia real con el legado es de tipado, no de comportamiento: en el legado, "grupo con
sources propias" y "grupo que comparte las del padre" son la **misma sintaxis**
(`configs.create({...})`, con o sin `options`) — la forma en runtime decide cuál es. En la nueva
implementación son dos formas sintácticas distintas (objeto plano vs. llamar a `create()` primero),
así que el propio shape ya dice, a simple vista, cuál caso es cada rama.

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
crea las `Source`s es responsable de cerrarlas directamente (`source.close()`) — `create()` solo
las usa para abrirlas y reenviar sus valores a cada `KeyStore`, nunca las retiene para más.

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
  de lo que el nuevo motor no tiene: `key`, `freeze`, o los métodos de agregación en la raíz
  (`.get()`/`.subscribe()`/`.close()`). Un grupo anidado con `sources` propias sí tiene equivalente
  en el nuevo motor — embeber otro `create()` — así que eso solo no bloquea la migración.

## Ver también

- `README.md` — guía de uso pública (por ahora documenta el motor legado; pendiente de actualizar
  para el nuevo `create()`).
- `CHANGELOG.md`, sección `[Unreleased]` — historial de qué se agregó/deprecó en cada motor.
- `src/config-node.spec.ts` — cobertura de comportamiento y tipos del nuevo motor.
- `src/config.types.field-builders.spec.ts` — cobertura equivalente del motor legado.
