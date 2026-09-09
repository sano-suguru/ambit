/**
 * DESIGN.md §3.5 gate 3, native side.
 *
 *     node scripts/m05-probe/update-native.ts <corpusRoot> <mutationId>
 *
 * Observes, mutates, then observes twice more from the *same* API session: once
 * after telling the engine which file changed, and once without telling it. The
 * second is the case that matters for §3.4 — an engine that answers from a
 * stale snapshot as though it were current turns a contract violation into a
 * clean run, and nothing downstream can tell.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { formatObservation, mutationById, type Observation } from "./mutations.ts";
import { loadAst, loadAstIs, loadSyncApi } from "./native-compiler.ts";

const { API } = await loadSyncApi();
const { getJSDocTags } = await loadAst();
const is = await loadAstIs();
// biome-ignore lint/suspicious/noExplicitAny: the compiler's own types are not available here
type Node = any;
// biome-ignore lint/suspicious/noExplicitAny: as above
type Project = any;

const root = path.resolve(process.argv[2] ?? "");
const mutation = mutationById(process.argv[3] ?? "body");

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

const configPath = findConfigFile(root);
const api = new API({ cwd: path.dirname(configPath) });

function observe(project: Project): Observation {
  const { program, checker } = project;
  const fileName = program.getSourceFileNames().find((f) => f.endsWith("/recursion.ts"));
  if (!fileName) throw new Error("recursion.ts not in program");
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) throw new Error("recursion.ts has no source file");

  let selfRecursiveCallsFetch = false;
  let leafReadsFileEffects = "none";
  let leafReadsFileExported = false;

  for (const statement of sourceFile.statements) {
    if (!is.isFunctionDeclaration(statement) || !statement.name) continue;
    const name = statement.name.text;
    if (name === "selfRecursive") {
      const walk = (node: Node): void => {
        if (
          is.isCallExpression(node) &&
          is.isIdentifier(node.expression) &&
          node.expression.text === "fetch"
        ) {
          selfRecursiveCallsFetch = true;
        }
        node.forEachChild(walk);
      };
      statement.forEachChild(walk);
    }
    if (name === "leafReadsFile") {
      for (const tag of getJSDocTags(statement)) {
        if (tag.tagName?.text === "effects") {
          const comment = tag.comment;
          const text =
            typeof comment === "string"
              ? comment
              : sourceFile.text.slice(comment?.pos ?? 0, comment?.end ?? 0);
          leafReadsFileEffects = text.trim() || "present";
        }
      }
      const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
      leafReadsFileExported =
        moduleSymbol !== undefined &&
        checker.getExportsOfModule(moduleSymbol).some((s) => s.name === "leafReadsFile");
    }
  }
  return { selfRecursiveCallsFetch, leafReadsFileEffects, leafReadsFileExported };
}

function projectOf(params?: Parameters<typeof api.updateSnapshot>[0]): Project {
  const project = api.updateSnapshot(params).getProjects()[0];
  if (!project) throw new Error(`no project opened for ${root}`);
  return project;
}

const before = observe(projectOf({ openProjects: [configPath] }));

mutation.apply(root);

// The engine is not told anything: a new snapshot, no `fileChanges`.
const stale = observe(projectOf());

const t0 = performance.now();
const notified = observe(projectOf({ fileChanges: { changed: [path.join(root, mutation.file)] } }));
const requeryMs = performance.now() - t0;

console.log(
  JSON.stringify({
    backend: "native",
    mutation: mutation.id,
    expectation: mutation.expectation,
    before: formatObservation(before),
    afterNotNotified: formatObservation(stale),
    afterNotified: formatObservation(notified),
    requeryMs,
  }),
);
api.close();
