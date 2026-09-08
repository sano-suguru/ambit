import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type {
  CallSite,
  ExtractedFile,
  ExtractedFunction,
  RawJsDoc,
  SourceLocation,
  SymbolId,
  TsBackend,
  UnresolvedReason,
} from "../../core/index.ts";
import { symbolId } from "../../core/index.ts";

/**
 * `TsBackend` implementation on the legacy TypeScript Compiler API
 * (DESIGN.md §3.4, §3.5). This is a throwaway implementation (plan D2):
 * the native backend comparison (M0.5) has not run, and this file exists to
 * let the contract-analysis layer (`src/checker/{summarize,propagate,
 * diagnose}.ts`) develop and prove out against a real, working backend now.
 *
 * This is the ONLY file allowed to import `typescript`. No `ts.Node`,
 * `ts.Symbol`, or `ts.Type` may be returned from `extractProject` — see
 * `src/core/backend.ts`.
 */
export const legacyTsBackend: TsBackend = {
  name: "typescript-legacy",
  version: ts.version,
  extractProject,
};

async function extractProject(rootDir: string): Promise<readonly ExtractedFile[]> {
  const absoluteRoot = path.resolve(rootDir);

  // A missing/non-directory target must fail loudly, not silently produce
  // zero files (DESIGN.md §3.4: "起動不能、未対応設定、解析失敗を
  // 「違反なし」に変換しない"). Without this check, ts.findConfigFile still
  // walks upward from a nonexistent path and can find an unrelated ancestor
  // tsconfig.json, silently analyzing the wrong (or no) files.
  if (!fs.existsSync(absoluteRoot) || !fs.statSync(absoluteRoot).isDirectory()) {
    throw new Error(`project root not found or not a directory: ${absoluteRoot}`);
  }

  const { rootNames, options } = loadProjectConfig(absoluteRoot);
  const program = ts.createProgram({ rootNames, options });
  const checker = program.getTypeChecker();

  // Pass 1: find every function/method declaration under the project root
  // and assign it a stable SymbolId, so pass 2 can resolve calls between
  // them regardless of which file declares which.
  const declaredNodeToId = new Map<ts.Node, SymbolId>();
  const sourceFiles = program
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile && isUnderRoot(sf.fileName, absoluteRoot));

  for (const sourceFile of sourceFiles) {
    for (const [node, declPath] of collectFunctionLikeDeclarations(sourceFile)) {
      declaredNodeToId.set(node, symbolId(relativePath(absoluteRoot, sourceFile), declPath));
    }
  }

  // Pass 2: extract each function's JSDoc and calls, resolving callees
  // against the map built in pass 1.
  const files: ExtractedFile[] = [];
  for (const sourceFile of sourceFiles) {
    const functions: ExtractedFunction[] = [];
    for (const [node, declPath] of collectFunctionLikeDeclarations(sourceFile)) {
      const id = symbolId(relativePath(absoluteRoot, sourceFile), declPath);
      functions.push({
        id,
        location: locationOf(sourceFile, nameOrNode(node)),
        jsDoc: extractJsDoc(node),
        calls: collectCalls(node, sourceFile, checker, declaredNodeToId),
      });
    }
    if (functions.length > 0) {
      files.push({ filePath: relativePath(absoluteRoot, sourceFile), functions });
    }
  }
  return files;
}

// ---- project loading --------------------------------------------------

function loadProjectConfig(absoluteRoot: string): {
  rootNames: readonly string[];
  options: ts.CompilerOptions;
} {
  const configPath = ts.findConfigFile(absoluteRoot, ts.sys.fileExists, "tsconfig.json");
  if (configPath) {
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      path.dirname(configPath),
    );
    return { rootNames: parsed.fileNames, options: parsed.options };
  }

  // No tsconfig.json found: fall back to every .ts file under the root with
  // a reasonable default (DESIGN.md §3.4 — analysis must not silently
  // degrade to "no violations" just because a config is missing).
  const rootNames = collectTsFiles(absoluteRoot);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
  };
  return { rootNames, options };
}

function collectTsFiles(dir: string): readonly string[] {
  const results: string[] = [];
  for (const entry of ts.sys.readDirectory(dir, [".ts", ".tsx"], ["node_modules"])) {
    results.push(entry);
  }
  return results;
}

function isUnderRoot(fileName: string, absoluteRoot: string): boolean {
  const rel = path.relative(absoluteRoot, fileName);
  return !rel.startsWith("..") && !path.isAbsolute(rel) && !fileName.includes("node_modules");
}

function relativePath(absoluteRoot: string, sourceFile: ts.SourceFile): string {
  return path.relative(absoluteRoot, sourceFile.fileName);
}

// ---- declaration discovery --------------------------------------------

type FunctionLikeDeclaration =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | (ts.VariableDeclaration & { readonly initializer: ts.FunctionExpression | ts.ArrowFunction });

/**
 * Walk a source file collecting function declarations, methods, and
 * variable-declared function/arrow expressions, each paired with its
 * "."-joined declaration path (DESIGN.md §5.3's "ファイル・宣言経路など
 * との対応"). Anonymous functions and functions nested inside another
 * function's body are out of scope for this slice (plan: "最初の垂直
 * スライス" §含むもの) — nested closures' calls are still walked and
 * attributed to their enclosing named declaration.
 */
function collectFunctionLikeDeclarations(
  sourceFile: ts.SourceFile,
): ReadonlyArray<readonly [FunctionLikeDeclaration, readonly string[]]> {
  const results: Array<[FunctionLikeDeclaration, readonly string[]]> = [];

  function visitTop(node: ts.Node, containerPath: readonly string[]): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const declPath = [...containerPath, node.name.text];
      results.push([node, declPath]);
      return; // do not descend into nested function declarations separately
    }
    if (ts.isClassDeclaration(node) && node.name) {
      const classPath = [...containerPath, node.name.text];
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          results.push([member, [...classPath, member.name.text]]);
        }
      }
      return;
    }
    if (
      ts.isVariableStatement(node) ||
      ts.isModuleBlock(node) ||
      ts.isModuleDeclaration(node) ||
      node === sourceFile
    ) {
      ts.forEachChild(node, (child) => visitTop(child, containerPath));
      return;
    }
    if (ts.isVariableDeclarationList(node)) {
      for (const decl of node.declarations) visitTop(decl, containerPath);
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer))
    ) {
      results.push([node as FunctionLikeDeclaration, [...containerPath, node.name.text]]);
      return;
    }
  }

  ts.forEachChild(sourceFile, (child) => visitTop(child, []));
  return results;
}

function nameOrNode(decl: FunctionLikeDeclaration): ts.Node {
  if (ts.isVariableDeclaration(decl)) return decl.name;
  return decl.name ?? decl;
}

function bodyOf(decl: FunctionLikeDeclaration): ts.Node | undefined {
  if (ts.isVariableDeclaration(decl)) return decl.initializer;
  return decl.body;
}

// ---- JSDoc extraction ---------------------------------------------------

function extractJsDoc(decl: FunctionLikeDeclaration): RawJsDoc | undefined {
  const target = ts.isVariableDeclaration(decl) ? (decl.parent.parent ?? decl) : decl;
  const tags = ts.getJSDocTags(target);
  if (tags.length === 0) return undefined;

  const map = new Map<string, string>();
  for (const tag of tags) {
    map.set(tag.tagName.text, jsDocTagText(tag));
  }
  return { tags: map };
}

function jsDocTagText(tag: ts.JSDocTag): string {
  const { comment } = tag;
  if (typeof comment === "string") return comment.trim();
  if (!comment) return "";
  return comment
    .map((part) =>
      part.kind === ts.SyntaxKind.JSDocText ? (part as ts.JSDocText).text : part.getText(),
    )
    .join("")
    .trim();
}

// ---- call extraction ----------------------------------------------------

function collectCalls(
  decl: FunctionLikeDeclaration,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  declaredNodeToId: ReadonlyMap<ts.Node, SymbolId>,
): readonly CallSite[] {
  const body = bodyOf(decl);
  if (!body) return [];

  const calls: CallSite[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      calls.push(classifyCall(node, sourceFile, checker, declaredNodeToId));
    } else if (ts.isNewExpression(node)) {
      const site = classifyNewExpression(node, sourceFile);
      if (site) calls.push(site);
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(body, visit);
  return calls;
}

function classifyNewExpression(
  node: ts.NewExpression,
  sourceFile: ts.SourceFile,
): CallSite | undefined {
  if (ts.isIdentifier(node.expression) && node.expression.text === "Function") {
    return {
      location: locationOf(sourceFile, node),
      unresolvedReason: "new-function",
    };
  }
  return undefined;
}

function classifyCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  declaredNodeToId: ReadonlyMap<ts.Node, SymbolId>,
): CallSite {
  const location = locationOf(sourceFile, node);

  // Dynamic import: import(...)
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return { location, unresolvedReason: "dynamic-import" };
  }

  const callee = node.expression;

  // eval(...)
  if (ts.isIdentifier(callee) && callee.text === "eval") {
    return { location, unresolvedReason: "eval" };
  }

  const symbol = checker.getSymbolAtLocation(callee);
  const declaration = symbol?.declarations?.[0];

  // Resolves to a project-local function/method we indexed in pass 1.
  if (declaration) {
    const resolvedId = declaredNodeToId.get(declaration);
    if (resolvedId) return { location, resolvedCallee: resolvedId };
  }

  // Ambient declarations (globals and stdlib types from .d.ts files, e.g.
  // `declare function fetch(...)`) are never project overloads or callback
  // parameters — they just describe how a builtin's type looks. Only real
  // project source is checked against the two rules below, so a stub match
  // is attempted for anything ambient instead of being misclassified.
  const isAmbientDeclaration = declaration?.getSourceFile().isDeclarationFile ?? false;

  if (declaration && !isAmbientDeclaration) {
    // A parameter (higher-order function calling its own callback argument):
    // out of scope for this slice's propagation (DESIGN.md §4.2 rule 4).
    if (ts.isParameter(declaration)) {
      return { location, unresolvedReason: "callback-parameter" };
    }

    // A resolved-but-bodyless overload signature.
    if (
      (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) &&
      !declaration.body
    ) {
      return { location, unresolvedReason: "overload-without-body" };
    }
  }

  const calleeType = checker.getTypeAtLocation(callee);
  const isAnyTyped = (calleeType.flags & ts.TypeFlags.Any) !== 0;

  const qualifiedName = qualifiedNameOf(checker, callee);
  if (qualifiedName) {
    return { location, calleeQualifiedName: qualifiedName };
  }

  if (isAnyTyped) {
    return { location, unresolvedReason: "any-typed" };
  }

  return { location, unresolvedReason: "unresolved-symbol" };
}

/**
 * Best-effort textual name for a call target, for stub matching
 * (`src/stubs/`). A bare identifier yields its own text (`"fetch"`); a
 * property access on an identifier bound to a namespace import yields
 * `"<module specifier>.<property>"` (e.g. `"node:fs".readFileSync` for
 * `import * as fs from "node:fs"; fs.readFileSync(...)`, reported as
 * `"node:fs.readFileSync"`). This does not resolve destructured or
 * re-exported bindings — see the limitation noted in
 * `src/stubs/node-builtins.ts`.
 */
function qualifiedNameOf(checker: ts.TypeChecker, expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) {
    // A bare global call (e.g. `fetch(...)`) has no project declaration of
    // its own; the identifier text is the best available name for stub
    // matching regardless of whether it resolves to a lib.dom.d.ts symbol.
    return expr.text;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const moduleSpecifier = moduleSpecifierOf(checker, expr.expression);
    if (moduleSpecifier) return `${moduleSpecifier}.${expr.name.text}`;
    return undefined;
  }
  return undefined;
}

function moduleSpecifierOf(checker: ts.TypeChecker, expr: ts.Expression): string | undefined {
  if (!ts.isIdentifier(expr)) return undefined;
  const symbol = checker.getSymbolAtLocation(expr);
  const decl = symbol?.declarations?.[0];
  if (!decl) return undefined;

  if (ts.isNamespaceImport(decl)) {
    const importDecl = decl.parent.parent;
    if (ts.isImportDeclaration(importDecl) && ts.isStringLiteral(importDecl.moduleSpecifier)) {
      return importDecl.moduleSpecifier.text;
    }
  }
  if (ts.isImportClause(decl.parent)) {
    const importDecl = decl.parent.parent;
    if (ts.isImportDeclaration(importDecl) && ts.isStringLiteral(importDecl.moduleSpecifier)) {
      return importDecl.moduleSpecifier.text;
    }
  }
  return undefined;
}

// ---- positions ------------------------------------------------------------

function locationOf(sourceFile: ts.SourceFile, node: ts.Node): SourceLocation {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    file: sourceFile.fileName,
    line: start.line + 1,
    col: start.character + 1,
    endLine: end.line + 1,
    endCol: end.character + 1,
  };
}

export type { UnresolvedReason };
