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
  UncarriedContract,
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

/** @effects fs_read */
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
  // them regardless of which file declares which. Each file's declarations
  // are kept (not just indexed into declaredNodeToId) so pass 2 can reuse
  // them instead of walking the file a second time.
  const declaredNodeToId = new Map<ts.Node, SymbolId>();
  const sourceFiles = program
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile && isUnderRoot(sf.fileName, absoluteRoot));

  const declarationsByFile = new Map<
    ts.SourceFile,
    ReturnType<typeof collectFunctionLikeDeclarations>
  >();
  for (const sourceFile of sourceFiles) {
    const declarations = collectFunctionLikeDeclarations(sourceFile);
    declarationsByFile.set(sourceFile, declarations);
    for (const [node, declPath] of declarations) {
      declaredNodeToId.set(node, symbolId(relativePath(absoluteRoot, sourceFile), declPath));
    }
  }

  // Pass 2: extract each function's JSDoc and calls, resolving callees
  // against the map built in pass 1; and tally every function-like node this
  // slice saw but did not extract (`skippedFunctions` — DESIGN.md §4.3).
  // Reuses pass 1's declarationsByFile instead of re-walking each file.
  const files: ExtractedFile[] = [];
  const skippedFunctions = new Map<SkippedFunctionKind, number>();
  const uncarriedContracts: UncarriedContract[] = [];
  for (const [sourceFile, declarations] of declarationsByFile) {
    const functions: ExtractedFunction[] = [];
    for (const [node, declPath] of declarations) {
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
    const skipped = collectSkippedFunctions(sourceFile, declaredNodeToId, absoluteRoot);
    for (const kind of skipped.kinds) {
      skippedFunctions.set(kind, (skippedFunctions.get(kind) ?? 0) + 1);
    }
    uncarriedContracts.push(...skipped.uncarried);
  }
  return { files, skippedFunctions, uncarriedContracts };
}

// ---- project loading --------------------------------------------------

/** @effects fs_read */
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

/** @effects fs_read */
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
  | (ts.VariableDeclaration & { readonly initializer: ts.FunctionExpression | ts.ArrowFunction })
  | (ts.PropertyAssignment & { readonly initializer: ts.FunctionExpression | ts.ArrowFunction });

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
    // `const handlers = { read() {…} }` / `{ read: () => {…} }`: the member's
    // body lives in the literal, so it gets its own id under the existing
    // declaration-path notation (`file.ts#handlers.read`), exactly as a class
    // method does. The container `handlers` is never itself indexed — its
    // initializer is an object literal, not a function — so no extracted
    // function's body contains these members and nothing is walked twice.
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const literal = indexableObjectLiteral(node);
      if (!literal) return;
      const objectPath = [...containerPath, node.name.text];
      for (const member of literal.properties) {
        // Identifier names only, mirroring the class-method rule above. A
        // computed, string, or numeric name has no spelling that survives
        // `symbolId`'s "."-join — `{ "a.b": … }` would be indistinguishable
        // from nesting — and DESIGN.md §5.3 requires a stable path that does
        // not lean on anything compiler-internal to disambiguate. Those stay
        // counted as `object-literal-method`.
        if (!member.name || !ts.isIdentifier(member.name)) continue;
        if (ts.isMethodDeclaration(member)) {
          results.push([member, [...objectPath, member.name.text]]);
        } else if (
          ts.isPropertyAssignment(member) &&
          (ts.isFunctionExpression(member.initializer) || ts.isArrowFunction(member.initializer))
        ) {
          results.push([member as FunctionLikeDeclaration, [...objectPath, member.name.text]]);
        }
      }
      return;
    }
  }

  ts.forEachChild(sourceFile, (child) => visitTop(child, []));
  return results;
}

/**
 * The object literal a `const` binds, when its members are safe to treat as
 * the call targets they name. `undefined` for every other binding.
 *
 * Two conditions make the syntactic match a fact rather than a convenience:
 *
 * - **`const` only.** A `let`/`var` binding may hold a different object by the
 *   time the call runs, so the members written here would not be the ones
 *   called.
 * - **No spread.** A spread can carry members this walk cannot enumerate, so
 *   any spread rejects the whole literal rather than trusting the members
 *   written beside it.
 *
 * This does not make resolution sound: `const` freezes the binding, not the
 * properties, so `handlers.read = other` still defeats it. Resolving a class
 * instance method already rests on the same assumption; this adds no new one.
 *
 * `satisfies` and `as const` wrap the literal without changing which object
 * its members belong to, so they are unwrapped rather than rejected.
 */
function indexableObjectLiteral(
  declaration: ts.VariableDeclaration,
): ts.ObjectLiteralExpression | undefined {
  if (!declaration.initializer) return undefined;
  if ((declaration.parent.flags & ts.NodeFlags.Const) === 0) return undefined;

  const literal = unwrapTypeOnlyExpression(declaration.initializer);
  if (!ts.isObjectLiteralExpression(literal)) return undefined;
  if (literal.properties.some(ts.isSpreadAssignment)) return undefined;
  return literal;
}

/** Strips wrappers that assert a type without changing the runtime value. */
function unwrapTypeOnlyExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isSatisfiesExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * True if `member` belongs to a literal `indexableObjectLiteral` accepts. The
 * same rule has to gate resolution as gates indexing: TypeScript resolves
 * `handlers.read` to the member's own declaration whether or not `handlers` is
 * a `const`, so without this check the guards above would apply only to the
 * receiver path and be bypassed by the direct one.
 */
function isInIndexableObjectLiteral(member: ts.Node): boolean {
  const literal = member.parent;
  if (literal === undefined || !ts.isObjectLiteralExpression(literal)) return false;

  let container: ts.Node = literal.parent;
  while (
    ts.isSatisfiesExpression(container) ||
    ts.isAsExpression(container) ||
    ts.isParenthesizedExpression(container)
  ) {
    container = container.parent;
  }
  return ts.isVariableDeclaration(container) && indexableObjectLiteral(container) === literal;
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
 * did not index, classified by kind (`SkippedFunctionKind`), plus any contract
 * written on one of them. The count turns "silent skip" into a visible number
 * (`ambit check --coverage`, DESIGN.md §4.3); the contracts turn a silently
 * dropped declaration into `AMB-E003`.
 */
function collectSkippedFunctions(
  sourceFile: ts.SourceFile,
  indexed: ReadonlyMap<ts.Node, SymbolId>,
  absoluteRoot: string,
): { readonly kinds: readonly SkippedFunctionKind[]; readonly uncarried: UncarriedContract[] } {
  const kinds: SkippedFunctionKind[] = [];
  const uncarried: UncarriedContract[] = [];

  function visit(node: ts.Node): void {
    if (isFunctionLikeNode(node) && !indexed.has(node) && !isIndexedInitializer(node, indexed)) {
      const kind = classifySkipped(node);
      kinds.push(kind);
      // `isFunctionLikeNode` has already narrowed to a real function-like
      // node; the local alias only widens it to the shape the JSDoc and
      // location helpers take.
      const decl = node as FunctionLikeDeclaration;
      const jsDoc = extractJsDoc(decl);
      for (const tag of CONTRACT_TAGS) {
        const raw = jsDoc?.tags.get(tag);
        if (raw === undefined) continue;
        uncarried.push({
          location: locationOf(absoluteRoot, sourceFile, nameOrNode(decl)),
          kind,
          tag,
          raw,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return { kinds, uncarried };
}

/**
 * The JSDoc tags that declare a contract (DESIGN.md §4.1). Only `@effects` is
 * enforced today, but a contract tag on a node that cannot carry one is dead
 * whichever tag it is, so all four are reported.
 */
const CONTRACT_TAGS = ["effects", "capabilities", "budget", "entrypoint"] as const;

/**
 * True if `node` is the function expression that *is* an indexed declaration's
 * body. `const f = () => {}` and `{ read: () => {} }` index the enclosing
 * `VariableDeclaration` / `PropertyAssignment`, not the arrow itself, so the
 * arrow would otherwise be counted as skipped as well as extracted — a
 * double-count that makes `--coverage` overstate what the analysis missed.
 */
function isIndexedInitializer(node: ts.Node, indexed: ReadonlyMap<ts.Node, SymbolId>): boolean {
  const parent = node.parent;
  return (
    parent !== undefined &&
    (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) &&
    parent.initializer === node &&
    indexed.has(parent)
  );
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
  if (ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl)) return decl.initializer;
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

    // The callee is an object-literal member: either indexed in its own right,
    // or holding an already-indexed function by reference.
    const memberId = objectLiteralMemberTarget(declaration, checker, declaredNodeToId);
    if (memberId) return { location, resolvedCallee: memberId };
  }

  // A property access on a module-scope `const` bound to an object literal is
  // resolvable from the value even when the literal carries a type annotation
  // and `getSymbolAtLocation` therefore lands on the annotation's member
  // signature instead of the literal's own member — the shape of Ambit's own
  // `legacyTsBackend: TsBackend = { extractProject }`. Genuine dynamic
  // dispatch is untouched: a receiver with no single literal behind it fails
  // the guards in `objectLiteralReceiverTarget` and stays unresolved.
  const receiverMemberId = objectLiteralReceiverTarget(callee, checker, declaredNodeToId);
  if (receiverMemberId) return { location, resolvedCallee: receiverMemberId };

  // An import binding whose alias couldn't be followed to any declaration at
  // all (e.g. the module specifier doesn't resolve, or the named export
  // doesn't exist) — `getAliasedSymbol()` returns TypeScript's `unknownSymbol`
  // in that case, whose `declarations` is `undefined`. Recorded as a
  // fallback reason rather than an early return, so a stub match is still
  // attempted below: an *unresolvable* `import { fetch } from "undici"`
  // falls back to the bare identifier text (`qualifiedNameOf`, below), which
  // still matches the stub table's bare `"fetch"` entry. A *resolvable* one
  // is qualified as `"undici.fetch"` instead and needs its own stub row
  // (see `src/stubs/node-builtins.ts`) — otherwise it downgrades from a
  // known `network` effect to `unknown`.
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

  const qualifiedName = qualifiedNameOf(checker, callee, importBindingReason === undefined);
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
 * The `SymbolId` a call through an object-literal member resolves to. Three
 * shapes, one hop each:
 *
 * - `{ read() {} }` / `{ read: () => {} }` — the member is indexed by
 *   `collectFunctionLikeDeclarations`, so it has an id of its own.
 * - `{ read: readIt }` — the member holds an already-indexed function by
 *   reference. The call resolves to *that* function's existing id; no second
 *   id is minted for the same body.
 * - `{ readIt }` — the same, reached via `getShorthandAssignmentValueSymbol`.
 *
 * The referenced function may itself be an import binding, so the value symbol
 * is de-aliased the way `classifyCall` de-aliases a callee. Exactly one hop: a
 * member holding another member, or a `const b = a` re-binding, is not
 * followed. Each further hop is another place the analysis could be wrong
 * without saying so, and one hop covers every shape this resolves.
 */
function objectLiteralMemberTarget(
  member: ts.Node,
  checker: ts.TypeChecker,
  declaredNodeToId: ReadonlyMap<ts.Node, SymbolId>,
): SymbolId | undefined {
  const own = declaredNodeToId.get(member);
  if (own) return own;
  if (!isInIndexableObjectLiteral(member)) return undefined;

  let valueSymbol: ts.Symbol | undefined;
  if (ts.isShorthandPropertyAssignment(member)) {
    valueSymbol = checker.getShorthandAssignmentValueSymbol(member);
  } else if (ts.isPropertyAssignment(member) && ts.isIdentifier(member.initializer)) {
    valueSymbol = checker.getSymbolAtLocation(member.initializer);
  } else {
    return undefined;
  }
  if (!valueSymbol) return undefined;

  const resolved =
    (valueSymbol.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(valueSymbol)
      : valueSymbol;
  const target = resolved.declarations?.[0];
  return target ? declaredNodeToId.get(target) : undefined;
}

/**
 * `X.p(...)` where `X` is a module-scope `const` bound to an object literal:
 * the member is found by name in the literal itself, so a type annotation on
 * `X` — which makes `getSymbolAtLocation` return the annotation's member
 * signature rather than the literal's member — does not hide the target.
 *
 * Which literals qualify — and why — is `indexableObjectLiteral`.
 */
function objectLiteralReceiverTarget(
  callee: ts.Expression,
  checker: ts.TypeChecker,
  declaredNodeToId: ReadonlyMap<ts.Node, SymbolId>,
): SymbolId | undefined {
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) {
    return undefined;
  }

  const receiverSymbol = checker.getSymbolAtLocation(callee.expression);
  if (!receiverSymbol) return undefined;
  const resolved =
    (receiverSymbol.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(receiverSymbol)
      : receiverSymbol;

  const declaration = resolved.declarations?.[0];
  if (!declaration || !ts.isVariableDeclaration(declaration)) return undefined;
  const literal = indexableObjectLiteral(declaration);
  if (!literal) return undefined;

  for (const member of literal.properties) {
    if (!member.name || !ts.isIdentifier(member.name)) continue;
    if (member.name.text !== callee.name.text) continue;
    return objectLiteralMemberTarget(member, checker, declaredNodeToId);
  }
  return undefined;
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
 *
 * Only argument positions whose *declared* parameter type can itself be
 * called are scanned (`acceptsCallableArgument`) — otherwise a
 * non-callback argument that merely happens to be a callable value (e.g.
 * `Array.prototype.reduce`'s `initialValue`, when the accumulator type is a
 * function type) would make the whole call look opaque even though its
 * actual callback is written inline and already walked by `collectCalls`.
 * Every branch that can't determine whether a position accepts a callable
 * (`getResolvedSignature` returns nothing, a JSDoc-only signature, an
 * out-of-range or rest parameter) falls back to scanning that argument
 * rather than skipping it, so this narrowing can only add opacity checks
 * back in, never silently drop the `any`/`unknown` fail-open guard above.
 */
function hasOpaqueCallableArgument(node: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const signature = checker.getResolvedSignature(node);
  return node.arguments.some((arg, index) => {
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return false;
    if (signature && !acceptsCallableArgument(signature, index, checker)) return false;
    const type = checker.getTypeAtLocation(arg);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
    return type.getCallSignatures().length > 0;
  });
}

/**
 * True if `signature`'s declared (not instantiated) parameter type at
 * `index` has call signatures — i.e. this argument position is a callback
 * slot. `checker.getTypeAtLocation` is called on the *parameter
 * declaration node*, not the argument: the declaration site carries the
 * generic, uninstantiated type (e.g. `reduce`'s `initialValue: U`), while
 * `getTypeAtLocation` on the argument itself would return the type
 * *instantiated* for this call (e.g. `() => number` when `U` is inferred
 * as a function type) and defeat the narrowing this function exists for.
 */
function acceptsCallableArgument(
  signature: ts.Signature,
  index: number,
  checker: ts.TypeChecker,
): boolean {
  const declaration = signature.declaration;
  // No declaration (e.g. a synthetic signature) or a JSDoc-only signature
  // (`JSDocSignature` has no `parameters` in the same shape) can't be
  // inspected — treat the slot as callable so the caller still scans it.
  if (!declaration || ts.isJSDocSignature(declaration)) return true;
  const parameter = declaration.parameters[index];
  // An argument beyond the declared parameter list, or a rest parameter
  // (whose declared type is the array type, not the element type), can't
  // be classified from the declaration either — stay conservative.
  if (!parameter || parameter.dotDotDotToken) return true;
  return isCallableParameterType(checker.getTypeAtLocation(parameter));
}

function isCallableParameterType(type: ts.Type): boolean {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
  if (type.isUnion()) return type.types.some(isCallableParameterType);
  return type.getCallSignatures().length > 0;
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
 * (`src/stubs/`). A property access on an identifier bound to a namespace
 * or default import yields `"<module specifier>.<property>"` (e.g.
 * `"node:fs".readFileSync` for `import * as fs from "node:fs";
 * fs.readFileSync(...)`, reported as `"node:fs.readFileSync"`; likewise for
 * `import fs from "node:fs"; fs.readFileSync(...)`).
 *
 * A bare identifier normally yields its own text (`"fetch"`) — the best
 * available name for stub matching regardless of whether it resolves to a
 * lib.dom.d.ts symbol. But when it's bound by a *resolved* named import
 * (`aliasResolved` — the alias was followed to a real declaration, see
 * `classifyCall`'s `importBindingReason`), the module specifier is known, so
 * the name is qualified the same way as a property access: `import {
 * readFileSync } from "node:fs"; readFileSync(...)` is reported as
 * `"node:fs.readFileSync"` (using the imported name, not a local `as`
 * alias). An *unresolved* named import (module doesn't resolve, or the
 * named export doesn't exist) still falls back to the bare identifier text
 * — an unresolvable `import { fetch } from "undici"` is still recognized as
 * `fetch` for stub matching, not silently downgraded to no name at all. Once
 * the same import *resolves*, though, it is qualified as `"undici.fetch"`
 * instead, which only matches the stub table if that qualified name has its
 * own row — a bare `"fetch"` row does not cover it.
 *
 * This does not resolve re-exported bindings several hops away — see the
 * limitation noted in `src/stubs/node-builtins.ts`.
 */
function qualifiedNameOf(
  checker: ts.TypeChecker,
  expr: ts.Expression,
  aliasResolved: boolean,
): string | undefined {
  if (ts.isIdentifier(expr)) {
    if (aliasResolved) {
      const namedImportQualifiedName = namedImportQualifiedNameOf(checker, expr);
      if (namedImportQualifiedName) return namedImportQualifiedName;
    }
    return expr.text;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const moduleSpecifier = moduleSpecifierOf(checker, expr.expression);
    if (moduleSpecifier) return `${moduleSpecifier}.${expr.name.text}`;
    return undefined;
  }
  return undefined;
}

/**
 * `"<module specifier>.<imported name>"` for an identifier bound by a named
 * import (`import { readFileSync } from "node:fs"`), using the *imported*
 * name (`propertyName`) rather than a local `as` alias (`import {
 * readFileSync as rf } ...` still yields `"node:fs.readFileSync"`, not
 * `"node:fs.rf"` — the stub table is keyed on the module's own export
 * names). `undefined` for anything that isn't a named import of a
 * string-literal module specifier (namespace/default imports are handled by
 * `moduleSpecifierOf` via the property-access branch above).
 */
function namedImportQualifiedNameOf(
  checker: ts.TypeChecker,
  expr: ts.Identifier,
): string | undefined {
  const symbol = checker.getSymbolAtLocation(expr);
  const decl = symbol?.declarations?.[0];
  if (!decl || !ts.isImportSpecifier(decl)) return undefined;
  const importDecl = decl.parent.parent.parent;
  if (!ts.isImportDeclaration(importDecl) || !ts.isStringLiteral(importDecl.moduleSpecifier)) {
    return undefined;
  }
  const importedName = decl.propertyName?.text ?? decl.name.text;
  return `${importDecl.moduleSpecifier.text}.${importedName}`;
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
  // A default import: `import fs from "node:fs"` — `decl` here is the
  // ImportClause itself (its `name` is the default binding), unlike a named
  // import where `decl` is an ImportSpecifier under the clause's
  // NamedImports. `ts.isImportClause(decl.parent)` would never match a
  // value import (NamespaceImport is caught above; ImportSpecifier's parent
  // is NamedImports, not ImportClause).
  if (ts.isImportClause(decl)) {
    const importDecl = decl.parent;
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
