/**
 * `Symbol.for` (the global symbol registry, keyed by string, shared across the whole JS realm)
 * rather than a plain `Symbol()` or an `instanceof` check — `bun build` bundles each public entry
 * point (`.`, `./node`, ...) independently, so a `Descriptor` built by one entry point's own
 * bundled copy of `config-descriptor.ts` (e.g. `file()` from `./node`) would fail an `instanceof
 * Descriptor` check done against another entry point's separately-bundled copy of the same
 * class (e.g. `configs.ts`'s own `isConfigDescriptor`). A registry symbol survives that
 * duplication.
 *
 * @deprecated Still required by `isConfigDescriptor()`/`create()` internally, and still set on
 * every real `Descriptor` instance — but writing the whole hand-written contract yourself (this
 * tag + a `.start()`) is no longer the recommended extension point. Construct `new Descriptor({
 * type, options, start, reduce?, close? })` instead (see the README's "Writing a custom
 * `Descriptor`" section); it already carries this tag for you.
 */
export const CONFIG_DESCRIPTOR_TAG = Symbol.for("@jondotsoy/configs/ConfigDescriptor");
