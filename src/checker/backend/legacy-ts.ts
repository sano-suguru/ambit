import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type {
  CallSite,
  ExtractedFile,
  ExtractedFunction,
  ExtractedProject,
  RawJsDoc,
  SkippedFunctionKind,
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

async function extractProject(rootDir: string): Promise<ExtractedProject> {
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
  // against the map built in pass 1; and tally every function-like node this
  // slice saw but did not extract (`skippedFunctions` — DESIGN.md §4.3).
  const files: ExtractedFile[] = [];
  const skippedFunctions = new Map<SkippedFunctionKind, number>();
  for (const sourceFile of sourceFiles) {
    const functions: ExtractedFunction[] = [];
    for (const [node, declPath] of collectFunctionLikeDeclarations(sourceFile)) {
      const id = symbolId(relativePath(absoluteRoot, sourceFile), declPath);
      functions.push({
        id,
        location: locationOf(absoluteRoot, sourceFile, nameOrNode(node)),
        jsDoc: extractJsDoc(node),
        calls: collectCalls(node, sourceFile, program, checker, declaredNodeToId, absoluteRoot),
      });
    }
    if (functions.length > 0) {
      files.push({ filePath: relativePath(absoluteRoot, sourceFile), functions });
    }
    for (const kind of collectSkippedFunctionKinds(sourceFile, declaredNodeToId)) {
      skippedFunctions.set(kind, (skippedFunctions.get(kind) ?? 0) + 1);
    }
  }
  return { files, skippedFunctions };
}

// ---- project loading --------------------------------------------------

function loadProjectConfig(absoluteRoot: string): {
  rootNames: readonly string[];
  options: ts.CompilerOptions;
} {
  const configPath = ts.findConfigFile(absoluteRoot, ts.sys.fileExists, "tsconfig.json");
  if (configPath) {
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    // A malformed tsconfig.json (unparseable JSON) must fail loudly, not
    // silently fall back to an empty `config` object — that would produce
    // 0 root files and read as "checked, no violations" (DESIGN.md §3.4).
    if (configFile.error) {
      throw new Error(
        `failed to read ${configPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")}`,
      );
    }

    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      path.dirname(configPath),
    );
    const errors = parsed.errors.filter((d) => d.category === ts.DiagnosticCategory.Error);
    if (errors.length > 0) {
      throw new Error(
        `invalid ${configPath}: ${errors
          .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
          .join("; ")}`,
      );
    }
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

/**
 * `ts.isFunctionLikeDeclaration` (a real function-like node with a body, as
 * opposed to a signature-only form like `MethodSignature` or
 * `FunctionTypeNode`, which `ts.isFunctionLike` also matches) exists at
 * runtime but is not declared in the public `typescript` .d.ts, so it's
 * redefined locally against `ts.FunctionLikeDeclaration`'s public union.
 */
function isFunctionLikeNode(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/**
 * Every function-like node in `sourceFile` that `collectFunctionLikeDeclarations`
 * did not index, classified by kind (`SkippedFunctionKind`). This is what
 * turns "silent skip" into a visible count (`ambit check --coverage`) — see
 * DESIGN.md §4.3 and the plan's note on measuring extraction coverage before
 * trusting it.
 */
function collectSkippedFunctionKinds(
  sourceFile: ts.SourceFile,
  indexed: ReadonlyMap<ts.Node, SymbolId>,
): readonly SkippedFunctionKind[] {
  const kinds: SkippedFunctionKind[] = [];

  function visit(node: ts.Node): void {
    if (isFunctionLikeNode(node) && !indexed.has(node)) {
      kinds.push(classifySkipped(node));
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return kinds;
}

function classifySkipped(node: ts.FunctionLikeDeclaration): SkippedFunctionKind {
  if (ts.isGetAccessor(node) || ts.isSetAccessor(node)) return "getter-setter";
  if (isObjectLiteralMethod(node)) return "object-literal-method";
  if (isDefaultExport(node)) return "anonymous-default-export";
  if (isCallbackArgument(node)) return "callback-argument";
  if (isNestedInAnotherFunction(node)) return "nested-function";
  return "other";
}

/**
 * `{ foo() {} }` (a MethodDeclaration whose parent is the object literal
 * directly) and `{ foo: () => 1 }` (an arrow/function expression assigned via
 * a PropertyAssignment, whose parent is the assignment, not the object
 * literal itself) are both object-literal methods in spirit; both must be
 * recognized so this kind isn't a narrower category than its name promises.
 */
function isObjectLiteralMethod(node: ts.Node): boolean {
  if (node.parent && ts.isObjectLiteralExpression(node.parent)) return true;
  const parent = node.parent;
  return (
    parent !== undefined &&
    ts.isPropertyAssignment(parent) &&
    parent.initializer === node &&
    ts.isObjectLiteralExpression(parent.parent)
  );
}

function isDefaultExport(node: ts.Node): boolean {
  if (ts.isExportAssignment(node.parent) && !node.parent.isExportEquals) return true;
  if (ts.canHaveModifiers(node)) {
    return (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
  }
  return false;
}

function isCallbackArgument(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent || !(ts.isCallExpression(parent) || ts.isNewExpression(parent))) return false;
  return (parent.arguments as readonly ts.Node[] | undefined)?.includes(node) ?? false;
}

/** Walks up from `node` to the source file, stopping at the first enclosing function-like ancestor. */
function isNestedInAnotherFunction(node: ts.Node): boolean {
  let current = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (isFunctionLikeNode(current)) return true;
    current = current.parent;
  }
  return false;
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
  program: ts.Program,
  checker: ts.TypeChecker,
  declaredNodeToId: ReadonlyMap<ts.Node, SymbolId>,
  absoluteRoot: string,
): readonly CallSite[] {
  const body = bodyOf(decl);
  if (!body) return [];

  const calls: CallSite[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      calls.push(classifyCall(node, sourceFile, program, checker, declaredNodeToId, absoluteRoot));
    } else if (ts.isNewExpression(node)) {
      const site = classifyNewExpression(node, sourceFile, absoluteRoot);
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
  absoluteRoot: string,
): CallSite | undefined {
  if (ts.isIdentifier(node.expression) && node.expression.text === "Function") {
    return {
      location: locationOf(absoluteRoot, sourceFile, node),
      unresolvedReason: "new-function",
    };
  }
  return undefined;
}

function classifyCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  program: ts.Program,
  checker: ts.TypeChecker,
  declaredNodeToId: ReadonlyMap<ts.Node, SymbolId>,
  absoluteRoot: string,
): CallSite {
  const location = locationOf(absoluteRoot, sourceFile, node);

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
  // A call to an imported identifier (`import { helper } from "./b.ts";
  // helper()`) resolves via getSymbolAtLocation to the `ImportSpecifier`/
  // `ImportClause` itself, not the declaration behind it — that binding is
  // an alias (`SymbolFlags.Alias`), and getAliasedSymbol() follows it
  // (through an entire re-export chain, e.g. a barrel `index.ts`) to the
  // real declaration, whether that's a project function or an ambient one
  // (e.g. `node:fs`'s `readFileSync` in `@types/node`). Calling
  // getAliasedSymbol() on a non-alias symbol asserts, so it's guarded.
  const isAlias = symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0;
  const resolvedSymbol = isAlias ? checker.getAliasedSymbol(symbol) : symbol;
  const declaration = resolvedSymbol?.declarations?.[0];

  // Resolves to a project-local function/method we indexed in pass 1
  // (directly, or via the alias resolution above).
  if (declaration) {
    const resolvedId = declaredNodeToId.get(declaration);
    if (resolvedId) return { location, resolvedCallee: resolvedId };
  }

  // An import binding whose alias couldn't be followed to any declaration at
  // all (e.g. the module specifier doesn't resolve, or the named export
  // doesn't exist) — `getAliasedSymbol()` returns TypeScript's `unknownSymbol`
  // in that case, whose `declarations` is `undefined`. Recorded as a
  // fallback reason rather than an early return, so a stub match is still
  // attempted below (an unresolvable `import { fetch } from "undici"` should
  // still be recognized as `network` via `qualifiedNameOf`, not silently
  // downgraded to a warning because the module didn't resolve).
  const importBindingReason: UnresolvedReason | undefined =
    isAlias && !declaration ? "import-binding" : undefined;

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

  // If this call ends up unresolved (no calleeQualifiedName, or one that
  // doesn't match a stub — decided later by `summarize.ts`), a more specific
  // reason than "unresolved-symbol" is already knowable from the ambient
  // declaration's own source file: TypeScript's default lib (a builtin
  // method reached through a value the connector layer can't name, e.g.
  // `set.has(...)`) vs. a third-party package's `.d.ts` (DESIGN.md §12).
  const ambientReason =
    isAmbientDeclaration && declaration
      ? ambientUnresolvedReason(declaration.getSourceFile(), program)
      : undefined;

  // `importBindingReason` and `ambientReason` are mutually exclusive (the
  // former only applies when `declaration` is undefined, the latter only
  // when it is defined), so combining them loses nothing.
  const fallbackReason = importBindingReason ?? ambientReason;

  const calleeType = checker.getTypeAtLocation(callee);
  const isAnyTyped = (calleeType.flags & ts.TypeFlags.Any) !== 0;

  const qualifiedName = qualifiedNameOf(checker, callee);
  if (qualifiedName) {
    return { location, calleeQualifiedName: qualifiedName, unresolvedReason: fallbackReason };
  }

  // qualifiedNameOf only names a bare identifier or a property access on an
  // import binding — a builtin method reached through a local value
  // (`set.has(...)`) has neither, so it falls through to here with no
  // textual name. The checker can still name the symbol directly; that name
  // is checked against src/stubs/pure-builtins.ts's allowlist (a separate
  // namespace — see CallSite.pureBuiltinName), not against calleeQualifiedName.
  if (ambientReason === "builtin-method" && resolvedSymbol) {
    const pureBuiltinName = checker.getFullyQualifiedName(resolvedSymbol);
    if (pureBuiltinName) {
      return {
        location,
        pureBuiltinName,
        unresolvedReason: ambientReason,
        callbackByReference: hasOpaqueCallableArgument(node, checker) || undefined,
      };
    }
  }

  if (isAnyTyped) {
    return { location, unresolvedReason: "any-typed" };
  }

  return { location, unresolvedReason: fallbackReason ?? "unresolved-symbol" };
}

/**
 * True if any argument is a callable passed by reference (an identifier,
 * property access, or other expression with call signatures) rather than
 * written inline as `x => ...` / `function (...) {...}`. `collectCalls`
 * only walks into an inline callback's body; a callback passed by reference
 * is invisible to it, so a method taking one (`forEach`, `map`, `some`, ...)
 * cannot be trusted as pure even if its own name is allowlisted.
 *
 * An `any`/`unknown`-typed argument has no call signatures of its own
 * (`getCallSignatures()` returns `[]`), so it must be treated as opaque
 * rather than as "not callable" — otherwise `arr.map(fnFromAnyRecord)`
 * would slip past this guard the same way `classifyCall`'s own
 * `any-typed` callee case treats `any` as unresolved, not as safe.
 */
function hasOpaqueCallableArgument(node: ts.CallExpression, checker: ts.TypeChecker): boolean {
  return node.arguments.some((arg) => {
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return false;
    const type = checker.getTypeAtLocation(arg);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
    return type.getCallSignatures().length > 0;
  });
}

function ambientUnresolvedReason(
  declarationSourceFile: ts.SourceFile,
  program: ts.Program,
): UnresolvedReason | undefined {
  if (program.isSourceFileDefaultLibrary(declarationSourceFile)) return "builtin-method";
  if (program.isSourceFileFromExternalLibrary(declarationSourceFile)) return "external-module";
  return undefined;
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

function locationOf(
  absoluteRoot: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
): SourceLocation {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    // Relative to the project root passed to `ambit check` (core/location.ts's
    // contract) — never absolute: it would leak the local filesystem layout
    // into NDJSON output and make `via[].file`/`location.file` inconsistent
    // with the already-relative `via[].symbol` (DESIGN.md §5.1 example uses
    // "src/tax.ts", not an absolute path).
    file: relativePath(absoluteRoot, sourceFile),
    line: start.line + 1,
    col: start.character + 1,
    endLine: end.line + 1,
    endCol: end.character + 1,
  };
}

export type { UnresolvedReason };
