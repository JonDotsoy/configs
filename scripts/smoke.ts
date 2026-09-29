/**
 * Runs `smoke/smoke.donly` with `@jondotsoy/smoking` against the package built from this
 * workspace instead of whatever `hotconfigs` version is currently on npm.
 *
 * `smoking` installs each `dependency` with `bun add` from its own scratch directory, so a relative
 * `file:` path can't reach `dist/`. Instead this builds and packs `dist/` (the same tarball
 * `npm publish ./dist` would upload) into a temp directory, then runs a copy of the smoke file whose
 * `dependency hotconfigs` line points at that tarball's absolute path.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const smokeFile = join(root, "smoke", "smoke.donly");

await Bun.$`bun run build`.cwd(root);

const workDir = await mkdtemp(join(tmpdir(), "hotconfigs-smoke-"));
const packed = await Bun.$`npm pack --silent --pack-destination ${workDir}`.cwd(join(root, "dist")).text();
const tarball = join(workDir, packed.trim().split("\n").pop()!);

const source = await readFile(smokeFile, "utf8");
if (!/^dependency hotconfigs$/m.test(source)) {
  throw new Error(`${smokeFile} must declare exactly \`dependency hotconfigs\``);
}
const runFile = join(workDir, "smoke.donly");
await writeFile(runFile, source.replace(/^dependency hotconfigs$/m, `dependency ${tarball}`));

const proc = Bun.spawn(["bunx", "@jondotsoy/smoking", runFile], { cwd: root, stdout: "inherit", stderr: "inherit" });
process.exit(await proc.exited);
