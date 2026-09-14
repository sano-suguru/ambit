/**
 * The mutations `scripts/bench-resident.ts` measures, checked against the files
 * they leave on disk. A mutation that writes nothing new still produces
 * plausible timings — the first `alternate` run did exactly that
 * (`docs/measurements/2026-09-14-resident-large-workload.md`) — so what is
 * asserted here is the bytes, never a timing.
 *
 * Variants start at 1 because `scenarioChild` applies `n + 1`.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMutation,
  deletionFile,
  MUTATIONS,
  type MutationKind,
  type MutationPlan,
  seedDeletionFiles,
} from "../scripts/bench-resident/mutations.ts";

const temporaries: string[] = [];
afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy directory whose analysis root is `src/`, with `test/` outside it. */
function fixture(): { copyDir: string; root: string; plan: MutationPlan } {
  const copyDir = mkdtempSync(path.join(tmpdir(), "ambit-bench-resident-"));
  temporaries.push(copyDir);
  const files: Record<string, string> = {
    "src/a.ts": "export function a(): number { return 1; }\n",
    "src/b.ts": "export function b(): number { return 2; }\n",
    "src/c.ts": "export function c(): number { return 3; }\n",
    "src/hub.ts":
      'import { a } from "./a.ts";\n\nexport function hub(): number {\n  return a();\n}\n',
    "test/outside.ts": "export function outside(): number { return 4; }\n",
    "tsconfig.json": '{ "compilerOptions": { "strict": true }, "include": ["src", "test"] }\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(copyDir, rel)), { recursive: true });
    writeFileSync(path.join(copyDir, rel), text);
  }
  return {
    copyDir,
    root: path.join(copyDir, "src"),
    plan: {
      leaf: "b.ts",
      leaves: ["a.ts", "b.ts", "c.ts"],
      outsideRoot: "test/outside.ts",
      hub: "hub.ts",
      hubClosure: 1,
      jsdoc: { file: "hub.ts", line: 3, id: "hub.ts#hub" },
      configFile: "ambit.config.ts",
      configExisted: false,
      configInStore: undefined,
      tsconfig: "tsconfig.json",
    },
  };
}

/** Every file under `dir`, relative to it, with its text. */
function snapshot(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    files.set(path.relative(dir, full), readFileSync(full, "utf8"));
  }
  return files;
}

/** Paths added, removed, or rewritten between two snapshots, sorted. */
function differences(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((rel) => before.get(rel) !== after.get(rel)).toSorted();
}

describe("bench-resident mutations", () => {
  it("alternate: alternates a code edit with a contract-only edit, and each contract edit writes new bytes", () => {
    const { copyDir, root, plan } = fixture();
    const originals = new Map<string, string>();
    const originalHub = readFileSync(path.join(root, plan.jsdoc.file), "utf8");
    const contractTexts: string[] = [];
    const touched: string[] = [];
    for (let variant = 1; variant <= 6; variant += 1) {
      const before = snapshot(copyDir);
      const { changes } = applyMutation("alternate", plan, copyDir, root, originals, variant);
      const after = snapshot(copyDir);
      expect(changes).toHaveLength(1);
      const rel = changes[0]?.path ?? "";
      expect(changes[0]?.kind).toBe("changed");
      expect(differences(before, after)).toEqual([path.join("src", rel)]);
      touched.push(rel);
      if (rel === plan.jsdoc.file) {
        // Contract-only: the original text plus one `@effects` line, nothing else.
        const lines = (after.get(path.join("src", rel)) ?? "").split("\n");
        const inserted = lines.splice(plan.jsdoc.line - 1, 1);
        expect(inserted[0]).toMatch(/^\/\*\* @effects \w+ \*\/$/);
        expect(lines.join("\n")).toBe(originalHub);
        contractTexts.push(inserted[0] ?? "");
      } else {
        expect(rel).toBe(plan.leaf);
      }
    }
    expect(touched).toEqual([
      plan.jsdoc.file,
      plan.leaf,
      plan.jsdoc.file,
      plan.leaf,
      plan.jsdoc.file,
      plan.leaf,
    ]);
    // The regression: passing the odd `variant` straight to the toggle wrote
    // `fs_write` every time, so no contract edit after the first changed a byte.
    expect(contractTexts).toHaveLength(3);
    expect(contractTexts[1]).not.toBe(contractTexts[0]);
    expect(contractTexts[2]).not.toBe(contractTexts[1]);
  });

  it("leaf-rotate: edits every selected leaf in turn, one per iteration", () => {
    const { copyDir, root, plan } = fixture();
    const originals = new Map<string, string>();
    const touched: string[] = [];
    for (let variant = 1; variant <= plan.leaves.length * 2; variant += 1) {
      const before = snapshot(copyDir);
      const { changes } = applyMutation("leaf-rotate", plan, copyDir, root, originals, variant);
      const changed = differences(before, snapshot(copyDir));
      expect(changes).toHaveLength(1);
      expect(changes[0]?.kind).toBe("changed");
      expect(changed).toEqual([path.join("src", changes[0]?.path ?? "")]);
      touched.push(changes[0]?.path ?? "");
    }
    const firstRound = touched.slice(0, plan.leaves.length);
    expect(firstRound.toSorted()).toEqual([...plan.leaves].toSorted());
    expect(touched.slice(plan.leaves.length)).toEqual(firstRound);
  });

  it("deletion: removes a distinct seeded file each iteration and reports that file", () => {
    const { copyDir, root, plan } = fixture();
    const originals = new Map<string, string>();
    const count = 4;
    seedDeletionFiles(root, count);
    const deleted: string[] = [];
    for (let variant = 1; variant <= count; variant += 1) {
      const before = snapshot(copyDir);
      const { changes } = applyMutation("deletion", plan, copyDir, root, originals, variant);
      const after = snapshot(copyDir);
      expect(changes).toHaveLength(1);
      const rel = changes[0]?.path ?? "";
      expect(changes[0]?.kind).toBe("deleted");
      expect(differences(before, after)).toEqual([path.join("src", rel)]);
      expect(before.has(path.join("src", rel))).toBe(true);
      expect(existsSync(path.join(root, rel))).toBe(false);
      deleted.push(rel);
    }
    expect(new Set(deleted).size).toBe(count);
    expect(deleted.toSorted()).toEqual(
      Array.from({ length: count }, (_, i) => deletionFile(i + 1)).toSorted(),
    );
  });

  it("outside-root: rewrites the selected project file outside the root and reports no in-root change", () => {
    const { copyDir, root, plan } = fixture();
    const originals = new Map<string, string>();
    let previous = readFileSync(path.join(copyDir, plan.outsideRoot ?? ""), "utf8");
    for (let variant = 1; variant <= 3; variant += 1) {
      const before = snapshot(copyDir);
      const { changes } = applyMutation("outside-root", plan, copyDir, root, originals, variant);
      expect(changes).toEqual([]);
      expect(differences(before, snapshot(copyDir))).toEqual([plan.outsideRoot]);
      const text = readFileSync(path.join(copyDir, plan.outsideRoot ?? ""), "utf8");
      expect(text).not.toBe(previous);
      previous = text;
    }
    expect(() =>
      applyMutation(
        "outside-root",
        { ...plan, outsideRoot: undefined },
        copyDir,
        root,
        originals,
        1,
      ),
    ).toThrow();
  });

  // The general form of the `alternate` defect: every iteration must leave the
  // tree different from the one the previous update saw, and every reported
  // change must name a file whose bytes actually moved.
  it.each(MUTATIONS)(
    "%s: every iteration changes bytes, and every reported change is real",
    (kind: MutationKind) => {
      const { copyDir, root, plan } = fixture();
      const originals = new Map<string, string>();
      const iterations = 6;
      // The same preparation `scenarioChild` does before its session opens.
      if (kind === "config") applyMutation(kind, plan, copyDir, root, originals, 0);
      if (kind === "deletion") seedDeletionFiles(root, iterations);
      for (let variant = 1; variant <= iterations; variant += 1) {
        const before = snapshot(copyDir);
        const { changes } = applyMutation(kind, plan, copyDir, root, originals, variant);
        const changed = differences(before, snapshot(copyDir));
        expect(changed, `${kind} variant ${variant} wrote no new bytes`).not.toEqual([]);
        for (const change of changes) {
          expect(changed).toContain(path.join("src", change.path));
        }
      }
    },
  );
});
