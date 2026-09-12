import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AnalysisResult,
  type ConfigDependencies,
  computeFingerprint,
  configDependencies,
  fingerprintPermitsReuse,
  openResidentSession,
  type ResidentSession,
  type ResidentStore,
} from "../src/checker/index.ts";
import { analyze } from "../src/cli/analyze.ts";
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
): Promise<{ readonly resident: AnalysisResult; readonly cold: AnalysisResult }> {
  const result = await session.update();
  if (!result.ok) throw result.error;
  const cold = await analyze(dir);
  expect(render(result.analysis)).toBe(render(cold));
  // The session's own accessor has to agree with what the update returned;
  // otherwise a caller reading `current()` gets a different answer from the one
  // the comparison passed.
  expect(render(session.current())).toBe(render(cold));
  return { resident: result.analysis, cold };
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
    const fingerprint = fingerprintOf(dir);

    // The resolved compiler options are not reachable without a backend
    // session, so today this is always non-empty — and the consequence is that
    // reuse is refused even when every hash matches. That is the direction this
    // is allowed to be wrong in (§3.4): rebuilding something it need not have.
    expect(fingerprint.undecidable.length).toBeGreaterThan(0);
    expect(fingerprintPermitsReuse(fingerprint, fingerprint)).toBe(false);
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
    expect(result.timings.impact).toBe(0);
    // The full-rebuild adapter cannot separate project construction from
    // extraction, and says so by leaving the field absent rather than by
    // reporting a zero that would read as free.
    expect(result.timings.projectUpdate).toBeUndefined();
    expect(result.full).toBe(true);
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
