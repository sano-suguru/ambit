import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type {
  CallSite,
  ExtractedFile,
  ExtractedFunction,
  ExtractedProject,
  LiteralArgument,
  OnExceed,
  RawJsDoc,
  RuntimeWrapper,
  SkippedFunctionKind,
  SourceLocation,
  SymbolId,
  TsBackend,
  UncarriedContract,
  UnresolvedReason,
  WrapperBudget,
} from "../../core/index.ts";
import { isOnExceed, symbolId } from "../../core/index.ts";
import { constructorStubKey } from "../../stubs/constructors.ts";
import { isFirstArgumentMutator, isMutatingBuiltin } from "../../stubs/mutating-builtins.ts";

/**
 * `TsBackend` implementation on the TypeScript Compiler API (DESIGN.md §3.4).
 *
 * **This is the adopted backend**, not a placeholder. M0.5's comparison ran and
 * chose it — DESIGN.md §3.5 and `docs/adr/0001-analysis-backend.md`, with the measurements
 * in `docs/status.md`. The native TypeScript 7 engine (Go) was faster on every
 * corpus and was still not adopted: its API is published entirely under
 * `unstable/`, it answers from a stale snapshot unless told which files
 * changed, and none of its speed was needed to meet a threshold. §3.5 also
 * records what would reopen the decision; changing the default now requires an
 * RFC (§9).
 *
 * The name `typescript-legacy` is the engine id in diagnostics and predates
 * that decision. It distinguishes the JavaScript implementation from the Go
 * one; it does not mean unmaintained. The version tracks the JS line's newest
 * stable release (6.0.3), by the rule in AGENTS.md.
 *
 * The separation this file sits behind is unchanged and still the point: this
 * is the ONLY file allowed to import `typescript`, and no `ts.Node`,
 * `ts.Symbol`, or `ts.Type` may be returned from `extractProject` — see
 * `src/core/backend.ts`. Adoption makes the boundary more useful, not less: it
 * is what will let §3.5's review happen without touching the contract layer.
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
  // zero files (DESIGN.md §3.4: "Do not convert a failure to start, an
  // unsupported setting, or an analysis failure into 'no violations'").
  // Without this check, ts.findConfigFile still
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
    const mintedInFile = new Set<SymbolId>();
    for (const [node, declPath] of declarations) {
      const id = symbolId(relativePath(absoluteRoot, sourceFile), declPath);
      // DESIGN.md §4.1: "the declaration path and the function the backend
      // returns must be one to one, or §4.2 rule 7's fixed-point iteration
      // does not converge". Two declarations under one id do not make a wrong
      // answer — they make no answer: `propagate` overwrites one summary with
      // the other every pass and `ambit check` never returns. So a residual
      // collision has to stop the run rather than reach the fixed point
      // (§3.4 — a failure to analyze is never reported as "no violations").
      if (mintedInFile.has(id)) {
        const { line } = locationOf(absoluteRoot, sourceFile, nameOrNode(node));
        throw new Error(
          `two declarations share the symbol id ${id} (the second is at line ${line}): ` +
            "a declaration path must name exactly one function, or the analysis does not " +
            "terminate (DESIGN.md §4.1). Report the shape — this is a gap in Ambit's " +
            "declaration paths, not in the code being checked.",
        );
      }
      mintedInFile.add(id);
      declaredNodeToId.set(node, id);
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
      const location = locationOf(absoluteRoot, sourceFile, nameOrNode(node));
      // An accessor / anonymous default export propagates like any other
      // function but does not adopt a contract comment (DESIGN.md §4.1 (a)).
      // Its JSDoc is deliberately not read — and a contract written there is
      // reported as AMB-E003 rather than dropped, exactly as it was before
      // the declaration became indexable.
      const configOnly = configOnlyPath(declPath);
      if (configOnly) {
        const jsDoc = extractJsDoc(node, absoluteRoot);
        for (const tag of CONTRACT_TAGS) {
          const raw = jsDoc?.tags.get(tag);
          if (raw === undefined) continue;
          uncarriedContracts.push({
            location,
            kind:
              ts.isGetAccessor(node) || ts.isSetAccessor(node)
                ? "getter-setter"
                : "anonymous-default-export",
            tag,
            raw,
            configKey: id,
          });
        }
      }
      functions.push({
        id,
        location,
        declarationStart: declarationStartOf(absoluteRoot, sourceFile, node),
        ...jsDocRangeOf(absoluteRoot, sourceFile, node),
        ...(ts.isClassDeclaration(node) ? { implicitConstructor: true as const } : {}),
        ...(configOnly ? { configOnly: true as const } : {}),
        jsDoc: configOnly ? undefined : extractJsDoc(node, absoluteRoot),
        calls: collectCalls(node, sourceFile, program, checker, declaredNodeToId, absoluteRoot),
      });
    }
    const runtimeWrappers = collectRuntimeWrappers(
      sourceFile,
      checker,
      declaredNodeToId,
      absoluteRoot,
    );
    if (functions.length > 0 || runtimeWrappers.length > 0) {
      files.push({
        filePath: relativePath(absoluteRoot, sourceFile),
        functions,
        runtimeWrappers,
      });
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
  /**
   * A class's *construction*, indexed under the declaration path
   * `Class.constructor`. Two node shapes stand for it: the
   * `ConstructorDeclaration` when the class writes one, and the
   * `ClassDeclaration` itself when it does not (an implicit constructor
   * still runs the property initializers and the base constructor, so it
   * still has effects to attribute). Exactly one of the two is indexed per
   * class, so a class never yields two entries for the same id.
   */
  | ts.ConstructorDeclaration
  | ts.ClassDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression
  | (ts.PropertyDeclaration & { readonly initializer: ts.FunctionExpression | ts.ArrowFunction })
  | (ts.VariableDeclaration & { readonly initializer: ts.FunctionExpression | ts.ArrowFunction })
  | (ts.PropertyAssignment & { readonly initializer: ts.FunctionExpression | ts.ArrowFunction });

/**
 * Walk a source file collecting function declarations, class methods,
 * variable-declared function/arrow expressions, and the identifier-named
 * members of a module-scope `const` object literal — each paired with its
 * "."-joined declaration path (DESIGN.md §5.3: "A symbol ID's declaration
 * path is joined with `"."`"). Anonymous functions and functions nested
 * inside another function's body are not extracted — nested closures' calls
 * are still walked and attributed to their enclosing named declaration.
 */
function collectFunctionLikeDeclarations(
  sourceFile: ts.SourceFile,
): ReadonlyArray<readonly [FunctionLikeDeclaration, readonly string[]]> {
  const results: Array<[FunctionLikeDeclaration, readonly string[]]> = [];

  function visitTop(node: ts.Node, containerPath: readonly string[]): void {
    // `export default function () {}` / `export default () => {}`: no name,
    // but exactly one such declaration can exist per file, so `#default` is
    // as stable a path as any identifier (DESIGN.md §4.1 (a)). Indexed at the
    // top level only — a default export is not nestable.
    if (containerPath.length === 0) {
      const anonymousDefault = anonymousDefaultExport(node);
      if (anonymousDefault) {
        results.push([anonymousDefault, [DEFAULT_EXPORT_PATH_SEGMENT]]);
        return;
      }
    }
    // A function declaration with no body declares a signature, not code: an
    // overload signature, or an ambient `declare function` written in a `.ts`
    // file. Indexing it would give the overload set's several declarations one
    // shared declaration path — and `ExtractedFile.functions` requires ids to
    // be unique, because `propagate`'s fixed point does not terminate without
    // it. It is counted as `bodyless-declaration` instead, and a contract
    // written on it is reported (AMB-E003) rather than silently attributed to
    // a declaration Ambit does not model. Same rule the constructor branch
    // below already applies.
    if (ts.isFunctionDeclaration(node) && node.name) {
      if (!node.body) return;
      const declPath = [...containerPath, node.name.text];
      results.push([node, declPath]);
      return; // do not descend into nested function declarations separately
    }
    if (ts.isClassDeclaration(node) && node.name) {
      const classPath = [...containerPath, node.name.text];
      for (const member of node.members) {
        // `member.body` for the same reason the function-declaration branch
        // above requires it: a method's overload signatures and an `abstract`
        // member declare a signature and no code.
        if (
          ts.isMethodDeclaration(member) &&
          member.body &&
          member.name &&
          ts.isIdentifier(member.name)
        ) {
          results.push([member, [...classPath, memberSegment(member, member.name.text)]]);
        }
        // `handle = async (req) => { … }` is a method written as a property.
        // It must be indexed in its own right, or its body would be
        // attributed to the constructor — construction creates the closure,
        // it does not run it, and a class of arrow-shaped request handlers
        // would make every `new Controller()` look like it hit the network.
        if (isFunctionValuedProperty(member)) {
          results.push([member, [...classPath, memberSegment(member, member.name.text)]]);
        }
        // An accessor's body runs like any other method's, so it propagates
        // like one; it is indexed under `get x` / `set x` because `get` and
        // `set` share a name and a plain `x` could not tell them apart
        // (DESIGN.md §4.1 (a)). A JSDoc tag written on it is still inert —
        // see `configOnlyPath`. A static accessor takes both markers:
        // `static get x`.
        if (
          (ts.isGetAccessor(member) || ts.isSetAccessor(member)) &&
          member.name &&
          ts.isIdentifier(member.name)
        ) {
          results.push([
            member,
            [...classPath, memberSegment(member, accessorSegment(member, member.name.text))],
          ]);
        }
      }
      // `new C(...)` has to have somewhere to propagate *from*, or a
      // constructor that opens a socket is invisible rather than `unknown`
      // (DESIGN.md §3.4). The explicit constructor is indexed when the class
      // writes one; otherwise the class node stands in for the implicit one,
      // which still runs property initializers and the base constructor.
      // Overload signatures carry no body, so the implementation is the one
      // indexed.
      const explicitConstructor = node.members.find(
        (member): member is ts.ConstructorDeclaration =>
          ts.isConstructorDeclaration(member) && member.body !== undefined,
      );
      results.push([explicitConstructor ?? node, [...classPath, CONSTRUCTOR_PATH_SEGMENT]]);
      return;
    }
    // A namespace is a container with a name, so its members hang off that
    // name in the declaration path (`sql.param`), exactly as a class's or an
    // object literal's do. Descending with the path unchanged would give
    // `namespace sql { export function param() {} }` the same path as a
    // top-level `param` in the same file — two functions under one id, which
    // §4.1 states as the one-to-one rule and `propagate` needs to terminate.
    // Observed on `drizzle-orm`'s `src/sql/sql.ts`, which has both.
    // A string-named `declare module "x"` is not a namespace and names
    // nothing here: its members are ambient and carry no body.
    if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
      const namespacePath = [...containerPath, node.name.text];
      ts.forEachChild(node, (child) => visitTop(child, namespacePath));
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
        if (ts.isGetAccessor(member) || ts.isSetAccessor(member)) {
          results.push([member, [...objectPath, accessorSegment(member, member.name.text)]]);
        } else if (ts.isMethodDeclaration(member)) {
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
      const jsDoc = extractJsDoc(decl, absoluteRoot);
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
    // A contract written on a `class` is inert: the class's construction is
    // indexed, but `extractJsDoc` refuses to read a class's own comment as
    // its implicit constructor's contract. Reported for the same reason
    // AMB-E003 reports every other inert declaration, and not counted in
    // `skippedFunctions`, which counts function-like nodes.
    if (ts.isClassDeclaration(node)) {
      const tags = ts.getJSDocTags(node);
      for (const tag of tags) {
        if (!(CONTRACT_TAGS as readonly string[]).includes(tag.tagName.text)) continue;
        uncarried.push({
          location: locationOf(absoluteRoot, sourceFile, node.name ?? node),
          kind: "class-declaration",
          tag: tag.tagName.text,
          raw: jsDocTagText(tag),
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
const CONTRACT_TAGS = ["effects", "capabilities", "budget", "entrypoint", "boundary"] as const;

/**
 * The declaration-path segment a class's construction is indexed under
 * (`src/db.ts#Client.constructor`). `constructor` cannot collide with a
 * method of the same name: `constructor(){}` in a class body *is* the
 * constructor, and a method named `constructor` is not expressible.
 */
const CONSTRUCTOR_PATH_SEGMENT = "constructor";

/** The declaration-path segment an anonymous `export default` is indexed under (DESIGN.md §4.1 (a)). */
const DEFAULT_EXPORT_PATH_SEGMENT = "default";

/**
 * `static run` — a `static` member's segment carries the marker, for exactly
 * the reason an accessor's carries `get` / `set` (DESIGN.md §4.1 (a)): a class
 * may declare `run()` and `static run()` at once, and a plain `run` cannot tell
 * them apart. They are two functions with two bodies, so one declaration path
 * for both breaks the one-to-one rule §4.1 states as "a termination
 * requirement as well as a notation" — `propagate` then has two summaries for
 * one key, overwrites one with the other every pass, and never converges.
 * Measured on a third-party backend, with an 11-line reproduction, in
 * `docs/measurements/2026-09-11-third-third-party-validation-outline.md`.
 *
 * The marker is unconditional rather than applied only where a collision
 * exists: a conditional one would change a static method's id the moment an
 * instance method of the same name was added, which is a rename of a symbol
 * nobody touched.
 *
 * A static accessor takes both markers, in the order they are written in the
 * source: `static get total`.
 */
function memberSegment(member: ts.ClassElement, segment: string): string {
  const modifiers = ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : [];
  const isStatic = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
  return isStatic ? `${STATIC_PATH_MARKER}${segment}` : segment;
}

/** `static ` — see {@link memberSegment}. */
const STATIC_PATH_MARKER = "static ";

/** `get total` / `set total` — the accessor's kind is part of the segment (DESIGN.md §4.1 (a)). */
function accessorSegment(
  node: ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
  name: string,
): string {
  return `${ts.isGetAccessor(node) ? "get" : "set"} ${name}`;
}

/**
 * The function an `export default` with no name introduces, or `undefined`.
 *
 * Covers both spellings: `export default function () {}` (a nameless
 * `FunctionDeclaration`) and `export default () => {}` / `export default
 * function () {}` as an expression (an `ExportAssignment`). A *named* default
 * export is not this case — it already has an identifier path.
 */
function anonymousDefaultExport(node: ts.Node): FunctionLikeDeclaration | undefined {
  if (ts.isFunctionDeclaration(node) && !node.name && isDefaultExport(node)) return node;
  if (ts.isExportAssignment(node) && !node.isExportEquals) {
    const expression = node.expression;
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      if (!ts.isFunctionExpression(expression) || !expression.name) return expression;
    }
  }
  return undefined;
}

/**
 * True for the declaration paths only `ambit.config.ts` can name: an accessor
 * and an anonymous default export (DESIGN.md §4.1 (a)).
 *
 * These nodes propagate like any other function, but a contract *comment* on
 * them is not adopted — §4.1 (a) keeps the config namespace a superset of the
 * JSDoc one, and §12 records the asymmetry that leaves. Derived from the path
 * rather than tracked in a side table so that the rule has exactly one
 * spelling.
 */
function configOnlyPath(declPath: readonly string[]): boolean {
  if (declPath.length === 1 && declPath[0] === DEFAULT_EXPORT_PATH_SEGMENT) return true;
  const written = declPath[declPath.length - 1] ?? "";
  const last = written.startsWith(STATIC_PATH_MARKER)
    ? written.slice(STATIC_PATH_MARKER.length)
    : written;
  return last.startsWith("get ") || last.startsWith("set ");
}

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
    (ts.isVariableDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.initializer === node &&
    indexed.has(parent)
  );
}

function classifySkipped(node: ts.FunctionLikeDeclaration): SkippedFunctionKind {
  // Checked before the shape-based kinds below: an overload signature is
  // syntactically a plain function or method declaration, so nothing else
  // here would distinguish it from one that was skipped for a different
  // reason.
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node)) &&
    !node.body
  ) {
    return "bodyless-declaration";
  }
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
 * recognized so the two forms are never classified differently.
 *
 * This runs only on members `collectFunctionLikeDeclarations` did not index,
 * so the kind it feeds is deliberately narrower than its name: what reaches it
 * are the members `indexableObjectLiteral` rules out.
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

/**
 * Where the declaration's own text starts, excluding leading JSDoc and other
 * trivia — the insertion point for a new contract comment.
 *
 * A `const f = () => {}` indexes the `VariableDeclaration`, whose start is
 * after the `const`; the statement is what a comment goes above.
 */
function declarationStartOf(
  absoluteRoot: string,
  sourceFile: ts.SourceFile,
  decl: FunctionLikeDeclaration,
): SourceLocation {
  const node: ts.Node = ts.isVariableDeclaration(decl) ? (decl.parent.parent ?? decl) : decl;
  const start = node.getStart(sourceFile, /* includeJsDocComment */ false);
  const position = sourceFile.getLineAndCharacterOfPosition(start);
  return {
    file: relativePath(absoluteRoot, sourceFile),
    line: position.line + 1,
    col: position.character + 1,
    endLine: position.line + 1,
    endCol: position.character + 1,
  };
}

/**
 * The one JSDoc block attached to `decl`, if there is exactly one. Read from
 * the comment nodes rather than from the tags, because the block a fix needs
 * to add a tag to is usually one that has no tags yet.
 */
function jsDocRangeOf(
  absoluteRoot: string,
  sourceFile: ts.SourceFile,
  decl: FunctionLikeDeclaration,
): { jsDocRange?: SourceLocation } {
  const target: ts.Node = ts.isVariableDeclaration(decl) ? (decl.parent.parent ?? decl) : decl;
  const blocks = ts.getJSDocCommentsAndTags(target).filter(ts.isJSDoc);
  // More than one block above the same declaration has no single right place
  // to add to; the fix falls back to a new block of its own.
  if (blocks.length !== 1) return {};
  const block = blocks[0];
  if (!block || block.getSourceFile() !== sourceFile) return {};
  return { jsDocRange: locationOf(absoluteRoot, sourceFile, block) };
}

function nameOrNode(decl: FunctionLikeDeclaration): ts.Node {
  if (ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)) return decl.name;
  // An arrow function has no name node at all; an anonymous default export is
  // reported at the expression itself.
  if (ts.isArrowFunction(decl)) return decl;
  return decl.name ?? decl;
}

/**
 * The node(s) whose calls belong to `decl`.
 *
 * More than one for a class's construction: an explicit constructor's body
 * runs *alongside* the class's property initializers and its parameter
 * defaults, and all three are effects of the same `new C(...)`. Attributing
 * them to one entry (`Class.constructor`) is what lets a caller propagate
 * from a single symbol.
 */
function bodiesOf(decl: FunctionLikeDeclaration): readonly ts.Node[] {
  if (
    ts.isVariableDeclaration(decl) ||
    ts.isPropertyAssignment(decl) ||
    ts.isPropertyDeclaration(decl)
  ) {
    return decl.initializer ? [decl.initializer] : [];
  }
  if (ts.isClassDeclaration(decl)) return propertyInitializersOf(decl);
  if (ts.isConstructorDeclaration(decl)) {
    const classBody = ts.isClassLike(decl.parent) ? propertyInitializersOf(decl.parent) : [];
    const parameterDefaults = decl.parameters
      .map((parameter) => parameter.initializer)
      .filter((initializer): initializer is ts.Expression => initializer !== undefined);
    return [...(decl.body ? [decl.body] : []), ...parameterDefaults, ...classBody];
  }
  return decl.body ? [decl.body] : [];
}

/**
 * The property initializers that actually run when the class is constructed.
 *
 * A property holding a function *value* is excluded: constructing the class
 * creates the closure, it does not call it. Those bodies belong to the
 * property's own entry (`isFunctionValuedProperty`), or — when the name has no
 * stable declaration path — to nothing, where `collectSkippedFunctions`
 * counts them, as it did before constructions were indexed at all.
 */
function propertyInitializersOf(node: ts.ClassLikeDeclaration): readonly ts.Node[] {
  return node.members
    .filter(ts.isPropertyDeclaration)
    .map((member) => member.initializer)
    .filter((initializer): initializer is ts.Expression => initializer !== undefined)
    .filter(
      (initializer) => !ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer),
    );
}

/** `name = () => {…}` / `name = function () {…}` on a class: a method written as a property. */
function isFunctionValuedProperty(member: ts.ClassElement): member is ts.PropertyDeclaration & {
  readonly name: ts.Identifier;
  readonly initializer: ts.FunctionExpression | ts.ArrowFunction;
} {
  return (
    ts.isPropertyDeclaration(member) &&
    ts.isIdentifier(member.name) &&
    member.initializer !== undefined &&
    (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer))
  );
}

// ---- runtime wrappers ---------------------------------------------------

/**
 * The calls that establish an entrypoint context. Matched by module specifier
 * and exported name, the same way the stub tables match everything else — a
 * local `as` alias or a re-export chain does not hide one, and a `withAmbit`
 * of one's own from somewhere else is not mistaken for it.
 *
 * The framework adapters are here because DESIGN.md §4.4 chose explicit
 * registration: a literal `spec` beside a same-file handler *is* that
 * handler's `@capabilities` and `@budget` (§4.4, "Removing the double
 * declaration"), so a registration this pass cannot see would take the
 * declaration with it — and where a project does write the JSDoc tag as well,
 * the agreement check (`AMB-E010` / `AMB-E011`) has to reach the registration
 * or the duplication would go uncompared. All three take `(spec, handler, …)`
 * in the same two positions, which is what makes one extraction serve them
 * all; an adapter that reordered them would silently stop being read.
 */
const RUNTIME_WRAPPER_NAMES: ReadonlyMap<string, string> = new Map([
  ["ambit-ts/runtime.withAmbit", "withAmbit"],
  ["ambit-ts/runtime/hono.ambitHandler", "ambitHandler"],
  ["ambit-ts/runtime/next.ambitRoute", "ambitRoute"],
]);

/**
 * Every `withAmbit(spec, handler)` in the file, with what the source fixes
 * about it (see {@link RuntimeWrapper}).
 *
 * A wrapper this pass cannot compare gets an `unmatchedReason` rather than
 * being left out: a wrapper that silently produced no record would read as
 * "checked and agreed".
 */
function collectRuntimeWrappers(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  declaredNodeToId: ReadonlyMap<ts.Node, SymbolId>,
  absoluteRoot: string,
): readonly RuntimeWrapper[] {
  const wrappers: RuntimeWrapper[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const wrapper = runtimeWrapperNameOf(checker, node.expression);
      if (wrapper !== undefined) {
        wrappers.push(
          runtimeWrapperOf(node, wrapper, sourceFile, checker, declaredNodeToId, absoluteRoot),
        );
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return wrappers;
}

function runtimeWrapperNameOf(checker: ts.TypeChecker, callee: ts.Expression): string | undefined {
  const qualified = importedQualifiedNameOf(checker, callee);
  return qualified === undefined ? undefined : RUNTIME_WRAPPER_NAMES.get(qualified);
}

function runtimeWrapperOf(
  node: ts.CallExpression,
  wrapper: string,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  declaredNodeToId: ReadonlyMap<ts.Node, SymbolId>,
  absoluteRoot: string,
): RuntimeWrapper {
  const location = locationOf(absoluteRoot, sourceFile, node);
  const capabilities = literalCapabilityListOf(node.arguments[0]);
  const budget = literalBudgetOf(node.arguments[0]);
  const handler = sameFileHandlerOf(node.arguments[1], sourceFile, checker, declaredNodeToId);

  // Both halves are carried whatever either one turned out to be. A spec that
  // builds its capability list at runtime but writes its budget as a literal
  // still has a budget worth comparing, and vice versa: collapsing the wrapper
  // to one "not compared" the moment either half is dynamic would drop a check
  // the source does support.
  const halves = {
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(budget === undefined ? {} : { budget }),
  };
  if (handler === undefined) {
    return { location, wrapper, ...halves, unmatchedReason: "handler-not-in-this-file" };
  }
  return { location, wrapper, ...halves, handler };
}

/**
 * The spec's `capabilities` as written, or `undefined` when the source does not
 * fix it — the spec is not an object literal, the array is not a literal, or an
 * element is not a string literal.
 *
 * A spec with no `capabilities` key yields `[]`: that is a grant of nothing,
 * which the handler's JSDoc can agree or disagree with, not an absence of
 * information.
 */
function literalCapabilityListOf(spec: ts.Expression | undefined): readonly string[] | undefined {
  if (!spec) return undefined;
  const literal = unwrapTypeOnlyExpression(spec);
  if (!ts.isObjectLiteralExpression(literal)) return undefined;
  if (literal.properties.some(ts.isSpreadAssignment)) return undefined;

  const property = literal.properties.find(
    (member): member is ts.PropertyAssignment =>
      ts.isPropertyAssignment(member) &&
      ts.isIdentifier(member.name) &&
      member.name.text === "capabilities",
  );
  if (!property) return [];

  const array = unwrapTypeOnlyExpression(property.initializer);
  if (!ts.isArrayLiteralExpression(array)) return undefined;

  const capabilities: string[] = [];
  for (const element of array.elements) {
    const value = unwrapTypeOnlyExpression(element);
    if (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value)) return undefined;
    capabilities.push(value.text);
  }
  return capabilities;
}

/**
 * The spec's `budget` as written, or `undefined` when the source does not fix
 * it — the spec is not an object literal, the `budget` value is not an object
 * literal, a key is not one of §4.5's four, or a value is not a literal.
 *
 * A spec with no `budget` key yields `{ kind: "absent" }`, on the same
 * reasoning as an absent `capabilities` key: writing no budget is a statement
 * the handler's JSDoc can contradict, not an absence of information.
 */
function literalBudgetOf(spec: ts.Expression | undefined): WrapperBudget | undefined {
  if (!spec) return undefined;
  const literal = unwrapTypeOnlyExpression(spec);
  if (!ts.isObjectLiteralExpression(literal)) return undefined;
  if (literal.properties.some(ts.isSpreadAssignment)) return undefined;

  const property = literal.properties.find(
    (member): member is ts.PropertyAssignment =>
      ts.isPropertyAssignment(member) &&
      ts.isIdentifier(member.name) &&
      member.name.text === "budget",
  );
  if (!property) return { kind: "absent" };

  const object = unwrapTypeOnlyExpression(property.initializer);
  if (!ts.isObjectLiteralExpression(object)) return undefined;
  if (object.properties.some(ts.isSpreadAssignment)) return undefined;

  let timeMs: number | undefined;
  let costUsd: number | undefined;
  let llmCalls: number | undefined;
  let onExceed: OnExceed | undefined;

  for (const member of object.properties) {
    if (!ts.isPropertyAssignment(member) || !ts.isIdentifier(member.name)) return undefined;
    const value = unwrapTypeOnlyExpression(member.initializer);
    if (member.name.text === "onExceed") {
      if (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value))
        return undefined;
      if (!isOnExceed(value.text)) return undefined;
      onExceed = value.text;
      continue;
    }
    const numeric = numericLiteralOf(value);
    if (numeric === undefined) return undefined;
    if (member.name.text === "timeMs") timeMs = numeric;
    else if (member.name.text === "costUsd") costUsd = numeric;
    else if (member.name.text === "llmCalls") llmCalls = numeric;
    // A key outside §4.5's four is not a budget this comparison understands.
    else return undefined;
  }

  return {
    kind: "literal",
    ...(timeMs === undefined ? {} : { timeMs }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(llmCalls === undefined ? {} : { llmCalls }),
    ...(onExceed === undefined ? {} : { onExceed }),
  };
}

/** A numeric literal, including a negated one — `-1` is a prefix expression, not a literal. */
function numericLiteralOf(node: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const operand = unwrapTypeOnlyExpression(node.operand);
    if (ts.isNumericLiteral(operand)) return -Number(operand.text);
  }
  return undefined;
}

/**
 * The handler's `SymbolId`, when it is an identifier naming a declaration this
 * file also declares and the analysis extracted.
 *
 * Same file on purpose. The comparison this feeds is between two statements a
 * reader sees together — the JSDoc above the handler and the spec beside it.
 * A handler declared elsewhere is reported as uncompared (`AMB-W004`), not
 * silently accepted; whether the same equality is the right test across files
 * is part of §12's "Mapping contracts to handlers", which this does not
 * settle.
 */
function sameFileHandlerOf(
  handler: ts.Expression | undefined,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  declaredNodeToId: ReadonlyMap<ts.Node, SymbolId>,
): SymbolId | undefined {
  if (!handler || !ts.isIdentifier(handler)) return undefined;
  const symbol = checker.getSymbolAtLocation(handler);
  if (!symbol) return undefined;
  const resolved =
    (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
  const declaration = resolved.declarations?.[0];
  if (!declaration || declaration.getSourceFile() !== sourceFile) return undefined;
  return declaredNodeToId.get(declaration);
}

// ---- JSDoc extraction ---------------------------------------------------

function extractJsDoc(decl: FunctionLikeDeclaration, absoluteRoot: string): RawJsDoc | undefined {
  // A `ClassDeclaration` is only ever indexed as a stand-in for an *implicit*
  // constructor (`collectFunctionLikeDeclarations`). That constructor has no
  // declaration site, so the class's own JSDoc must not be read as its
  // contract: `/** @effects pure */ class C {}` documents the class, and
  // treating it as a verified constructor contract would manufacture a
  // guarantee out of a comment about something else.
  if (ts.isClassDeclaration(decl)) return undefined;
  const target = ts.isVariableDeclaration(decl) ? (decl.parent.parent ?? decl) : decl;
  const tags = ts.getJSDocTags(target);
  if (tags.length === 0) return undefined;

  const map = new Map<string, string>();
  const locations = new Map<string, SourceLocation>();
  const sourceFile = target.getSourceFile();
  for (const tag of tags) {
    map.set(tag.tagName.text, jsDocTagText(tag));
    locations.set(tag.tagName.text, jsDocTagLocation(absoluteRoot, sourceFile, tag));
  }
  return { tags: map, tagLocations: locations };
}

/**
 * A JSDoc tag's own span, with trailing trivia trimmed.
 *
 * `tag.getEnd()` runs to where the next tag or the closing `*/ ` begins, so it
 * swallows the whitespace after the tag text. A fix that replaced that span
 * would produce `; /** @effects network*​/`. The patch has to be one a person
 * would have written (DESIGN.md §5.3), so the range stops at the last
 * non-whitespace character.
 */
function jsDocTagLocation(
  absoluteRoot: string,
  sourceFile: ts.SourceFile,
  tag: ts.JSDocTag,
): SourceLocation {
  const start = tag.getStart(sourceFile);
  const text = sourceFile.text;
  let end = tag.getEnd();
  while (end > start && /\s/.test(text[end - 1] ?? "")) end--;

  const startPosition = sourceFile.getLineAndCharacterOfPosition(start);
  const endPosition = sourceFile.getLineAndCharacterOfPosition(end);
  return {
    file: relativePath(absoluteRoot, sourceFile),
    line: startPosition.line + 1,
    col: startPosition.character + 1,
    endLine: endPosition.line + 1,
    endCol: endPosition.character + 1,
  };
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
  const bodies = bodiesOf(decl);
  if (bodies.length === 0 && !ts.isClassDeclaration(decl)) return [];

  const calls: CallSite[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      calls.push(
        classifyCall(node, sourceFile, program, checker, declaredNodeToId, absoluteRoot, decl),
      );
    } else if (ts.isNewExpression(node)) {
      calls.push(
        classifyNewExpression(node, sourceFile, program, checker, declaredNodeToId, absoluteRoot),
      );
    } else {
      // Assignments are not calls, but they mutate exactly the same way a
      // mutating builtin method does (DESIGN.md §4.2, "Local mutation and
      // `pure`"), so they enter the same array.
      const mutation = classifyAssignment(node, sourceFile, checker, absoluteRoot, decl);
      if (mutation) calls.push(mutation);
    }
    ts.forEachChild(node, visit);
  }

  for (const body of bodies) {
    // A property initializer / parameter default *is itself* an expression
    // that may be a call, unlike a block body — visit it, don't only descend.
    if (ts.isBlock(body)) ts.forEachChild(body, visit);
    else visit(body);
  }

  // An implicit constructor still calls its base constructor. There is no
  // `super(...)` node to classify, so the heritage clause stands in for it;
  // without this a `class Derived extends Effectful {}` would report no calls
  // at all (DESIGN.md §3.4).
  if (ts.isClassDeclaration(decl)) {
    const base = baseTypeExpressionOf(decl);
    if (base) {
      calls.push(
        classifyConstruct(base, base, sourceFile, program, checker, declaredNodeToId, absoluteRoot),
      );
    }
  }

  return calls;
}

function enclosingClassOf(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isClassLike(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function baseTypeExpressionOf(node: ts.ClassLikeDeclaration): ts.Expression | undefined {
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    return clause.types[0]?.expression;
  }
  return undefined;
}

/**
 * `new X(...)`. Before this existed the expression was dropped unless it was
 * `new Function`, so a `pure` function that did `new PrismaClient()` reported
 * no call at all — not even `unknown`. DESIGN.md §3.4 forbids exactly that:
 * an unanalyzed path must stay visible, never collapse into "no violation".
 */
function classifyNewExpression(
  node: ts.NewExpression,
  sourceFile: ts.SourceFile,
  program: ts.Program,
  checker: ts.TypeChecker,
  declaredNodeToId: ReadonlyMap<ts.Node, SymbolId>,
  absoluteRoot: string,
): CallSite {
  if (ts.isIdentifier(node.expression) && node.expression.text === "Function") {
    return {
      location: locationOf(absoluteRoot, sourceFile, node),
      unresolvedReason: "new-function",
    };
  }
  return classifyConstruct(
    node.expression,
    node,
    sourceFile,
    program,
    checker,
    declaredNodeToId,
    absoluteRoot,
  );
}

/**
 * Resolve a construction — `new X(...)`, `super(...)`, or the implicit base
 * call of a derived class — to the `Class.constructor` entry it runs, or to a
 * named-but-external constructor the stub tables may know
 * (`src/stubs/constructors.ts`).
 *
 * `classExpression` is the expression naming the class; `site` is the node the
 * diagnostic should point at (the whole `new` expression, or the heritage
 * clause for an implicit base call).
 */
function classifyConstruct(
  classExpression: ts.Expression,
  site: ts.Node,
  sourceFile: ts.SourceFile,
  program: ts.Program,
  checker: ts.TypeChecker,
  declaredNodeToId: ReadonlyMap<ts.Node, SymbolId>,
  absoluteRoot: string,
): CallSite {
  const location = locationOf(absoluteRoot, sourceFile, site);

  const symbol = checker.getSymbolAtLocation(classExpression);
  const isAlias = symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0;
  const resolvedSymbol = isAlias ? checker.getAliasedSymbol(symbol) : symbol;
  const declaration = resolvedSymbol?.declarations?.find(ts.isClassLike);

  if (declaration) {
    const resolved = constructorTarget(declaration, declaredNodeToId);
    if (resolved) return { location, resolvedCallee: resolved };
  }

  const declarationSourceFile = declaration?.getSourceFile();
  const ambientReason = declarationSourceFile?.isDeclarationFile
    ? ambientUnresolvedReason(declarationSourceFile, program)
    : undefined;
  const importBindingReason: UnresolvedReason | undefined =
    isAlias && !resolvedSymbol?.declarations ? "import-binding" : undefined;

  const name = qualifiedNameOf(
    checker,
    program,
    classExpression,
    importBindingReason === undefined,
    ambientReason !== "builtin-method",
  );
  if (name) {
    return {
      location,
      calleeQualifiedName: constructorStubKey(name),
      unresolvedReason: importBindingReason ?? ambientReason,
      // `new Promise(namedExecutor)` runs `namedExecutor` immediately; the
      // pure-constructor allowlist must not cover a body this walk never
      // visited (DESIGN.md §4.2 rule 4). A named executor that *is* an
      // extracted function is a `callbackTargets` edge instead — the body is
      // right there to propagate from.
      ...(ts.isNewExpression(site) ? callableArgumentFields(site, checker, declaredNodeToId) : {}),
      // `new Date()` reads the clock; `new Date(2020, 0, 1)` does not
      // (DESIGN.md §4.2 lists the clock under `env`).
      constructedWithoutArguments:
        (ts.isNewExpression(site) ? (site.arguments?.length ?? 0) === 0 : true) || undefined,
    };
  }

  return {
    location,
    unresolvedReason: importBindingReason ?? ambientReason ?? "unresolved-symbol",
  };
}

/**
 * Whether `declaration` is a function-valued node written inside one of the
 * bodies `collectCalls` walks for `enclosing` — the exact condition under
 * which its calls are already part of `enclosing`'s own call list.
 *
 * Matched against {@link bodiesOf} rather than against `enclosing` itself, so
 * the two can never drift apart: a body `collectCalls` does not walk (a class's
 * function-valued property, which has its own entry) must not be reported as
 * already accounted for.
 */
function isWalkedIntoSummaryOf(
  declaration: ts.Declaration,
  enclosing: FunctionLikeDeclaration,
): boolean {
  if (declaration === enclosing) return false;
  if (!isFunctionValuedDeclaration(declaration)) return false;
  const bodies = bodiesOf(enclosing);
  if (bodies.length === 0) return false;
  for (let current: ts.Node | undefined = declaration; current; current = current.parent) {
    if (bodies.includes(current)) return true;
    if (ts.isSourceFile(current)) return false;
  }
  return false;
}

/** A declaration whose value is a function with a body, in any of the shapes that can hold one. */
function isFunctionValuedDeclaration(declaration: ts.Declaration): boolean {
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    ts.isConstructorDeclaration(declaration) ||
    ts.isGetAccessor(declaration) ||
    ts.isSetAccessor(declaration)
  ) {
    return declaration.body !== undefined;
  }
  if (
    ts.isVariableDeclaration(declaration) ||
    ts.isPropertyAssignment(declaration) ||
    ts.isPropertyDeclaration(declaration)
  ) {
    const initializer = declaration.initializer;
    return (
      initializer !== undefined &&
      (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
    );
  }
  return ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration);
}

/** The indexed `Class.constructor` entry for a class: its explicit constructor, or the class node standing in for the implicit one. */
function constructorTarget(
  declaration: ts.ClassLikeDeclaration,
  declaredNodeToId: ReadonlyMap<ts.Node, SymbolId>,
): SymbolId | undefined {
  for (const member of declaration.members) {
    if (!ts.isConstructorDeclaration(member) || !member.body) continue;
    const id = declaredNodeToId.get(member);
    if (id) return id;
  }
  return declaredNodeToId.get(declaration);
}

/**
 * `f!` → `f`, through any number of assertions and the parentheses that may
 * wrap them. A non-null assertion is a type-level statement with no runtime
 * meaning and no effect on which declaration the callee names.
 */
function unwrapNonNullAssertions(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

/**
 * The declaration of `symbol` that carries code, or its first declaration when
 * none does.
 *
 * An overloaded function is one symbol with several declarations: the
 * signatures, then the implementation. Only the implementation runs, and only
 * it is extracted (`collectFunctionLikeDeclarations`), so a call that stopped
 * at `declarations[0]` would reach a node with no id and no body — and a
 * body-less node infers an empty effect set, which reads as `pure` however the
 * implementation behaves. DESIGN.md §3.2 names this case: "With overloads
 * the selected declaration may have no body".
 *
 * Returning the first declaration when nothing has a body is deliberate: the
 * caller needs a node to classify (ambient vs. project, parameter vs.
 * function), and an ambient overload set legitimately has no implementation.
 */
function implementationDeclarationOf(symbol: ts.Symbol | undefined): ts.Declaration | undefined {
  const declarations = symbol?.declarations;
  if (!declarations || declarations.length === 0) return undefined;
  if (declarations.length === 1) return declarations[0];
  for (const declaration of declarations) {
    if (
      (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) &&
      declaration.body
    ) {
      return declaration;
    }
  }
  return declarations[0];
}

function classifyCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  program: ts.Program,
  checker: ts.TypeChecker,
  declaredNodeToId: ReadonlyMap<ts.Node, SymbolId>,
  absoluteRoot: string,
  enclosing: FunctionLikeDeclaration,
): CallSite {
  const location = locationOf(absoluteRoot, sourceFile, node);

  // Dynamic import: import(...)
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return { location, unresolvedReason: "dynamic-import" };
  }

  // `f!()` is a call to `f`. The non-null assertion narrows the *type* and
  // leaves the declaration exactly where it was, so it must not cost the call
  // its resolution — docs/open-questions.md requires `as any` and `!` to be told apart,
  // and they differ in precisely this: a cast to `any` destroys the
  // declaration, an assertion keeps it. Only the assertion is unwrapped here;
  // `(f as any)()` continues to fall through to `any-typed`.
  const callee = unwrapNonNullAssertions(node.expression);

  // eval(...)
  if (ts.isIdentifier(callee) && callee.text === "eval") {
    return { location, unresolvedReason: "eval" };
  }

  // `super(...)` runs the base class's constructor. `getSymbolAtLocation` on
  // the `super` keyword does not name it, so the base is taken from the
  // enclosing class's heritage clause instead.
  if (callee.kind === ts.SyntaxKind.SuperKeyword) {
    const enclosingClass = enclosingClassOf(node);
    const base = enclosingClass ? baseTypeExpressionOf(enclosingClass) : undefined;
    if (!base) return { location, unresolvedReason: "unresolved-symbol" };
    return classifyConstruct(
      base,
      node,
      sourceFile,
      program,
      checker,
      declaredNodeToId,
      absoluteRoot,
    );
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
  // An overload set is several declarations under one symbol, and only the
  // implementation has code. `declarations[0]` is the first *signature*, whose
  // empty body would infer an empty effect set — so the implementation is
  // preferred when there is one, and `declarations[0]` remains the answer when
  // there is not (an ambient overload set, which falls to
  // `overload-without-body` below). Which declaration this is decides both the
  // resolved target and every classification derived from its source file.
  const declaration = implementationDeclarationOf(resolvedSymbol);

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
  const receiverMemberId =
    objectLiteralReceiverTarget(callee, checker, declaredNodeToId) ??
    constructedInstanceMemberTarget(callee, checker, declaredNodeToId);
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

  // A callee written *inside* the declaration being summarized — a nested
  // `function`, or a `const` holding an arrow — has no id of its own (nothing
  // inside a function body is indexed), but its body is not missing from this
  // summary either: `collectCalls` walked straight through it, so every call
  // it makes is already recorded here. The call site therefore adds nothing,
  // and reporting it `unknown` would claim the analysis lost a body it in fact
  // read (DESIGN.md §3.4 cuts the other way too — an *analyzed* path must not
  // read as an unanalyzed one).
  //
  // Deliberately not the same thing as extracting the nested function: it
  // gets no id, no contract, and no summary of its own. Whether it should is
  // docs/open-questions.md's "Nested function declarations and the locality rule".
  if (declaration && !isAmbientDeclaration && isWalkedIntoSummaryOf(declaration, enclosing)) {
    return { location, inlinedCallee: true };
  }

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
  // `set.has(...)`) vs. a third-party package's `.d.ts` (docs/open-questions.md).
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

  // The factory origin is withheld when the method being called is the
  // compiler's own — a package interface may extend a default-lib type, and a
  // name here would take the call off the `pureBuiltinName` path below, which
  // is the only path that can prove it effect-free (DESIGN.md §4.2).
  const qualifiedName = qualifiedNameOf(
    checker,
    program,
    callee,
    importBindingReason === undefined,
    ambientReason !== "builtin-method",
  );
  if (qualifiedName) {
    return {
      location,
      calleeQualifiedName: qualifiedName,
      literalArguments: literalArgumentsOf(node),
      unresolvedReason: fallbackReason,
      // Carried for the same reason it is carried on `pureBuiltinName`: a
      // name in this namespace can also be allowlisted as pure (a bare global
      // like `Number(x)`), and an opaque callable argument must refuse that
      // verdict (DESIGN.md §4.2 rule 4). It says nothing about a stub match,
      // which is decided by the name and the literal arguments alone.
      ...callableArgumentFields(node, checker, declaredNodeToId),
    };
  }

  // qualifiedNameOf only names a bare identifier or a property access on an
  // import binding — a builtin method reached through a local value
  // (`set.has(...)`) has neither, so it falls through to here with no
  // textual name. The checker can still name the symbol directly; that name
  // is checked against src/stubs/pure-builtins.ts's allowlist (a separate
  // namespace — see CallSite.pureBuiltinName), not against calleeQualifiedName.
  if (ambientReason === "builtin-method" && resolvedSymbol) {
    const builtinName = checker.getFullyQualifiedName(resolvedSymbol);
    if (builtinName) {
      const callable = callableArgumentsOf(node, checker, declaredNodeToId);
      const callbackByReference = callable.opaque || undefined;
      const callbackTargets =
        callable.targets.length > 0 ? { callbackTargets: callable.targets } : {};
      // A name that writes into its first argument (`Object.assign(target,
      // …)`) is a mutation of *that* value. DESIGN.md §4.2's locality rule
      // reads "the root of the mutation target", which here is the argument,
      // not the `Object` global the call is spelled through.
      const mutatedArgument = isFirstArgumentMutator(builtinName) ? node.arguments[0] : undefined;
      if (mutatedArgument) {
        const escaping = !isLocallyOwnedMutationTarget(mutatedArgument, enclosing, checker);
        return {
          location,
          ...callbackTargets,
          mutation: {
            escaping,
            qualifiedName: builtinName,
            ...(escaping && callbackByReference ? { unknownCallback: true as const } : {}),
          },
        };
      }
      if (isMutatingBuiltin(builtinName) && ts.isPropertyAccessExpression(callee)) {
        const escaping = !isLocallyOwnedMutationTarget(callee.expression, enclosing, checker);
        // A local mutation carries no effect, so a callback the walk never
        // enters is the only thing left that could — and that is plain
        // `unknown`, not a mutation site (DESIGN.md §4.2 rule 4).
        if (!escaping && callbackByReference) {
          return {
            location,
            pureBuiltinName: builtinName,
            unresolvedReason: ambientReason,
            callbackByReference,
            ...callbackTargets,
          };
        }
        return {
          location,
          ...callbackTargets,
          mutation: {
            escaping,
            qualifiedName: builtinName,
            ...(escaping && callbackByReference ? { unknownCallback: true as const } : {}),
          },
        };
      }
      return {
        location,
        pureBuiltinName: builtinName,
        unresolvedReason: ambientReason,
        callbackByReference,
        ...callbackTargets,
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
 * The extracted method a receiver bound by `const` to `new C(...)` names, when
 * `C` is a class in this project.
 *
 * DESIGN.md §4.2 rule 7 requires the annotation not to change the answer:
 * "Because it follows the entity rather than the type annotation, `const
 * handlers: H = { read }` and `const handlers = { read }` give the same
 * result", and "Method resolution on class instances rests on the same
 * premise". Without this, only the unannotated form resolved — the checker
 * lands on the class's own member for `const c = new C()`, and on the
 * *annotation's* member signature for `const c: I = new C()`, which no
 * declaration path names.
 *
 * The premise is the one §4.2 rule 7 already states and no wider: `const`
 * fixes the binding, so the value really is that `new`; it does not freeze the
 * properties, so `c.m = other` still defeats it. A receiver that is anything
 * else — a parameter, a `let`, a factory result — yields nothing and stays
 * unresolved.
 *
 * The `extends` chain is walked because an inherited method is the one that
 * runs. An override is found first: members are searched from the derived
 * class outward.
 */
function constructedInstanceMemberTarget(
  callee: ts.Expression,
  checker: ts.TypeChecker,
  declaredNodeToId: ReadonlyMap<ts.Node, SymbolId>,
): SymbolId | undefined {
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) {
    return undefined;
  }
  const receiver = symbolTargetOf(callee.expression, checker);
  const declaration = receiver?.declarations?.[0];
  if (!declaration || !ts.isVariableDeclaration(declaration)) return undefined;
  if ((declaration.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
  const initializer = declaration.initializer
    ? unwrapTypeOnlyExpression(declaration.initializer)
    : undefined;
  if (!initializer || !ts.isNewExpression(initializer)) return undefined;

  const name = callee.name.text;
  const visited = new Set<ts.ClassLikeDeclaration>();
  let current = classDeclarationOf(initializer.expression, checker);
  while (current && !visited.has(current)) {
    visited.add(current);
    for (const member of current.members) {
      if (!member.name || !ts.isIdentifier(member.name) || member.name.text !== name) continue;
      const id = declaredNodeToId.get(member);
      if (id) return id;
    }
    const base = baseTypeExpressionOf(current);
    current = base ? classDeclarationOf(base, checker) : undefined;
  }
  return undefined;
}

/** The class an expression names, following import aliases. */
function classDeclarationOf(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.ClassLikeDeclaration | undefined {
  return symbolTargetOf(expression, checker)?.declarations?.find(ts.isClassLike);
}

/** `getSymbolAtLocation`, with an import alias followed to what it names. */
function symbolTargetOf(expression: ts.Expression, checker: ts.TypeChecker): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol) return undefined;
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

/**
 * The assignment-shaped mutation at `node`, if any (DESIGN.md §4.2, "Local
 * mutation and `pure`"): `a.b = 1`, `a.b += 1`, `a.b++`, `delete a.b`, and a
 * write
 * to a binding declared outside `enclosing`.
 *
 * Reassigning a variable the function itself declared (`let i = 0; i++`) is
 * not a mutation of anything: nothing outside can observe it, and it is not
 * recorded as a site at all.
 */
function classifyAssignment(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  absoluteRoot: string,
  enclosing: FunctionLikeDeclaration,
): CallSite | undefined {
  const target = assignmentTargetOf(node);
  if (!target) return undefined;

  // A destructuring assignment writes to several places at once; one escaping
  // leaf makes the whole statement a `state_write` (DESIGN.md §4.2,
  // "The rule for deciding locality").
  const escaping = assignmentLeavesOf(target).some(
    (leaf) => !isLocalAssignmentLeaf(leaf, enclosing, checker),
  );
  if (!escaping) return undefined;
  return { location: locationOf(absoluteRoot, sourceFile, node), mutation: { escaping: true } };
}

/**
 * Whether writing to one destructuring leaf stays inside `enclosing`. A bare
 * identifier the function declared is its own local; anything else is decided
 * by {@link isLocallyOwnedMutationTarget}.
 */
function isLocalAssignmentLeaf(
  leaf: ts.Expression,
  enclosing: FunctionLikeDeclaration,
  checker: ts.TypeChecker,
): boolean {
  if (ts.isIdentifier(leaf)) {
    const declaration = checker.getSymbolAtLocation(leaf)?.valueDeclaration;
    return declaration !== undefined && isLexicallyInside(declaration, enclosing);
  }
  if (!ts.isPropertyAccessExpression(leaf) && !ts.isElementAccessExpression(leaf)) {
    // Not a shape this analysis can place — over-approximate to escaping.
    return false;
  }
  return isLocallyOwnedMutationTarget(leaf, enclosing, checker);
}

/**
 * The individual places an assignment target writes to. A plain target is
 * itself; a destructuring pattern (`[a.x, b] = xs`, `({ y: o.z } = v)`) is
 * flattened to its leaves, so no write goes unexamined.
 */
function assignmentLeavesOf(target: ts.Expression): readonly ts.Expression[] {
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.flatMap((element) =>
      ts.isOmittedExpression(element) ? [] : assignmentLeavesOf(stripAssignmentDefault(element)),
    );
  }
  if (ts.isObjectLiteralExpression(target)) {
    return target.properties.flatMap((property) => {
      if (ts.isPropertyAssignment(property)) {
        return assignmentLeavesOf(stripAssignmentDefault(property.initializer));
      }
      if (ts.isShorthandPropertyAssignment(property)) return [property.name];
      // A spread target (`{...rest} = v`) writes to whatever follows it.
      if (ts.isSpreadAssignment(property)) return assignmentLeavesOf(property.expression);
      return [];
    });
  }
  if (ts.isSpreadElement(target)) return assignmentLeavesOf(target.expression);
  return [target];
}

/** `a.x = 1` in `[a.x = 1] = xs`: the default value is not part of the target. */
function stripAssignmentDefault(node: ts.Expression): ts.Expression {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ? node.left
    : node;
}

/** The expression a mutating statement writes through, or `undefined` if `node` is not one. */
function assignmentTargetOf(node: ts.Node): ts.Expression | undefined {
  if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
    return node.left;
  }
  if (
    (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return node.operand;
  }
  if (ts.isDeleteExpression(node)) return node.expression;
  return undefined;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment &&
    kind !== ts.SyntaxKind.EqualsGreaterThanToken
  );
}

/**
 * Whether the value `target` writes through was allocated inside `enclosing`
 * — the locality rule of DESIGN.md §4.2, "The rule for deciding locality",
 * deliberately
 * as narrow as §4.2 rule 7 and, like it, not a soundness claim: a fresh value
 * handed to something else before being mutated still reads as local, because
 * Ambit does no alias analysis.
 *
 * Local iff the root of the access chain is a fresh allocation itself, or an
 * identifier bound by `const` inside `enclosing` to a fresh allocation.
 * Everything else — a parameter (its declaration is lexically inside the
 * function but the value is the caller's), `this`, a module-scope or outer
 * binding, `let`/`var`, an unresolvable root — is escaping, over-approximated
 * on purpose.
 */
function isLocallyOwnedMutationTarget(
  target: ts.Expression,
  enclosing: FunctionLikeDeclaration,
  checker: ts.TypeChecker,
): boolean {
  const root = mutationRootOf(target);
  if (isFreshAllocation(root)) return true;
  if (root.kind === ts.SyntaxKind.ThisKeyword) return isThisOfNewOperand(root);
  if (!ts.isIdentifier(root)) return false;

  const declaration = checker.getSymbolAtLocation(root)?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration)) return false;
  if ((ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0) return false;
  if (!declaration.initializer || !isFreshAllocation(declaration.initializer)) return false;
  return isLexicallyInside(declaration, enclosing);
}

/**
 * Whether `this` denotes an object nothing else holds yet: the function it
 * binds to is the direct operand of a `NewExpression` (`new function () {
 * this.x = 1 }`), or it is the constructor of a class with no `extends`
 * clause. Any other `this` (a method's, a callback's, a derived
 * constructor's, one the analysis cannot place) is escaping.
 *
 * The constructor case is not a convenience: with `erasableSyntaxOnly` there
 * are no parameter properties, so `this.x = x` in a constructor is the only
 * way to write a field, and calling it `state_write` would make `pure`
 * unusable on every constructor in the language subset Ambit targets.
 */
function isThisOfNewOperand(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    // Arrow functions do not bind `this`; keep walking out through them.
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) {
      return current.parent !== undefined && ts.isNewExpression(current.parent);
    }
    // A base class's constructor allocated the object it is writing to, and
    // the only way out is its own return. A derived one cannot claim that:
    // `super(...)` ran first and may have handed `this` to something else.
    if (ts.isConstructorDeclaration(current)) {
      return ts.isClassLike(current.parent) && baseTypeExpressionOf(current.parent) === undefined;
    }
    if (ts.isClassLike(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

/** The base of a property/element access chain: `a` in `a.b[0].c`. */
function mutationRootOf(target: ts.Expression): ts.Expression {
  let current: ts.Expression = target;
  for (;;) {
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/** An expression that necessarily produces a value no one else holds yet. */
function isFreshAllocation(node: ts.Node): boolean {
  return (
    ts.isArrayLiteralExpression(node) ||
    ts.isObjectLiteralExpression(node) ||
    ts.isNewExpression(node)
  );
}

function isLexicallyInside(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

/** {@link callableArgumentsOf}, in the optional-field shape a `CallSite` literal spreads. */
function callableArgumentFields(
  node: ts.CallExpression | ts.NewExpression,
  checker: ts.TypeChecker,
  declaredNodeToId: ReadonlyMap<ts.Node, SymbolId>,
): Pick<CallSite, "callbackByReference" | "callbackTargets"> {
  const callable = callableArgumentsOf(node, checker, declaredNodeToId);
  return {
    ...(callable.opaque ? { callbackByReference: true as const } : {}),
    ...(callable.targets.length > 0 ? { callbackTargets: callable.targets } : {}),
  };
}

/**
 * The callable arguments a call passes *by reference*, split by whether the
 * reference can be followed.
 *
 * An inline arrow or function expression is neither: `collectCalls` walks its
 * body and attributes its calls to the enclosing function already.
 *
 * `targets` are the references that name a declaration this project extracted,
 * so DESIGN.md §4.2 rule 4's "inferred from the actual argument at the call
 * site" can be carried out literally. `opaque` is what is left — a callable
 * from a package, a parameter, a `.bind()` result — for which the rule's other
 * half applies: "If it cannot be inferred, `unknown`".
 *
 * An argument counts as callable when it is passed by reference (an
 * identifier, property access, or other expression with call signatures)
 * rather than written inline as `x => ...` / `function (...) {...}`.
 * `collectCalls` only walks into an inline callback's body; a callback passed
 * by reference is invisible to it, so a method taking one (`forEach`, `map`,
 * `some`, ...) cannot be trusted as pure on its own name alone — either the
 * reference resolves to an extracted function, and the effects come from
 * there, or it does not, and the call is `unknown`.
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
function callableArgumentsOf(
  node: ts.CallExpression | ts.NewExpression,
  checker: ts.TypeChecker,
  declaredNodeToId: ReadonlyMap<ts.Node, SymbolId>,
): { readonly opaque: boolean; readonly targets: readonly SymbolId[] } {
  const signature = checker.getResolvedSignature(node);
  const targets: SymbolId[] = [];
  let opaque = false;
  for (const [index, arg] of (node.arguments ?? []).entries()) {
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) continue;
    if (signature && !acceptsCallableArgument(signature, index, checker)) continue;
    const type = checker.getTypeAtLocation(arg);
    const callable =
      (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ||
      type.getCallSignatures().length > 0;
    if (!callable) continue;
    const target = extractedFunctionTarget(arg, checker, declaredNodeToId);
    if (target) targets.push(target);
    else opaque = true;
  }
  return { opaque, targets };
}

/**
 * The `SymbolId` of the extracted function an expression names, when it names
 * one. Follows the same path `classifyCall` follows for a callee — import
 * aliases included — because "the function this expression refers to" is the
 * same question in both places.
 */
function extractedFunctionTarget(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  declaredNodeToId: ReadonlyMap<ts.Node, SymbolId>,
): SymbolId | undefined {
  const expr = unwrapNonNullAssertions(expression);
  if (!ts.isIdentifier(expr) && !ts.isPropertyAccessExpression(expr)) return undefined;
  const symbol = checker.getSymbolAtLocation(expr);
  if (!symbol) return undefined;
  const resolved =
    (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
  const declaration = implementationDeclarationOf(resolved);
  if (!declaration) return undefined;
  return (
    declaredNodeToId.get(declaration) ??
    objectLiteralMemberTarget(declaration, checker, declaredNodeToId)
  );
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

/**
 * Which flavour of ambient declaration a callee resolved to, so an unresolved
 * call says what would fix it: the compiler's own lib (`builtin-method`), an
 * installed package's types (`external-module`), or a `.d.ts` written by the
 * project itself (`ambient-declaration` — a hand-written `declare module`,
 * common in a project that types a dependency locally).
 */
function ambientUnresolvedReason(
  declarationSourceFile: ts.SourceFile,
  program: ts.Program,
): UnresolvedReason | undefined {
  if (program.isSourceFileDefaultLibrary(declarationSourceFile)) return "builtin-method";
  if (program.isSourceFileFromExternalLibrary(declarationSourceFile)) return "external-module";
  return "ambient-declaration";
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
  program: ts.Program,
  expr: ts.Expression,
  aliasResolved: boolean,
  factoryOriginAllowed: boolean,
): string | undefined {
  if (ts.isIdentifier(expr)) {
    if (aliasResolved) {
      const imported = importedQualifiedNameOf(checker, expr);
      if (imported) return imported;
    }
    return expr.text;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    return memberChainQualifiedNameOf(checker, program, expr, factoryOriginAllowed);
  }
  return undefined;
}

/**
 * `<origin>.<property path>` for a property-access expression, where
 * `<origin>` says where the receiver came from and the path is what the source
 * literally wrote after it.
 *
 * Three origins are recognized, each a fact about the project's own source or
 * about a declaration the source imports, never about a local spelling:
 *
 * - a namespace or default import — `node:fs` for `import * as fs from
 *   "node:fs"`, giving `node:fs.readFileSync` (and now `node:fs.promises.readFile`
 *   for a deeper path, which previously had no name at all);
 * - the class a `const` was constructed from — `pg.Pool` for `const pool = new
 *   Pool(...)` with `Pool` imported from `"pg"`, giving `pg.Pool.query` and
 *   `@prisma/client.PrismaClient.user.findMany`;
 * - the type an imported *factory* handed back — `mysql2/promise.Pool` for
 *   `const pool = createPool(...)`, see {@link factoryResultQualifiedNameOf}.
 *
 * Anything else yields `undefined`: a receiver whose origin is a parameter, a
 * `let`, or a project-local class has no module-qualified name that a stub
 * table could honestly key on, and inventing one from the local variable's
 * spelling would make the table match by coincidence.
 */
function memberChainQualifiedNameOf(
  checker: ts.TypeChecker,
  program: ts.Program,
  expr: ts.PropertyAccessExpression,
  factoryOriginAllowed: boolean,
): string | undefined {
  const path: string[] = [];
  let current: ts.Expression = expr;
  while (ts.isPropertyAccessExpression(current)) {
    path.unshift(current.name.text);
    current = current.expression;
  }

  const origin = ts.isIdentifier(current)
    ? (moduleSpecifierOf(checker, current) ??
      constructedClassQualifiedNameOf(checker, current) ??
      (factoryOriginAllowed ? factoryResultQualifiedNameOf(checker, program, current) : undefined))
    : undefined;
  if (origin) return [origin, ...path].join(".");

  return factoryOriginAllowed ? installedTypeQualifiedNameOf(checker, program, expr) : undefined;
}

/**
 * `"<package>.<type name>.<property path>"` for a member chain whose receiver
 * is held by something no binding rule above can follow — a class field, a
 * parameter, or the result of an earlier call in a fluent chain.
 *
 * The three origins above all name the receiver from *where the value came
 * from*, which requires a binding the analysis can see: a module-scope import,
 * a `const` holding `new <ImportedClass>`, a `const` holding an imported
 * factory's result. That covers a client a module constructs for itself and
 * nothing else. Measured on a third-party backend (Unleash, `src/lib`,
 * 3523 functions): its database calls are written through an injected
 * `this.db`, or through a parameter, and not one of them was named — so the
 * bundled `pg`, `mysql2` and Prisma rules could not have fired on any of them
 * either. A client a
 * class is *handed* is the ordinary shape in server code, and DESIGN.md §3.4's
 * rule cuts against leaving it silent.
 *
 * What this rule reads is the receiver's **type**, which is a different fact
 * from the ones above and is kept to what a type can honestly settle:
 *
 * - it names the *package's* API, never a project declaration. Every
 *   declaration of the type must be a class or interface in a `.d.ts` that
 *   came from an installed package ({@link installedPackageNameOf}), so a
 *   project-local interface — Unleash's own `ITagStore`, Ambit's own
 *   `TsBackend` — yields nothing and §4.2 rule 7 still decides those through
 *   the receiver's value;
 * - it is a name, not a verdict, exactly as the three origins above are. A
 *   package no bundled table covers gets its name here and still reports
 *   `unknown`;
 * - it reads the receiver's type where §4.2 rule 7 refuses to read a
 *   receiver's *annotation*. The two answer different questions:
 *   {@link factoryResultQualifiedNameOf}'s comment declines the annotation
 *   because a body could be resolved from the value instead, and here there is
 *   no body — the declaration is a package's `.d.ts`, and which package API the
 *   call was type-checked against is the only fact available;
 * - it is withheld wherever `factoryOriginAllowed` is false — the callee's own
 *   declaration is the compiler's lib — for the reason that flag already
 *   exists: a package interface may extend a default-lib type, and a name here
 *   would take `arr.map(…)` off the `pureBuiltinName` path that is the only
 *   one able to prove it effect-free.
 *
 * The chain is walked toward its root and the **root-most** named receiver
 * wins, so a client reached through a delegate keeps the key shape the client
 * tables already use: `this.prisma.user.findMany()` is
 * `@prisma/client.PrismaClient.user.findMany`, not
 * `@prisma/client.UserDelegate.findMany`.
 *
 * Unlike the receiver's *value*, a type is not evidence about the object's
 * identity: a subclass may override the method named here. That is the same
 * gap DESIGN.md §4.2 rule 7 already states for method resolution on class
 * instances, and no wider — what a type does settle is which package API the
 * call site was type-checked against.
 */
function installedTypeQualifiedNameOf(
  checker: ts.TypeChecker,
  program: ts.Program,
  expr: ts.PropertyAccessExpression,
): string | undefined {
  const path: string[] = [];
  let current: ts.Expression = expr;
  let named: string | undefined;
  while (ts.isPropertyAccessExpression(current)) {
    path.unshift(current.name.text);
    const receiver = current.expression;
    const origin = installedTypeNameOf(checker, program, receiver);
    if (origin !== undefined) named = [origin, ...path].join(".");
    current = receiver;
  }
  return named;
}

/**
 * `"<package>.<type name>"` for an expression whose type a package declares,
 * and `undefined` for every other expression.
 *
 * Both halves have to come from the package rather than from the call site.
 * The type name is the one the declaring module gave the type
 * ({@link packageTypeNameOf}). The package name has two sources, and which one
 * applies is decided by where the declaration came from rather than by which
 * answers first:
 *
 * - a declaration that came from `node_modules`
 *   (`isSourceFileFromExternalLibrary`, the same predicate behind the
 *   `external-module` reason) is named from the path it resolved through
 *   ({@link installedPackageNameOf}), *including* when it sits inside a
 *   `declare module "…"`. `@types/node` writes its whole surface that way, so
 *   reading the ambient name first would key `fs.Stats.isDirectory` beside the
 *   `node:fs.*` rows the import specifier already produces — the split that
 *   {@link installedPackageNameOf} refuses `@types/node` to prevent;
 * - otherwise the only honest source is a `declare module "…"` the declaration
 *   sits inside, which names its own module, so a hand-written declaration
 *   produces the key an installed package would — the property the client
 *   table already relies on. A `.d.ts` the project wrote outside one passes
 *   {@link packageTypeNameOf} and still names no package.
 */
function installedTypeNameOf(
  checker: ts.TypeChecker,
  program: ts.Program,
  expr: ts.Expression,
): string | undefined {
  const type = checker.getTypeAtLocation(expr);
  const typeName = packageTypeNameOf(program, type);
  if (typeName === undefined) return undefined;

  const declaration = type.getSymbol()?.declarations?.[0];
  if (!declaration) return undefined;

  const file = declaration.getSourceFile();
  const packageName = program.isSourceFileFromExternalLibrary(file)
    ? installedPackageNameOf(file.fileName)
    : ambientModuleNameOf(declaration);
  return packageName === undefined ? undefined : `${packageName}.${typeName}`;
}

/**
 * The module specifier of the `declare module "…"` a declaration sits inside,
 * or `undefined` when it sits in none. A `namespace` (an unquoted module
 * declaration) is not one and names nothing here.
 */
function ambientModuleNameOf(declaration: ts.Declaration): string | undefined {
  for (let node: ts.Node | undefined = declaration; node; node = node.parent) {
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) return node.name.text;
  }
  return undefined;
}

/**
 * `"<module specifier>.<returned type name>"` for a receiver bound by `const`
 * to a call of an *imported* function — `"mysql2/promise.Pool"` for `const
 * pool = createPool(...)`, and the same through `await` for `const conn =
 * await createConnection(...)`.
 *
 * This is the factory half of the same question {@link
 * constructedClassQualifiedNameOf} answers for `new`. A client handed out by a
 * factory is the ordinary shape in the wild — `mysql2` has no exported class
 * to construct — and without a name for it every call through the client is
 * `unknown`, which then propagates to every transitive caller.
 *
 * Both halves of the name are evidence, not a guess:
 *
 * - the specifier is the one the source wrote, followed through re-exports the
 *   same way a named import is ({@link deepestPackageHop}), so a barrel does
 *   not rename the package. It has to be *bare*: every bundled table is keyed
 *   on a package or a Node.js builtin, so a relative path could never match
 *   one, and emitting it would put a name in `top-unresolved-names` that reads
 *   like a stub candidate and is not. A project-local wrapper around a
 *   package's factory therefore stays unnamed;
 * - the type name is read off the declaration the *call expression's own type*
 *   resolves to — not off the variable, whose annotation §4.2 rule 7 forbids
 *   letting decide, and not off the factory's local spelling.
 *
 * Four conditions keep the name honest, and each rules out a shape where it
 * would be a coincidence rather than a fact:
 *
 * - **`const`**, exactly as for `new`: a `let` may hold something else by the
 *   time the call runs. `const` fixes the binding, not the object's
 *   properties, so this is the same premise §4.2 rule 7 already states — and
 *   no wider.
 * - **an imported callee**, because a project-local factory has no
 *   module-qualified name, and its result is a class this analysis could in
 *   principle follow to a body. Naming it would hide that.
 * - **a class or interface declaration**, so an anonymous return type
 *   (`{ run(): void }`), a union, or a primitive yields nothing.
 * - **declared in a `.d.ts` that is not the compiler's own lib.** A package
 *   type has no body to follow, which is why a name is the only handle on it.
 *   The default-lib exclusion is load-bearing rather than tidy: a factory
 *   returning `Map` or `ReadonlyArray` would otherwise take its methods off
 *   `src/stubs/pure-builtins.ts` — turning a call proven effect-free into an
 *   unresolved one, which is a signal regression even though it errs safe.
 *
 * A name is not a verdict. A package no bundled table covers gets its name
 * here and still reports `unknown`; what changes is that the name now appears
 * in `--coverage`'s `top-unresolved-names` instead of vanishing into the
 * reason count.
 */
function factoryResultQualifiedNameOf(
  checker: ts.TypeChecker,
  program: ts.Program,
  receiver: ts.Identifier,
): string | undefined {
  const symbol = checker.getSymbolAtLocation(receiver);
  if (!symbol) return undefined;
  const resolved =
    (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;

  const declaration = resolved.declarations?.[0];
  if (!declaration || !ts.isVariableDeclaration(declaration)) return undefined;
  if ((declaration.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
  if (!declaration.initializer) return undefined;

  // The `await`ed form is the same fact one step later: `createConnection()`
  // returns a promise of the client, and the client is what the binding holds.
  // The type is read from whichever of the two nodes the binding is, so the
  // promise wrapper never becomes the name.
  const value = unwrapTypeOnlyExpression(declaration.initializer);
  const call = ts.isAwaitExpression(value) ? unwrapTypeOnlyExpression(value.expression) : value;
  if (!ts.isCallExpression(call)) return undefined;

  const specifier = importedModuleSpecifierOf(checker, call.expression);
  if (specifier === undefined || specifier.startsWith(".")) return undefined;

  const typeName = packageTypeNameOf(program, checker.getTypeAtLocation(value));
  return typeName === undefined ? undefined : `${specifier}.${typeName}`;
}

/**
 * The declared name of a type whose every declaration is a class or interface
 * in a declaration file other than the compiler's own lib — see
 * {@link factoryResultQualifiedNameOf} for why each of those is required.
 *
 * `getSymbol()` rather than `aliasSymbol`: an alias is the spelling at the use
 * site, and this name has to be the one the declaring module gave the type.
 */
function packageTypeNameOf(program: ts.Program, type: ts.Type): string | undefined {
  const symbol = type.getSymbol();
  const declarations = symbol?.declarations;
  if (!symbol || !declarations || declarations.length === 0) return undefined;

  const name = symbol.getName();
  // TypeScript names an anonymous object type `__type`; the declaration check
  // below already refuses one, and this refuses the whole `__`-prefixed
  // internal namespace rather than relying on that.
  if (!name || name.startsWith("__")) return undefined;

  for (const declaration of declarations) {
    if (!ts.isClassDeclaration(declaration) && !ts.isInterfaceDeclaration(declaration)) {
      return undefined;
    }
    const file = declaration.getSourceFile();
    if (!file.isDeclarationFile || program.isSourceFileDefaultLibrary(file)) return undefined;
  }
  return name;
}

/**
 * The name of the installed package that ships `declarationFile`, read off the
 * resolved path: the segment after the last `node_modules/`, plus the one
 * before it when the package is scoped.
 *
 * This is the one place a qualified name comes from a path rather than from
 * the project's own source, and the path is used because it *is* what the
 * source would have written: a package is importable under the directory name
 * it resolves through, which is what makes `import … from "knex"` find
 * `node_modules/knex`. An aliased install (`npm i pgx@npm:pg`) is therefore
 * named `pgx` here — the same answer {@link moduleSpecifierOf} already gives
 * for a receiver whose origin *is* an import, and the reason to prefer this
 * over the `name` in the package's own `package.json`, which would disagree
 * with the rest of the rules in exactly that case. It also keeps the whole
 * naming path free of the filesystem.
 *
 * `@types/<pkg>` is answered as `<pkg>`: the types are a stand-in for the
 * package, and a table keyed on `@types/pg.Pool.query` would match only
 * projects whose `pg` happens to be untyped. `@types/node` is refused
 * outright — Node's builtins are already keyed from the import specifier
 * (`node:fs.readFileSync`), and a second spelling for the same operations
 * would decide nothing and split the table.
 *
 * `undefined` for a declaration that did not resolve through a `node_modules`
 * directory at all: it names no package, and a guess would be a coincidence.
 * Yarn PnP and any other resolver that does not lay packages out under
 * `node_modules` therefore names nothing here, which is the same answer the
 * rule gives for a receiver it cannot place — not a wrong one.
 *
 * Exported for `test/backend.legacy-ts.test.ts`: the path shapes this has to
 * survive (pnpm's virtual store, a scope, a nested `node_modules`, a
 * `@types` package, a Windows separator) are a property of the string, and
 * reaching them all through a compiled fixture would need one installed
 * package per case.
 */
export function installedPackageNameOf(declarationFile: string): string | undefined {
  // TypeScript normalizes `SourceFile.fileName` to forward slashes on every
  // platform. Splitting on both is defence against that invariant changing,
  // not a dependency on it: a backslash cannot occur inside a package name.
  const segments = declarationFile.split(/[\\/]/);
  const marker = segments.lastIndexOf("node_modules");
  if (marker === -1) return undefined;

  const first = segments[marker + 1];
  if (first === undefined || first === "") return undefined;
  const second = segments[marker + 2];
  if (first.startsWith("@") && (second === undefined || second === "")) return undefined;
  const name = first.startsWith("@") ? `${first}/${second}` : first;
  if (!name.startsWith("@types/")) return name;

  const typed = name.slice("@types/".length);
  // `@types/node` covers the builtins, which the import specifier already
  // keys — see above.
  return typed === "node" || typed === "" ? undefined : typed;
}

/**
 * The module specifier behind an expression that names an import, and nothing
 * else — `"mysql2/promise"` for `createPool` (named, aliased, or reached
 * through a barrel) and for `mysql.createPool` (namespace or default import).
 *
 * Taken apart from {@link importedQualifiedNameOf}, which joins the specifier
 * to the exported name: here the exported name is the factory's, and the name
 * being built is the returned type's.
 */
function importedModuleSpecifierOf(
  checker: ts.TypeChecker,
  expr: ts.Expression,
): string | undefined {
  if (ts.isIdentifier(expr)) {
    const symbol = checker.getSymbolAtLocation(expr);
    if (!symbol) return undefined;
    const hop = deepestPackageHop(reExportHopsOf(checker, symbol));
    return hop?.specifier ?? defaultImportSpecifierOf(checker, expr);
  }
  if (ts.isPropertyAccessExpression(expr)) return moduleSpecifierOf(checker, expr.expression);
  return undefined;
}

/**
 * The module-qualified class name a receiver was constructed from, following
 * the binding through imports and re-exports — `"pg.Pool"` for a `const pool =
 * new Pool(...)` declared in another module and re-exported by a barrel.
 *
 * `undefined` unless the binding is a `const` whose initializer is a `new`
 * expression naming an *imported* class. `const` because a `let` may hold a
 * different object by the time the call runs; imported because a locally
 * declared class has no module-qualified name. This rests on exactly the
 * assumption DESIGN.md §4.2 rule 7 already states for object literals —
 * `const` fixes the binding, not the object's properties — and adds no other.
 */
function constructedClassQualifiedNameOf(
  checker: ts.TypeChecker,
  receiver: ts.Identifier,
): string | undefined {
  const symbol = checker.getSymbolAtLocation(receiver);
  if (!symbol) return undefined;
  const resolved =
    (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;

  const declaration = resolved.declarations?.[0];
  if (!declaration || !ts.isVariableDeclaration(declaration)) return undefined;
  if ((declaration.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
  if (!declaration.initializer) return undefined;

  const initializer = unwrapTypeOnlyExpression(declaration.initializer);
  if (!ts.isNewExpression(initializer)) return undefined;
  return importedQualifiedNameOf(checker, initializer.expression);
}

/**
 * `"<module specifier>.<exported name>"` for an expression that names an
 * import, and `undefined` for anything else — including a bare local
 * identifier, which `qualifiedNameOf` falls back to separately.
 *
 * The distinction matters wherever the name is used as a *prefix* rather than
 * as a whole key ({@link constructedClassQualifiedNameOf}): a prefix built from
 * a local spelling would collide across projects, so only module-derived names
 * qualify.
 */
function importedQualifiedNameOf(checker: ts.TypeChecker, expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) {
    const named = namedImportQualifiedNameOf(checker, expr);
    if (named) return named;
    const defaultSpecifier = defaultImportSpecifierOf(checker, expr);
    // The module's default export has no name of its own to borrow — the local
    // binding's spelling is the importer's choice, not the module's.
    return defaultSpecifier === undefined ? undefined : `${defaultSpecifier}.default`;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const moduleSpecifier = moduleSpecifierOf(checker, expr.expression);
    return moduleSpecifier === undefined ? undefined : `${moduleSpecifier}.${expr.name.text}`;
  }
  return undefined;
}

/** The module specifier of a default import (`import OpenAI from "openai"`), and nothing else. */
function defaultImportSpecifierOf(
  checker: ts.TypeChecker,
  expr: ts.Identifier,
): string | undefined {
  const decl = checker.getSymbolAtLocation(expr)?.declarations?.[0];
  if (!decl || !ts.isImportClause(decl)) return undefined;
  const importDecl = decl.parent;
  if (!ts.isImportDeclaration(importDecl) || !ts.isStringLiteral(importDecl.moduleSpecifier)) {
    return undefined;
  }
  return importDecl.moduleSpecifier.text;
}

/**
 * What each argument of `node` says statically (see {@link LiteralArgument}).
 * `undefined` when nothing at all could be read from any argument, so a call
 * whose arguments are all opaque carries no field rather than an array of
 * holes.
 */
function literalArgumentsOf(
  node: ts.CallExpression,
): readonly (LiteralArgument | undefined)[] | undefined {
  const args = node.arguments;
  if (args.length === 0) return undefined;
  const read = args.map(literalArgumentOf);
  return read.some((argument) => argument !== undefined) ? read : undefined;
}

function literalArgumentOf(argument: ts.Expression): LiteralArgument | undefined {
  const expr = unwrapTypeOnlyExpression(argument);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return { text: expr.text, complete: true };
  }
  // A template literal's static head is the part the source fixes; everything
  // after the first substitution is the caller's to decide at runtime.
  if (ts.isTemplateExpression(expr)) {
    return { text: expr.head.text, complete: false };
  }
  if (ts.isObjectLiteralExpression(expr)) {
    const properties = new Map<string, string>();
    for (const property of expr.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      if (!ts.isIdentifier(property.name)) continue;
      const value = unwrapTypeOnlyExpression(property.initializer);
      if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
        properties.set(property.name.text, value.text);
      }
    }
    return properties.size === 0 ? undefined : { properties };
  }
  return undefined;
}

/**
 * `"<module specifier>.<exported name>"` for an identifier bound by a named
 * import, following the re-export chain to the module that actually owns the
 * binding.
 *
 * The imported name is used rather than a local `as` alias (`import {
 * readFileSync as rf } ...` still yields `"node:fs.readFileSync"` — the stub
 * table is keyed on the module's own export names).
 *
 * The chain matters for a barrel file: `import { readFileSync } from
 * "./lib/index.ts"` with the barrel re-exporting `"node:fs"` has to name
 * `node:fs.readFileSync`, not `./lib/index.ts.readFileSync`, or the bundled
 * effect table misses it. {@link deepestPackageHop} explains which hop wins,
 * and why the deepest one is not always right.
 *
 * `undefined` for anything that isn't a named import of a string-literal
 * module specifier (namespace/default imports are handled by
 * `moduleSpecifierOf` and `defaultImportSpecifierOf`).
 */
function namedImportQualifiedNameOf(
  checker: ts.TypeChecker,
  expr: ts.Identifier,
): string | undefined {
  const symbol = checker.getSymbolAtLocation(expr);
  if (!symbol) return undefined;
  const hops = reExportHopsOf(checker, symbol);
  const hop = deepestPackageHop(hops);
  return hop === undefined ? undefined : `${hop.specifier}.${hop.name}`;
}

/** One `from "<specifier>"` an alias chain passes through, with the name exported there. */
interface ReExportHop {
  readonly specifier: string;
  readonly name: string;
}

/**
 * Every `from "<specifier>"` between an identifier's binding and the
 * declaration behind it, outermost first. Stops at the first declaration that
 * is not an import/export specifier — that is where the binding is really
 * declared — and on a cycle, which a malformed re-export can produce.
 */
function reExportHopsOf(checker: ts.TypeChecker, symbol: ts.Symbol): readonly ReExportHop[] {
  const hops: ReExportHop[] = [];
  const seen = new Set<ts.Symbol>();
  let current: ts.Symbol | undefined = symbol;

  while (current && !seen.has(current)) {
    seen.add(current);
    const hop = reExportHopOf(current.declarations?.[0]);
    if (hop) hops.push(hop);
    // Only an alias has an immediate target; asking a non-alias asserts.
    if ((current.flags & ts.SymbolFlags.Alias) === 0) break;
    current = checker.getImmediateAliasedSymbol(current);
  }
  return hops;
}

function reExportHopOf(decl: ts.Declaration | undefined): ReExportHop | undefined {
  if (!decl) return undefined;
  if (ts.isImportSpecifier(decl)) {
    const importDecl = decl.parent.parent.parent;
    if (!ts.isImportDeclaration(importDecl) || !ts.isStringLiteral(importDecl.moduleSpecifier)) {
      return undefined;
    }
    return {
      specifier: importDecl.moduleSpecifier.text,
      name: decl.propertyName?.text ?? decl.name.text,
    };
  }
  // `export { x } from "m"`. A local re-export (`export { x }`, no `from`) has
  // no specifier of its own and contributes no hop — the chain walks past it
  // to whatever declares `x`.
  if (ts.isExportSpecifier(decl)) {
    const exportDecl = decl.parent.parent;
    if (
      !ts.isExportDeclaration(exportDecl) ||
      !exportDecl.moduleSpecifier ||
      !ts.isStringLiteral(exportDecl.moduleSpecifier)
    ) {
      return undefined;
    }
    return {
      specifier: exportDecl.moduleSpecifier.text,
      name: decl.propertyName?.text ?? decl.name.text,
    };
  }
  return undefined;
}

/**
 * Which hop names the binding for stub-matching purposes: the deepest one with
 * a *bare* specifier, and otherwise the first.
 *
 * Deepest is not simply right. A package's own types re-export internally
 * (`export { helper } from "./internal.js"` inside `node_modules/pkg`), and the
 * deepest hop there is a path inside the package, which means nothing outside
 * it — `pkg.helper` is the name. A bare specifier, by contrast, always names a
 * package or a Node.js builtin, which is exactly what the bundled tables are
 * keyed on, so the deepest bare specifier is the one that crossed the last
 * real boundary.
 */
function deepestPackageHop(hops: readonly ReExportHop[]): ReExportHop | undefined {
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    if (hop && !hop.specifier.startsWith(".")) return hop;
  }
  return hops[0];
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
