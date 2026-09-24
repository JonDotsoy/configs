/**
 * Registry of the numbered case scripts in this folder, and which engines
 * each one is expected to run under. Consumed by scripts/run-test-cases.ts.
 */

export type Engine = "node" | "bun" | "deno" | "browser";

export interface CaseDef {
  /** File name, relative to this folder, e.g. "01-import-root.ts". */
  file: string;
  /** One sentence: what this case exercises. */
  description: string;
  /** Engines this case is expected to run under. */
  engines: Engine[];
  /**
   * Engines where a failure is tolerated: the case still runs (never skipped), but a failure is
   * reported as a WARNING instead of a FAILED — it shows up in the report with its output, but
   * doesn't fail `bun run test:cases`'s exit code. Use this for a case whose behavior is expected
   * to break on a given engine (e.g. a node:fs-backed source bundled for a browser) but that's
   * still worth *running* there, to see and document exactly how it breaks, rather than skipping
   * it outright. Omit (or leave an engine out of it) to fail hard on that engine instead — the
   * default, for everything but a documented exception like this.
   */
  tolerateFailureEngines?: Engine[];
}

const allEngines: Engine[] = ["node", "bun", "deno", "browser"];

export const cases: CaseDef[] = [
  { file: "01-import-root.ts", description: "Every documented top-level export resolves from the root entry point.", engines: allEngines },
  { file: "02-import-sources-subpaths.ts", description: "Every browser-safe sources/* subpath resolves its factory function.", engines: allEngines },
  {
    file: "03-import-sources-file.ts",
    description: "sources/file resolves — node:fs-backed, so a browser bundle stubs it out; run there anyway to document the breakage instead of skipping it.",
    engines: allEngines,
    tolerateFailureEngines: ["browser"],
  },
  { file: "04-import-react.ts", description: "The /react subpath resolves useConfig, with the react peer dependency itself resolvable.", engines: allEngines },
  { file: "05-create-with-literal-source.ts", description: "configs.create() + literalSource: publish once, read two leaf fields, close.", engines: allEngines },
  { file: "06-create-with-env-source.ts", description: "envSource + mapKey.snakeCase over an explicit env object maps keys into a nested shape.", engines: allEngines },
  { file: "07-fetch-source-data-url.ts", description: "fetchSource performs a real fetch (against a data: URL) and applies treePath.", engines: allEngines },
  { file: "08-sse-source-connection-failure.ts", description: "sseSource against an address nothing listens on fails gracefully into null instead of throwing.", engines: allEngines },
  { file: "09-pull-source-polls-and-closes.ts", description: "pullSource pulls immediately, then on every interval, until closed.", engines: allEngines },
  { file: "10-custom-source-lifecycle.ts", description: "A hand-rolled Source: multiple control.set() calls, and close() running its close() hook exactly once.", engines: allEngines },
  { file: "11-source-reduce-patches.ts", description: "A Source's reduce(incoming, previous) turns partial patches into an accumulated snapshot.", engines: allEngines },
  { file: "12-nested-config-groups.ts", description: "Nested configs.create() groups resolve fields at every depth and close() cascades.", engines: allEngines },
  { file: "13-mapkey-strategies.ts", description: "Every built-in mapKey strategy (snakeCase, identity, camelCase, lookup) as pure functions.", engines: allEngines },
  { file: "14-shape-schema-required.ts", description: "A 'shape' field's schema failure throws when required, and is swallowed into null otherwise.", engines: allEngines },
  {
    file: "15-file-source-reads-json.ts",
    description: "fileSource reads a real JSON file from disk once — node:fs-backed, so a browser bundle stubs it out; run there anyway to document the breakage instead of skipping it.",
    engines: allEngines,
    tolerateFailureEngines: ["browser"],
  },
  {
    file: "16-shell-source-runs-command.ts",
    description: "shellSource runs a command via node:child_process's spawn and publishes its parsed stdout as the config tree — node:child_process-backed, so a browser bundle stubs it out; run there anyway to document the breakage instead of skipping it.",
    engines: allEngines,
    tolerateFailureEngines: ["browser"],
  },
  {
    file: "17-node-file-field.ts",
    description: "@jondotsoy/configs/node's file() field decodes a source value into a FileBlob, and a URL default is read eagerly from disk — node:fs-backed, so a browser bundle stubs it out; run there anyway to document the breakage instead of skipping it.",
    engines: allEngines,
    tolerateFailureEngines: ["browser"],
  },
];
