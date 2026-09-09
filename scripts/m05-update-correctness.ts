/**
 * DESIGN.md §3.5 gate 3 — 更新の正しさ.
 *
 *     node scripts/m05-update-correctness.ts
 *
 * Changes one thing at a time in a throwaway copy of
 * `test/fixtures/backend-conformance` and asks each backend whether it now
 * reports the new state. Everything is checked at the *backend* level, which is
 * the layer §3.5 gate 3 is about; this is not M1's resident checker and does
 * not implement one.
 *
 * Two of §3.5's five change kinds are deliberately not measured per backend.
 * `ambit.config.ts` and `src/stubs/` are read by Ambit and never by a compiler
 * — `src/checker/config.ts` imports it, `src/stubs/*` is plain data — so both
 * backends receive exactly the same bytes through exactly the same code.
 * Running them twice would report one number twice and imply a difference that
 * cannot exist. `test/e2e.config.test.ts` already covers that a config change
 * changes the diagnostics.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { MUTATIONS } from "./m05-probe/mutations.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const SOURCE = path.join(REPO_ROOT, "test", "fixtures", "backend-conformance");

function run(probe: string, root: string, mutationId: string): Record<string, unknown> {
  const result = spawnSync(
    process.execPath,
    [path.join(HERE, "m05-probe", probe), root, mutationId],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`${probe} failed:\n${result.stderr}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

const scratch = mkdtempSync(path.join(tmpdir(), "ambit-m05-update-"));
try {
  console.log(`node: ${process.version}  platform: ${process.platform}/${process.arch}`);
  for (const mutation of MUTATIONS) {
    console.log(`\n## ${mutation.description}`);
    console.log(`   must report afterwards: ${mutation.expectation}`);
    for (const probe of ["update-legacy.ts", "update-native.ts"]) {
      // A fresh copy per backend: each probe mutates its own corpus, so neither
      // sees the other's edit.
      const root = path.join(scratch, `${mutation.id}-${probe}`);
      cpSync(SOURCE, root, { recursive: true });
      const observed = run(probe, root, mutation.id);
      const label = String(observed.backend).padEnd(6);
      console.log(`   ${label} before:               ${observed.before}`);
      if (observed.after !== undefined) {
        console.log(`   ${label} after:                ${observed.after}`);
      } else {
        console.log(`   ${label} after, told:          ${observed.afterNotified}`);
        console.log(`   ${label} after, NOT told:      ${observed.afterNotNotified}`);
      }
      console.log(`   ${label} re-query:             ${Number(observed.requeryMs).toFixed(1)} ms`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
