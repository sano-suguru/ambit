import path from "node:path";
import { describe, expect, it } from "vitest";
import { legacyTsBackend } from "../src/checker/index.ts";
import { analyze } from "../src/cli/analyze.ts";
import type { ExtractedProject, TsBackend } from "../src/core/index.ts";

/**
 * Diagnostics come out in a canonical order that is a function of the
 * findings, not of the order the backend discovered files in.
 *
 * Before this, `diagnose` iterated the propagated state's insertion order,
 * which follows the summaries, which follow `ExtractedProject.files`. That is
 * a property of the walk: a backend that read a directory differently — or
 * DESIGN.md §6.2's resident path, which patches one file's entry into a store
 * rather than rebuilding the list — would report the same findings in a
 * different order, and §6.2's equivalence law is stated in bytes.
 *
 * The test drives that difference directly rather than hoping a real backend
 * produces one: the same adopted backend, with `files` reversed. Everything
 * downstream sees a legitimate extraction in a different order.
 */

const FIXTURE = path.resolve(import.meta.dirname, "fixtures", "propagation");

/** The adopted backend, with `files` and `modules` reversed. */
const reversedOrderBackend: TsBackend = {
  name: legacyTsBackend.name,
  version: legacyTsBackend.version,
  async extractProject(rootDir: string): Promise<ExtractedProject> {
    const project = await legacyTsBackend.extractProject(rootDir);
    return {
      ...project,
      files: [...project.files].reverse(),
      modules: [...project.modules].reverse(),
    };
  },
};

describe("diagnostic order does not depend on file discovery order", () => {
  it("reports the same diagnostics, in the same order, when `files` is reversed", async () => {
    const forward = await analyze(FIXTURE);
    const reversed = await analyze(FIXTURE, { backend: reversedOrderBackend });

    // A positive control first: the fixture has to produce enough diagnostics
    // across enough files for the order to be observable at all.
    expect(forward.diagnostics.length).toBeGreaterThan(1);
    expect(new Set(forward.diagnostics.map((d) => d.location.file)).size).toBeGreaterThan(1);

    expect(reversed.diagnostics).toEqual(forward.diagnostics);
  });

  it("reports authority records and coverage identically too", async () => {
    const forward = await analyze(FIXTURE);
    const reversed = await analyze(FIXTURE, { backend: reversedOrderBackend });

    expect(reversed.authority).toEqual(forward.authority);
    // `toEqual` on a Map ignores insertion order, and insertion order is what
    // `Object.fromEntries` serializes — so the count maps are compared as the
    // bytes `check --coverage --format json` would print.
    expect(JSON.stringify(reversed.coverage)).toBe(JSON.stringify(forward.coverage));
    expect([...reversed.coverage.unresolvedByReason.keys()]).toEqual([
      ...forward.coverage.unresolvedByReason.keys(),
    ]);
  });

  it("orders by file, then line, then column, then diagnostic id", async () => {
    const { diagnostics } = await analyze(FIXTURE);
    const keys = diagnostics.map((d) => [d.location.file, d.location.line, d.location.col, d.id]);
    const sorted = [...keys].sort(
      (a, b) =>
        String(a[0]).localeCompare(String(b[0]), "en") ||
        Number(a[1]) - Number(b[1]) ||
        Number(a[2]) - Number(b[2]) ||
        String(a[3]).localeCompare(String(b[3]), "en"),
    );
    expect(keys).toEqual(sorted);
  });
});
