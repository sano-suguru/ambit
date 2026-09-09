/**
 * DESIGN.md §3.5 gate 1, native side — does the distributed TypeScript 7 API
 * supply the primitives `src/checker/backend/legacy-ts.ts` is built from?
 *
 *     node scripts/m05-probe/native-primitives.ts test/fixtures/backend-smoke
 *     node scripts/m05-probe/native-primitives.ts test/fixtures/backend-conformance
 *
 * The legacy side of this gate is `test/backend.conformance.test.ts`, which
 * runs in `pnpm test`. This one cannot: it needs a compiler that is not a
 * dependency (see `native-compiler.ts`). So it prints, and `docs/status.md`
 * records what it printed.
 *
 * It answers questions, not benchmarks — gate 4 is `m05-backend-compare.ts`.
 * The questions are the ones whose answers would decide the gate: whether a
 * JSDoc tag can be located (§5.3 needs the tag's own range for `fixes[].edits`),
 * whether positions are UTF-16 code units (`SourceLocation`'s promise), whether
 * an overload set looks the same from this side, and what stands in for
 * `getFullyQualifiedName`, which this API does not have.
 */

import path from "node:path";
import process from "node:process";
import { loadAst, loadAstIs, loadSyncApi, nativeVersion } from "./native-compiler.ts";

const { API, SymbolFlags } = await loadSyncApi();
const { getJSDocTags } = await loadAst();
const is = await loadAstIs();

const root = path.resolve(process.argv[2] ?? "test/fixtures/backend-smoke");
const api = new API({ cwd: root, collectTiming: true });
const project = api
  .updateSnapshot({ openProjects: [path.join(root, "tsconfig.json")] })
  .getProjects()[0];
if (!project) throw new Error(`no project opened for ${root}`);
const { program, checker } = project;

const local = program.getSourceFileNames().filter((f: string) => f.startsWith(root));
const sourceFileOf = (name: string) => {
  const found = local.find((f: string) => f.endsWith(`/${name}`));
  return found ? program.getSourceFile(found) : undefined;
};

const lines: string[] = [];
const say = (label: string, value: string) => lines.push(`${label}: ${value}`);

console.log(`# ${nativeVersion()} on ${path.relative(process.cwd(), root)}`);
console.log(`node: ${process.version}  platform: ${process.platform}/${process.arch}`);

// --- the predicates and walk primitives -----------------------------------
// Legacy uses ~37 `ts.isX` predicates and `ts.forEachChild`. Three of its names
// do not exist here; the question is whether they are gone or renamed.
const RENAMED: Record<string, string> = {
  isGetAccessor: "isGetAccessorDeclaration",
  isSetAccessor: "isSetAccessorDeclaration",
  isClassLike: "isClassLikeDeclaration",
};
const renames = Object.entries(RENAMED).map(
  ([legacyName, nativeName]) =>
    `${legacyName} -> ${typeof is[nativeName] === "function" ? nativeName : "MISSING"}`,
);
say("predicate renames", renames.join(", "));
say(
  "forEachChild",
  typeof (await loadAst()).forEachChild === "function"
    ? "module export"
    : "method on Node only (legacy uses the module export)",
);

// --- JSDoc tag locations (§5.3) -------------------------------------------
for (const [file, fnName] of [
  ["sample.ts", "fetchRateDeclared"],
  ["recursion.ts", "leafReadsFile"],
] as const) {
  const sourceFile = sourceFileOf(file);
  if (!sourceFile) continue;
  const declaration = sourceFile.statements.find(
    // biome-ignore lint/suspicious/noExplicitAny: the compiler's types are not available here
    (s: any) => is.isFunctionDeclaration(s) && s.name?.text === fnName,
  );
  if (!declaration) continue;
  const tag = getJSDocTags(declaration)[0];
  if (!tag) {
    say(`jsdoc tag on ${fnName}`, "getJSDocTags returned none");
    continue;
  }
  const start = sourceFile.getLineAndCharacterOfPosition(tag.pos);
  const end = sourceFile.getLineAndCharacterOfPosition(tag.end);
  say(
    `jsdoc tag on ${fnName}`,
    `@${tag.tagName?.text} at line ${start.line + 1} col ${start.character + 1} .. line ${end.line + 1} col ${end.character + 1} (text ${JSON.stringify(sourceFile.text.slice(tag.pos, tag.end))})`,
  );
}

// --- what stands in for getFullyQualifiedName ------------------------------
{
  const sourceFile = sourceFileOf("sample.ts");
  if (sourceFile) {
    // biome-ignore lint/suspicious/noExplicitAny: as above
    let call: any;
    // biome-ignore lint/suspicious/noExplicitAny: as above
    const walk = (node: any): void => {
      if (
        is.isCallExpression(node) &&
        is.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "has"
      ) {
        call ??= node;
      }
      node.forEachChild(walk);
    };
    sourceFile.forEachChild(walk);
    say(
      "getFullyQualifiedName",
      typeof checker.getFullyQualifiedName === "function" ? "present" : "ABSENT",
    );
    const symbol = call && checker.getSymbolAtLocation(call.expression.name);
    if (symbol) {
      const chain: string[] = [];
      let current = symbol;
      for (let i = 0; i < 6 && current; i++) {
        chain.push(current.name);
        current = current.getParent();
      }
      say("  reconstructed from the parent chain", chain.reverse().join("."));
      const declaration = symbol.declarations?.[0]?.resolve(project);
      const declarationFile = declaration?.getSourceFile();
      say(
        "  declaring file",
        declarationFile
          ? `${declarationFile.fileName.split("/").pop()} defaultLib=${program.isSourceFileDefaultLibrary(declarationFile)} external=${program.isSourceFileFromExternalLibrary(declarationFile)}`
          : "unresolved",
      );
    }
  }
}

// --- alias resolution ------------------------------------------------------
{
  const sourceFile = sourceFileOf("sample.ts");
  const importDeclaration = sourceFile?.statements.find(
    // biome-ignore lint/suspicious/noExplicitAny: as above
    (s: any) => is.isImportDeclaration(s) && String(s.moduleSpecifier.text).includes("helper"),
  );
  const specifier = importDeclaration?.importClause?.namedBindings?.elements?.[0];
  const symbol = specifier?.name && checker.getSymbolAtLocation(specifier.name);
  if (symbol) {
    const isAlias = (symbol.flags & SymbolFlags.Alias) !== 0;
    const aliased = isAlias ? checker.getAliasedSymbol(symbol) : symbol;
    say(
      "getAliasedSymbol",
      `${symbol.name} -> ${aliased.name} in ${aliased.declarations?.[0]?.path?.split("/").pop()} (isUnknownSymbol=${checker.isUnknownSymbol(aliased)})`,
    );
  }
}

// --- overload sets ---------------------------------------------------------
{
  const sourceFile = sourceFileOf("overloads.ts");
  if (sourceFile) {
    // biome-ignore lint/suspicious/noExplicitAny: as above
    let call: any;
    // biome-ignore lint/suspicious/noExplicitAny: as above
    const walk = (node: any): void => {
      if (
        is.isCallExpression(node) &&
        is.isIdentifier(node.expression) &&
        node.expression.text === "widen"
      ) {
        call ??= node;
      }
      node.forEachChild(walk);
    };
    sourceFile.forEachChild(walk);
    const symbol = call && checker.getSymbolAtLocation(call.expression);
    // biome-ignore lint/suspicious/noExplicitAny: as above
    const shapes = (symbol?.declarations ?? []).map((d: any) => {
      const node = d.resolve(project);
      return node && is.isFunctionDeclaration(node) ? (node.body ? "impl" : "sig") : "?";
    });
    say("overload set `widen`", `${shapes.length} declarations: ${shapes.join(",")}`);
    // biome-ignore lint/suspicious/noExplicitAny: as above
    const bodyless = (s: any) => is.isFunctionDeclaration(s) && !s.body;
    const signature = sourceFile.statements.find(bodyless);
    // biome-ignore lint/suspicious/noExplicitAny: as above
    const tagNames = getJSDocTags(signature).map((t: any) => t.tagName?.text);
    say("  jsdoc readable off a bodyless signature", tagNames.join(",") || "(none)");
  }
}

// --- Unicode positions -----------------------------------------------------
{
  const sourceFile = sourceFileOf("unicode.ts");
  if (sourceFile) {
    // biome-ignore lint/suspicious/noExplicitAny: as above
    let identifier: any;
    // biome-ignore lint/suspicious/noExplicitAny: as above
    const walk = (node: any): void => {
      if (
        is.isCallExpression(node) &&
        is.isIdentifier(node.expression) &&
        node.expression.text === "日本語関数" &&
        sourceFile.text
          .split("\n")
          [sourceFile.getLineAndCharacterOfPosition(node.pos).line]?.includes("🎯")
      ) {
        identifier ??= node.expression;
      }
      node.forEachChild(walk);
    };
    sourceFile.forEachChild(walk);
    if (identifier) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        identifier.getStart(sourceFile),
      );
      const text = sourceFile.text.split("\n")[line] ?? "";
      const utf16 = text.indexOf("日本語関数(");
      say(
        "unicode position on the astral line",
        `line ${line + 1}: reported character ${character}; UTF-16 index ${utf16} (match=${character === utf16}), UTF-8 bytes ${Buffer.byteLength(text.slice(0, utf16), "utf8")}, code points ${[...text.slice(0, utf16)].length}`,
      );
    } else {
      say("unicode position on the astral line", "call not found");
    }
  }
}

for (const line of lines) console.log(`  ${line}`);
const totals = api.getTimingInfo().totals;
console.log(
  `  IPC: ${totals.requestCount} requests, ${(totals.bytesReceived / 1024).toFixed(0)} KiB received`,
);
api.close();
