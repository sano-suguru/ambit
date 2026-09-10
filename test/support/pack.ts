import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { inject } from "vitest";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.join(import.meta.dirname, "..", "..");

/**
 * How long a loser waits for the winner's result before giving up. Both
 * `beforeAll` hooks that call `packedTarball()` already budget 300_000ms for
 * install-and-run, most of it `npm install`; this stays well inside that so
 * a stuck winner surfaces as a clear timeout message here rather than the
 * hook's generic one. `pnpm pack` alone measured ~1.7s idle — the margin is
 * for contention, not for the pack itself.
 */
const LOCK_WAIT_TIMEOUT_MS = 120_000;
const LOCK_POLL_INTERVAL_MS = 200;

let packing: Promise<string> | undefined;

/**
 * Build and pack the distribution tarball once per test run, and hand every
 * caller the same path.
 *
 * Two e2e files need a tarball, and with `fileParallelism` on they run as
 * separate processes. Packing per file means two `tsc` processes writing
 * the same `dist/` while the other tars it — a race that passes on a fast
 * machine and fails elsewhere. The in-process memo below only protects
 * repeat calls within one file's own process; the file lock below protects
 * against the other file's process. The `dist/` removal is deliberate:
 * without it the tarball could be built from a stale manual `pnpm build`,
 * and `prepack` would never be proven to run.
 */
export function packedTarball(): Promise<string> {
  packing ??= packWithLock();
  return packing;
}

async function packWithLock(): Promise<string> {
  const dir = inject("packDir");
  const lockPath = path.join(dir, "pack.lock");
  const resultPath = path.join(dir, "pack.result.json");

  let handle: fs.FileHandle;
  try {
    handle = await fs.open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return await waitForResult(resultPath, lockPath);
    }
    throw error;
  }

  try {
    const tarball = await pack(dir);
    await fs.writeFile(resultPath, JSON.stringify({ tarball }));
    return tarball;
  } catch (error) {
    // A loser polling `resultPath` must not hang past this failure just
    // because it never sees a result appear.
    await fs.writeFile(resultPath, JSON.stringify({ error: String(error) }));
    throw error;
  } finally {
    await handle.close();
  }
}

async function waitForResult(resultPath: string, lockPath: string): Promise<string> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  for (;;) {
    let raw: string | undefined;
    try {
      raw = await fs.readFile(resultPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (raw !== undefined) {
      const result = JSON.parse(raw) as { tarball: string } | { error: string };
      if ("error" in result) {
        throw new Error(`pnpm pack failed in the process that won the lock: ${result.error}`);
      }
      return result.tarball;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${LOCK_WAIT_TIMEOUT_MS}ms waiting for another test file's ` +
          `pnpm pack (lock at ${lockPath})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));
  }
}

async function pack(dir: string): Promise<string> {
  await fs.rm(path.join(REPO_ROOT, "dist"), { recursive: true, force: true });
  await execFileAsync("pnpm", ["pack", "--pack-destination", dir], { cwd: REPO_ROOT });
  const entry = (await fs.readdir(dir)).find((name) => name.endsWith(".tgz"));
  if (!entry) throw new Error(`pnpm pack produced no tarball in ${dir}`);
  return path.join(dir, entry);
}
