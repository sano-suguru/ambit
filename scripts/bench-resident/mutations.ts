/**
 * The mutations `scripts/bench-resident.ts` applies, split out of the script so
 * `test/bench-resident.test.ts` can check that each one really changes what it
 * says it changes: the script runs its benchmark at top level on import.
 */

import fs from "node:fs";
import path from "node:path";
import type { FileChange } from "../../src/checker/resident.ts";

export const MUTATIONS = [
  "leaf",
  "hub",
  "jsdoc",
  "config",
  "addition",
  "tsconfig",
  // Added for the large-subject workload run; not part of phase 5's six.
  "deletion",
  "outside-root",
  "leaf-rotate",
  "alternate",
] as const;
export type MutationKind = (typeof MUTATIONS)[number];

/** What the selection child decided, in root-relative and copy-relative terms. */
export interface MutationPlan {
  readonly leaf: string;
  /** Up to five leaves around the median, for `leaf-rotate`; `leaf` is among them. */
  readonly leaves: readonly string[];
  /** Copy-relative; verified to force a whole rebuild when edited. */
  readonly outsideRoot: string | undefined;
  readonly hub: string;
  readonly hubClosure: number;
  readonly jsdoc: { readonly file: string; readonly line: number; readonly id: string };
  /** Relative to the copy directory, not to the root. */
  readonly configFile: string;
  readonly configExisted: boolean;
  /** Root-relative when the config lies under the root and is a store file. */
  readonly configInStore: string | undefined;
  /** Relative to the copy directory. */
  readonly tsconfig: string;
}

export interface Applied {
  /** What a caller that tracks changes reports. */
  readonly changes: readonly FileChange[];
}

export const LEAF_MARK = "// ambit-bench";

export function deletionFile(variant: number): string {
  return `__ambit_bench_deleted_${variant}.ts`;
}

/** @effects fs_read, fs_write */
export function applyMutation(
  kind: MutationKind,
  plan: MutationPlan,
  copyDir: string,
  root: string,
  originals: Map<string, string>,
  variant: number,
): Applied {
  const original = (file: string): string => {
    const cached = originals.get(file);
    if (cached !== undefined) return cached;
    const text = fs.readFileSync(file, "utf8");
    originals.set(file, text);
    return text;
  };
  const appendFunction = (file: string): void => {
    fs.writeFileSync(
      file,
      `${original(file)}\n${LEAF_MARK}\nexport function __ambitBench(): number { return ${variant}; }\n`,
    );
  };
  switch (kind) {
    case "leaf-rotate": {
      const rel = plan.leaves[variant % plan.leaves.length] ?? plan.leaf;
      appendFunction(path.join(root, rel));
      return { changes: [{ kind: "changed", path: rel }] };
    }
    case "alternate":
      // Even variants: a code edit to the leaf; odd: the contract-only toggle.
      // The toggle reads its own parity, so it is handed the odd variants'
      // ordinal — passing `variant` itself would write `fs_write` every time.
      return variant % 2 === 0
        ? applyMutation("leaf", plan, copyDir, root, originals, variant)
        : applyMutation("jsdoc", plan, copyDir, root, originals, (variant - 1) / 2);
    case "deletion": {
      // `scenarioChild` created one file per iteration before the session opened.
      const rel = deletionFile(variant);
      fs.rmSync(path.join(root, rel));
      return { changes: [{ kind: "deleted", path: rel }] };
    }
    case "outside-root": {
      if (plan.outsideRoot === undefined) throw new Error("no outside-root project file");
      appendFunction(path.join(copyDir, plan.outsideRoot));
      // A caller can only report in-root paths; the session must find this itself.
      return { changes: [] };
    }
    case "leaf":
    case "hub": {
      const rel = kind === "leaf" ? plan.leaf : plan.hub;
      const file = path.join(root, rel);
      // A new exported function at the end of the file: an implementation edit
      // that changes the file's summaries and shifts no existing line.
      fs.writeFileSync(
        file,
        `${original(file)}\n${LEAF_MARK}\nexport function __ambitBench(): number { return ${variant}; }\n`,
      );
      return { changes: [{ kind: "changed", path: rel }] };
    }
    case "jsdoc": {
      const file = path.join(root, plan.jsdoc.file);
      const lines = original(file).split("\n");
      const effect = variant % 2 === 0 ? "fs_read" : "fs_write";
      lines.splice(plan.jsdoc.line - 1, 0, `/** @effects ${effect} */`);
      fs.writeFileSync(file, lines.join("\n"));
      return { changes: [{ kind: "changed", path: plan.jsdoc.file }] };
    }
    case "config": {
      const file = path.join(copyDir, plan.configFile);
      writeConfig(file, plan.configExisted ? original(file) : undefined, variant);
      return {
        changes:
          plan.configInStore === undefined ? [] : [{ kind: "changed", path: plan.configInStore }],
      };
    }
    case "addition": {
      const rel = `__ambit_bench_added_${variant}.ts`;
      fs.writeFileSync(
        path.join(root, rel),
        `export function __ambitBenchAdded${variant}(): number { return ${variant}; }\n`,
      );
      return { changes: [{ kind: "added", path: rel }] };
    }
    case "tsconfig": {
      // A module-resolution option nothing in the subject reads: it changes no
      // resolution, and it still moves the tsconfig text and the resolved
      // options — so both halves of the reuse gate must refuse, and
      // `tryReuseStructureFromOldProgram` must see a resolution change.
      const file = path.join(copyDir, plan.tsconfig);
      const text = original(file);
      if (text.includes('"customConditions"')) {
        throw new Error(
          `${file} already sets customConditions; the tsconfig mutation would clobber it`,
        );
      }
      const replaced = text.replace(
        /"compilerOptions"\s*:\s*\{/,
        (match) => `${match} "customConditions": ["ambit-bench-${variant % 2}"],`,
      );
      if (replaced === text) throw new Error(`${file} has no compilerOptions object to edit`);
      fs.writeFileSync(file, replaced);
      return { changes: [] };
    }
  }
}

/**
 * A config that did not exist is created as an unused effect alias whose
 * value toggles; one that did exist gets a toggled trailing comment. Both move
 * the loaded config's hash (`hashConfigValue` covers the source text), which is
 * what makes the session re-summarize every file.
 */
function writeConfig(file: string, existing: string | undefined, variant: number): void {
  if (existing === undefined) {
    const effect = variant % 2 === 0 ? "fs_read" : "fs_write";
    fs.writeFileSync(file, `export default { effects: { ambit_bench: ["${effect}"] } };\n`);
    return;
  }
  fs.writeFileSync(file, `${existing}\n${LEAF_MARK} ${variant % 2}\n`);
}

/**
 * The files `deletion` removes, one per iteration, created before the session
 * opens so that removing one is a deletion rather than an addition undone.
 *
 * @effects fs_write
 */
export function seedDeletionFiles(root: string, count: number): void {
  for (let n = 1; n <= count; n += 1) {
    fs.writeFileSync(
      path.join(root, deletionFile(n)),
      `export function __ambitBenchDeleted${n}(): number { return ${n}; }\n`,
    );
  }
}
