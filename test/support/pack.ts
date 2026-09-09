import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.join(import.meta.dirname, "..", "..");

let packing: Promise<string> | undefined;

/**
 * Build and pack the distribution tarball once per test run, and hand every
 * caller the same path.
 *
 * Two e2e files need a tarball, and vitest runs them in parallel workers.
 * Packing per file means two `tsc` processes writing the same `dist/` while
 * the other is tarring it — a race that passes or fails on machine speed. The
 * `dist/` removal is deliberate: without it the tarball could be built from a
 * stale manual `pnpm build`, and `prepack` would never be proven to run.
 */
export function packedTarball(): Promise<string> {
  packing ??= pack();
  return packing;
}

async function pack(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ambit-pack-"));
  await fs.rm(path.join(REPO_ROOT, "dist"), { recursive: true, force: true });
  await execFileAsync("pnpm", ["pack", "--pack-destination", dir], { cwd: REPO_ROOT });
  const entry = (await fs.readdir(dir)).find((name) => name.endsWith(".tgz"));
  if (!entry) throw new Error(`pnpm pack produced no tarball in ${dir}`);
  return path.join(dir, entry);
}
