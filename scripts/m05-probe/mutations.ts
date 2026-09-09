/**
 * The controlled changes DESIGN.md §3.5 gate 3 asks for, and the question each
 * one poses to a backend. Shared by both update probes so that the two are
 * asked literally the same thing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface Mutation {
  readonly id: string;
  readonly description: string;
  /** The file it rewrites, relative to the corpus root. */
  readonly file: string;
  readonly apply: (root: string) => void;
  /** What a backend that saw the change must now report. */
  readonly expectation: string;
}

function rewrite(root: string, file: string, from: string, to: string): void {
  const full = path.join(root, file);
  const before = readFileSync(full, "utf8");
  if (!before.includes(from)) throw new Error(`mutation target not found in ${file}: ${from}`);
  writeFileSync(full, before.replace(from, to));
}

export const MUTATIONS: readonly Mutation[] = [
  {
    id: "body",
    description: "function body — a new call appears in selfRecursive",
    file: "recursion.ts",
    apply: (root) =>
      rewrite(
        root,
        "recursion.ts",
        "export function selfRecursive(n: number): number {",
        'export function selfRecursive(n: number): number {\n  void fetch("https://example.com/");',
      ),
    expectation: "selfRecursive now contains a call to fetch",
  },
  {
    id: "contract",
    description: "contract comment only — @effects fs_read becomes network",
    file: "recursion.ts",
    apply: (root) =>
      rewrite(root, "recursion.ts", "/** @effects fs_read */", "/** @effects network */"),
    expectation: "leafReadsFile declares network",
  },
  {
    id: "export",
    description: "export — leafReadsFile stops being exported",
    file: "recursion.ts",
    apply: (root) =>
      rewrite(root, "recursion.ts", "export function leafReadsFile", "function leafReadsFile"),
    expectation: "leafReadsFile is no longer an export of the module",
  },
];

export function mutationById(id: string): Mutation {
  const found = MUTATIONS.find((m) => m.id === id);
  if (!found) throw new Error(`unknown mutation: ${id}`);
  return found;
}

/**
 * The three facts every probe reports, before and after. They are chosen so
 * that each mutation moves exactly one of them: a backend that answered from a
 * stale state shows it here as an unchanged value, not as an error.
 */
export interface Observation {
  /** Whether `selfRecursive`'s body contains a call named `fetch`. */
  readonly selfRecursiveCallsFetch: boolean;
  /** The `@effects` text on `leafReadsFile`, or "none". */
  readonly leafReadsFileEffects: string;
  /** Whether `leafReadsFile` is exported. */
  readonly leafReadsFileExported: boolean;
}

export function formatObservation(o: Observation): string {
  return `fetch=${o.selfRecursiveCallsFetch} effects=${o.leafReadsFileEffects} exported=${o.leafReadsFileExported}`;
}
