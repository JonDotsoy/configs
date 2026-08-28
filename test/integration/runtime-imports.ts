/**
 * Integration suite: verifies the built, packed package actually imports and
 * works under Node LTS, Node latest, Bun latest, and Deno latest — not just
 * under Bun via source resolution like the unit specs do.
 *
 * Not part of the default `bun test` sweep (this file has no .test./.spec.
 * in its name), so run it explicitly:
 *
 *   NODE_LST_BIN=/path/to/node-lts \
 *   NODE_LATEST_BIN=/path/to/node-latest \
 *   BUN_LATEST_BIN=/path/to/bun \
 *   DENO_LATEST_BIN=/path/to/deno \
 *   bun test test/integration/runtime-imports.ts
 *
 * Any of the four env vars may be omitted; the matching runtime is skipped
 * rather than failed, so the suite stays useful on a machine that doesn't
 * have every runtime installed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = new URL("../../", import.meta.url).pathname;
const fixtureScript = new URL("./fixtures/check-imports.mjs", import.meta.url).pathname;

// Persists across suite runs so re-running the suite doesn't pay for a fresh
// `npm install` every time — only when the packed tarball actually changed.
const cacheDir = join(tmpdir(), "jondotsoy-configs-integration-cache");
const hashFile = join(cacheDir, ".tarball-sha256");

const runtimes: { name: string; bin: string | undefined; args: string[] }[] = [
  { name: "Node LTS", bin: process.env.NODE_LST_BIN, args: [fixtureScript] },
  { name: "Node latest", bin: process.env.NODE_LATEST_BIN, args: [fixtureScript] },
  { name: "Bun latest", bin: process.env.BUN_LATEST_BIN, args: [fixtureScript] },
  // envSource() with no explicit `env` reads all of process.env, so Deno
  // needs unscoped --allow-env (a per-key scope isn't enough).
  { name: "Deno latest", bin: process.env.DENO_LATEST_BIN, args: ["run", "--allow-env", "--allow-read", fixtureScript] },
];

let tarballPath: string | undefined;

async function runScript(bin: string, args: string[]) {
  const proc = Bun.spawn({
    cmd: [bin, ...args],
    cwd: cacheDir,
    env: { ...process.env, SERVER_PORT: "4000" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

beforeAll(async () => {
  await $`bun run build`.cwd(repoRoot).quiet();

  const packOutput = await $`bun pm pack`.cwd(repoRoot).quiet().text();
  const tarballName = packOutput
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line.endsWith(".tgz"));
  if (!tarballName) {
    throw new Error(`Could not determine tarball name from pack output:\n${packOutput}`);
  }
  tarballPath = join(repoRoot, tarballName);

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await readFile(tarballPath));
  const tarballHash = hasher.digest("hex");

  await mkdir(cacheDir, { recursive: true });
  const cachedHash = existsSync(hashFile) ? (await readFile(hashFile, "utf8")).trim() : null;
  const alreadyInstalled = existsSync(join(cacheDir, "node_modules", "@jondotsoy", "configs"));

  if (cachedHash !== tarballHash || !alreadyInstalled) {
    await writeFile(
      join(cacheDir, "package.json"),
      JSON.stringify({ name: "jondotsoy-configs-integration-cache", type: "module", private: true }, null, 2),
    );
    await $`npm install ${tarballPath} --no-audit --no-fund`.cwd(cacheDir).quiet();
    await writeFile(hashFile, tarballHash);
  }
});

afterAll(async () => {
  if (tarballPath) await rm(tarballPath, { force: true });
});

describe("runtime import checks", () => {
  for (const runtime of runtimes) {
    test.skipIf(!runtime.bin)(
      `${runtime.name} imports @jondotsoy/configs and every sources/* subpath`,
      async () => {
        const { stdout, stderr, exitCode } = await runScript(runtime.bin!, runtime.args);
        if (exitCode !== 0) console.error(stderr);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("ALL_CHECKS_PASSED");
        expect(stdout.match(/^ok - /gm)?.length).toBe(9);
      },
    );
  }
});
