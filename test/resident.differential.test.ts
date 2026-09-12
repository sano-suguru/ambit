import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { MUTATIONS } from "../scripts/m05-probe/mutations.ts";
import {
  type AnalysisResult,
  type ConfigDependencies,
  computeFingerprint,
  configDependencies,
  type FileChange,
  fingerprintPermitsExtractionReuse,
  fingerprintPermitsReuse,
  type ImpactReport,
  legacyTsBackend,
  openResidentSession,
  type PropagatedFunction,
  propagate,
  type ResidentSession,
  type ResidentStore,
} from "../src/checker/index.ts";
import { analyze } from "../src/cli/analyze.ts";
import type { SymbolId } from "../src/core/index.ts";
import { renderAnalysis } from "./support/render-analysis.ts";

/**
 * DESIGN.md §6.2's **equivalence law**, asserted rather than argued.
 *
 * > For any tree and any sequence of edits, the resident path's result must
 * > equal what a cold run over the same tree produces — the same diagnostics,
 * > the same `kind: "authority"` records, the same coverage counts, in the same
 * > order. Not "the same violations": the same bytes, including the `via`
 * > chains and the `unresolved` multisets.
 *
 * So the comparison here is over **rendered bytes**, not over objects.
 * `expect(a).toEqual(b)` on a `Map` ignores insertion order, and insertion
 * order is exactly what `check --coverage --format json` serializes — an
 * object comparison would pass on a difference the CLI would print.
 *
 * Every row also asserts the *delta* the mutation was supposed to cause.
 * Without that, a mutation whose target string was never found would leave the
 * tree untouched and the row would pass by comparing two identical analyses of
 * the same unedited tree, which is the shape of a test that verifies nothing.
 */

const FIXTURES = path.resolve(import.meta.dirname, "fixtures");
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const temporaries: string[] = [];
const sessions: ResidentSession[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A writable copy of a fixture, with a `package.json` at its root.
 *
 * The `package.json` is not decoration: `ambit.config.ts` is found by walking
 * up and stopping at the first directory holding a `package.json` or `.git`
 * (§4.1 (c)), and the fingerprint's resolution inputs are found the same way.
 * Without one, a tree under the OS temporary directory would search upward out
 * of itself.
 */
function copyFixture(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ambit-resident-"));
  temporaries.push(dir);
  cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "subject" })}\n`);
  return dir;
}

function write(dir: string, file: string, contents: string): void {
  const full = path.join(dir, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

function remove(dir: string, file: string): void {
  rmSync(path.join(dir, file), { force: true });
}

function edit(dir: string, file: string, from: string, to: string): void {
  const full = path.join(dir, file);
  const before = readText(full);
  if (!before.includes(from)) throw new Error(`edit target not found in ${file}: ${from}`);
  writeFileSync(full, before.replace(from, to));
}

function readText(full: string): string {
  return readFileSync(full, "utf8");
}

/**
 * The whole externally observable result as bytes — shared with
 * `test/support/cold-oracle.ts`, which renders the same thing from a separate
 * process. See `test/support/render-analysis.ts`.
 */
const render = renderAnalysis;

/**
 * A cold `analyze()` over `dir` **in a process of its own**, rendered.
 *
 * The in-process oracle is the right one almost everywhere and the wrong one
 * for anything the two paths can share and go stale on — a cached config
 * module makes the session and the in-process oracle agree on the same wrong
 * answer. A separate process shares no module registry with this one.
 */
function renderColdInSeparateProcess(dir: string): string {
  const result = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, "support", "cold-oracle.ts"), dir],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`cold oracle failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout;
}

/** Run the resident session's next generation and the cold oracle over the same tree. */
async function updateAndCompare(
  session: ResidentSession,
  dir: string,
  changes?: readonly FileChange[],
): Promise<{
  readonly resident: AnalysisResult;
  readonly cold: AnalysisResult;
  readonly full: boolean;
  readonly reextracted: readonly string[];
}> {
  const result = await session.update(changes);
  if (!result.ok) throw result.error;
  const cold = await analyze(dir);
  expect(render(result.analysis)).toBe(render(cold));
  // The session's own accessor has to agree with what the update returned;
  // otherwise a caller reading `current()` gets a different answer from the one
  // the comparison passed.
  expect(render(session.current())).toBe(render(cold));
  return {
    resident: result.analysis,
    cold,
    full: result.full,
    reextracted: result.reextracted,
  };
}

async function open(dir: string): Promise<ResidentSession> {
  const session = await openResidentSession(dir);
  sessions.push(session);
  return session;
}

/**
 * The observed effects of one authority record, plus `"unknown"` where
 * propagation reached a call it could not resolve — the two together are what
 * a reader of `ambit diff` sees change.
 */
function effectsOf(analysis: AnalysisResult, symbol: string): readonly string[] {
  const record = analysis.authority.find((r) => r.symbol === symbol);
  if (!record) return [];
  return [...record.effects.observed, ...(record.effects.unknown ? ["unknown"] : [])].sort();
}

/** The effects a record *declares*, or `null` where nothing declares it. */
function declaredOf(analysis: AnalysisResult, symbol: string): readonly string[] | null {
  const declared = analysis.authority.find((r) => r.symbol === symbol)?.effects.declared;
  return declared ? [...declared].sort() : (declared ?? null);
}

function symbols(analysis: AnalysisResult): readonly string[] {
  return analysis.authority.map((r) => r.symbol);
}

function unresolvedTotal(analysis: AnalysisResult): number {
  return analysis.coverage.callSitesUnresolved;
}

// ---------------------------------------------------------------------------

describe("resident session: the first generation equals a cold run", () => {
  for (const fixture of ["cross-module", "propagation", "realistic-api", "wrappers", "contracts"]) {
    it(`${fixture}`, async () => {
      const dir = copyFixture(fixture);
      const session = await open(dir);
      expect(render(session.current())).toBe(render(await analyze(dir)));
    });
  }
});

describe("resident session: each mutation's update equals a cold run over the same tree", () => {
  it("an ordinary source edit", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);
    const before = session.current();

    edit(
      dir,
      "direct-import.ts",
      "export function pureCallsImportedNetwork(): number {",
      'export function pureCallsImportedNetwork(): number {\n  void fetch("https://example.com/added");',
    );
    const { resident } = await updateAndCompare(session, dir);

    // The delta: a `fetch` inside the function is a direct `network`, where
    // before it only inherited one.
    expect(effectsOf(before, "direct-import.ts#pureCallsImportedNetwork")).toEqual(["network"]);
    expect(resident.diagnostics.length).toBeGreaterThan(0);
  });

  it("a JSDoc-only edit", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);
    const before = session.current();

    // Nothing about the code changes — only the contract comment. §6.2 names
    // this explicitly: "Do not ignore a change to contract comments alone, even
    // when type information is unchanged."
    edit(dir, "direct-import.ts", "/** @effects pure */", "/** @effects network */");
    const { resident } = await updateAndCompare(session, dir);

    const declaredBefore = before.diagnostics.filter(
      (d) => d.location.file === "direct-import.ts",
    ).length;
    const declaredAfter = resident.diagnostics.filter(
      (d) => d.location.file === "direct-import.ts",
    ).length;
    expect(declaredBefore).toBeGreaterThan(0);
    expect(declaredAfter).toBe(0);
  });

  it("authority added, then the same authority removed", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);

    edit(
      dir,
      "builtin-named-import.ts",
      "export function callsBuiltinNamedImport(): void {",
      'export function callsBuiltinNamedImport(): void {\n  void fetch("https://example.com/");',
    );
    const added = (await updateAndCompare(session, dir)).resident;
    expect(effectsOf(added, "builtin-named-import.ts#callsBuiltinNamedImport")).toContain(
      "network",
    );

    edit(dir, "builtin-named-import.ts", '\n  void fetch("https://example.com/");', "");
    const removed = (await updateAndCompare(session, dir)).resident;
    // The non-monotonic direction, which a fixed point that only ever unions
    // would get wrong.
    expect(effectsOf(removed, "builtin-named-import.ts#callsBuiltinNamedImport")).not.toContain(
      "network",
    );
  });

  it("a file added", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);
    const before = session.current();

    write(
      dir,
      "newly-added.ts",
      '/** @effects pure */\nexport function addedLater(): void {\n  void fetch("https://example.com/new");\n}\n',
    );
    const { resident } = await updateAndCompare(session, dir);

    expect(symbols(before)).not.toContain("newly-added.ts#addedLater");
    expect(symbols(resident)).toContain("newly-added.ts#addedLater");
  });

  it("a file deleted", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);
    const before = session.current();

    remove(dir, "builtin-named-import.ts");
    const { resident } = await updateAndCompare(session, dir);

    expect(symbols(before)).toContain("builtin-named-import.ts#callsBuiltinNamedImport");
    expect(symbols(resident)).not.toContain("builtin-named-import.ts#callsBuiltinNamedImport");
  });

  it("an unresolved import, then the file it names is added", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);
    const before = session.current();

    // `missing-module-import.ts` imports "./no-such-file.ts", which resolves to
    // nothing — so the store holds no import edge to it. This is the case
    // §6.2 makes a file *addition* re-check everything for: no closure over the
    // edges already held could find the importer.
    expect(effectsOf(before, "missing-module-import.ts#callsMissingModuleImport")).toContain(
      "unknown",
    );

    write(
      dir,
      "no-such-file.ts",
      '/** @effects network */\nexport function doesNotExist(): void {\n  void fetch("https://example.com/");\n}\n',
    );
    const { resident } = await updateAndCompare(session, dir);

    const after = effectsOf(resident, "missing-module-import.ts#callsMissingModuleImport");
    expect(after).toContain("network");
    expect(after).not.toContain("unknown");
    expect(unresolvedTotal(resident)).toBeLessThan(unresolvedTotal(before));
  });

  it("a new file taking resolution precedence from an existing candidate", async () => {
    const dir = copyFixture("cross-module");
    write(
      dir,
      "precedence/index.ts",
      "/** @effects pure */\nexport function target(): number {\n  return 1;\n}\n",
    );
    write(
      dir,
      "precedence-importer.ts",
      'import { target } from "./precedence/index.ts";\n\nexport function callsTarget(): number {\n  return target();\n}\n',
    );
    const session = await open(dir);
    const before = session.current();
    expect(effectsOf(before, "precedence-importer.ts#callsTarget")).toEqual([]);

    // The importer's held edge points at `precedence/index.ts` — the candidate
    // that keeps resolving, not the one that arrives. Re-pointing the specifier
    // is how the same precedence question is posed without depending on a
    // resolution mode's directory-index rules.
    write(
      dir,
      "precedence.ts",
      '/** @effects network */\nexport function target(): void {\n  void fetch("https://example.com/");\n}\n',
    );
    edit(dir, "precedence-importer.ts", './precedence/index.ts"', './precedence.ts"');
    const { resident } = await updateAndCompare(session, dir);

    expect(effectsOf(resident, "precedence-importer.ts#callsTarget")).toContain("network");
  });

  it("a rename, as a delete and an add", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);
    const before = session.current();

    const body =
      '/** @effects network */\nexport function fetchRate(): number {\n  fetch("https://example.com/rate");\n  return 0;\n}\n';
    remove(dir, "callee.ts");
    write(dir, "callee-renamed.ts", body);
    edit(dir, "direct-import.ts", './callee.ts"', './callee-renamed.ts"');
    edit(dir, "index.ts", './callee.ts"', './callee-renamed.ts"');
    const { resident } = await updateAndCompare(session, dir);

    // Every old id gone, every new id new. The resident path makes no rename
    // guess — that reconciliation is `ambit diff`'s, and it comes from git.
    expect(symbols(before)).toContain("callee.ts#fetchRate");
    expect(symbols(resident)).not.toContain("callee.ts#fetchRate");
    expect(symbols(resident)).toContain("callee-renamed.ts#fetchRate");
  });

  it("a re-export barrel re-pointed", async () => {
    const dir = copyFixture("cross-module");
    write(
      dir,
      "other-callee.ts",
      "/** @effects fs_read */\nexport function fetchRate(): number {\n  return 1;\n}\n",
    );
    const session = await open(dir);
    const before = session.current();
    expect(effectsOf(before, "barrel-import.ts#pureCallsBarrelImportedNetwork")).toContain(
      "network",
    );

    // `index.ts` declares no function of its own and so never reaches
    // `ExtractedProject.files` — it exists in the store only as an
    // `ExtractedModule`, which is the whole reason that record exists.
    edit(
      dir,
      "index.ts",
      'export { fetchRate } from "./callee.ts";',
      'export { fetchRate } from "./other-callee.ts";',
    );
    const { resident } = await updateAndCompare(session, dir);

    const after = effectsOf(resident, "barrel-import.ts#pureCallsBarrelImportedNetwork");
    expect(after).toContain("fs_read");
    expect(after).not.toContain("network");
  });

  it("a cycle, edited", async () => {
    const dir = copyFixture("cross-module");
    write(
      dir,
      "cycle.ts",
      [
        "export function ping(n: number): number {",
        "  return n <= 0 ? 0 : pong(n - 1);",
        "}",
        "",
        "export function pong(n: number): number {",
        "  return n <= 0 ? 0 : ping(n - 1);",
        "}",
        "",
      ].join("\n"),
    );
    const session = await open(dir);
    const before = session.current();
    expect(effectsOf(before, "cycle.ts#ping")).toEqual([]);

    // An effect introduced inside a cycle has to reach every member of it.
    edit(
      dir,
      "cycle.ts",
      "return n <= 0 ? 0 : pong(n - 1);",
      'void fetch("https://example.com/");\n  return n <= 0 ? 0 : pong(n - 1);',
    );
    const { resident } = await updateAndCompare(session, dir);

    expect(effectsOf(resident, "cycle.ts#ping")).toContain("network");
    expect(effectsOf(resident, "cycle.ts#pong")).toContain("network");
  });

  it("a callback edge added and removed", async () => {
    const dir = copyFixture("cross-module");
    write(
      dir,
      "callbacks.ts",
      [
        "function plain(n: number): number {",
        "  return n + 1;",
        "}",
        "",
        "/** @effects pure */",
        "export function mapsOver(values: readonly number[]): readonly number[] {",
        "  return values.map(plain);",
        "}",
        "",
      ].join("\n"),
    );
    const session = await open(dir);
    const before = session.current();
    expect(effectsOf(before, "callbacks.ts#mapsOver")).toEqual([]);

    // The callback target gains an effect, and the edge is what carries it to
    // the caller — `callbackTargets` changing is what puts the summary in the
    // changed set.
    edit(
      dir,
      "callbacks.ts",
      "function plain(n: number): number {\n  return n + 1;",
      'function plain(n: number): number {\n  void fetch("https://example.com/");\n  return n + 1;',
    );
    const gained = (await updateAndCompare(session, dir)).resident;
    expect(effectsOf(gained, "callbacks.ts#mapsOver")).toContain("network");

    edit(dir, "callbacks.ts", "  return values.map(plain);", "  return values.map((n) => n + 1);");
    const lost = (await updateAndCompare(session, dir)).resident;
    expect(effectsOf(lost, "callbacks.ts#mapsOver")).not.toContain("network");
  });

  it("an ambit.config.ts contract added, changed and removed", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);
    const before = session.current();
    expect(declaredOf(before, "builtin-named-import.ts#callsBuiltinNamedImport")).toBeNull();

    const config = (effects: string) =>
      `export default {\n  contracts: {\n    "builtin-named-import.ts#callsBuiltinNamedImport": { effects: [${effects}] },\n  },\n};\n`;

    write(dir, "ambit.config.ts", config('"fs_read"'));
    const declared = (await updateAndCompare(session, dir)).resident;
    expect(declaredOf(declared, "builtin-named-import.ts#callsBuiltinNamedImport")).toEqual([
      "fs_read",
    ]);

    // The second write is what a cached ES module would defeat: same path, new
    // text. A stale import would keep answering `fs_read` on *both* sides and
    // the comparison would pass while both were wrong — so the delta assertion
    // below is what actually tests the invalidation.
    write(dir, "ambit.config.ts", config('"network"'));
    const changed = (await updateAndCompare(session, dir)).resident;
    expect(declaredOf(changed, "builtin-named-import.ts#callsBuiltinNamedImport")).toEqual([
      "network",
    ]);

    remove(dir, "ambit.config.ts");
    const gone = (await updateAndCompare(session, dir)).resident;
    expect(declaredOf(gone, "builtin-named-import.ts#callsBuiltinNamedImport")).toBeNull();
  });

  it("a config key that names nothing is reported, and stops being reported when it matches", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);

    write(
      dir,
      "ambit.config.ts",
      'export default {\n  contracts: {\n    "nowhere.ts#missing": { effects: [] },\n  },\n};\n',
    );
    const unmatched = (await updateAndCompare(session, dir)).resident;
    expect(unmatched.diagnostics.some((d) => d.id === "AMB-W006")).toBe(true);

    write(
      dir,
      "ambit.config.ts",
      'export default {\n  contracts: {\n    "callee.ts#fetchRate": { effects: ["network"] },\n  },\n};\n',
    );
    const matched = (await updateAndCompare(session, dir)).resident;
    expect(matched.diagnostics.some((d) => d.id === "AMB-W006")).toBe(false);
  });

  it("an ambit.config.ts helper edited, checked against a separate-process cold run", async () => {
    const dir = copyFixture("cross-module");
    write(
      dir,
      "config-contracts.ts",
      'export const contracts = {\n  "builtin-named-import.ts#callsBuiltinNamedImport": { effects: ["fs_read"] },\n};\n',
    );
    write(
      dir,
      "ambit.config.ts",
      'import { contracts } from "./config-contracts.ts";\n\nexport default { contracts };\n',
    );
    const session = await open(dir);
    expect(
      declaredOf(session.current(), "builtin-named-import.ts#callsBuiltinNamedImport"),
    ).toEqual(["fs_read"]);

    // The config file's own text does not change here — only a module it
    // imports. A cache key built from the config's text alone leaves this
    // update answering out of the previous generation's helper, and the
    // in-process oracle would go stale with it and agree. Hence the separate
    // process: it shares no module registry with this one.
    write(
      dir,
      "config-contracts.ts",
      'export const contracts = {\n  "builtin-named-import.ts#callsBuiltinNamedImport": { effects: ["network"] },\n};\n',
    );
    const result = await session.update();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(declaredOf(result.analysis, "builtin-named-import.ts#callsBuiltinNamedImport")).toEqual([
      "network",
    ]);
    expect(render(result.analysis)).toBe(renderColdInSeparateProcess(dir));
    // And the in-process oracle agrees too — which it only does because
    // `loadConfig` evaluates an importing config in a fresh module registry.
    expect(render(result.analysis)).toBe(render(await analyze(dir)));
  });

  it("an ambit.config.ts helper reached through a multiline import, edited", async () => {
    const dir = copyFixture("cross-module");
    write(
      dir,
      "config-contracts.ts",
      'export const contracts = {\n  "builtin-named-import.ts#callsBuiltinNamedImport": { effects: ["fs_read"] },\n};\n',
    );
    // The binding list runs across several lines. A scanner that stops at the
    // first newline reads this file as importing nothing, takes the path that
    // cannot see an edited dependency, and answers out of the previous
    // generation — with the in-process oracle agreeing, because it went stale
    // too. That was a live defect, not a hypothetical.
    write(
      dir,
      "ambit.config.ts",
      'import {\n  contracts,\n} from "./config-contracts.ts";\n\nexport default { contracts };\n',
    );
    const session = await open(dir);
    expect(
      declaredOf(session.current(), "builtin-named-import.ts#callsBuiltinNamedImport"),
    ).toEqual(["fs_read"]);

    write(
      dir,
      "config-contracts.ts",
      'export const contracts = {\n  "builtin-named-import.ts#callsBuiltinNamedImport": { effects: ["network"] },\n};\n',
    );
    const result = await session.update();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(declaredOf(result.analysis, "builtin-named-import.ts#callsBuiltinNamedImport")).toEqual([
      "network",
    ]);
    expect(render(result.analysis)).toBe(renderColdInSeparateProcess(dir));
  });

  it("an ambit.config.ts whose only import is a bare specifier", async () => {
    const dir = copyFixture("cross-module");
    // A real installed package, so the bare specifier resolves the way a
    // consumer's `ambit-ts/config` would. `node_modules` is outside the
    // analysis root's file set, so it changes nothing about what is checked.
    write(
      dir,
      "node_modules/config-helper/package.json",
      `${JSON.stringify({ name: "config-helper", version: "1.0.0", type: "module", main: "index.js" })}\n`,
    );
    write(
      dir,
      "node_modules/config-helper/index.js",
      'export const contracts = { "builtin-named-import.ts#callsBuiltinNamedImport": { effects: ["network"] } };\n',
    );
    // Nothing relative is imported, so the hash closure is the config alone —
    // and the config still has a dependency Node caches by URL. Deciding how to
    // load from the closure's *size* put this config on the cheap path; the
    // decision is `hasImports`, which a bare specifier sets exactly as a
    // relative one does.
    write(
      dir,
      "ambit.config.ts",
      'import { contracts } from "config-helper";\n\nexport default { contracts };\n',
    );
    const session = await open(dir);
    expect(
      declaredOf(session.current(), "builtin-named-import.ts#callsBuiltinNamedImport"),
    ).toEqual(["network"]);
    expect(render(session.current())).toBe(renderColdInSeparateProcess(dir));

    // Rewrite the installed package. The config file's own text does not
    // change and neither does the hash closure — a bare specifier is
    // deliberately not in it. What has to happen anyway is that the next
    // generation *evaluates* the config against the new package rather than
    // against the copy Node cached, which is what `hasImports` decides.
    write(
      dir,
      "node_modules/config-helper/index.js",
      'export const contracts = { "builtin-named-import.ts#callsBuiltinNamedImport": { effects: ["fs_read"] } };\n',
    );
    const result = await session.update();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(declaredOf(result.analysis, "builtin-named-import.ts#callsBuiltinNamedImport")).toEqual([
      "fs_read",
    ]);
    expect(render(result.analysis)).toBe(renderColdInSeparateProcess(dir));
  });

  it("a change, then the same change reverted", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);
    const original = render(session.current());

    edit(dir, "callee.ts", '  fetch("https://example.com/rate");\n', "");
    const changed = (await updateAndCompare(session, dir)).resident;
    expect(effectsOf(changed, "callee.ts#fetchRate")).toEqual([]);

    edit(
      dir,
      "callee.ts",
      "export function fetchRate(): number {\n",
      'export function fetchRate(): number {\n  fetch("https://example.com/rate");\n',
    );
    const reverted = (await updateAndCompare(session, dir)).resident;
    // Byte-for-byte back to where it started. Authority *decreasing* and then
    // returning is where a fixed point that never resets would be caught.
    expect(render(reverted)).toBe(original);
  });

  it("ten sequential mutations in one session", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);

    const mutations: readonly (() => void)[] = [
      () => write(dir, "step1.ts", "export function one(): number {\n  return 1;\n}\n"),
      () => edit(dir, "step1.ts", "return 1;", 'void fetch("https://example.com/1");\n  return 1;'),
      () =>
        write(
          dir,
          "step2.ts",
          'import { one } from "./step1.ts";\n\nexport function two(): number {\n  return one();\n}\n',
        ),
      () => edit(dir, "direct-import.ts", "/** @effects pure */", "/** @effects network */"),
      () => remove(dir, "builtin-default-import.ts"),
      () =>
        write(
          dir,
          "ambit.config.ts",
          'export default {\n  contracts: {\n    "step1.ts#one": { effects: [] },\n  },\n};\n',
        ),
      () => edit(dir, "index.ts", 'export { fetchRate } from "./callee.ts";', ""),
      () => write(dir, "step3.ts", 'export { one } from "./step1.ts";\n'),
      () => edit(dir, "step2.ts", './step1.ts"', './step3.ts"'),
      () => remove(dir, "ambit.config.ts"),
    ];

    const rendered: string[] = [];
    for (const mutate of mutations) {
      mutate();
      const { resident } = await updateAndCompare(session, dir);
      rendered.push(render(resident));
    }

    expect(session.committed().store.generation).toBe(mutations.length + 1);
    // A single update cannot catch state that survives into a third generation;
    // the point of the chain is that each generation is compared, and that the
    // chain actually moved rather than settling after step one.
    expect(new Set(rendered).size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------

describe("resident session: a failed update is a failure, not an answer", () => {
  /**
   * §6.2: "An update that throws ... leaves the resident state at the last
   * generation it committed and is reported as a failure ... The previous
   * generation's diagnostics are never re-served as though they described the
   * current tree."
   *
   * Four things are proved for each failure shape, and the third is the one
   * that matters: a committed previous generation is not the same thing as an
   * answer about the tree that failed.
   */
  async function provesFailure(
    dir: string,
    session: ResidentSession,
    breakIt: () => void,
    repair: () => void,
  ): Promise<Error> {
    const committedBefore = session.committed();
    const renderedBefore = render(committedBefore.analysis);

    breakIt();
    const failed = await session.update();

    // 1. The update reports failure.
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error("unreachable");

    // The cold path fails on the same tree, **with the same message**: §6.2
    // asks for "the same exit code and the same distinction a one-shot run
    // would give it", and two paths that fail on different halves of a doubly
    // broken tree would give different distinctions. Asserting only that both
    // threw would not see that.
    await expect(analyze(dir)).rejects.toThrow(failed.error.message);

    // 2. The previous generation stays committed, byte-identical.
    expect(session.committed().store.generation).toBe(committedBefore.store.generation);
    expect(render(session.committed().analysis)).toBe(renderedBefore);
    expect(failed.generation).toBe(committedBefore.store.generation);

    // 3. And it is not served as the current answer.
    expect(() => session.current()).toThrow(/no generation describes the current tree/);

    // 4. A later valid update succeeds and is equal to cold again.
    repair();
    const repaired = await session.update();
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) throw new Error("unreachable");
    expect(repaired.generation).toBe(committedBefore.store.generation + 1);
    expect(render(repaired.analysis)).toBe(render(await analyze(dir)));
    expect(() => session.current()).not.toThrow();

    return failed.error;
  }

  it("a tsconfig that stopped parsing", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);
    const good = readText(path.join(dir, "tsconfig.json"));

    const error = await provesFailure(
      dir,
      session,
      () => write(dir, "tsconfig.json", "{ not json"),
      () => write(dir, "tsconfig.json", good),
    );
    expect(error.message).toMatch(/tsconfig\.json/);
  });

  it("an ambit.config.ts that no longer loads", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);

    const error = await provesFailure(
      dir,
      session,
      () => write(dir, "ambit.config.ts", "export default {{{ broken\n"),
      () => remove(dir, "ambit.config.ts"),
    );
    expect(error.message).toMatch(/ambit\.config\.ts/);
  });

  it("two declarations colliding on one symbol id", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);

    const collision =
      "export const holder = {\n  dup() {\n    return 1;\n  },\n  dup() {\n    return 2;\n  },\n};\n";
    const error = await provesFailure(
      dir,
      session,
      () => write(dir, "collision.ts", collision),
      () => remove(dir, "collision.ts"),
    );
    // §4.1: a residual collision has to stop the run rather than reach the
    // fixed point, which would never converge.
    expect(error.message).toMatch(/share the symbol id/);
  });

  it("a tree with nothing analyzable in it", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);
    const sources = [
      "barrel-builtin-import.ts",
      "barrel-import.ts",
      "builtin-aliased-named-import.ts",
      "builtin-default-import.ts",
      "builtin-named-import.ts",
      "callee.ts",
      "deep-barrel-import.ts",
      "deep-barrel.ts",
      "direct-import.ts",
      "index.ts",
      "missing-module-import.ts",
    ];
    const contents = sources.map((file) => [file, readText(path.join(dir, file))] as const);

    const error = await provesFailure(
      dir,
      session,
      () => {
        for (const file of sources) remove(dir, file);
        write(dir, "empty.ts", "export const nothing = 1;\n");
      },
      () => {
        remove(dir, "empty.ts");
        for (const [file, text] of contents) write(dir, file, text);
      },
    );
    // §3.4: "no analyzable functions" must not read as "checked, no violations".
    expect(error.message).toMatch(/no analyzable functions/);
  });
  it("a tsconfig and a config broken at once fail the same way on both paths", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);
    const good = readText(path.join(dir, "tsconfig.json"));

    // Which of the two is reported depends on which is read first, and the two
    // paths have to read them in the same order — otherwise the resident path
    // names the tsconfig where a one-shot run names the config, and a reader
    // fixes the wrong file.
    const error = await provesFailure(
      dir,
      session,
      () => {
        write(dir, "tsconfig.json", "{ not json");
        write(dir, "ambit.config.ts", "export default {{{ broken\n");
      },
      () => {
        write(dir, "tsconfig.json", good);
        remove(dir, "ambit.config.ts");
      },
    );
    expect(error.message).toMatch(/ambit\.config\.ts/);
  });
});

// ---------------------------------------------------------------------------

describe("ProjectFingerprint fails toward rebuilding", () => {
  const engine = { name: "typescript-legacy", version: "0.0.0-test" } as const;

  function fingerprintOf(dir: string) {
    return computeFingerprint(dir, {
      ...engine,
      extractProject: () => {
        throw new Error("not called");
      },
    });
  }

  it("never permits reuse while anything is undecidable, even against itself", async () => {
    const dir = copyFixture("cross-module");

    // Phase 4 removed the permanent "resolved compiler options are not
    // available" entry, because the backend session now compares them from a
    // program it built — so an ordinary project is decidable from here.
    const plain = fingerprintOf(dir);
    expect(plain.undecidable).toEqual([]);
    expect(plain.projectUndecidable).toEqual([]);
    expect(plain.configUndecidable).toEqual([]);

    // The rule itself is unchanged: an unknown on *either* side refuses, and
    // refuses even against an identical fingerprint. Asserted per list,
    // because the two gate different things — a config the closure walk could
    // not follow says nothing about extraction, which no contract reaches.
    const projectUnknown = { ...plain, undecidable: ["?"], projectUndecidable: ["?"] };
    expect(fingerprintPermitsReuse(projectUnknown, projectUnknown)).toBe(false);
    expect(fingerprintPermitsExtractionReuse(projectUnknown, projectUnknown)).toBe(false);

    const configUnknown = { ...plain, undecidable: ["?"], configUndecidable: ["?"] };
    expect(fingerprintPermitsReuse(configUnknown, configUnknown)).toBe(false);
    expect(fingerprintPermitsExtractionReuse(configUnknown, configUnknown)).toBe(true);
  });

  it("permits reuse only when every input is identical and nothing is undecidable", async () => {
    const dir = copyFixture("cross-module");
    const decidable = { ...fingerprintOf(dir), undecidable: [] as readonly string[] };

    expect(fingerprintPermitsReuse(decidable, decidable)).toBe(true);
    expect(fingerprintPermitsReuse(decidable, { ...decidable, tsconfigHash: "x" })).toBe(false);
    expect(fingerprintPermitsReuse(decidable, { ...decidable, configHash: "x" })).toBe(false);
    expect(fingerprintPermitsReuse(decidable, { ...decidable, resolutionHash: "x" })).toBe(false);
    expect(fingerprintPermitsReuse(decidable, { ...decidable, engineVersion: "x" })).toBe(false);
    expect(fingerprintPermitsReuse(decidable, { ...decidable, undecidable: ["anything"] })).toBe(
      false,
    );
  });

  it("moves the hash a change belongs to, and leaves the others alone", async () => {
    const dir = copyFixture("cross-module");
    const before = fingerprintOf(dir);

    // A source edit moves nothing: the fingerprint is about the project's
    // *inputs*, and file contents are what `FileChange` and the extraction
    // carry.
    edit(dir, "callee.ts", "return 0;", "return 1;");
    expect(fingerprintOf(dir)).toEqual(before);

    write(dir, "ambit.config.ts", "export default { contracts: {} };\n");
    const configured = fingerprintOf(dir);
    expect(configured.configHash).not.toBe(before.configHash);
    expect(configured.tsconfigHash).toBe(before.tsconfigHash);
    expect(configured.resolutionHash).toBe(before.resolutionHash);

    write(dir, "package.json", `${JSON.stringify({ name: "subject", version: "2" })}\n`);
    const installed = fingerprintOf(dir);
    expect(installed.resolutionHash).not.toBe(configured.resolutionHash);
    expect(installed.configHash).toBe(configured.configHash);

    write(dir, "tsconfig.json", `${readText(path.join(dir, "tsconfig.json"))}\n`);
    expect(fingerprintOf(dir).tsconfigHash).not.toBe(installed.tsconfigHash);
  });

  it("moves configHash when a file the config imports changes, not only the config", async () => {
    const dir = copyFixture("cross-module");
    write(dir, "config-contracts.ts", "export const contracts = {};\n");
    write(
      dir,
      "ambit.config.ts",
      'import { contracts } from "./config-contracts.ts";\n\nexport default { contracts };\n',
    );
    const before = fingerprintOf(dir);

    // The config file itself is untouched. Hashing its text alone would report
    // this as "nothing changed" — the permissive direction §6.2 forbids.
    write(
      dir,
      "config-contracts.ts",
      'export const contracts = { "callee.ts#fetchRate": { effects: ["network"] } };\n',
    );
    const after = fingerprintOf(dir);
    expect(after.configHash).not.toBe(before.configHash);
    expect(after.tsconfigHash).toBe(before.tsconfigHash);
    expect(after.resolutionHash).toBe(before.resolutionHash);
  });

  it("reports an unreadable or dynamically imported config dependency as undecidable", async () => {
    const dir = copyFixture("cross-module");
    write(
      dir,
      "ambit.config.ts",
      'import { contracts } from "./not-on-disk.ts";\n\nexport default { contracts };\n',
    );
    expect(
      fingerprintOf(dir).undecidable.some((reason) => /resolves to no file/.test(reason)),
    ).toBe(true);

    write(
      dir,
      "ambit.config.ts",
      'const { contracts } = await import("./config-contracts.ts");\n\nexport default { contracts };\n',
    );
    expect(fingerprintOf(dir).undecidable.some((reason) => /dynamic import/.test(reason))).toBe(
      true,
    );
  });

  it("sets hasImports for every import shape, and only for a real one", async () => {
    const dir = copyFixture("cross-module");
    const dependenciesFor = (source: string): ConfigDependencies => {
      write(dir, "ambit.config.ts", source);
      return configDependencies(path.join(dir, "ambit.config.ts"));
    };

    // No import at all: the cheap content-query path, and it must stay cheap —
    // this is what almost every config looks like.
    expect(dependenciesFor("export default { contracts: {} };\n").hasImports).toBe(false);

    // A bare specifier. Not in the hash closure (a package change is a
    // resolution change), but still a module Node caches by URL.
    expect(
      dependenciesFor(
        'import { defineConfig } from "ambit-ts/config";\nexport default defineConfig({});\n',
      ).hasImports,
    ).toBe(true);

    // The shape that was silently missed: a binding list across several lines.
    const multiline = dependenciesFor(
      'import {\n  contracts,\n} from "./config-contracts.ts";\nexport default { contracts };\n',
    );
    expect(multiline.hasImports).toBe(true);

    // Side-effect import, and a re-export.
    expect(dependenciesFor('import "./side-effect.ts";\nexport default {};\n').hasImports).toBe(
      true,
    );
    expect(dependenciesFor('export * from "./other.ts";\nexport default {};\n').hasImports).toBe(
      true,
    );

    // A string containing the word `from` inside the exported object is not an
    // import — but if the scan ever reads it as one, the cost is a worker
    // start, never a stale answer. The direction this is allowed to be wrong in
    // is the expensive one.
    const prose = dependenciesFor('export default { contracts: { "a.ts#f": { effects: [] } } };\n');
    expect(prose.undecidable).toEqual([]);
  });

  it("reports an `extends` chain as undecidable rather than hashing past it", async () => {
    const dir = copyFixture("cross-module");
    const plain = fingerprintOf(dir);
    const extendsReason = /extends/;
    expect(plain.undecidable.some((reason) => extendsReason.test(reason))).toBe(false);

    write(dir, "base.json", '{ "compilerOptions": { "strict": true } }\n');
    write(dir, "tsconfig.json", '{ "extends": "./base.json", "include": ["**/*.ts"] }\n');
    expect(fingerprintOf(dir).undecidable.some((reason) => extendsReason.test(reason))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("resident session: nothing snapshot-bound is retained", () => {
  it("the committed store survives structuredClone", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);
    await session.update();
    const store: ResidentStore = session.committed().store;

    // `structuredClone` throws `DataCloneError` on a function, so it catches a
    // retained compiler node, type, signature, or closure over one — every
    // object shape that carries methods. It is **one guard, not a proof**: a
    // snapshot-bound *primitive* (an internal numeric or string id) clones
    // fine. What rules those out is the other two: `test/architecture.test.ts`
    // forbids this file from importing `typescript` at all, and `src/core`'s
    // `TsBackend` boundary fixes what may cross it (§3.4). The three together
    // are the argument; this assertion alone is not.
    expect(() => structuredClone(store)).not.toThrow();

    // And the store is actually populated, so the assertion above is not
    // passing over an empty object.
    expect(store.files.size).toBeGreaterThan(5);
    expect(store.state.size).toBeGreaterThan(5);
    expect(store.reverseImports.size).toBeGreaterThan(0);
    expect(store.reverseCalls.size).toBeGreaterThan(0);
    // A barrel that declares nothing still has an entry, and still has edges.
    expect(store.files.get("deep-barrel.ts")?.extracted).toBeUndefined();
    expect(store.files.get("deep-barrel.ts")?.module.imports).toEqual(["index.ts"]);
    expect([...(store.reverseImports.get("index.ts") ?? [])]).toContain("deep-barrel.ts");
  });

  it("reports every phase §6.2 names, and reports transfer as a measured zero", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);
    const result = await session.update();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.timings.transfer).toBe(0);
    expect(result.timings.extraction).toBeGreaterThan(0);
    expect(result.timings.summarize).toBeGreaterThanOrEqual(0);
    expect(result.timings.propagate).toBeGreaterThanOrEqual(0);
    expect(result.timings.report).toBeGreaterThanOrEqual(0);
    // Phase 3 measures the changed-summary comparison and the reverse-call
    // closure, so this is a real number. It is not asserted `> 0`: the phase
    // is genuinely fast enough to round to zero on a small tree, and a test
    // demanding a nonzero duration would be a test of the clock.
    expect(result.timings.impact).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.timings.impact)).toBe(true);
    // The legacy backend's `openProject` separates building the program from
    // walking it, so this is a real number (phase 4).
    expect(result.timings.projectUpdate).toBeGreaterThan(0);
    expect(result.full).toBe(true);
    // Extraction is still whole-project in phase 3; only the fixed point is
    // scoped. `full` therefore stays true, and `impact.scoped` is the separate
    // fact that the fixed point was not the whole one.
    expect(result.impact.scoped).toBe(true);
  });

  it("leaves projectUpdate absent for a backend that cannot separate the phases", async () => {
    const dir = copyFixture("cross-module");
    // A backend with no `openProject` is driven through the full-rebuild
    // adapter, which reaches the engine only through `extractProject` and so
    // cannot see where building the program ends and walking it begins. It says
    // so by leaving the field absent rather than by reporting a zero that would
    // read as free (§3.4's distinction between "nothing found" and "nothing
    // looked for").
    const session = await openResidentSession(dir, {
      backend: {
        name: legacyTsBackend.name,
        version: legacyTsBackend.version,
        extractProject: (root) => legacyTsBackend.extractProject(root),
      },
    });
    sessions.push(session);
    const result = await session.update([{ kind: "changed", path: "callee.ts" }]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.timings.projectUpdate).toBeUndefined();
    // And it never answers partially, so the adapter path stays exactly what
    // ADR-0014 kept it as: architecture A.
    expect(result.full).toBe(true);
  });
});

// ---------------------------------------------------------------------------

/**
 * The propagated state as bytes, in iteration order.
 *
 * Phase 3's own law, the one the equivalence law does not reach: the scoped
 * fixed point's whole state must equal `propagate`'s over the same summaries —
 * every symbol, every witness, every per-body split, not only the parts a
 * report happens to print. `expect(a).toEqual(b)` would not see a `Map` whose
 * entries moved, so this renders them.
 */
function renderState(state: ReadonlyMap<SymbolId, PropagatedFunction>): string {
  return [...state]
    .map(([id, propagated]) =>
      JSON.stringify({
        id,
        summary: propagated.summary.id,
        observed: [...propagated.observed.effects],
        observedUnknown: propagated.observed.unknown,
        effectWitness: [...propagated.effectWitness],
        unknownWitness: propagated.unknownWitness ?? null,
        required: propagated.required.capabilities,
        requiredUnknown: propagated.required.unknown,
        capabilityWitness: [...propagated.capabilityWitness],
        capabilityUnknownWitness: propagated.capabilityUnknownWitness ?? null,
        bodies:
          propagated.bodies?.map((body) => ({
            observed: [...body.observed.effects],
            observedUnknown: body.observed.unknown,
            required: body.required.capabilities,
            requiredUnknown: body.required.unknown,
          })) ?? null,
      }),
    )
    .join("\n");
}

/**
 * One generation, with every phase-3 obligation asserted:
 *
 * 1. the resident result equals a cold `analyze()` byte for byte (§6.2);
 * 2. the **scoped** state equals `propagate` over the same summaries, symbol
 *    for symbol — the oracle `propagateScoped` is written against;
 * 3. the fixed point actually ran scoped, so a row that silently fell back to
 *    the whole fixed point cannot pass as evidence of phase 3.
 *
 * The summaries handed to the oracle are read off the committed state rather
 * than re-derived, so the oracle sees exactly the summaries this generation
 * propagated, in the order it propagated them.
 */
async function updateAndProveScoped(
  session: ResidentSession,
  dir: string,
  changes?: readonly FileChange[],
): Promise<{
  readonly resident: AnalysisResult;
  readonly impact: ImpactReport;
  readonly full: boolean;
  readonly reextracted: readonly string[];
}> {
  const result = await session.update(changes);
  if (!result.ok) throw result.error;
  const cold = await analyze(dir);
  expect(render(result.analysis)).toBe(render(cold));
  expect(render(session.current())).toBe(render(cold));

  const store = session.committed().store;
  const summaries = [...store.state.values()].map((propagated) => propagated.summary);
  expect(renderState(store.state)).toBe(renderState(propagate(summaries)));

  expect(result.impact.scoped).toBe(true);
  expect(result.impact.totalFunctions).toBe(summaries.length);
  // `I ⊇ S`, always. A changed symbol outside the impact set is a symbol whose
  // committed value would be reused after its inputs moved.
  for (const id of result.impact.changed) expect(result.impact.impacted).toContain(id);

  // No stale edge survives a patch. Both reverse graphs are rebuilt from the
  // committed file map every generation, and this is what says the map they
  // were rebuilt from is the one a whole extraction would have produced.
  expect(renderGraph(store.reverseImports)).toBe(
    renderGraph(
      importGraphOf(
        [...store.files.values()].map((entry) => entry.module.filePath),
        store,
      ),
    ),
  );
  return {
    resident: result.analysis,
    impact: result.impact,
    full: result.full,
    reextracted: result.reextracted,
  };
}

/** A reverse graph as sorted bytes, so a comparison sees an entry that moved. */
function renderGraph(graph: ReadonlyMap<string, ReadonlySet<string>>): string {
  return [...graph]
    .map(([key, values]) => `${key} <- ${[...values].toSorted().join(",")}`)
    .toSorted()
    .join("\n");
}

/** The reverse-import graph rebuilt from the store's own module records. */
function importGraphOf(
  paths: readonly string[],
  store: ResidentStore,
): ReadonlyMap<string, ReadonlySet<string>> {
  const reverse = new Map<string, Set<string>>();
  for (const filePath of paths) {
    for (const target of store.files.get(filePath)?.module.imports ?? []) {
      const importers = reverse.get(target) ?? new Set<string>();
      importers.add(filePath);
      reverse.set(target, importers);
    }
  }
  return reverse;
}

describe("resident session: the scoped fixed point (phase 3)", () => {
  it("puts nothing in S for an edit no summary records, and still equals cold", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);
    const original = render(session.current());

    // Same line count, same column count, same calls — the only thing that
    // moved is a literal inside an expression statement nothing summarizes.
    edit(dir, "callee.ts", "  return 0;", "  return 1;");
    const { impact, resident } = await updateAndProveScoped(session, dir);

    expect(impact.changed).toEqual([]);
    expect(impact.impacted).toEqual([]);
    expect(render(resident)).toBe(original);
    // And the point of the row: the whole tree was reused, not recomputed.
    expect(impact.totalFunctions).toBeGreaterThan(5);
  });

  it("scopes a direct effect added and removed to the callee and its callers", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);
    const before = session.current();
    expect(effectsOf(before, "callee.ts#fetchRate")).toEqual(["network"]);

    edit(dir, "callee.ts", '  fetch("https://example.com/rate");\n', "");
    const added = await updateAndProveScoped(session, dir);
    expect(effectsOf(added.resident, "callee.ts#fetchRate")).toEqual([]);
    // `S` is the one function whose body changed — it is the only function in
    // that file, so nothing else moved a line. `I` adds its callers: the
    // direct importer and the two that reach it through `index.ts`.
    expect(added.impact.changed).toEqual(["callee.ts#fetchRate"]);
    expect(added.impact.impacted.toSorted()).toEqual([
      "barrel-import.ts#pureCallsBarrelImportedNetwork",
      "callee.ts#fetchRate",
      "direct-import.ts#pureCallsImportedNetwork",
    ]);
    // The evidence that phase 3 is doing anything at all.
    expect(added.impact.impacted.length).toBeLessThan(added.impact.totalFunctions);

    edit(
      dir,
      "callee.ts",
      "export function fetchRate(): number {\n",
      'export function fetchRate(): number {\n  fetch("https://example.com/rate");\n',
    );
    const removed = await updateAndProveScoped(session, dir);
    // The non-monotonic direction, back up. A seed-and-union fixed point would
    // have kept the lowered value in `added` and be caught here.
    expect(effectsOf(removed.resident, "callee.ts#fetchRate")).toEqual(["network"]);
  });

  it("re-resolves a caller whose callee changed identity", async () => {
    const dir = copyFixture("cross-module");
    write(
      dir,
      "other-rate.ts",
      "/** @effects fs_read */\nexport function fetchRate(): number {\n  return 1;\n}\n",
    );
    const session = await open(dir);

    edit(dir, "direct-import.ts", './callee.ts"', './other-rate.ts"');
    const { resident, impact } = await updateAndProveScoped(session, dir);

    expect(effectsOf(resident, "direct-import.ts#pureCallsImportedNetwork")).toEqual(["fs_read"]);
    // The caller's `calls[0].callee` moved, so the caller itself is in `S` —
    // the callees did not change at all.
    expect(impact.changed).toEqual(["direct-import.ts#pureCallsImportedNetwork"]);
  });

  it("handles a call edge added and then removed", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);

    edit(
      dir,
      "direct-import.ts",
      "  return fetchRate();",
      "  void fetchRate();\n  return fetchRate();",
    );
    const added = await updateAndProveScoped(session, dir);
    expect(added.impact.changed).toEqual(["direct-import.ts#pureCallsImportedNetwork"]);

    edit(dir, "direct-import.ts", "  void fetchRate();\n", "");
    const removed = await updateAndProveScoped(session, dir);
    expect(effectsOf(removed.resident, "direct-import.ts#pureCallsImportedNetwork")).toEqual([
      "network",
    ]);
  });

  it("invalidates the callers of a deleted callee through the old reverse graph", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);
    const before = session.current();
    expect(effectsOf(before, "direct-import.ts#pureCallsImportedNetwork")).toEqual(["network"]);

    // The deleted symbol is only in the *old* graph, and its callers are only
    // reachable from there. They must fall to `unknown`, not keep the value
    // they inherited from a function that no longer exists.
    remove(dir, "callee.ts");
    edit(dir, "index.ts", 'export { fetchRate } from "./callee.ts";\n', "");
    const { resident, impact } = await updateAndProveScoped(session, dir);

    expect(symbols(resident)).not.toContain("callee.ts#fetchRate");
    expect(effectsOf(resident, "direct-import.ts#pureCallsImportedNetwork")).toContain("unknown");
    expect(impact.changed).toContain("callee.ts#fetchRate");
    expect(impact.impacted).toContain("direct-import.ts#pureCallsImportedNetwork");
  });

  it("propagates an authority added inside a cycle, and removed again", async () => {
    const dir = copyFixture("cross-module");
    write(
      dir,
      "cycle.ts",
      [
        "export function ping(n: number): number {",
        "  return n <= 0 ? 0 : pong(n - 1);",
        "}",
        "",
        "export function pong(n: number): number {",
        "  return n <= 0 ? 0 : ping(n - 1);",
        "}",
        "",
        "export function callsCycle(): number {",
        "  return ping(3);",
        "}",
        "",
      ].join("\n"),
    );
    const session = await open(dir);

    edit(
      dir,
      "cycle.ts",
      "  return n <= 0 ? 0 : pong(n - 1);",
      '  void fetch("https://example.com/");\n  return n <= 0 ? 0 : pong(n - 1);',
    );
    const added = await updateAndProveScoped(session, dir);
    expect(effectsOf(added.resident, "cycle.ts#pong")).toContain("network");
    expect(effectsOf(added.resident, "cycle.ts#callsCycle")).toContain("network");
    // All three are in `S`, and only the first for a body reason: inserting a
    // line moves every declaration below it, and `location` is compared
    // because a diagnostic's reported position is part of the bytes §6.2
    // compares. That is the comparator being conservative in the direction it
    // is allowed to be wrong in — it costs a recomputation, never an answer.
    expect(added.impact.changed.toSorted()).toEqual([
      "cycle.ts#callsCycle",
      "cycle.ts#ping",
      "cycle.ts#pong",
    ]);
    expect(added.impact.impacted.toSorted()).toEqual([
      "cycle.ts#callsCycle",
      "cycle.ts#ping",
      "cycle.ts#pong",
    ]);
    expect(added.impact.impacted.length).toBeLessThan(added.impact.totalFunctions);

    edit(dir, "cycle.ts", '  void fetch("https://example.com/");\n', "");
    const removed = await updateAndProveScoped(session, dir);
    // Removing it has to drain the whole cycle. A value that only unions would
    // leave `network` on all three forever.
    expect(effectsOf(removed.resident, "cycle.ts#ping")).toEqual([]);
    expect(effectsOf(removed.resident, "cycle.ts#pong")).toEqual([]);
    expect(effectsOf(removed.resident, "cycle.ts#callsCycle")).toEqual([]);
  });

  it("follows an overload implementation swapped under an unchanged signature", async () => {
    const dir = copyFixture("cross-module");
    write(
      dir,
      "overloaded.ts",
      [
        "export function load(key: string): number;",
        "export function load(key: number): number;",
        "export function load(key: string | number): number {",
        "  void key;",
        '  void fetch("https://example.com/");',
        "  return 0;",
        "}",
        "",
        "export function callsOverload(): number {",
        '  return load("a");',
        "}",
        "",
      ].join("\n"),
    );
    const session = await open(dir);
    expect(effectsOf(session.current(), "overloaded.ts#callsOverload")).toContain("network");

    // Only the implementation's body changes; the signatures, and so the
    // symbol id the call resolves to, do not move.
    edit(dir, "overloaded.ts", '  void fetch("https://example.com/");\n', "");
    const { resident, impact } = await updateAndProveScoped(session, dir);

    expect(effectsOf(resident, "overloaded.ts#callsOverload")).toEqual([]);
    // The implementation, because its body lost a call; the caller, because
    // deleting that line moved it up — see the cycle row.
    expect(impact.changed).toContain("overloaded.ts#load");
    expect(impact.impacted).toContain("overloaded.ts#callsOverload");
    expect(impact.impacted.length).toBeLessThan(impact.totalFunctions);
  });

  it("re-derives the per-body split when the inline-callback owner gains and loses a body", async () => {
    const dir = copyFixture("cross-module");
    write(
      dir,
      "inline.ts",
      [
        "declare const router: {",
        "  post(name: string, handler: () => void): void;",
        "};",
        "",
        'router.post("first", () => {',
        '  void fetch("https://example.com/first");',
        "});",
        "",
        'router.post("second", () => {',
        "  void 1;",
        "});",
        "",
      ].join("\n"),
    );
    const session = await open(dir);
    const owner = symbols(session.current()).find((id) => id.startsWith("inline.ts#"));
    expect(owner).toBeDefined();

    // A third body. `bodies` changes, so the owner is in `S`, and the per-body
    // derivation has to run again against the new split — the one pass
    // `propagate` makes after its fixed point.
    edit(
      dir,
      "inline.ts",
      'router.post("second", () => {\n  void 1;\n});',
      'router.post("second", () => {\n  void 1;\n});\n\nrouter.post("third", () => {\n  void fetch("https://example.com/third");\n});',
    );
    const gained = await updateAndProveScoped(session, dir);
    expect(gained.impact.changed).toEqual([owner]);

    edit(
      dir,
      "inline.ts",
      '\n\nrouter.post("third", () => {\n  void fetch("https://example.com/third");\n});',
      "",
    );
    const lost = await updateAndProveScoped(session, dir);
    expect(lost.impact.changed).toEqual([owner]);
  });

  it("starts and stops cutting a body off when @boundary is added and removed", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);
    expect(effectsOf(session.current(), "callee.ts#fetchRate")).toEqual(["network"]);

    // `@boundary` with no `@capabilities` makes the capability requirement
    // `unknown` rather than empty, and that has to reach the caller.
    edit(
      dir,
      "callee.ts",
      "/** @effects network */",
      "/**\n * @effects network\n * @boundary vendor code\n */",
    );
    const bounded = await updateAndProveScoped(session, dir);
    expect(bounded.impact.changed).toEqual(["callee.ts#fetchRate"]);
    expect(bounded.impact.impacted).toContain("direct-import.ts#pureCallsImportedNetwork");

    edit(
      dir,
      "callee.ts",
      "/**\n * @effects network\n * @boundary vendor code\n */",
      "/** @effects network */",
    );
    const unbounded = await updateAndProveScoped(session, dir);
    expect(effectsOf(unbounded.resident, "callee.ts#fetchRate")).toEqual(["network"]);
  });

  it("rebuilds AMB-W006 from the per-file matched keys, not from a whole-project run", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);

    // Two exact keys: one names a real symbol, one names nothing. The union of
    // what the files matched has to subtract exactly the first.
    write(
      dir,
      "ambit.config.ts",
      'export default {\n  contracts: {\n    "callee.ts#fetchRate": { effects: ["network"] },\n    "nowhere.ts#missing": { effects: [] },\n  },\n};\n',
    );
    const partial = await updateAndProveScoped(session, dir);
    const unmatched = session.committed().store.unmatchedExactKeys;
    expect(unmatched).toEqual(["nowhere.ts#missing"]);
    expect(
      partial.resident.diagnostics.filter((d) => d.id === "AMB-W006").map((d) => d.message),
    ).toHaveLength(1);
    // The per-file record the union came from.
    expect(session.committed().store.files.get("callee.ts")?.matchedConfigKeys).toEqual([
      "callee.ts#fetchRate",
    ]);
    expect(session.committed().store.files.get("index.ts")?.matchedConfigKeys).toEqual([]);

    // The unmatched key starts matching. Nothing about the source changed, so
    // the only thing that can move the diagnostic is the config path.
    write(dir, "nowhere.ts", "export function missing(): number {\n  return 1;\n}\n");
    const matched = await updateAndProveScoped(session, dir);
    expect(session.committed().store.unmatchedExactKeys).toEqual([]);
    expect(matched.resident.diagnostics.some((d) => d.id === "AMB-W006")).toBe(false);
  });

  it("returns byte-identically after a change is reverted", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);
    const original = render(session.current());
    const originalState = renderState(session.committed().store.state);

    edit(dir, "callee.ts", "/** @effects network */", "/** @effects fs_read */");
    const changed = await updateAndProveScoped(session, dir);
    expect(render(changed.resident)).not.toBe(original);

    edit(dir, "callee.ts", "/** @effects fs_read */", "/** @effects network */");
    const reverted = await updateAndProveScoped(session, dir);
    expect(render(reverted.resident)).toBe(original);
    // And the internal state too, not only what the report prints: a witness
    // map left pointing at the wrong callee would survive the first check.
    expect(renderState(session.committed().store.state)).toBe(originalState);
  });

  it("survives twelve sequential mutations, proving the scoped state each time", async () => {
    const dir = copyFixture("cross-module");
    write(
      dir,
      "chain.ts",
      [
        "export function leaf(): number {",
        "  return 1;",
        "}",
        "",
        "export function middle(): number {",
        "  return leaf();",
        "}",
        "",
        "export function top(): number {",
        "  return middle();",
        "}",
        "",
      ].join("\n"),
    );
    const session = await open(dir);

    const steps: readonly (() => void)[] = [
      () =>
        edit(dir, "chain.ts", "  return 1;", '  void fetch("https://example.com/1");\n  return 1;'),
      () =>
        edit(
          dir,
          "chain.ts",
          "export function leaf(): number {",
          "/** @effects network */\nexport function leaf(): number {",
        ),
      () => edit(dir, "chain.ts", "  return middle();", "  return middle() + leaf();"),
      () => edit(dir, "chain.ts", '  void fetch("https://example.com/1");\n', ""),
      () =>
        write(
          dir,
          "chain-extra.ts",
          'import { top } from "./chain.ts";\n\nexport function outer(): number {\n  return top();\n}\n',
        ),
      () => edit(dir, "chain.ts", "/** @effects network */\n", ""),
      () => edit(dir, "chain.ts", "  return middle() + leaf();", "  return middle();"),
      () =>
        write(
          dir,
          "ambit.config.ts",
          'export default {\n  contracts: {\n    "chain.ts#leaf": { effects: ["fs_read"] },\n  },\n};\n',
        ),
      () =>
        edit(
          dir,
          "chain.ts",
          "export function middle(): number {",
          "/** @effects pure */\nexport function middle(): number {",
        ),
      () => remove(dir, "ambit.config.ts"),
      () => remove(dir, "chain-extra.ts"),
      () => edit(dir, "chain.ts", "  return middle();", "  return middle() + 1;"),
      () => remove(dir, "chain.ts"),
    ];

    const rendered: string[] = [];
    for (const step of steps) {
      step();
      const { resident } = await updateAndProveScoped(session, dir);
      rendered.push(render(resident));
    }

    expect(new Set(rendered).size).toBeGreaterThan(1);
    expect(session.committed().store.generation).toBe(rendered.length + 1);
  });

  it("answers §3.5's gate-3 mutations from the new tree, never from a stale one", async () => {
    const dir = copyFixture("cross-module");
    // The gate-3 subject, as `scripts/m05-probe/mutations.ts` expects to find
    // it. ADR-0001's headline failure was a contract comment rewritten and a
    // stale answer returned with no error; a resident path that reintroduces
    // it has failed whatever else it achieves.
    write(
      dir,
      "recursion.ts",
      [
        "/** @effects fs_read */",
        "export function leafReadsFile(): number {",
        "  return 1;",
        "}",
        "",
        "export function selfRecursive(n: number): number {",
        "  if (n <= 0) return leafReadsFile();",
        "  return selfRecursive(n - 1);",
        "}",
        "",
      ].join("\n"),
    );
    const session = await open(dir);
    expect(declaredOf(session.current(), "recursion.ts#leafReadsFile")).toEqual(["fs_read"]);
    expect(effectsOf(session.current(), "recursion.ts#selfRecursive")).toEqual(["fs_read"]);

    for (const mutation of MUTATIONS) {
      mutation.apply(dir);
      const { resident, impact } = await updateAndProveScoped(session, dir);
      expect(impact.changed.length).toBeGreaterThan(0);
      expect(impact.impacted.length).toBeLessThan(impact.totalFunctions);
      // Each mutation moves exactly one observable, and the one that matters
      // is the contract comment: `@effects fs_read` becoming `network` has to
      // reach the recursive caller.
      if (mutation.id === "contract") {
        expect(declaredOf(resident, "recursion.ts#leafReadsFile")).toEqual(["network"]);
        expect(effectsOf(resident, "recursion.ts#selfRecursive")).toEqual(["network"]);
      }
      if (mutation.id === "body") {
        expect(effectsOf(resident, "recursion.ts#selfRecursive")).toContain("network");
      }
    }
  });

  it("runs the scoped path even though the fingerprint refuses reuse", async () => {
    const dir = copyFixture("cross-module");
    // An `extends` chain is a file this layer will not resolve the way the
    // compiler does, so the project half of the fingerprint is undecidable and
    // no extraction is reused. Phase 3 does not live inside that branch — it
    // reuses no compiler or extraction result, only Ambit's own summaries —
    // and this is the row that says so.
    write(dir, "base.json", '{ "compilerOptions": { "strict": true } }\n');
    write(
      dir,
      "tsconfig.json",
      '{ "extends": "./base.json", "compilerOptions": { "module": "nodenext", "moduleResolution": "nodenext", "target": "es2023" }, "include": ["**/*.ts"] }\n',
    );
    const session = await open(dir);

    const fingerprint = session.committed().store.fingerprint;
    expect(fingerprint.projectUndecidable.length).toBeGreaterThan(0);
    expect(fingerprintPermitsExtractionReuse(fingerprint, fingerprint)).toBe(false);

    edit(dir, "callee.ts", "  return 0;", "  return 1;");
    const { impact, full } = await updateAndProveScoped(session, dir, [
      { kind: "changed", path: "callee.ts" },
    ]);
    // Extraction was not reused — the fingerprint refused — and the fixed
    // point was scoped anyway.
    expect(full).toBe(true);
    expect(impact.scoped).toBe(true);
    expect(impact.impacted).toEqual([]);
  });

  it("reuses most of a real tree when one function in it changes", async () => {
    const dir = copyFixture("realistic-api");
    const session = await open(dir);

    const risk = path.join(dir, "src", "domain", "risk.ts");
    const text = readText(risk);
    const marker = text.indexOf("export ");
    writeFileSync(
      risk,
      `${text.slice(0, marker)}export function addedByPhaseThree(): void {\n  void fetch("https://example.com/");\n}\n\n${text.slice(marker)}`,
    );

    const { impact } = await updateAndProveScoped(session, dir);
    // The evidence the goal asks for: `I` is a small fraction of the tree, on
    // a tree big enough for the fraction to mean something.
    expect(impact.totalFunctions).toBeGreaterThan(20);
    expect(impact.impacted.length).toBeLessThan(impact.totalFunctions);
    expect(impact.changed).toContain("src/domain/risk.ts#addedByPhaseThree");
  });
});

// ---------------------------------------------------------------------------

describe("resident session: self-hosting", () => {
  it("equals a cold run over src/, across two generations", async () => {
    const source = path.join(REPO_ROOT, "src");
    const session = await open(source);
    const cold = await analyze(source);

    // Fixtures do not have the shapes this repository has — the same reason
    // `test/backend.legacy-ts.test.ts` asserts against `src/` directly.
    expect(render(session.current())).toBe(render(cold));

    // A second generation over the same (unmutated) tree. `src/` is not edited
    // here on purpose: other test files read it concurrently, and a mutation
    // would make this suite's result depend on the scheduler.
    const second = await session.update();
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.generation).toBe(2);
    expect(render(second.analysis)).toBe(render(cold));
  });

  it("scopes a real mutation on a copy of src/, and equals cold", async () => {
    // A copy, never the real tree: other test files read `src/` concurrently,
    // and `node_modules` is deliberately not linked in — resolution is worse
    // here than in the repository, which changes nothing about what is being
    // asserted. Both paths see the same tree.
    const dir = mkdtempSync(path.join(tmpdir(), "ambit-selfhost-"));
    temporaries.push(dir);
    cpSync(path.join(REPO_ROOT, "src"), path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "selfhost" })}\n`);
    writeFileSync(
      path.join(dir, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2023",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            skipLibCheck: true,
            noEmit: true,
            allowImportingTsExtensions: true,
          },
          include: ["**/*.ts"],
        },
        null,
        2,
      )}\n`,
    );

    const session = await open(dir);
    const total = session.committed().store.state.size;
    expect(total).toBeGreaterThan(200);

    // One real function in one real file, chosen because it has callers.
    edit(
      dir,
      path.join("src", "checker", "impact.ts"),
      "export function impactClosure(",
      "/** @effects pure */\nexport function impactClosure(",
    );
    const result = await session.update();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(render(result.analysis)).toBe(render(await analyze(dir)));
    const state = session.committed().store.state;
    const summaries = [...state.values()].map((propagated) => propagated.summary);
    expect(renderState(state)).toBe(renderState(propagate(summaries)));
    expect(result.impact.scoped).toBe(true);
    // The shape this row exists to show: a one-function edit on a real
    // codebase recomputes a small part of it.
    expect(result.impact.changed).toContain("src/checker/impact.ts#impactClosure");
    expect(result.impact.impacted.length).toBeLessThan(result.impact.totalFunctions);
  });

  it("equals a cold run over a mutated copy of a realistic tree", async () => {
    const dir = copyFixture("realistic-api");
    const session = await open(dir);
    const before = session.current();

    // `realistic-api` declares `"types": []` deliberately — it must type-check
    // with nothing installed — so a copy of it analyzes outside the repository
    // unchanged.
    const handlers = path.join(dir, "src", "domain", "risk.ts");
    const text = readText(handlers);
    const marker = text.indexOf("export ");
    expect(marker).toBeGreaterThan(-1);
    writeFileSync(
      handlers,
      `${text.slice(0, marker)}/** @effects pure */\nexport function addedByTheSuite(): number {\n  return 1;\n}\n\n${text.slice(marker)}`,
    );

    const { resident } = await updateAndCompare(session, dir);
    expect(symbols(before)).not.toContain("src/domain/risk.ts#addedByTheSuite");
    expect(symbols(resident)).toContain("src/domain/risk.ts#addedByTheSuite");
  });
});

// ---------------------------------------------------------------------------

/**
 * Phase 4: the reverse-import closure, and the reuse gate that decides whether
 * a closure may be taken at all.
 *
 * Every row asserts five things, because four of them can pass while the fifth
 * is wrong:
 *
 * 1. the resident result equals a cold run byte for byte (§6.2);
 * 2. the scoped state equals `propagate` over the same summaries;
 * 3. the **verdict** — full or partial — is the one §6.2's table names;
 * 4. the **closure** — which files were re-extracted — is the expected set;
 * 5. no stale edge survives in either reverse graph.
 *
 * 1, 2 and 5 are `updateAndProveScoped`'s; 3 and 4 are each row's own. A row
 * that asserted only equivalence would pass just as well against a session
 * that re-extracted everything, which is exactly the thing phase 4 is supposed
 * to stop doing.
 */
describe("resident session: the reverse-import closure (phase 4)", () => {
  const CHANGED = (file: string): FileChange => ({ kind: "changed", path: file });

  it("re-extracts an edited file and its transitive importers, and nothing else", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);
    const everything = [...session.committed().store.files.keys()].toSorted();

    edit(dir, "callee.ts", "  return 0;", "  return 1;");
    const { full, reextracted } = await updateAndProveScoped(session, dir, [CHANGED("callee.ts")]);

    expect(full).toBe(false);
    // `callee.ts` itself, plus every file that reaches it through imports:
    // `index.ts` and `direct-import.ts` import it, the two barrels import
    // `index.ts`, and `deep-barrel-import.ts` imports `deep-barrel.ts`. The
    // closure is transitive and it stops there.
    expect(reextracted).toEqual([
      "barrel-builtin-import.ts",
      "barrel-import.ts",
      "callee.ts",
      "deep-barrel-import.ts",
      "deep-barrel.ts",
      "direct-import.ts",
      "index.ts",
    ]);
    expect(reextracted.length).toBeLessThan(everything.length);
    // The files outside it kept the entries they committed.
    expect(everything).toContain("missing-module-import.ts");
    expect(reextracted).not.toContain("missing-module-import.ts");
  });

  it("re-extracts a leaf's closure only, for a file nothing imports", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);

    edit(dir, "direct-import.ts", "/** @effects pure */", "/** @effects network */");
    const { full, reextracted, resident } = await updateAndProveScoped(session, dir, [
      CHANGED("direct-import.ts"),
    ]);

    // A JSDoc-only edit: §6.2 requires it to propagate backwards, and the
    // extraction closure is still just the file, because nothing imports it.
    expect(full).toBe(false);
    expect(reextracted).toEqual(["direct-import.ts"]);
    expect(declaredOf(resident, "direct-import.ts#pureCallsImportedNetwork")).toEqual(["network"]);
  });

  it("closes over a re-pointed barrel, including one that declares nothing", async () => {
    const dir = copyFixture("cross-module");
    // A second target for the barrel to point at, present from the start so
    // that the generation under test is an *edit*, not an addition.
    write(
      dir,
      "other-rate.ts",
      "/** @effects fs_read */\nexport function fetchRate(): number {\n  return 7;\n}\n",
    );
    const session = await open(dir);
    expect(session.committed().store.files.get("index.ts")?.extracted).toBeUndefined();

    // `index.ts` declares no function of its own — it is a barrel — and
    // re-pointing it changes what every importer of it resolves to. A store
    // built from `ExtractedFile` alone would hold no edge for it at all.
    edit(dir, "index.ts", './callee.ts"', './other-rate.ts"');
    const { full, reextracted, resident } = await updateAndProveScoped(session, dir, [
      CHANGED("index.ts"),
    ]);

    expect(full).toBe(false);
    expect(reextracted).toContain("index.ts");
    // Every importer of the barrel is in the closure, transitively.
    expect(reextracted).toContain("deep-barrel.ts");
    expect(reextracted).not.toContain("callee.ts");
    expect(symbols(resident)).toContain("other-rate.ts#fetchRate");
  });

  it("follows a deleted file through the old graph and leaves no stale edge", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);
    // `deep-barrel.ts` re-exports `index.ts` and nothing imports it, so it can
    // go without breaking the tree.
    expect(session.committed().store.files.has("deep-barrel.ts")).toBe(true);

    remove(dir, "deep-barrel.ts");
    const { full, reextracted } = await updateAndProveScoped(session, dir, [
      { kind: "deleted", path: "deep-barrel.ts" },
    ]);

    expect(full).toBe(false);
    // Every file whose resolution a deletion can change had a specifier
    // resolving *to* the deleted file — exactly an edge the old graph holds —
    // so the closure is safe, and the deleted file itself is not re-extracted.
    expect(reextracted).not.toContain("deep-barrel.ts");

    const store = session.committed().store;
    expect(store.files.has("deep-barrel.ts")).toBe(false);
    for (const importers of store.reverseImports.values()) {
      expect([...importers]).not.toContain("deep-barrel.ts");
    }
    expect([...store.state.keys()].some((id) => id.startsWith("deep-barrel.ts#"))).toBe(false);
  });

  it("rebuilds everything for an added file", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);

    write(
      dir,
      "added.ts",
      'import { fetchRate } from "./callee.ts";\n\n/** @effects pure */\nexport function usesRate(): number {\n  return fetchRate();\n}\n',
    );
    const { full, reextracted, resident } = await updateAndProveScoped(session, dir, [
      { kind: "added", path: "added.ts" },
    ]);

    // No closure over the edges already held can find the importers a new file
    // changes: a specifier that resolved to nothing held no edge at all.
    expect(full).toBe(true);
    expect(reextracted).toContain("added.ts");
    expect(effectsOf(resident, "added.ts#usesRate")).toContain("network");
  });

  it("rebuilds everything for a rename, and makes no `moved` guess", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);

    write(dir, "callee-renamed.ts", readText(path.join(dir, "callee.ts")));
    remove(dir, "callee.ts");
    edit(dir, "direct-import.ts", './callee.ts"', './callee-renamed.ts"');
    edit(dir, "index.ts", './callee.ts"', './callee-renamed.ts"');

    const { full, resident } = await updateAndProveScoped(session, dir, [
      { kind: "added", path: "callee-renamed.ts" },
      { kind: "deleted", path: "callee.ts" },
      CHANGED("direct-import.ts"),
      CHANGED("index.ts"),
    ]);

    expect(full).toBe(true);
    expect(symbols(resident)).toContain("callee-renamed.ts#fetchRate");
    expect(symbols(resident)).not.toContain("callee.ts#fetchRate");
  });

  it("rebuilds everything when the file an unresolved specifier names arrives", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);
    const before = session.current();
    expect(unresolvedTotal(before)).toBeGreaterThan(0);

    write(
      dir,
      "missing-target.ts",
      "/** @effects network */\nexport function absent(): number {\n  return 1;\n}\n",
    );
    write(
      dir,
      "missing-module-import.ts",
      'import { absent } from "./missing-target.ts";\n\n/** @effects pure */\nexport function callsAbsent(): number {\n  return absent();\n}\n',
    );

    const { full, resident } = await updateAndProveScoped(session, dir, [
      { kind: "added", path: "missing-target.ts" },
      CHANGED("missing-module-import.ts"),
    ]);
    expect(full).toBe(true);
    expect(effectsOf(resident, "missing-module-import.ts#callsAbsent")).toContain("network");
  });

  it("reuses extraction and re-summarizes every file for a config-only change", async () => {
    const dir = copyFixture("cross-module");
    // Present before the session opens: writing a `.ts` file into the root is
    // a file *addition*, and this row is about editing a config, not adding
    // one.
    write(dir, "ambit.config.ts", "export default { contracts: {} };\n");
    const session = await open(dir);

    // A symbol with no JSDoc contract of its own, so the config's contract is
    // what the summary carries rather than a divergence against one.
    const target = "deep-barrel-import.ts#callsTwiceReExportedBuiltin";
    write(
      dir,
      "ambit.config.ts",
      `export default { contracts: { ${JSON.stringify(target)}: { effects: ["fs_read"] } } };\n`,
    );
    const { full, reextracted, resident } = await updateAndProveScoped(session, dir, []);

    // §6.2's config row: extraction untouched, every contract re-derived. The
    // closure is empty because no source file moved.
    expect(full).toBe(false);
    // Only the config file itself: no source file moved, and no contract in the
    // config can change how a call resolves. Its own module record is refreshed
    // because it is a `.ts` file under the root like any other.
    expect(reextracted).toEqual(["ambit.config.ts"]);
    expect(declaredOf(resident, target)).toEqual(["fs_read"]);

    // And every file's summaries were rebuilt, not only the empty closure's:
    // the store's own `matchedConfigKeys` is what AMB-W006 is derived from, and
    // a subset re-summarization would report a matched key as unmatched.
    expect(session.committed().store.unmatchedExactKeys).toEqual([]);

    write(
      dir,
      "ambit.config.ts",
      'export default { contracts: { "callee.ts#nobody": { effects: ["fs_read"] } } };\n',
    );
    const second = await updateAndProveScoped(session, dir, []);
    expect(second.full).toBe(false);
    expect(second.reextracted).toEqual(["ambit.config.ts"]);
    expect(session.committed().store.unmatchedExactKeys).toEqual(["callee.ts#nobody"]);
  });

  it('closes over an `import("…")` type node, which is a dependency with no import statement', async () => {
    const dir = copyFixture("cross-module");
    write(
      dir,
      "svc.ts",
      'export class Svc {\n  /** @effects network */\n  run(): number {\n    fetch("https://example.com/");\n    return 1;\n  }\n}\n',
    );
    write(
      dir,
      "import-type-user.ts",
      '/** @effects pure */\nexport function callsThroughImportType(s: import("./svc.ts").Svc): number {\n  return s.run();\n}\n',
    );
    const session = await open(dir);
    // Probed rather than assumed: the annotation is what makes the checker
    // resolve this call, and the file writes no import statement at all.
    expect(session.committed().store.files.get("import-type-user.ts")?.module.imports).toEqual([
      "svc.ts",
    ]);

    edit(dir, "svc.ts", "  run(): number {", "  runRenamed(): number {");
    edit(dir, "import-type-user.ts", "  return s.run();", "  return s.runRenamed();");
    const { full, reextracted } = await updateAndProveScoped(session, dir, [
      CHANGED("svc.ts"),
      CHANGED("import-type-user.ts"),
    ]);

    expect(full).toBe(false);
    expect(reextracted).toContain("import-type-user.ts");
  });

  it("rebuilds everything when a file enters the program without a root name moving", async () => {
    const dir = copyFixture("cross-module");
    // An explicit `files:` list, so the program's in-root file set is not the
    // root-name set: a file enters by being imported, and no root name moves
    // when it does.
    write(
      dir,
      "tsconfig.json",
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2023",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            skipLibCheck: true,
            noEmit: true,
            allowImportingTsExtensions: true,
          },
          files: ["direct-import.ts"],
        },
        null,
        2,
      )}\n`,
    );
    const session = await open(dir);
    expect(session.committed().store.files.has("barrel-import.ts")).toBe(false);

    edit(
      dir,
      "direct-import.ts",
      'import { fetchRate } from "./callee.ts";',
      'import { fetchRate } from "./callee.ts";\nimport { pureCallsBarrelImportedNetwork } from "./barrel-import.ts";\nvoid pureCallsBarrelImportedNetwork;',
    );
    const { full } = await updateAndProveScoped(session, dir, [CHANGED("direct-import.ts")]);

    // `barrel-import.ts` arrived in the program. A closure would have minted
    // its ids in pass 1 and never extracted it, so cold would report its
    // functions and the resident path would not.
    expect(full).toBe(true);
    expect(session.committed().store.files.has("barrel-import.ts")).toBe(true);
  });

  it("rebuilds everything when the tsconfig changes", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);

    const tsconfig = JSON.parse(readText(path.join(dir, "tsconfig.json")));
    tsconfig.compilerOptions.paths = { "#alias/*": ["./*"] };
    tsconfig.compilerOptions.baseUrl = ".";
    write(dir, "tsconfig.json", `${JSON.stringify(tsconfig, null, 2)}\n`);

    const { full } = await updateAndProveScoped(session, dir, [CHANGED("callee.ts")]);
    expect(full).toBe(true);
  });

  it("rebuilds everything when the resolution inputs change", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);

    write(dir, "package.json", `${JSON.stringify({ name: "subject", version: "2" })}\n`);
    const { full } = await updateAndProveScoped(session, dir, [CHANGED("callee.ts")]);
    expect(full).toBe(true);
  });

  it("rebuilds everything when a package under node_modules is rewritten in place", async () => {
    const dir = copyFixture("cross-module");
    write(dir, "node_modules/dep/package.json", '{ "name": "dep", "types": "index.d.ts" }\n');
    write(dir, "node_modules/dep/index.d.ts", "export declare function helper(): number;\n");
    write(
      dir,
      "uses-dep.ts",
      'import { helper } from "dep";\n\n/** @effects pure */\nexport function callsHelper(): number {\n  return helper();\n}\n',
    );
    const session = await open(dir);

    // Neither `package.json` nor a lockfile moves, so the disk-side
    // fingerprint reads "nothing changed". What sees the rewrite is the
    // program's own input list, which the backend hashes.
    write(dir, "node_modules/dep/index.d.ts", "export declare function helper(): string;\n");
    const { full } = await updateAndProveScoped(session, dir, [CHANGED("callee.ts")]);
    expect(full).toBe(true);
  });

  it("rebuilds everything when a `.d.ts` inside the root changes", async () => {
    const dir = copyFixture("cross-module");
    write(
      dir,
      "ambient.d.ts",
      'declare module "ambient-thing" {\n  export function go(): void;\n}\n',
    );
    const session = await open(dir);

    write(
      dir,
      "ambient.d.ts",
      'declare module "ambient-thing" {\n  export function go(): number;\n}\n',
    );
    const { full } = await updateAndProveScoped(session, dir, [CHANGED("callee.ts")]);
    expect(full).toBe(true);
  });

  it("rebuilds everything for a change to a file whose declarations are global", async () => {
    const dir = copyFixture("cross-module");
    write(dir, "globals.ts", "declare global {\n  var ambitGlobal: number;\n}\nexport {};\n");
    const session = await open(dir);

    write(dir, "globals.ts", "declare global {\n  var ambitGlobal: string;\n}\nexport {};\n");
    const { full } = await updateAndProveScoped(session, dir, [CHANGED("globals.ts")]);
    expect(full).toBe(true);
  });

  it("rebuilds everything when the caller reports no change set at all", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);

    // The one honest gap §6.2 leaves open, made explicit: a caller that does
    // not report changes gets a whole re-extraction, because a closure over
    // nothing would answer from the previous tree.
    edit(dir, "callee.ts", "  return 0;", "  return 1;");
    const { full } = await updateAndProveScoped(session, dir);
    expect(full).toBe(true);
  });

  it("rebuilds everything for a path this session never extracted", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);

    edit(dir, "callee.ts", "  return 0;", "  return 1;");
    const { full } = await updateAndProveScoped(session, dir, [
      CHANGED("callee.ts"),
      CHANGED("not-a-file-this-session-saw.ts"),
    ]);
    expect(full).toBe(true);
  });

  it("survives a mid-edit syntax error and recovers on the next update", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);

    // The compiler recovers from a syntax error, so this is not a failure: the
    // answer changes and still equals cold.
    write(dir, "callee.ts", "/** @effects network */\nexport function fetchRate(): number {\n");
    await updateAndProveScoped(session, dir, [CHANGED("callee.ts")]);

    write(
      dir,
      "callee.ts",
      '/** @effects network */\nexport function fetchRate(): number {\n  fetch("https://example.com/rate");\n  return 0;\n}\n',
    );
    const { resident } = await updateAndProveScoped(session, dir, [CHANGED("callee.ts")]);
    expect(effectsOf(resident, "callee.ts#fetchRate")).toContain("network");
  });

  it("re-extracts everything on the first update after a failed one", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);

    // A generation that throws leaves the backend one program ahead of the
    // committed store. Comparing the next update against that baseline would
    // read a change made *before* the failure as "nothing moved".
    write(dir, "tsconfig.json", "{ not json");
    const failed = await session.update([CHANGED("callee.ts")]);
    expect(failed.ok).toBe(false);

    write(
      dir,
      "tsconfig.json",
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2023",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            skipLibCheck: true,
            noEmit: true,
            allowImportingTsExtensions: true,
            types: ["node"],
          },
          include: ["**/*.ts"],
        },
        null,
        2,
      )}\n`,
    );
    edit(dir, "callee.ts", "  return 0;", "  return 2;");
    const recovered = await updateAndProveScoped(session, dir, [CHANGED("callee.ts")]);
    expect(recovered.full).toBe(true);

    // And the session is usable again, on the partial path.
    edit(dir, "callee.ts", "  return 2;", "  return 3;");
    const next = await updateAndProveScoped(session, dir, [CHANGED("callee.ts")]);
    expect(next.full).toBe(false);
  });

  it("survives ten sequential partial updates on one session", async () => {
    const dir = copyFixture("cross-module");
    const session = await open(dir);

    const steps: readonly (readonly [() => void, readonly FileChange[]])[] = [
      [() => edit(dir, "callee.ts", "  return 0;", "  return 1;"), [CHANGED("callee.ts")]],
      [
        () => edit(dir, "direct-import.ts", "/** @effects pure */", "/** @effects fs_read */"),
        [CHANGED("direct-import.ts")],
      ],
      [
        () => edit(dir, "callee.ts", '  fetch("https://example.com/rate");\n', ""),
        [CHANGED("callee.ts")],
      ],
      [
        () =>
          edit(
            dir,
            "callee.ts",
            "export function fetchRate(): number {",
            'export function fetchRate(): number {\n  fetch("https://example.com/again");',
          ),
        [CHANGED("callee.ts")],
      ],
      [
        () => edit(dir, "direct-import.ts", "  return fetchRate();", "  return fetchRate() + 1;"),
        [CHANGED("direct-import.ts")],
      ],
      [
        () => edit(dir, "index.ts", 'export { fetchRate } from "./callee.ts";', ""),
        [CHANGED("index.ts")],
      ],
      [
        () => edit(dir, "index.ts", 'export { readFileSync } from "node:fs";', ""),
        [CHANGED("index.ts")],
      ],
      [
        () => edit(dir, "callee.ts", "/** @effects network */", "/** @effects network, fs_read */"),
        [CHANGED("callee.ts")],
      ],
      [
        () => edit(dir, "callee.ts", "/** @effects network, fs_read */", "/** @effects network */"),
        [CHANGED("callee.ts")],
      ],
      [
        () => edit(dir, "direct-import.ts", "/** @effects fs_read */", "/** @effects pure */"),
        [CHANGED("direct-import.ts")],
      ],
    ];

    let partials = 0;
    for (const [apply, changes] of steps) {
      apply();
      const { full } = await updateAndProveScoped(session, dir, changes);
      if (!full) partials += 1;
    }
    // Every step here is an in-place edit, so every one of them should have
    // taken the closure. Asserted as a count rather than per step, so a future
    // widening of a full-rebuild trigger reads as a number moving rather than
    // as a row failing for a reason nobody looks at.
    expect(partials).toBe(steps.length);
    expect(session.committed().store.generation).toBe(steps.length + 1);
  });

  it("answers §3.5's gate-3 mutations through the closure, never from a stale tree", async () => {
    const dir = copyFixture("cross-module");
    write(
      dir,
      "recursion.ts",
      [
        "/** @effects fs_read */",
        "export function leafReadsFile(): number {",
        "  return 1;",
        "}",
        "",
        "export function selfRecursive(n: number): number {",
        "  if (n <= 0) return leafReadsFile();",
        "  return selfRecursive(n - 1);",
        "}",
        "",
      ].join("\n"),
    );
    const session = await open(dir);

    // ADR-0001's headline failure was a contract comment rewritten and a stale
    // answer returned with no error. Here each mutation goes through the
    // *closure* rather than a whole re-extraction, which is the path that can
    // reintroduce it.
    for (const mutation of MUTATIONS) {
      mutation.apply(dir);
      const { resident, full, reextracted } = await updateAndProveScoped(session, dir, [
        CHANGED(mutation.file),
      ]);
      expect(full).toBe(false);
      expect(reextracted).toContain(mutation.file);
      if (mutation.id === "contract") {
        expect(declaredOf(resident, "recursion.ts#leafReadsFile")).toEqual(["network"]);
        expect(effectsOf(resident, "recursion.ts#selfRecursive")).toEqual(["network"]);
      }
      if (mutation.id === "body") {
        expect(effectsOf(resident, "recursion.ts#selfRecursive")).toContain("network");
      }
    }
  });

  it("takes the closure on a copy of src/, and equals cold", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ambit-phase4-"));
    temporaries.push(dir);
    cpSync(path.join(REPO_ROOT, "src"), path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "selfhost" })}\n`);
    writeFileSync(
      path.join(dir, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2023",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            skipLibCheck: true,
            noEmit: true,
            allowImportingTsExtensions: true,
          },
          include: ["**/*.ts"],
        },
        null,
        2,
      )}\n`,
    );

    const session = await open(dir);
    const total = session.committed().store.files.size;
    expect(total).toBeGreaterThan(30);

    edit(
      dir,
      path.join("src", "checker", "impact.ts"),
      "export function impactClosure(",
      "/** @effects pure */\nexport function impactClosure(",
    );
    const { full, reextracted } = await updateAndProveScoped(session, dir, [
      CHANGED("src/checker/impact.ts"),
    ]);

    expect(full).toBe(false);
    expect(reextracted).toContain("src/checker/impact.ts");
    // The shape phase 4 exists for: a real codebase, one file edited, a closure
    // smaller than the tree.
    expect(reextracted.length).toBeLessThan(total);
  });
});
