#!/usr/bin/env bun
/**
 * Runs every case in test/cases/ under every engine it declares support for
 * (node, bun, deno, browser), and writes a Markdown report to
 * test-cases-report/report.md.
 *
 * Every case runs against the packed, installed tarball, not the repo's own
 * source or dist/ via self-reference: `bun run build` produces dist/ (with
 * its own dist/package.json, see scripts/build.ts), `npm pack` is run
 * *inside* dist/ so the tarball's root is dist/ itself — exactly the
 * artifact `npm publish` would produce from dist/ directly — and the
 * resulting tarball is installed with `npm install` into a scratch
 * directory that has no relation to this repo's own package.json. Each case
 * file is copied into that scratch directory before running it, so its bare
 * `@jondotsoy/configs` (and subpath) imports can only resolve through the
 * installed `node_modules` — not through Node/Bun's own-package
 * self-reference, which would silently mask a packaging mistake (a missing
 * export, a stray/omitted file) by falling back to the workspace source.
 *
 * The browser case bundles that same copied file with `Bun.build` (target:
 * "browser"), letting it resolve `@jondotsoy/configs` from the scratch
 * directory's `node_modules` too — so the browser bundle is built from the
 * same packed `dist/**` output as the CLI engines, not from `src/*.ts`.
 * The bundle is inlined into a small HTML page and driven with Playwright's
 * Chromium, matching this repo's existing browser test setup
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
import { $ } from "bun";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  // Deno's permission system gates the same as its own Deno.Command. --node-modules-dir=manual
  // resolves against the scratch directory's already npm-installed node_modules as-is; "auto"
  // instead lets Deno manage (and rewrite) that folder itself, which corrupts it for the CLI/browser
  // runs of other cases and engines still to come against that same shared scratch directory.
  {
    name: "deno",
    bin: process.env.DENO_BIN ?? Bun.which("deno") ?? undefined,
    args: (f) => ["run", "--node-modules-dir=manual", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-run", f],
  },
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

/**
 * Packs the current build (`bun run build` must have already run) with `npm pack`, run *inside*
 * dist/ so dist/package.json (not the repo's root package.json) is the tarball's manifest and
 * dist/ itself is the tarball's root — exactly the artifact `npm publish` would produce from
 * dist/ directly. Installs the tarball with `npm install` into a fresh scratch directory
 * unrelated to this repo's own package.json, so nothing in it can resolve `@jondotsoy/configs`
 * via workspace self-reference. Returns that directory; the caller is responsible for cleaning
 * it up.
 */
async function packAndInstall(): Promise<string> {
  console.log("== pack ==");
  const distDir = join(repoRoot, "dist");
  const packOutput = await $`npm pack`.cwd(distDir).quiet().text();
  const tarballName = packOutput
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line.endsWith(".tgz"));
  if (!tarballName) {
    throw new Error(`Could not determine tarball name from pack output:\n${packOutput}`);
  }
  const tarballPath = join(distDir, tarballName);

  try {
    const scratchDir = await mkdtemp(join(tmpdir(), "jondotsoy-configs-test-cases-"));
    console.log(`== installing packed tarball into ${scratchDir} ==`);
    await writeFile(
      join(scratchDir, "package.json"),
      JSON.stringify({ name: "jondotsoy-configs-test-cases-scratch", type: "module", private: true }, null, 2),
    );
    await $`npm install ${tarballPath} --no-audit --no-fund`.cwd(scratchDir).quiet();

    // `dist/react.js` imports `react` at the top level (a peer dependency, not bundled into the
    // tarball), so the /react subpath case needs it resolvable too. A real consumer app already
    // has it installed per the peerDependency; here, copy this repo's own devDependency install
    // instead of fetching it fresh from the registry for every run.
    await cp(join(repoRoot, "node_modules/react"), join(scratchDir, "node_modules/react"), { recursive: true });
    const reactVersion = JSON.parse(await readFile(join(scratchDir, "node_modules/react/package.json"), "utf8")).version;
    const manifestPath = join(scratchDir, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    // `npm install` only records @jondotsoy/configs itself in "dependencies"; declaring react there
    // too (even though it was copied in by hand, not installed) is what lets Deno's node_modules-dir
    // resolution recognize it as a real dependency instead of stray content in node_modules/.
    manifest.dependencies = { ...manifest.dependencies, react: reactVersion };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    return scratchDir;
  } finally {
    await rm(tarballPath, { force: true });
  }
}

async function runCli(engine: CliEngine, scratchDir: string, caseFile: string): Promise<{ compileCommand: string; output: string; passed: boolean; skippedReason?: string }> {
  const relPath = `test/cases/${caseFile}`;
  if (!engine.bin) {
    return {
      compileCommand: `$ ${engine.name} ${relPath}`,
      output: "",
      passed: false,
      skippedReason: `${engine.name} binary not found on PATH (set ${engine.name.toUpperCase()}_BIN to override)`,
    };
  }

  const scratchFile = join(scratchDir, caseFile);
  const args = engine.args(scratchFile);
  const compileCommand = `$ ${engine.bin === Bun.which(engine.name) ? engine.name : engine.bin} ${args.map((a) => (a === scratchFile ? relPath : a)).join(" ")} (running the copy installed against the packed tarball, not the repo's dist/)`;

  const proc = Bun.spawn({ cmd: [engine.bin, ...args], cwd: scratchDir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const output = [stdout, stderr].filter(Boolean).join("\n").trim();
  const passed = exitCode === 0 && stdout.includes("ALL_CHECKS_PASSED");
  return { compileCommand, output, passed };
}

/**
 * Reads the installed package's own package.json "exports" map and resolves each subpath to its
 * real file under the scratch directory's node_modules — e.g. "@jondotsoy/configs/sources/env" ->
 * ".../node_modules/@jondotsoy/configs/sources/env.js" (dist/ was packed as the tarball's own
 * root, so there's no "dist/" segment in the installed layout). Bundling against these resolved paths
 * directly (rather than leaving `Bun.build` to walk node_modules and match exports conditions on
 * its own for a `target: "browser"` build) sidesteps bundler-version quirks in that matching for a
 * scoped package, while still exercising the exact files the installed tarball's own exports map
 * points at.
 */
async function loadConfigsExportsMap(scratchDir: string): Promise<Record<string, string>> {
  const pkgDir = join(scratchDir, "node_modules/@jondotsoy/configs");
  const pkg = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8")) as {
    exports: Record<string, { import?: string; default?: string }>;
  };
  const map: Record<string, string> = {};
  for (const [subpath, conditions] of Object.entries(pkg.exports)) {
    const target = conditions.import ?? conditions.default;
    if (!target) continue;
    const specifier = subpath === "." ? "@jondotsoy/configs" : `@jondotsoy/configs/${subpath.replace(/^\.\//, "")}`;
    map[specifier] = join(pkgDir, target);
  }
  return map;
}

function configsExportsPlugin(exportsMap: Record<string, string>) {
  return {
    name: "configs-exports",
    setup(build: Parameters<NonNullable<Parameters<typeof Bun.build>[0]["plugins"]>[number]["setup"]>[0]) {
      build.onResolve({ filter: /^@jondotsoy\/configs(\/.*)?$/ }, (args: { path: string }) => {
        const resolved = exportsMap[args.path];
        if (!resolved) throw new Error(`configs-exports: "${args.path}" isn't in the installed package's exports map`);
        return { path: resolved };
      });
    },
  };
}

async function runBrowser(
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
  scratchDir: string,
  caseFile: string,
  exportsMap: Record<string, string>,
): Promise<{ compileCommand: string; output: string; passed: boolean; skippedReason?: string }> {
  const relPath = `test/cases/${caseFile}`;
  const compileCommand = `$ bun build ${relPath} --target browser --format esm (resolving @jondotsoy/configs against the packed tarball's installed exports, inlined into an index.html, driven by Playwright's Chromium)`;

  const buildResult = await Bun.build({
    entrypoints: [join(scratchDir, caseFile)],
    target: "browser",
    format: "esm",
    plugins: [configsExportsPlugin(exportsMap)],
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

  const scratchDir = await packAndInstall();
  const exportsMap = await loadConfigsExportsMap(scratchDir);

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
      // Copy fresh into the scratch dir right before running it: cheap, and keeps each engine run
      // isolated from whatever a previous engine's run (or bundle) may have left behind there.
      await cp(join(casesDir, caseDef.file), join(scratchDir, caseDef.file));

      for (const engine of caseDef.engines) {
        console.log(`-- ${caseDef.file} (${engine}) --`);
        const tolerated = caseDef.tolerateFailureEngines?.includes(engine) ?? false;
        if (engine === "browser") {
          const r = await runBrowser(browser, scratchDir, caseDef.file, exportsMap);
          results.push({ caseDef, engine, tolerated, ...r });
        } else {
          const cliEngine = cliEngines.find((e) => e.name === engine)!;
          const r = await runCli(cliEngine, scratchDir, caseDef.file);
          results.push({ caseDef, engine, tolerated, ...r });
        }
      }
    }
  } finally {
    await browser?.close();
    await rm(scratchDir, { recursive: true, force: true });
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
    "`test/cases/manifest.ts`, against an `npm pack` tarball built from dist/",
    "(dist/package.json as its manifest) and installed with `npm install` into",
    "a scratch directory — not this repo's own dist/ via",
    "self-reference, so a packaging mistake (a missing export, a stray or",
    "omitted file) actually surfaces here. node/bun/deno run the copied script",
    "directly; the browser engine bundles it with `Bun.build`, resolving",
    "`@jondotsoy/configs` from that same installed tarball, into a small page",
    "driven by Playwright's Chromium. A case listed in its manifest",
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
