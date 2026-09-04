#!/usr/bin/env bun
/**
 * Runs every case in test/cases/ under every engine it declares support for
 * (node, bun, deno, browser), and writes a Markdown report to
 * test-cases-report/report.md.
 *
 * node/bun/deno cases run straight from source: `bun run build` first
 * produces dist/, and each runtime's own self-reference resolution (its
 * package.json's "name" + "exports" fields) resolves the bare
 * `@jondotsoy/configs` specifiers in test/cases/*.ts against that dist/ —
 * no packing/installing needed, since the cases run from inside this repo.
 *
 * The browser case bundles the same case file with `Bun.build` (target:
 * "browser"), aliasing `@jondotsoy/configs` and its subpaths straight to
 * their `src/*.ts` source (mirroring test/browser/app.tsx, which does the
 * same by hand) since a browser page can't resolve a bare npm specifier on
 * its own. The bundle is inlined into a small HTML page and driven with
 * Playwright's Chromium, matching this repo's existing browser test setup
 * (playwright.config.ts).
 *
 * A case can list an engine in its `tolerateFailureEngines` (test/cases/manifest.ts) to say
 * "run this here anyway, but a failure is expected — report it as a WARNING, not a FAILED". Unlike
 * skipping the engine outright, this still runs the case and captures its real output (e.g.
 * `sources/file`'s node:fs calls silently no-op in a browser bundle), so the report documents the
 * actual breakage instead of hiding it. Only a *non*-tolerated failure fails the process's exit
 * code.
 *
 * Usage: bun run test:cases
 * Optional overrides: NODE_BIN, BUN_BIN, DENO_BIN (default to whatever's on
 * PATH; a missing binary just skips that engine's rows in the report).
 */
import { chromium } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cases, type CaseDef, type Engine } from "../test/cases/manifest.js";

const repoRoot = new URL("../", import.meta.url).pathname;
const casesDir = join(repoRoot, "test/cases");
const reportDir = join(repoRoot, "test-cases-report");

const sandboxChromium = "/opt/pw-browsers/chromium";
const chromiumExecutablePath = existsSync(sandboxChromium) ? sandboxChromium : undefined;

interface CliEngine {
  name: Extract<Engine, "node" | "bun" | "deno">;
  bin: string | undefined;
  args: (caseFile: string) => string[];
}

const cliEngines: CliEngine[] = [
  { name: "node", bin: process.env.NODE_BIN ?? Bun.which("node") ?? undefined, args: (f) => ["--experimental-strip-types", "--no-warnings", f] },
  { name: "bun", bin: process.env.BUN_BIN ?? Bun.which("bun") ?? undefined, args: (f) => [f] },
  // --allow-run: shellSource's test case spawns a real command via node:child_process, which
  // Deno's permission system gates the same as its own Deno.Command.
  { name: "deno", bin: process.env.DENO_BIN ?? Bun.which("deno") ?? undefined, args: (f) => ["run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-run", f] },
];

interface CaseResult {
  caseDef: CaseDef;
  engine: Engine;
  compileCommand: string;
  output: string;
  passed: boolean;
  skippedReason?: string;
  /** True when this engine is listed in the case's `tolerateFailureEngines` — a failure here is a WARNING, not a hard FAILED. */
  tolerated: boolean;
}

async function runCli(engine: CliEngine, caseFile: string): Promise<{ compileCommand: string; output: string; passed: boolean; skippedReason?: string }> {
  const relPath = `test/cases/${caseFile}`;
  if (!engine.bin) {
    return {
      compileCommand: `$ ${engine.name} ${relPath}`,
      output: "",
      passed: false,
      skippedReason: `${engine.name} binary not found on PATH (set ${engine.name.toUpperCase()}_BIN to override)`,
    };
  }

  const args = engine.args(join(casesDir, caseFile));
  const compileCommand = `$ ${engine.bin === Bun.which(engine.name) ? engine.name : engine.bin} ${args.map((a) => (a.includes(casesDir) ? relPath : a)).join(" ")}`;

  const proc = Bun.spawn({ cmd: [engine.bin, ...args], cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const output = [stdout, stderr].filter(Boolean).join("\n").trim();
  const passed = exitCode === 0 && stdout.includes("ALL_CHECKS_PASSED");
  return { compileCommand, output, passed };
}

// Aliases `@jondotsoy/configs` and its subpaths to their `src/*.ts` source, the same way
// test/browser/app.tsx imports the library by hand — a browser page can't resolve a bare
// npm specifier, so the case files' imports are rewritten at bundle time instead.
const subpathAliases: Record<string, string> = {
  "@jondotsoy/configs": "src/configs.ts",
  "@jondotsoy/configs/sources/env": "src/sources/env.ts",
  "@jondotsoy/configs/sources/fetch": "src/sources/fetch.ts",
  "@jondotsoy/configs/sources/sse": "src/sources/sse.ts",
  "@jondotsoy/configs/sources/file": "src/sources/file.ts",
  "@jondotsoy/configs/sources/literal": "src/sources/literal.ts",
  "@jondotsoy/configs/sources/pull": "src/sources/pull.ts",
  "@jondotsoy/configs/sources/shell": "src/sources/shell.ts",
  "@jondotsoy/configs/react": "src/react.ts",
};

function configsAliasPlugin() {
  return {
    name: "configs-alias",
    setup(build: Parameters<NonNullable<Parameters<typeof Bun.build>[0]["plugins"]>[number]["setup"]>[0]) {
      build.onResolve({ filter: /^@jondotsoy\/configs(\/.*)?$/ }, (args: { path: string }) => {
        const rel = subpathAliases[args.path];
        if (!rel) throw new Error(`configs-alias: no alias registered for "${args.path}"`);
        return { path: join(repoRoot, rel) };
      });
    },
  };
}

async function runBrowser(
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
  caseFile: string,
): Promise<{ compileCommand: string; output: string; passed: boolean; skippedReason?: string }> {
  const relPath = `test/cases/${caseFile}`;
  const compileCommand = `$ bun build ${relPath} --target browser --format esm (aliasing @jondotsoy/configs -> src/, inlined into an index.html, driven by Playwright's Chromium)`;

  const buildResult = await Bun.build({
    entrypoints: [join(casesDir, caseFile)],
    target: "browser",
    format: "esm",
    plugins: [configsAliasPlugin()],
  });
  if (!buildResult.success) {
    return { compileCommand, output: buildResult.logs.map(String).join("\n"), passed: false };
  }
  const bundleCode = await buildResult.outputs[0]!.text();

  const html = `<!doctype html>
<html>
  <body>
    <script type="module">
      window.__CASE_DONE__ = false;
      window.__CASE_RESULT__ = null;
      try {
        ${bundleCode}
        window.__CASE_RESULT__ = "PASS";
      } catch (e) {
        window.__CASE_RESULT__ = "FAIL: " + (e && e.message ? e.message : String(e));
      } finally {
        window.__CASE_DONE__ = true;
      }
    </script>
  </body>
</html>`;

  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(html, { headers: { "content-type": "text/html" } }),
  });

  if (!browser) {
    server.stop(true);
    return { compileCommand, output: "", passed: false, skippedReason: "no Chromium instance available (see the launch error logged at startup)" };
  }

  const page = await browser.newPage();
  const logs: string[] = [];
  page.on("console", (msg) => logs.push(msg.text()));
  page.on("pageerror", (err) => logs.push("pageerror: " + err.message));

  let result = "FAIL: timed out waiting for the page to finish";
  try {
    await page.goto(`http://localhost:${server.port}/`);
    await page.waitForFunction(() => (globalThis as unknown as { __CASE_DONE__: boolean }).__CASE_DONE__ === true, { timeout: 10_000 });
    result = await page.evaluate(() => (globalThis as unknown as { __CASE_RESULT__: string }).__CASE_RESULT__);
  } catch (error) {
    logs.push(`runner error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await page.close();
    server.stop(true);
  }

  const output = [...logs, `RESULT: ${result}`].join("\n");
  return { compileCommand, output, passed: result === "PASS" };
}

async function main() {
  console.log("== build ==");
  await Bun.$`bun run build`.cwd(repoRoot).quiet();

  // Prefer the sandbox's pre-installed Chromium; elsewhere (e.g. GitHub Actions, after a plain
  // `bunx playwright install`), fall back to Playwright's own resolution. A launch that still fails
  // (no browser installed anywhere) just skips the browser rows instead of failing the whole run.
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch(chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : {});
  } catch (error) {
    console.error(`Could not launch Chromium, browser cases will be skipped: ${error instanceof Error ? error.message : String(error)}`);
  }

  const results: CaseResult[] = [];

  try {
    for (const caseDef of cases) {
      for (const engine of caseDef.engines) {
        console.log(`-- ${caseDef.file} (${engine}) --`);
        const tolerated = caseDef.tolerateFailureEngines?.includes(engine) ?? false;
        if (engine === "browser") {
          const r = await runBrowser(browser, caseDef.file);
          results.push({ caseDef, engine, tolerated, ...r });
        } else {
          const cliEngine = cliEngines.find((e) => e.name === engine)!;
          const r = await runCli(cliEngine, caseDef.file);
          results.push({ caseDef, engine, tolerated, ...r });
        }
      }
    }
  } finally {
    await browser?.close();
  }

  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, "report.md"), await renderReport(results));

  const skipped = results.filter((r) => r.skippedReason);
  const failedAfterSkip = results.filter((r) => !r.passed && !r.skippedReason);
  const warned = failedAfterSkip.filter((r) => r.tolerated);
  const failed = failedAfterSkip.filter((r) => !r.tolerated);
  const passed = results.length - skipped.length - failedAfterSkip.length;
  console.log(
    `\n${results.length} case runs: ${passed} passed, ${failed.length} failed, ${warned.length} warned (tolerated failure), ${skipped.length} skipped.`,
  );
  console.log(`Report written to ${join(reportDir, "report.md")}`);

  if (warned.length > 0) {
    for (const w of warned) console.warn(`WARNING (tolerated failure): ${w.caseDef.file} (${w.engine})`);
  }

  if (failed.length > 0) {
    for (const f of failed) console.error(`FAILED: ${f.caseDef.file} (${f.engine})`);
    process.exit(1);
  }
}

async function renderReport(results: CaseResult[]): Promise<string> {
  const lines: string[] = ["# Test cases report", ""];
  lines.push(
    "Each case in `test/cases/` is a self-contained script exercising one specific",
    "piece of behavior, run under every engine it declares support for in",
    "`test/cases/manifest.ts`. node/bun/deno run the script directly; the browser",
    "engine bundles it (aliasing `@jondotsoy/configs` to its `src/` source) into a",
    "small page driven by Playwright's Chromium. A case listed in its manifest",
    "entry's `tolerateFailureEngines` still runs on that engine, but a failure",
    "there is reported as a WARNING instead of a FAILED, and doesn't fail the run",
    "— use it to document expected breakage (e.g. a node:fs-backed source in a",
    "browser bundle) instead of skipping the case outright. Generated by",
    "`bun run test:cases` (scripts/run-test-cases.ts) — do not edit by hand.",
    "",
  );

  const byFile = new Map<string, CaseResult[]>();
  for (const r of results) {
    const list = byFile.get(r.caseDef.file) ?? [];
    list.push(r);
    byFile.set(r.caseDef.file, list);
  }

  for (const caseDef of cases) {
    const runs = byFile.get(caseDef.file) ?? [];
    const scriptContent = await readFile(join(casesDir, caseDef.file), "utf8");

    for (const run of runs) {
      lines.push(`## case test/cases/${caseDef.file} — ${run.engine}`, "");
      lines.push(caseDef.description, "");
      lines.push("```ts", scriptContent.trimEnd(), "```", "");
      lines.push(`Compile: \`${run.compileCommand}\``, "");

      const status = run.skippedReason
        ? `SKIPPED: ${run.skippedReason}`
        : run.passed
          ? "PASSED"
          : run.tolerated
            ? "WARNING: failed, but tolerated for this engine (tolerateFailureEngines in manifest.ts) — does not fail the run"
            : "FAILED";
      const body = run.output || "(no output)";
      lines.push("```", `[${status}]`, body, "```", "");
    }
  }

  return lines.join("\n");
}

await main();
