/**
 * DESIGN.md §3.5 gate 4 — the legacy (TypeScript 5.x Compiler API) side of the
 * comparison. Run by `scripts/m05-backend-compare.ts`, one process per
 * measurement; prints one JSON object on stdout.
 *
 * The walk here mirrors `scripts/m05-probe/native.ts` query for query. It is
 * deliberately *not* `legacyTsBackend.extractProject`: that would put Ambit's
 * own classification on one side of the comparison and not the other.
 */

import path from "node:path";
import process from "node:process";
import ts from "typescript";
import { CONTRACT_TAGS, childRssMiB, emptyCounts, nodeRssMiB } from "./shared.ts";

const corpus = path.resolve(process.argv[2] ?? "src");
const t0 = performance.now();

const configPath = ts.findConfigFile(corpus, ts.sys.fileExists, "tsconfig.json");
if (!configPath) throw new Error(`no tsconfig.json found from ${corpus}`);
const parsed = ts.parseJsonConfigFileContent(
  ts.readConfigFile(configPath, ts.sys.readFile).config,
  ts.sys,
  path.dirname(configPath),
);
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const checker = program.getTypeChecker();
const startupMs = performance.now() - t0;

const t1 = performance.now();
const counts = emptyCounts();

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  );
}

for (const sourceFile of program.getSourceFiles()) {
  if (sourceFile.isDeclarationFile) continue;
  if (!sourceFile.fileName.startsWith(corpus)) continue;
  counts.files++;

  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      counts.functions++;
      for (const tag of ts.getJSDocTags(node)) {
        if (CONTRACT_TAGS.has(tag.tagName.text)) counts.contractTags++;
      }
    }
    if (ts.isCallExpression(node)) {
      counts.calls++;
      const callee = node.expression;
      const symbol = checker.getSymbolAtLocation(callee);
      const isAlias = symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0;
      const resolved = isAlias ? checker.getAliasedSymbol(symbol) : symbol;
      const declaration = resolved?.declarations?.[0];
      if (declaration) {
        counts.resolved++;
        const file = declaration.getSourceFile();
        if (program.isSourceFileDefaultLibrary(file)) counts.defaultLib++;
        else if (program.isSourceFileFromExternalLibrary(file)) counts.external++;
        else counts.local++;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
}

const extractMs = performance.now() - t1;

console.log(
  JSON.stringify({
    backend: "legacy",
    engineVersion: ts.version,
    startupMs,
    extractMs,
    totalMs: startupMs + extractMs,
    nodeRssMiB: nodeRssMiB(),
    childRssMiB: childRssMiB(),
    counts,
  }),
);
