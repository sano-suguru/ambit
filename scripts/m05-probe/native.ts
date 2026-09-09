/**
 * DESIGN.md §3.5 gate 4 — the native (TypeScript 7 / Go engine) side of the
 * comparison. Run by `scripts/m05-backend-compare.ts`, one process per
 * measurement; prints one JSON object on stdout.
 *
 * The compiler is loaded from `.m05-native/`, outside this repository's
 * dependency tree — see `scripts/m05-probe/native-compiler.ts` for why it must
 * not be a devDependency. This file is a measurement probe, not a backend:
 * nothing under `src/` imports it, and `test/architecture.test.ts` keeps it
 * that way.
 *
 * The walk mirrors `scripts/m05-probe/legacy.ts` query for query. Two
 * differences are forced by the API rather than chosen:
 *
 *   - `getFullyQualifiedName` has no counterpart on the native `Checker`, so
 *     neither probe uses it; the classification both do (default lib /
 *     external / project) is the part legacy derives from the same
 *     declaration.
 *   - a declaration reaches this side as a `NodeHandle` and has to be
 *     `resolve()`d before its source file can be read. That round trip is part
 *     of what is being measured, so it is not hoisted out.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadAst, loadAstIs, loadSyncApi, nativeVersion } from "./native-compiler.ts";
import { CONTRACT_TAGS, childRssMiB, emptyCounts, nodeRssMiB } from "./shared.ts";

const { API, SymbolFlags } = await loadSyncApi();
const { getJSDocTags } = await loadAst();
const is = await loadAstIs();
// biome-ignore lint/suspicious/noExplicitAny: the compiler's own types are not available here
type Node = any;

const corpus = path.resolve(process.argv[2] ?? "src");

/** The same search `ts.findConfigFile` does on the legacy side: nearest ancestor. */
function findConfigFile(from: string): string {
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no tsconfig.json found from ${from}`);
    dir = parent;
  }
}

const configPath = findConfigFile(corpus);
const t0 = performance.now();

const api = new API({ cwd: path.dirname(configPath), collectTiming: true });
const snapshot = api.updateSnapshot({ openProjects: [configPath] });
const project = snapshot.getProjects()[0];
if (!project) throw new Error(`no project opened for ${corpus}`);
const { program, checker } = project;
const startupMs = performance.now() - t0;

const t1 = performance.now();
const counts = emptyCounts();

function isFunctionLike(node: Node): boolean {
  return (
    is.isFunctionDeclaration(node) ||
    is.isMethodDeclaration(node) ||
    is.isArrowFunction(node) ||
    is.isFunctionExpression(node) ||
    is.isConstructorDeclaration(node) ||
    is.isGetAccessorDeclaration(node) ||
    is.isSetAccessorDeclaration(node)
  );
}

for (const fileName of program.getSourceFileNames()) {
  if (!fileName.startsWith(corpus)) continue;
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile || sourceFile.isDeclarationFile) continue;
  counts.files++;

  const visit = (node: Node): void => {
    if (isFunctionLike(node)) {
      counts.functions++;
      for (const tag of getJSDocTags(node)) {
        if (tag.tagName && CONTRACT_TAGS.has(tag.tagName.text)) counts.contractTags++;
      }
    }
    if (is.isCallExpression(node)) {
      counts.calls++;
      const callee = node.expression;
      const symbol = checker.getSymbolAtLocation(callee);
      const isAlias = symbol !== undefined && (symbol.flags & SymbolFlags.Alias) !== 0;
      const resolved = isAlias && symbol ? checker.getAliasedSymbol(symbol) : symbol;
      const handle = resolved?.declarations?.[0];
      const declaration = handle?.resolve(project);
      if (declaration) {
        counts.resolved++;
        const file = declaration.getSourceFile();
        if (program.isSourceFileDefaultLibrary(file)) counts.defaultLib++;
        else if (program.isSourceFileFromExternalLibrary(file)) counts.external++;
        else counts.local++;
      }
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
}

const extractMs = performance.now() - t1;
const timing = api.getTimingInfo().totals;
// Sampled before `close()`: after it there is no child left to measure.
const childRss = childRssMiB();
api.close();

console.log(
  JSON.stringify({
    backend: "native",
    engineVersion: nativeVersion(),
    startupMs,
    extractMs,
    totalMs: startupMs + extractMs,
    nodeRssMiB: nodeRssMiB(),
    childRssMiB: childRss,
    counts,
    ipc: {
      requests: timing.requestCount,
      bytesSent: timing.bytesSent,
      bytesReceived: timing.bytesReceived,
      serverMs: timing.serverTimeMs,
      transportMs: timing.transportOverheadMs,
    },
  }),
);
