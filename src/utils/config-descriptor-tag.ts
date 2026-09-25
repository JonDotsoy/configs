/**
 * `Symbol.for` (the global symbol registry, keyed by string, shared across the whole JS realm)
 * rather than a plain `Symbol()` or an `instanceof` check — `bun build` bundles each public entry
 * point (`.`, `./node`, ...) independently, so a `Descriptor` built by one entry point's own
 * bundled copy of `config-descriptor.ts` (e.g. `file()` from `./node`) would fail an `instanceof
 * Descriptor` check done against another entry point's separately-bundled copy of the same
 * class (e.g. `configs.ts`'s own `isConfigDescriptor`). A registry symbol survives that
 * duplication.
 */
export const CONFIG_DESCRIPTOR_TAG = Symbol.for("@jondotsoy/configs/ConfigDescriptor");
