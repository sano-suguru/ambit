/**
 * DESIGN.md §3.5 gate 3, legacy side.
 *
 *     node scripts/m05-probe/update-legacy.ts <corpusRoot> <mutationId>
 *
 * Observes, mutates, and observes again inside one process. The legacy path has
 * no snapshot to keep, so "re-query" means building a second `ts.Program` — the
 * same thing `ambit check` does on every run. That is why the re-query cost
 * below is the *whole* cost and not an increment: §6.2's resident path is not
 * implemented, and this measurement is the reason the gap matters rather than a
 * substitute for closing it.
 */

import path from "node:path";
import process from "node:process";
import ts from "typescript";
import { formatObservation, mutationById, type Observation } from "./mutations.ts";

const root = path.resolve(process.argv[2] ?? "");
const mutation = mutationById(process.argv[3] ?? "body");

function observe(): Observation {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error(`no tsconfig.json found from ${root}`);
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, ts.sys.readFile).config,
    ts.sys,
    path.dirname(configPath),
  );
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const checker = program.getTypeChecker();
  const sourceFile = program
    .getSourceFiles()
    .find((f) => f.fileName.endsWith("/recursion.ts") && !f.isDeclarationFile);
  if (!sourceFile) throw new Error("recursion.ts not in program");

  let selfRecursiveCallsFetch = false;
  let leafReadsFileEffects = "none";
  let leafReadsFileExported = false;

  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name) continue;
    const name = statement.name.text;
    if (name === "selfRecursive") {
      const walk = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "fetch"
        ) {
          selfRecursiveCallsFetch = true;
        }
        ts.forEachChild(node, walk);
      };
      walk(statement);
    }
    if (name === "leafReadsFile") {
      for (const tag of ts.getJSDocTags(statement)) {
        if (tag.tagName.text === "effects") {
          leafReadsFileEffects = String(tag.comment ?? "").trim() || "present";
        }
      }
      const symbol = checker.getSymbolAtLocation(statement.name);
      const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
      leafReadsFileExported =
        symbol !== undefined &&
        (checker.getExportsOfModule(moduleSymbol as ts.Symbol) ?? []).some(
          (s) => s.name === "leafReadsFile",
        );
    }
  }
  return { selfRecursiveCallsFetch, leafReadsFileEffects, leafReadsFileExported };
}

const before = observe();
mutation.apply(root);
const t0 = performance.now();
const after = observe();
const requeryMs = performance.now() - t0;

console.log(
  JSON.stringify({
    backend: "legacy",
    mutation: mutation.id,
    expectation: mutation.expectation,
    before: formatObservation(before),
    after: formatObservation(after),
    requeryMs,
    notified: "n/a — a fresh program is built per query",
  }),
);
