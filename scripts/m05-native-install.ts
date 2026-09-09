/**
 * Installs the native TypeScript compiler for the DESIGN.md §3.5 gate probes.
 *
 *     node scripts/m05-native-install.ts [version]
 *
 * Into `.m05-native/` (gitignored), never into this repository's own
 * dependencies — see `scripts/m05-probe/native-compiler.ts` for why the two
 * must not share a `node_modules/.bin`.
 *
 * `npm` is used rather than `pnpm` on purpose: the install is a scratch tree
 * with its own lockfile, and it must not touch `pnpm-lock.yaml`.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { NATIVE_ROOT } from "./m05-probe/native-compiler.ts";

const version = process.argv[2] ?? "7.0.2";

mkdirSync(NATIVE_ROOT, { recursive: true });
writeFileSync(
  path.join(NATIVE_ROOT, "package.json"),
  `${JSON.stringify({ name: "ambit-m05-native", version: "0.0.0", private: true }, null, 2)}\n`,
);

const result = spawnSync(
  "npm",
  ["install", `typescript@${version}`, "--no-audit", "--no-fund", "--silent"],
  { cwd: NATIVE_ROOT, stdio: "inherit" },
);

if (result.status !== 0) {
  console.error(`npm install typescript@${version} failed in ${NATIVE_ROOT}`);
  process.exitCode = 1;
} else {
  console.log(`installed typescript@${version} into ${NATIVE_ROOT}`);
}
