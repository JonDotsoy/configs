/**
 * Runs `smoke/smoke.donly` with `@jondotsoy/smoking` against the package built from this
 * workspace instead of whatever `hotconfigs` version is currently on npm.
 *
 * `smoke.donly` declares no `dependency` of its own. This builds and packs `dist/` (the same
 * tarball `npm publish ./dist` would upload) into a temp directory and hands it to `smoking` with
 * `--dependency <path>/hotconfigs-<version>.tgz`.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

await Bun.$`bun run build`.cwd(root);

const workDir = await mkdtemp(join(tmpdir(), "hotconfigs-smoke-"));
const packed = await Bun.$`npm pack --silent --pack-destination ${workDir}`.cwd(join(root, "dist")).text();
const tarball = join(workDir, packed.trim().split("\n").pop()!);

const proc = Bun.spawn(["bunx", "@jondotsoy/smoking", "--dependency", tarball, join(root, "smoke", "smoke.donly")], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await proc.exited);
