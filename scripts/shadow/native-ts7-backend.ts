/**
 * A `TsBackend` on the native TypeScript 7 engine (Go), for **shadow analysis
 * only**.
 *
 * DESIGN.md §3.5 and `docs/adr/0001-analysis-backend.md` adopted the
 * JS-implemented Compiler API (`src/checker/backend/legacy-ts.ts`) and did not
 * adopt native TypeScript. Nothing here reopens that: this backend is never
 * loaded by `ambit check`, never decides a diagnostic, an exit code or a
 * review outcome, and lives under `scripts/` with the rest of the measurement
 * procedures. What it produces is evidence — the gate-1 conformance detail and
 * the gate-3 update behaviour a revisit would need, measured rather than
 * predicted.
 *
 * It is deliberately *not* a second product backend:
 *
 * - The compiler is loaded from `.m05-native/` (gitignored, installed by
 *   `node scripts/m05-native-install.ts`), never from this package's
 *   dependencies — `scripts/m05-probe/native-compiler.ts` records why the two
 *   must not share a `node_modules/.bin`, and `test/architecture.test.ts`
 *   keeps `src/` away from both.
 * - It is untyped against the compiler's own `.d.ts`, for the same reason the
 *   probes are: a package that is not installed by default cannot be
 *   type-checked.
 * - One `API` instance per `extractProject`, closed afterwards. ADR-0001's
 *   reason 2 is that the native snapshot answers *stale* unless it is told
 *   which files changed; a fresh snapshot per run sidesteps that rather than
 *   solving it, and a shadow run is one-shot. Do not reuse the instance
 *   without implementing `fileChanges` invalidation first.
 *
 * **What is ported, and what is not.** The shadow comparison is only honest if
 * "TS7 has not been taught this shape" is distinguishable from "TS7 disagrees",
 * so the gaps are listed rather than left to be inferred from a divergence
 * count. `NOT_PORTED` below is that list, and
 * `scripts/shadow/compare.ts` reads it to classify a divergence as
 * `not-yet-ported`.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type {
  CallSite,
  ExtractedFile,
  ExtractedFunction,
  ExtractedProject,
  LiteralArgument,
  RawJsDoc,
  RuntimeWrapper,
  SkippedFunctionKind,
  SourceLocation,
  SymbolId,
  TsBackend,
  UncarriedContract,
  UnresolvedReason,
  WrapperBudget,
} from "../../src/core/index.ts";
import { isOnExceed, symbolId } from "../../src/core/index.ts";
import { constructorStubKey } from "../../src/stubs/constructors.ts";
import { isFirstArgumentMutator, isMutatingBuiltin } from "../../src/stubs/mutating-builtins.ts";
import { loadAst, loadAstIs, loadSyncApi, nativeVersion } from "../m05-probe/native-compiler.ts";

// biome-ignore lint/suspicious/noExplicitAny: the compiler's own types are not available here
type Node = any;
// biome-ignore lint/suspicious/noExplicitAny: as above
type Any = any;

/**
 * The legacy-backend behaviour this port does **not** reproduce, each with the
 * `legacy-ts.ts` function that implements it. A divergence whose category is
 * named here is a gap in this port, not a disagreement between the compilers —
 * see `scripts/shadow/compare.ts`.
 */
export const NOT_PORTED: readonly string[] = [
  // Receiver-origin naming: `memberChainQualifiedNameOf`'s second and third
  // origins (the class a `const` was constructed from; the type an imported
  // factory returned). Only the namespace/default-import origin is ported, so
  // `pg.Pool.query` and `mysql2/promise.Pool.query` are named on the legacy
  // side and unnamed here.
  "qualified-name:constructed-receiver",
  "qualified-name:factory-receiver",
  // `installedTypeQualifiedNameOf` / `packageTypeNameOf`: naming a receiver by
  // the *package type* it is declared with, so `checker: ts.TypeChecker` gives
  // `typescript.TypeChecker.getTypeAtLocation`. This is the largest single gap
  // measured — 63 of the 133 divergences on `src`.
  "qualified-name:installed-type-receiver",
  // `objectLiteralReceiverTarget` / `constructedInstanceMemberTarget`: a call
  // through a receiver whose value is certainly one object literal or one
  // constructed class instance. `objectLiteralMemberTarget` *is* ported.
  "resolution:literal-receiver",
  "resolution:instance-member",
  // `reExportHopsOf` / `deepestPackageHop`: naming a binding by the package it
  // was re-exported from rather than by the module the source imported.
  "qualified-name:re-export-hop",
  // `loadProjectConfig`'s no-tsconfig fallback. The native API opens a project
  // by config path, so a root with no `tsconfig.json` throws here instead of
  // scanning for `.ts` files.
  "project:no-tsconfig-fallback",
];

let loaded: { api: Any; ast: Any; is: Any } | undefined;

async function loadCompiler(): Promise<{ api: Any; ast: Any; is: Any }> {
  loaded ??= { api: await loadSyncApi(), ast: await loadAst(), is: await loadAstIs() };
  return loaded;
}

/**
 * The shadow backend. `version` is read from the install rather than assumed:
 * a measurement must never record a version it did not run.
 */
export const nativeTs7Backend: TsBackend = {
  name: "typescript-native",
  get version(): string {
    return nativeVersion().replace(/^typescript@/, "");
  },
  extractProject,
};

/** @effects fs_read */
async function extractProject(rootDir: string): Promise<ExtractedProject> {
  const c = await loadCompiler();
  const { API } = c.api;
  const absoluteRoot = path.resolve(rootDir);
  if (!existsSync(absoluteRoot)) {
    throw new Error(`project root not found or not a directory: ${absoluteRoot}`);
  }
  const configPath = findConfigFile(absoluteRoot);
  const api = new API({ cwd: path.dirname(configPath) });
  try {
    const project = api.updateSnapshot({ openProjects: [configPath] }).getProjects()[0];
    if (!project) throw new Error(`no project opened for ${configPath}`);
    return new Extractor(c, project, absoluteRoot).run();
  } finally {
    api.close();
  }
}

/** The same upward search `ts.findConfigFile` does on the legacy side. */
function findConfigFile(from: string): string {
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `no tsconfig.json found from ${from} (${NOT_PORTED.includes("project:no-tsconfig-fallback") ? "the no-tsconfig fallback is not ported" : ""})`,
      );
    }
    dir = parent;
  }
}

const CONTRACT_TAGS = ["effects", "capabilities", "budget", "entrypoint", "boundary"] as const;
const CONSTRUCTOR_PATH_SEGMENT = "constructor";
const DEFAULT_EXPORT_PATH_SEGMENT = "default";
const INLINE_CALLBACKS_PATH_SEGMENT = "<inline callbacks>";
const STATIC_PATH_MARKER = "static ";

/**
 * The declaration paths only `ambit.config.ts` can name — an accessor and an
 * anonymous default export (DESIGN.md §4.1 (a)). Derived from the path, as on
 * the legacy side, so the rule has one spelling.
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
 * Where the block comment ending at `end` opens, found by walking the trivia
 * from `fullStart` rather than by searching backwards for `/*`: a JSDoc body
 * may contain that sequence, and a search would then report a position inside
 * the comment as its start.
 */
function commentStartOf(text: string, fullStart: number, end: number): number | undefined {
  let index = fullStart;
  while (index < end) {
    const ch = text[index];
    if (ch !== undefined && /\s/.test(ch)) {
      index++;
      continue;
    }
    if (text.startsWith("//", index)) {
      const lineEnd = text.indexOf("\n", index);
      index = lineEnd === -1 ? end : lineEnd + 1;
      continue;
    }
    if (text.startsWith("/*", index)) {
      const close = text.indexOf("*/", index + 2);
      if (close === -1) return undefined;
      if (close + 2 === end) return index;
      index = close + 2;
      continue;
    }
    return undefined;
  }
  return undefined;
}

const RUNTIME_WRAPPER_NAMES: ReadonlyMap<string, string> = new Map([
  ["ambit-ts/runtime.withAmbit", "withAmbit"],
  ["ambit-ts/runtime/hono.ambitHandler", "ambitHandler"],
  ["ambit-ts/runtime/next.ambitRoute", "ambitRoute"],
]);

/**
 * One extraction run. A class rather than a module of functions because every
 * helper needs the same four things (the loaded compiler, the project, the
 * program/checker pair and the root), and threading them through ~40
 * signatures is how the legacy file got to five-parameter helpers.
 */
class Extractor {
  private readonly ast: Any;
  private readonly is: Any;
  private readonly K: Any;
  private readonly SymbolFlags: Any;
  private readonly program: Any;
  private readonly checker: Any;
  private readonly declaredNodeToId = new Map<Node, SymbolId>();
  private readonly project: Any;
  private readonly absoluteRoot: string;

  constructor(c: { api: Any; ast: Any; is: Any }, project: Any, absoluteRoot: string) {
    this.project = project;
    this.absoluteRoot = absoluteRoot;
    this.ast = c.ast;
    this.is = c.is;
    this.K = c.ast.SyntaxKind;
    this.SymbolFlags = c.api.SymbolFlags;
    this.program = project.program;
    this.checker = project.checker;
  }

  run(): ExtractedProject {
    const sourceFiles: Node[] = [];
    for (const fileName of this.program.getSourceFileNames()) {
      if (!this.isUnderRoot(fileName)) continue;
      const sourceFile = this.program.getSourceFile(fileName);
      if (!sourceFile || sourceFile.isDeclarationFile) continue;
      sourceFiles.push(sourceFile);
    }

    // Pass 1 — mint one id per declaration, so pass 2 can resolve calls
    // between files. The collision check is the legacy one and for the legacy
    // reason: two declarations under one id make `propagate` never converge
    // (DESIGN.md §4.1), so it has to stop the run.
    const declarationsByFile = new Map<Node, ReadonlyArray<readonly [Node, readonly string[]]>>();
    for (const sourceFile of sourceFiles) {
      const declarations = this.collectFunctionLikeDeclarations(sourceFile);
      declarationsByFile.set(sourceFile, declarations);
      const minted = new Set<SymbolId>();
      for (const [node, declPath] of declarations) {
        const id = symbolId(this.relativePath(sourceFile), declPath);
        if (minted.has(id)) {
          const { line } = this.locationOf(sourceFile, this.nameOrNode(node));
          throw new Error(
            `two declarations share the symbol id ${id} (the second is at line ${line})`,
          );
        }
        minted.add(id);
        this.declaredNodeToId.set(node, id);
      }
    }

    // Pass 2 — JSDoc, calls, wrappers, and the tally of what was seen and not
    // extracted.
    const files: ExtractedFile[] = [];
    const skippedFunctions = new Map<SkippedFunctionKind, number>();
    const uncarriedContracts: UncarriedContract[] = [];
    for (const [sourceFile, declarations] of declarationsByFile) {
      const functions: ExtractedFunction[] = [];
      for (const [node, declPath] of declarations) {
        const id = symbolId(this.relativePath(sourceFile), declPath);
        const location = this.locationOf(sourceFile, this.nameOrNode(node));
        const configOnly = configOnlyPath(declPath);
        if (configOnly) {
          const jsDoc = this.extractJsDoc(node);
          for (const tag of CONTRACT_TAGS) {
            const raw = jsDoc?.tags.get(tag);
            if (raw === undefined) continue;
            uncarriedContracts.push({
              location,
              kind:
                this.is.isGetAccessorDeclaration(node) || this.is.isSetAccessorDeclaration(node)
                  ? "getter-setter"
                  : "anonymous-default-export",
              tag,
              raw,
              configKey: id,
            });
          }
        }
        const bodies = this.is.isSourceFile(node) ? this.ownedBodyCalls(node) : undefined;
        functions.push({
          id,
          location,
          declarationStart: this.declarationStartOf(sourceFile, node),
          ...this.jsDocRangeOf(sourceFile, node),
          ...(this.is.isClassDeclaration(node) ? { implicitConstructor: true as const } : {}),
          ...(configOnly ? { configOnly: true as const } : {}),
          ...(bodies ? { bodies, undeclarable: true as const } : {}),
          jsDoc: configOnly ? undefined : this.extractJsDoc(node),
          calls: bodies?.flat() ?? this.collectCalls(node, sourceFile),
        });
      }
      const runtimeWrappers = this.collectRuntimeWrappers(sourceFile);
      if (functions.length > 0 || runtimeWrappers.length > 0) {
        files.push({ filePath: this.relativePath(sourceFile), functions, runtimeWrappers });
      }
      const skipped = this.collectSkippedFunctions(sourceFile);
      for (const kind of skipped.kinds) {
        skippedFunctions.set(kind, (skippedFunctions.get(kind) ?? 0) + 1);
      }
      uncarriedContracts.push(...skipped.uncarried);
    }
    return { files, skippedFunctions, uncarriedContracts };
  }

  // ---- positions --------------------------------------------------------

  private isUnderRoot(fileName: string): boolean {
    const rel = path.relative(this.absoluteRoot, fileName);
    return !rel.startsWith("..") && !path.isAbsolute(rel) && !fileName.includes("node_modules");
  }

  private relativePath(sourceFile: Node): string {
    return path.relative(this.absoluteRoot, sourceFile.fileName);
  }

  private locationOf(sourceFile: Node, node: Node): SourceLocation {
    if (this.is.isSourceFile(node)) {
      return { file: this.relativePath(sourceFile), line: 1, col: 1, endLine: 1, endCol: 1 };
    }
    // `getStart(sourceFile)`, not `getStart()`: on this API a JSDoc node asked
    // without the source file reports its *full* start, so the block's range
    // began at the end of the previous statement. Measured — six divergences on
    // `test/fixtures/backend-conformance`, all of them `jsDocRange`.
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    return {
      file: this.relativePath(sourceFile),
      line: start.line + 1,
      col: start.character + 1,
      endLine: end.line + 1,
      endCol: end.character + 1,
    };
  }

  // ---- declaration discovery --------------------------------------------

  private collectFunctionLikeDeclarations(
    sourceFile: Node,
  ): ReadonlyArray<readonly [Node, readonly string[]]> {
    const is = this.is;
    const results: Array<[Node, readonly string[]]> = [];

    const visitTop = (node: Node, containerPath: readonly string[]): void => {
      if (containerPath.length === 0) {
        const anonymousDefault = this.anonymousDefaultExport(node);
        if (anonymousDefault) {
          results.push([anonymousDefault, [DEFAULT_EXPORT_PATH_SEGMENT]]);
          return;
        }
      }
      if (is.isFunctionDeclaration(node) && node.name) {
        if (!node.body) return;
        results.push([node, [...containerPath, node.name.text]]);
        return;
      }
      if (is.isClassDeclaration(node) && node.name) {
        const classPath = [...containerPath, node.name.text];
        for (const member of node.members) {
          if (
            is.isMethodDeclaration(member) &&
            member.body &&
            member.name &&
            is.isIdentifier(member.name)
          ) {
            results.push([member, [...classPath, this.memberSegment(member, member.name.text)]]);
          }
          if (this.isFunctionValuedProperty(member)) {
            results.push([member, [...classPath, this.memberSegment(member, member.name.text)]]);
          }
          if (
            (is.isGetAccessorDeclaration(member) || is.isSetAccessorDeclaration(member)) &&
            member.name &&
            is.isIdentifier(member.name)
          ) {
            results.push([
              member,
              [
                ...classPath,
                this.memberSegment(member, this.accessorSegment(member, member.name.text)),
              ],
            ]);
          }
        }
        const explicitConstructor = [...node.members].find(
          (member: Node) => is.isConstructorDeclaration(member) && member.body !== undefined,
        );
        results.push([explicitConstructor ?? node, [...classPath, CONSTRUCTOR_PATH_SEGMENT]]);
        return;
      }
      if (is.isModuleDeclaration(node) && is.isIdentifier(node.name)) {
        const namespacePath = [...containerPath, node.name.text];
        node.forEachChild((child: Node) => {
          visitTop(child, namespacePath);
        });
        return;
      }
      if (
        is.isVariableStatement(node) ||
        is.isModuleBlock(node) ||
        is.isModuleDeclaration(node) ||
        node === sourceFile
      ) {
        node.forEachChild((child: Node) => {
          visitTop(child, containerPath);
        });
        return;
      }
      if (is.isVariableDeclarationList(node)) {
        for (const decl of node.declarations) visitTop(decl, containerPath);
        return;
      }
      if (
        is.isVariableDeclaration(node) &&
        is.isIdentifier(node.name) &&
        node.initializer &&
        (is.isFunctionExpression(node.initializer) || is.isArrowFunction(node.initializer))
      ) {
        results.push([node, [...containerPath, node.name.text]]);
        return;
      }
      if (is.isVariableDeclaration(node) && is.isIdentifier(node.name)) {
        const literal = this.indexableObjectLiteral(node);
        if (!literal) return;
        const objectPath = [...containerPath, node.name.text];
        for (const member of literal.properties) {
          if (!member.name || !is.isIdentifier(member.name)) continue;
          if (is.isGetAccessorDeclaration(member) || is.isSetAccessorDeclaration(member)) {
            results.push([member, [...objectPath, this.accessorSegment(member, member.name.text)]]);
          } else if (is.isMethodDeclaration(member)) {
            results.push([member, [...objectPath, member.name.text]]);
          } else if (
            is.isPropertyAssignment(member) &&
            (is.isFunctionExpression(member.initializer) || is.isArrowFunction(member.initializer))
          ) {
            results.push([member, [...objectPath, member.name.text]]);
          }
        }
        return;
      }
    };

    sourceFile.forEachChild((child: Node) => {
      visitTop(child, []);
    });

    if (this.unownedInlineCallbacks(sourceFile).length > 0) {
      results.push([sourceFile, [INLINE_CALLBACKS_PATH_SEGMENT]]);
    }
    return results;
  }

  private unownedInlineCallbacks(sourceFile: Node): readonly Node[] {
    const is = this.is;
    const found: Node[] = [];
    const visit = (node: Node): void => {
      if (is.isClassLikeDeclaration(node) || this.isFunctionLikeNode(node)) {
        if (
          this.isCallbackArgument(node) &&
          (is.isArrowFunction(node) || is.isFunctionExpression(node))
        ) {
          found.push(node);
        }
        return;
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
    return found;
  }

  private indexableObjectLiteral(declaration: Node): Node | undefined {
    if (!declaration.initializer) return undefined;
    if ((declaration.parent.flags & this.ast.NodeFlags.Const) === 0) return undefined;
    const literal = this.unwrapTypeOnlyExpression(declaration.initializer);
    if (!this.is.isObjectLiteralExpression(literal)) return undefined;
    if ([...literal.properties].some((p: Node) => this.is.isSpreadAssignment(p))) return undefined;
    return literal;
  }

  private unwrapTypeOnlyExpression(expression: Node): Node {
    const is = this.is;
    let current = expression;
    while (
      is.isSatisfiesExpression(current) ||
      is.isAsExpression(current) ||
      is.isParenthesizedExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  }

  private isInIndexableObjectLiteral(member: Node): boolean {
    const is = this.is;
    const literal = member.parent;
    if (!literal || !is.isObjectLiteralExpression(literal)) return false;
    let container: Node = literal.parent;
    while (
      is.isSatisfiesExpression(container) ||
      is.isAsExpression(container) ||
      is.isParenthesizedExpression(container)
    ) {
      container = container.parent;
    }
    return (
      is.isVariableDeclaration(container) && this.indexableObjectLiteral(container) === literal
    );
  }

  private isFunctionLikeNode(node: Node): boolean {
    const is = this.is;
    return (
      is.isFunctionDeclaration(node) ||
      is.isFunctionExpression(node) ||
      is.isArrowFunction(node) ||
      is.isMethodDeclaration(node) ||
      is.isGetAccessorDeclaration(node) ||
      is.isSetAccessorDeclaration(node) ||
      is.isConstructorDeclaration(node)
    );
  }

  private memberSegment(member: Node, segment: string): string {
    const isStatic = [...(member.modifiers ?? [])].some(
      (modifier: Node) => modifier.kind === this.K.StaticKeyword,
    );
    return isStatic ? `${STATIC_PATH_MARKER}${segment}` : segment;
  }

  private accessorSegment(node: Node, name: string): string {
    return `${this.is.isGetAccessorDeclaration(node) ? "get" : "set"} ${name}`;
  }

  private anonymousDefaultExport(node: Node): Node | undefined {
    const is = this.is;
    if (is.isFunctionDeclaration(node) && !node.name && this.isDefaultExport(node)) return node;
    if (is.isExportAssignment(node) && !node.isExportEquals) {
      const expression = node.expression;
      if (is.isArrowFunction(expression) || is.isFunctionExpression(expression)) {
        if (!is.isFunctionExpression(expression) || !expression.name) return expression;
      }
    }
    return undefined;
  }

  private isDefaultExport(node: Node): boolean {
    if (node.parent && this.is.isExportAssignment(node.parent) && !node.parent.isExportEquals) {
      return true;
    }
    return [...(node.modifiers ?? [])].some((m: Node) => m.kind === this.K.DefaultKeyword);
  }

  private isCallbackArgument(node: Node): boolean {
    const parent = node.parent;
    if (!parent || !(this.is.isCallExpression(parent) || this.is.isNewExpression(parent))) {
      return false;
    }
    return [...(parent.arguments ?? [])].includes(node);
  }

  private isNestedInAnotherFunction(node: Node): boolean {
    let current = node.parent;
    while (current && !this.is.isSourceFile(current)) {
      if (this.isFunctionLikeNode(current)) return true;
      current = current.parent;
    }
    return false;
  }

  private isObjectLiteralMethod(node: Node): boolean {
    const is = this.is;
    if (node.parent && is.isObjectLiteralExpression(node.parent)) return true;
    const parent = node.parent;
    return (
      parent !== undefined &&
      is.isPropertyAssignment(parent) &&
      parent.initializer === node &&
      is.isObjectLiteralExpression(parent.parent)
    );
  }

  private isFunctionValuedProperty(member: Node): boolean {
    const is = this.is;
    return (
      is.isPropertyDeclaration(member) &&
      is.isIdentifier(member.name) &&
      member.initializer !== undefined &&
      (is.isArrowFunction(member.initializer) || is.isFunctionExpression(member.initializer))
    );
  }

  private isIndexedInitializer(node: Node): boolean {
    const is = this.is;
    const parent = node.parent;
    return (
      parent !== undefined &&
      (is.isVariableDeclaration(parent) ||
        is.isPropertyAssignment(parent) ||
        is.isPropertyDeclaration(parent)) &&
      parent.initializer === node &&
      this.declaredNodeToId.has(parent)
    );
  }

  private classifySkipped(node: Node): SkippedFunctionKind {
    const is = this.is;
    if (
      (is.isFunctionDeclaration(node) ||
        is.isMethodDeclaration(node) ||
        is.isConstructorDeclaration(node)) &&
      !node.body
    ) {
      return "bodyless-declaration";
    }
    if (is.isGetAccessorDeclaration(node) || is.isSetAccessorDeclaration(node)) {
      return "getter-setter";
    }
    if (this.isObjectLiteralMethod(node)) return "object-literal-method";
    if (this.isDefaultExport(node)) return "anonymous-default-export";
    if (this.isCallbackArgument(node)) return "callback-argument";
    if (this.isNestedInAnotherFunction(node)) return "nested-function";
    return "other";
  }

  private collectSkippedFunctions(sourceFile: Node): {
    readonly kinds: readonly SkippedFunctionKind[];
    readonly uncarried: UncarriedContract[];
  } {
    const is = this.is;
    const kinds: SkippedFunctionKind[] = [];
    const uncarried: UncarriedContract[] = [];

    const visit = (node: Node): void => {
      if (
        this.isFunctionLikeNode(node) &&
        !this.declaredNodeToId.has(node) &&
        !this.isIndexedInitializer(node)
      ) {
        const kind = this.classifySkipped(node);
        kinds.push(kind);
        const jsDoc = this.extractJsDoc(node);
        for (const tag of CONTRACT_TAGS) {
          const raw = jsDoc?.tags.get(tag);
          if (raw === undefined) continue;
          uncarried.push({
            location: this.locationOf(sourceFile, this.nameOrNode(node)),
            kind,
            tag,
            raw,
          });
        }
      }
      if (is.isClassDeclaration(node)) {
        for (const tag of this.ast.getJSDocTags(node)) {
          const name = tag.tagName?.text;
          if (!name || !(CONTRACT_TAGS as readonly string[]).includes(name)) continue;
          uncarried.push({
            location: this.locationOf(sourceFile, node.name ?? node),
            kind: "class-declaration",
            tag: name,
            raw: this.jsDocTagText(tag),
          });
        }
      }
      node.forEachChild(visit);
    };

    sourceFile.forEachChild(visit);
    return { kinds, uncarried };
  }

  // ---- JSDoc -------------------------------------------------------------

  private nameOrNode(decl: Node): Node {
    const is = this.is;
    if (is.isSourceFile(decl)) return decl;
    if (is.isVariableDeclaration(decl) || is.isPropertyDeclaration(decl)) return decl.name;
    if (is.isArrowFunction(decl)) return decl;
    return decl.name ?? decl;
  }

  /** The node a JSDoc block or tag is read off: a `const f = …` reads the statement. */
  private jsDocTarget(decl: Node): Node {
    return this.is.isVariableDeclaration(decl) ? (decl.parent?.parent ?? decl) : decl;
  }

  private declarationStartOf(sourceFile: Node, decl: Node): SourceLocation {
    const node = this.is.isVariableDeclaration(decl) ? (decl.parent?.parent ?? decl) : decl;
    // `getStart(sourceFile, includeJsDocComment)` — the JSDoc is excluded, so
    // the position is where a new contract comment goes.
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false));
    return {
      file: this.relativePath(sourceFile),
      line: position.line + 1,
      col: position.character + 1,
      endLine: position.line + 1,
      endCol: position.character + 1,
    };
  }

  private jsDocRangeOf(sourceFile: Node, decl: Node): { jsDocRange?: SourceLocation } {
    if (this.is.isSourceFile(decl)) return {};
    const target = this.jsDocTarget(decl);
    // The two compilers do not attach JSDoc blocks alike. Where a declaration
    // is preceded by a file-level block and its own, the legacy checker's
    // `getJSDocCommentsAndTags` reports **one** block and `node.jsDoc` here
    // reports **two**; `getLeadingCommentRanges` reports two as well, so the
    // trivia is not a way around it. More than one block has no single right
    // place for a fix to add to either way, so both sides fall back to a new
    // block of its own — the ranges simply differ in which declarations reach
    // that fallback. Measured: three `jsDocRange` divergences on `src`
    // (`cli/github.ts#githubData`, `runtime/hono.ts#ambitHandler`,
    // `stubs/pure-builtins.ts#members`), none on the fixture corpus.
    const blocks = [...(target.jsDoc ?? [])];
    if (blocks.length !== 1) return {};
    const block = blocks[0];
    if (!block || block.getSourceFile() !== sourceFile) return {};
    // A JSDoc node's own text is trivia, so `getStart()` skips *past* the
    // comment and `getFullStart()` sits wherever the preceding trivia began —
    // the top of the file, when the statement above it carries a line comment.
    // Neither is where the block's own opener is, so the trivia is walked.
    // Measured as six `jsDocRange` divergences on
    // `test/fixtures/backend-conformance`.
    const start = commentStartOf(sourceFile.text, block.getFullStart(), block.getEnd());
    if (start === undefined) return {};
    const startPosition = sourceFile.getLineAndCharacterOfPosition(start);
    const endPosition = sourceFile.getLineAndCharacterOfPosition(block.getEnd());
    return {
      jsDocRange: {
        file: this.relativePath(sourceFile),
        line: startPosition.line + 1,
        col: startPosition.character + 1,
        endLine: endPosition.line + 1,
        endCol: endPosition.character + 1,
      },
    };
  }

  private extractJsDoc(decl: Node): RawJsDoc | undefined {
    const is = this.is;
    if (is.isClassDeclaration(decl)) return undefined;
    if (is.isSourceFile(decl)) return undefined;
    const target = this.jsDocTarget(decl);
    const tags = this.ast.getJSDocTags(target);
    if (tags.length === 0) return undefined;

    const map = new Map<string, string>();
    const locations = new Map<string, SourceLocation>();
    const sourceFile = target.getSourceFile();
    for (const tag of tags) {
      const name = tag.tagName?.text;
      if (name === undefined) continue;
      map.set(name, this.jsDocTagText(tag));
      locations.set(name, this.jsDocTagLocation(sourceFile, tag));
    }
    return { tags: map, tagLocations: locations };
  }

  private jsDocTagLocation(sourceFile: Node, tag: Node): SourceLocation {
    const start = tag.getStart(sourceFile);
    const text: string = sourceFile.text;
    let end = tag.getEnd();
    // The tag's span runs to where the next tag (or the closing `*` + `/`)
    // begins, so it swallows the whitespace after the text. A fix has to be a
    // patch a person would have written (DESIGN.md §5.3).
    while (end > start && /\s/.test(text[end - 1] ?? "")) end--;
    const startPosition = sourceFile.getLineAndCharacterOfPosition(start);
    const endPosition = sourceFile.getLineAndCharacterOfPosition(end);
    return {
      file: this.relativePath(sourceFile),
      line: startPosition.line + 1,
      col: startPosition.character + 1,
      endLine: endPosition.line + 1,
      endCol: endPosition.character + 1,
    };
  }

  private jsDocTagText(tag: Node): string {
    const comment = tag.comment;
    if (comment === undefined || comment === null) return "";
    if (typeof comment === "string") return comment.trim();
    return [...comment]
      .map((part: Node) => (this.is.isJSDocText(part) ? part.text : part.getText()))
      .join("")
      .trim();
  }

  // ---- call extraction ----------------------------------------------------

  private bodiesOf(decl: Node): readonly Node[] {
    const is = this.is;
    if (is.isSourceFile(decl)) {
      return this.unownedInlineCallbacks(decl).flatMap((cb) => this.bodiesOf(cb));
    }
    if (
      is.isVariableDeclaration(decl) ||
      is.isPropertyAssignment(decl) ||
      is.isPropertyDeclaration(decl)
    ) {
      return decl.initializer ? [decl.initializer] : [];
    }
    if (is.isClassDeclaration(decl)) return this.propertyInitializersOf(decl);
    if (is.isConstructorDeclaration(decl)) {
      const classBody = is.isClassLikeDeclaration(decl.parent)
        ? this.propertyInitializersOf(decl.parent)
        : [];
      const parameterDefaults = [...decl.parameters]
        .map((parameter: Node) => parameter.initializer)
        .filter((initializer: Node) => initializer !== undefined);
      return [...(decl.body ? [decl.body] : []), ...parameterDefaults, ...classBody];
    }
    return decl.body ? [decl.body] : [];
  }

  private propertyInitializersOf(node: Node): readonly Node[] {
    const is = this.is;
    return [...node.members]
      .filter((member: Node) => is.isPropertyDeclaration(member))
      .map((member: Node) => member.initializer)
      .filter((initializer: Node) => initializer !== undefined)
      .filter(
        (initializer: Node) =>
          !is.isArrowFunction(initializer) && !is.isFunctionExpression(initializer),
      );
  }

  private ownedBodyCalls(sourceFile: Node): readonly (readonly CallSite[])[] {
    return this.unownedInlineCallbacks(sourceFile).map((callback) =>
      this.collectCalls(callback, sourceFile),
    );
  }

  private collectCalls(decl: Node, sourceFile: Node): readonly CallSite[] {
    const is = this.is;
    if (is.isSourceFile(decl)) return this.ownedBodyCalls(decl).flat();

    const bodies = this.bodiesOf(decl);
    if (bodies.length === 0 && !is.isClassDeclaration(decl)) return [];

    const calls: CallSite[] = [];
    const visit = (node: Node): void => {
      if (is.isCallExpression(node)) {
        calls.push(this.classifyCall(node, sourceFile, decl));
      } else if (is.isNewExpression(node)) {
        calls.push(this.classifyNewExpression(node, sourceFile));
      } else {
        const mutation = this.classifyAssignment(node, sourceFile, decl);
        if (mutation) calls.push(mutation);
      }
      node.forEachChild(visit);
    };

    for (const body of bodies) {
      if (is.isBlock(body)) body.forEachChild(visit);
      else visit(body);
    }

    if (is.isClassDeclaration(decl)) {
      const base = this.baseTypeExpressionOf(decl);
      if (base) calls.push(this.classifyConstruct(base, base, sourceFile));
    }
    return calls;
  }

  private enclosingClassOf(node: Node): Node | undefined {
    let current: Node | undefined = node.parent;
    while (current && !this.is.isSourceFile(current)) {
      if (this.is.isClassLikeDeclaration(current)) return current;
      current = current.parent;
    }
    return undefined;
  }

  private baseTypeExpressionOf(node: Node): Node | undefined {
    for (const clause of node.heritageClauses ?? []) {
      if (clause.token !== this.K.ExtendsKeyword) continue;
      return [...clause.types][0]?.expression;
    }
    return undefined;
  }

  private classifyNewExpression(node: Node, sourceFile: Node): CallSite {
    if (this.is.isIdentifier(node.expression) && node.expression.text === "Function") {
      return { location: this.locationOf(sourceFile, node), unresolvedReason: "new-function" };
    }
    return this.classifyConstruct(node.expression, node, sourceFile);
  }

  private classifyConstruct(classExpression: Node, site: Node, sourceFile: Node): CallSite {
    const is = this.is;
    const location = this.locationOf(sourceFile, site);

    const symbol = this.checker.getSymbolAtLocation(classExpression);
    const isAlias = symbol !== undefined && (symbol.flags & this.SymbolFlags.Alias) !== 0;
    const resolvedSymbol = isAlias ? this.checker.getAliasedSymbol(symbol) : symbol;
    const declaration = this.declarationsOf(resolvedSymbol).find((d: Node) =>
      is.isClassLikeDeclaration(d),
    );

    if (declaration) {
      const resolved = this.constructorTarget(declaration);
      if (resolved) return { location, resolvedCallee: resolved };
    }

    const declarationSourceFile = declaration?.getSourceFile();
    const ambientReason = declarationSourceFile?.isDeclarationFile
      ? this.ambientUnresolvedReason(declarationSourceFile)
      : undefined;
    const importBindingReason: UnresolvedReason | undefined =
      isAlias && this.declarationsOf(resolvedSymbol).length === 0 ? "import-binding" : undefined;

    const name = this.qualifiedNameOf(
      classExpression,
      importBindingReason === undefined,
      ambientReason !== "builtin-method",
    );
    if (name) {
      return {
        location,
        calleeQualifiedName: constructorStubKey(name),
        unresolvedReason: importBindingReason ?? ambientReason,
        ...(is.isNewExpression(site) ? this.callableArgumentFields(site) : {}),
        constructedWithoutArguments:
          (is.isNewExpression(site) ? [...(site.arguments ?? [])].length === 0 : true) || undefined,
      };
    }
    return {
      location,
      unresolvedReason: importBindingReason ?? ambientReason ?? "unresolved-symbol",
    };
  }

  private constructorTarget(declaration: Node): SymbolId | undefined {
    for (const member of declaration.members) {
      if (!this.is.isConstructorDeclaration(member) || !member.body) continue;
      const id = this.declaredNodeToId.get(member);
      if (id) return id;
    }
    return this.declaredNodeToId.get(declaration);
  }

  /** `symbol.declarations` are `NodeHandle`s on this API; each needs a round trip. */
  private declarationsOf(symbol: Node): readonly Node[] {
    const handles = symbol?.declarations;
    if (!handles) return [];
    const resolved: Node[] = [];
    for (const handle of handles) {
      const node = handle?.resolve(this.project);
      if (node) resolved.push(node);
    }
    return resolved;
  }

  private implementationDeclarationOf(symbol: Node): Node | undefined {
    const declarations = this.declarationsOf(symbol);
    if (declarations.length === 0) return undefined;
    if (declarations.length === 1) return declarations[0];
    for (const declaration of declarations) {
      if (
        (this.is.isFunctionDeclaration(declaration) || this.is.isMethodDeclaration(declaration)) &&
        declaration.body
      ) {
        return declaration;
      }
    }
    return declarations[0];
  }

  private unwrapNonNullAssertions(expression: Node): Node {
    let current = expression;
    while (this.is.isNonNullExpression(current) || this.is.isParenthesizedExpression(current)) {
      current = current.expression;
    }
    return current;
  }

  private isFunctionValuedDeclaration(declaration: Node): boolean {
    const is = this.is;
    if (
      is.isFunctionDeclaration(declaration) ||
      is.isMethodDeclaration(declaration) ||
      is.isConstructorDeclaration(declaration) ||
      is.isGetAccessorDeclaration(declaration) ||
      is.isSetAccessorDeclaration(declaration)
    ) {
      return declaration.body !== undefined;
    }
    if (
      is.isVariableDeclaration(declaration) ||
      is.isPropertyAssignment(declaration) ||
      is.isPropertyDeclaration(declaration)
    ) {
      const initializer = declaration.initializer;
      return (
        initializer !== undefined &&
        (is.isArrowFunction(initializer) || is.isFunctionExpression(initializer))
      );
    }
    return is.isFunctionExpression(declaration) || is.isArrowFunction(declaration);
  }

  private isWalkedIntoSummaryOf(declaration: Node, enclosing: Node): boolean {
    if (declaration === enclosing) return false;
    if (!this.isFunctionValuedDeclaration(declaration)) return false;
    const bodies = this.bodiesOf(enclosing);
    if (bodies.length === 0) return false;
    for (let current: Node | undefined = declaration; current; current = current.parent) {
      if (bodies.includes(current)) return true;
      if (this.is.isSourceFile(current)) return false;
    }
    return false;
  }

  private ambientUnresolvedReason(declarationSourceFile: Node): UnresolvedReason | undefined {
    if (this.program.isSourceFileDefaultLibrary(declarationSourceFile)) return "builtin-method";
    if (this.program.isSourceFileFromExternalLibrary(declarationSourceFile)) {
      return "external-module";
    }
    return "ambient-declaration";
  }

  private classifyCall(node: Node, sourceFile: Node, enclosing: Node): CallSite {
    const is = this.is;
    const location = this.locationOf(sourceFile, node);

    if (node.expression.kind === this.K.ImportKeyword) {
      return { location, unresolvedReason: "dynamic-import" };
    }
    const callee = this.unwrapNonNullAssertions(node.expression);
    if (is.isIdentifier(callee) && callee.text === "eval") {
      return { location, unresolvedReason: "eval" };
    }
    if (callee.kind === this.K.SuperKeyword) {
      const enclosingClass = this.enclosingClassOf(node);
      const base = enclosingClass ? this.baseTypeExpressionOf(enclosingClass) : undefined;
      if (!base) return { location, unresolvedReason: "unresolved-symbol" };
      return this.classifyConstruct(base, node, sourceFile);
    }

    const symbol = this.checker.getSymbolAtLocation(callee);
    const isAlias = symbol !== undefined && (symbol.flags & this.SymbolFlags.Alias) !== 0;
    const resolvedSymbol = isAlias ? this.checker.getAliasedSymbol(symbol) : symbol;
    const declaration = this.implementationDeclarationOf(resolvedSymbol);

    if (declaration) {
      const resolvedId = this.declaredNodeToId.get(declaration);
      if (resolvedId) return { location, resolvedCallee: resolvedId };
      const memberId = this.objectLiteralMemberTarget(declaration);
      if (memberId) return { location, resolvedCallee: memberId };
    }

    const importBindingReason: UnresolvedReason | undefined =
      isAlias && !declaration ? "import-binding" : undefined;
    const isAmbientDeclaration = declaration?.getSourceFile().isDeclarationFile ?? false;

    if (
      declaration &&
      !isAmbientDeclaration &&
      this.isWalkedIntoSummaryOf(declaration, enclosing)
    ) {
      return { location, inlinedCallee: true };
    }

    if (declaration && !isAmbientDeclaration) {
      if (is.isParameterDeclaration(declaration)) {
        return { location, unresolvedReason: "callback-parameter" };
      }
      if (
        (is.isFunctionDeclaration(declaration) || is.isMethodDeclaration(declaration)) &&
        !declaration.body
      ) {
        return { location, unresolvedReason: "overload-without-body" };
      }
    }

    const ambientReason =
      isAmbientDeclaration && declaration
        ? this.ambientUnresolvedReason(declaration.getSourceFile())
        : undefined;
    const fallbackReason = importBindingReason ?? ambientReason;
    const isAnyTyped = this.isAnyType(this.checker.getTypeAtLocation(callee));

    const qualifiedName = this.qualifiedNameOf(
      callee,
      importBindingReason === undefined,
      ambientReason !== "builtin-method",
    );
    if (qualifiedName) {
      return {
        location,
        calleeQualifiedName: qualifiedName,
        literalArguments: this.literalArgumentsOf(node),
        unresolvedReason: fallbackReason,
        ...this.callableArgumentFields(node),
      };
    }

    if (ambientReason === "builtin-method" && resolvedSymbol) {
      const builtinName = this.fullyQualifiedNameOf(resolvedSymbol);
      if (builtinName) {
        const callable = this.callableArgumentsOf(node);
        const callbackByReference = callable.opaque || undefined;
        const callbackTargets =
          callable.targets.length > 0 ? { callbackTargets: callable.targets } : {};
        const mutatedArgument = isFirstArgumentMutator(builtinName)
          ? [...(node.arguments ?? [])][0]
          : undefined;
        if (mutatedArgument) {
          const escaping = !this.isLocallyOwnedMutationTarget(mutatedArgument, enclosing);
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
        if (isMutatingBuiltin(builtinName) && is.isPropertyAccessExpression(callee)) {
          const escaping = !this.isLocallyOwnedMutationTarget(callee.expression, enclosing);
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

    if (isAnyTyped) return { location, unresolvedReason: "any-typed" };
    return { location, unresolvedReason: fallbackReason ?? "unresolved-symbol" };
  }

  /**
   * `any` without a `TypeFlags` bit to test: the native `Type` exposes its
   * flags inconsistently across shapes, so the compiler's own rendering is the
   * check. `typeToString` is what the native API offers in place of the flag,
   * and `"any"` is not a name a declared type can take.
   */
  private isAnyType(type: Node): boolean {
    if (type === undefined) return false;
    const flags = type.flags;
    if (typeof flags === "number") return (flags & this.api_TypeFlags_Any()) !== 0;
    try {
      return this.checker.typeToString(type) === "any";
    } catch {
      return false;
    }
  }

  private api_TypeFlags_Any(): number {
    return loaded?.api.TypeFlags?.Any ?? 1;
  }

  /**
   * The native `Checker` has no `getFullyQualifiedName` (ADR-0001, "gate 1"),
   * so the name is reconstructed from the symbol's parent chain — the shape
   * `scripts/m05-probe/native-primitives.ts` measured. `Set.has` and
   * `Body.text` come out the same as the legacy checker's; a symbol whose
   * chain reaches a module or the global scope stops there rather than
   * inventing a prefix.
   */
  private fullyQualifiedNameOf(symbol: Node): string | undefined {
    const parts: string[] = [];
    let current: Node | undefined = symbol;
    for (let hops = 0; current && hops < 8; hops++) {
      const name: string | undefined = current.name;
      if (name === undefined || name === "" || name.startsWith("__")) break;
      parts.unshift(name);
      current = current.getParent();
    }
    return parts.length > 0 ? parts.join(".") : undefined;
  }

  private objectLiteralMemberTarget(member: Node): SymbolId | undefined {
    const is = this.is;
    if (!this.isInIndexableObjectLiteral(member)) return undefined;
    const own = this.declaredNodeToId.get(member);
    if (own) return own;
    // `{ read: readIt }` / `{ readIt }` — one hop to the referenced function.
    const value = is.isPropertyAssignment(member)
      ? member.initializer
      : is.isShorthandPropertyAssignment(member)
        ? member.name
        : undefined;
    if (!value || !is.isIdentifier(value)) return undefined;
    let symbol = is.isShorthandPropertyAssignment(member)
      ? this.checker.getShorthandAssignmentValueSymbol(member)
      : this.checker.getSymbolAtLocation(value);
    if (symbol && (symbol.flags & this.SymbolFlags.Alias) !== 0) {
      symbol = this.checker.getAliasedSymbol(symbol);
    }
    const declaration = this.implementationDeclarationOf(symbol);
    return declaration ? this.declaredNodeToId.get(declaration) : undefined;
  }

  // ---- names -------------------------------------------------------------

  private qualifiedNameOf(
    expr: Node,
    aliasResolved: boolean,
    _factoryOriginAllowed: boolean,
  ): string | undefined {
    const is = this.is;
    if (is.isIdentifier(expr)) {
      if (aliasResolved) {
        const imported = this.importedQualifiedNameOf(expr);
        if (imported) return imported;
      }
      return expr.text;
    }
    if (is.isPropertyAccessExpression(expr)) {
      // Only the namespace/default-import origin is ported — see NOT_PORTED.
      const segments: string[] = [];
      let current: Node = expr;
      while (is.isPropertyAccessExpression(current)) {
        segments.unshift(current.name.text);
        current = current.expression;
      }
      if (!is.isIdentifier(current)) return undefined;
      const origin = this.moduleSpecifierOf(current);
      return origin ? `${origin}.${segments.join(".")}` : undefined;
    }
    return undefined;
  }

  /** `import { readFileSync } from "node:fs"` → `node:fs.readFileSync`. */
  private importedQualifiedNameOf(expr: Node): string | undefined {
    const is = this.is;
    const symbol = this.checker.getSymbolAtLocation(expr);
    const declaration = symbol?.declarations?.[0]?.resolve(this.project);
    if (!declaration || !is.isImportSpecifier(declaration)) return undefined;
    const importDeclaration = declaration.parent?.parent?.parent;
    if (!importDeclaration || !is.isImportDeclaration(importDeclaration)) return undefined;
    const specifier = importDeclaration.moduleSpecifier;
    if (!specifier || !is.isStringLiteral(specifier)) return undefined;
    const imported: string = declaration.propertyName?.text ?? declaration.name?.text ?? "";
    return imported ? `${specifier.text}.${imported}` : undefined;
  }

  /** `import * as fs from "node:fs"` / `import fs from "node:fs"` → `node:fs`. */
  private moduleSpecifierOf(expr: Node): string | undefined {
    const is = this.is;
    const symbol = this.checker.getSymbolAtLocation(expr);
    // Not de-aliased: the import *binding* is what names the module. A
    // de-aliased symbol lands on the module's own declaration, which has no
    // specifier to read.
    const declaration = this.declarationsOf(symbol).find(
      (d: Node) => is.isNamespaceImport(d) || is.isImportClause(d) || is.isImportSpecifier(d),
    );
    if (!declaration) return undefined;
    if (is.isImportSpecifier(declaration)) return undefined;
    let importDeclaration: Node | undefined;
    if (is.isNamespaceImport(declaration)) importDeclaration = declaration.parent?.parent;
    else if (is.isImportClause(declaration)) importDeclaration = declaration.parent;
    if (!importDeclaration || !is.isImportDeclaration(importDeclaration)) return undefined;
    const specifier = importDeclaration.moduleSpecifier;
    return specifier && is.isStringLiteral(specifier) ? specifier.text : undefined;
  }

  // ---- arguments ----------------------------------------------------------

  private literalArgumentsOf(node: Node): readonly (LiteralArgument | undefined)[] {
    return [...(node.arguments ?? [])].map((argument: Node) => this.literalArgumentOf(argument));
  }

  private literalArgumentOf(argument: Node): LiteralArgument | undefined {
    const is = this.is;
    if (is.isStringLiteral(argument) || is.isNoSubstitutionTemplateLiteral(argument)) {
      return { text: argument.text, complete: true };
    }
    if (is.isTemplateExpression(argument)) {
      return { text: argument.head.text, complete: false };
    }
    if (is.isObjectLiteralExpression(argument)) {
      const properties = new Map<string, string>();
      for (const property of argument.properties) {
        if (!is.isPropertyAssignment(property)) continue;
        if (!property.name || !is.isIdentifier(property.name)) continue;
        const value = property.initializer;
        if (!value || !is.isStringLiteral(value)) continue;
        properties.set(property.name.text, value.text);
      }
      return properties.size > 0 ? { properties } : undefined;
    }
    return undefined;
  }

  private callableArgumentFields(node: Node): {
    callbackByReference?: true;
    callbackTargets?: readonly SymbolId[];
  } {
    const callable = this.callableArgumentsOf(node);
    return {
      ...(callable.opaque ? { callbackByReference: true as const } : {}),
      ...(callable.targets.length > 0 ? { callbackTargets: callable.targets } : {}),
    };
  }

  /**
   * The callables passed *by reference*, split into the ones that reach an
   * extracted function and the ones that do not. An inline callback is not
   * here: its body is walked as part of the enclosing function's calls.
   */
  private callableArgumentsOf(node: Node): {
    readonly opaque: boolean;
    readonly targets: readonly SymbolId[];
  } {
    const is = this.is;
    const signature = this.checker.getResolvedSignature(node);
    const targets: SymbolId[] = [];
    let opaque = false;
    for (const [index, argument] of [...(node.arguments ?? [])].entries()) {
      if (is.isArrowFunction(argument) || is.isFunctionExpression(argument)) continue;
      if (signature && !this.acceptsCallableArgument(signature, index)) continue;
      // Callability is decided by the argument's *type*, never by whether a
      // declaration was found: a callback parameter (`xs.map(f)` inside a
      // higher-order function) has a declaration that is not function-valued,
      // and skipping it made the call read as fully analyzed. That is the
      // direction DESIGN.md §4.2 rule 4 forbids — "if it cannot be inferred,
      // `unknown`" — and it was measured as two `shadow-less-unknown`
      // divergences on `test/fixtures/backend-conformance/generics.ts`.
      if (!this.isCallableArgumentType(this.checker.getTypeAtLocation(argument))) continue;
      const target = this.extractedFunctionTarget(argument);
      if (target) targets.push(target);
      else opaque = true;
    }
    return { opaque, targets };
  }

  /** The extracted function an expression names, following the callee path. */
  private extractedFunctionTarget(expression: Node): SymbolId | undefined {
    const is = this.is;
    const expr = this.unwrapNonNullAssertions(expression);
    if (!is.isIdentifier(expr) && !is.isPropertyAccessExpression(expr)) return undefined;
    let symbol = this.checker.getSymbolAtLocation(expr);
    if (!symbol) return undefined;
    if ((symbol.flags & this.SymbolFlags.Alias) !== 0) {
      symbol = this.checker.getAliasedSymbol(symbol);
    }
    const declaration = this.implementationDeclarationOf(symbol);
    if (!declaration) return undefined;
    return this.declaredNodeToId.get(declaration) ?? this.objectLiteralMemberTarget(declaration);
  }

  /**
   * Whether argument position `index` is a callback slot, read off the
   * *declared* parameter type. Every branch that cannot tell falls back to
   * "yes", so the narrowing can only add opacity checks back, never drop one.
   */
  private acceptsCallableArgument(signature: Node, index: number): boolean {
    const declaration = signature.declaration;
    if (!declaration || this.is.isJSDocSignature(declaration)) return true;
    const parameter = [...(declaration.parameters ?? [])][index];
    if (!parameter || parameter.dotDotDotToken) return true;
    return this.isCallableArgumentType(this.checker.getTypeAtLocation(parameter));
  }

  /**
   * `any`/`unknown` counts as callable: such a value has no call signatures of
   * its own, and treating "no signatures" as "not a callback" would let
   * `arr.map(fnFromAnyRecord)` past the guard above.
   */
  private isCallableArgumentType(type: Node): boolean {
    if (type === undefined) return false;
    if (this.isAnyType(type) || this.isUnknownType(type)) return true;
    if (type.isUnionType?.() === true) {
      return [...(type.getTypes?.() ?? [])].some((t: Node) => this.isCallableArgumentType(t));
    }
    try {
      return this.checker.getSignaturesOfType(type, this.callSignatureKind()).length > 0;
    } catch {
      return false;
    }
  }

  private callSignatureKind(): Any {
    return loaded?.api.SignatureKind?.Call ?? 0;
  }

  private isUnknownType(type: Node): boolean {
    try {
      return this.checker.typeToString(type) === "unknown";
    } catch {
      return false;
    }
  }

  // ---- mutation -----------------------------------------------------------

  /**
   * An assignment, `++`/`--`, or `delete` that writes somewhere the enclosing
   * function does not own (DESIGN.md §4.2, "Local mutation and `pure`"). One
   * escaping leaf makes the whole statement a write.
   */
  private classifyAssignment(node: Node, sourceFile: Node, enclosing: Node): CallSite | undefined {
    const target = this.assignmentTargetOf(node);
    if (!target) return undefined;
    const escaping = this.assignmentLeavesOf(target).some(
      (leaf: Node) => !this.isLocalAssignmentLeaf(leaf, enclosing),
    );
    if (!escaping) return undefined;
    return { location: this.locationOf(sourceFile, node), mutation: { escaping: true } };
  }

  /**
   * Whether writing to one leaf stays inside `enclosing`. A bare identifier the
   * function itself declared is its own local; anything else goes through the
   * locality rule.
   *
   * The identifier branch is load-bearing rather than an optimization: without
   * it a module-scope rebinding (`unscopedPolicy = policy`) is not a
   * property write and would be dropped entirely, taking its `state_write`
   * with it. Measured — one `shadow-less-authority` divergence on `src`,
   * `runtime/enforce.ts#setUnscopedPolicy`.
   */
  private isLocalAssignmentLeaf(leaf: Node, enclosing: Node): boolean {
    const is = this.is;
    if (is.isIdentifier(leaf)) {
      const declaration = this.valueDeclarationOf(this.checker.getSymbolAtLocation(leaf));
      return declaration !== undefined && this.isLexicallyInside(declaration, enclosing);
    }
    if (!is.isPropertyAccessExpression(leaf) && !is.isElementAccessExpression(leaf)) return false;
    return this.isLocallyOwnedMutationTarget(leaf, enclosing);
  }

  /** A symbol's value declaration, resolved from its handle. */
  private valueDeclarationOf(symbol: Node): Node | undefined {
    const handle = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    return handle?.resolve(this.project);
  }

  private assignmentTargetOf(node: Node): Node | undefined {
    const is = this.is;
    if (is.isBinaryExpression(node) && is.isAssignmentOperatorToken(node.operatorToken)) {
      return node.left;
    }
    if (
      (is.isPostfixUnaryExpression(node) || is.isPrefixUnaryExpression(node)) &&
      (node.operator === this.K.PlusPlusToken || node.operator === this.K.MinusMinusToken)
    ) {
      return node.operand;
    }
    if (is.isDeleteExpression(node)) return node.expression;
    return undefined;
  }

  /** The individual places an assignment target writes to, destructuring flattened. */
  private assignmentLeavesOf(target: Node): readonly Node[] {
    const is = this.is;
    if (is.isArrayLiteralExpression(target)) {
      return [...target.elements].flatMap((element: Node) =>
        is.isOmittedExpression(element)
          ? []
          : this.assignmentLeavesOf(this.stripAssignmentDefault(element)),
      );
    }
    if (is.isObjectLiteralExpression(target)) {
      return [...target.properties].flatMap((property: Node) => {
        if (is.isPropertyAssignment(property)) {
          return this.assignmentLeavesOf(this.stripAssignmentDefault(property.initializer));
        }
        if (is.isShorthandPropertyAssignment(property)) return [property.name];
        if (is.isSpreadAssignment(property)) return this.assignmentLeavesOf(property.expression);
        return [];
      });
    }
    if (is.isSpreadElement(target)) return this.assignmentLeavesOf(target.expression);
    return [target];
  }

  /** `a.x = 1` in `[a.x = 1] = xs`: the default value is not part of the target. */
  private stripAssignmentDefault(node: Node): Node {
    return this.is.isBinaryExpression(node) && node.operatorToken?.kind === this.K.EqualsToken
      ? node.left
      : node;
  }

  /** The base of a property/element access chain, through the wrappers that change no value. */
  private mutationRootOf(target: Node): Node {
    const is = this.is;
    let current = target;
    for (;;) {
      if (
        is.isPropertyAccessExpression(current) ||
        is.isElementAccessExpression(current) ||
        is.isNonNullExpression(current) ||
        is.isParenthesizedExpression(current) ||
        is.isAsExpression(current)
      ) {
        current = current.expression;
        continue;
      }
      return current;
    }
  }

  /**
   * The locality rule of DESIGN.md §4.2: local iff the root is a fresh
   * allocation, or an identifier bound by `const` inside `enclosing` to one.
   * A parameter, `this`, an outer or module-scope binding, a `let`, and an
   * unresolvable root are all escaping — over-approximated on purpose.
   */
  private isLocallyOwnedMutationTarget(target: Node, enclosing: Node): boolean {
    const is = this.is;
    const root = this.mutationRootOf(target);
    if (this.isFreshAllocation(root)) return true;
    if (root.kind === this.K.ThisKeyword) return this.isThisOfNewOperand(root);
    if (!is.isIdentifier(root)) return false;

    const declaration = this.valueDeclarationOf(this.checker.getSymbolAtLocation(root));
    if (!declaration || !is.isVariableDeclaration(declaration)) return false;
    if (((declaration.parent?.flags ?? 0) & this.ast.NodeFlags.Const) === 0) return false;
    if (!declaration.initializer || !this.isFreshAllocation(declaration.initializer)) return false;
    return this.isLexicallyInside(declaration, enclosing);
  }

  /**
   * `this` denoting an object nothing else holds yet: the operand of a `new`,
   * or a base class's constructor. Calling a constructor's `this.x = x` a
   * `state_write` would make `pure` unusable on every constructor in the
   * language subset Ambit targets (`erasableSyntaxOnly`: no parameter
   * properties).
   */
  private isThisOfNewOperand(node: Node): boolean {
    const is = this.is;
    for (let current: Node | undefined = node; current; current = current.parent) {
      if (is.isFunctionDeclaration(current) || is.isFunctionExpression(current)) {
        return current.parent !== undefined && is.isNewExpression(current.parent);
      }
      if (is.isConstructorDeclaration(current)) {
        return (
          is.isClassLikeDeclaration(current.parent) &&
          this.baseTypeExpressionOf(current.parent) === undefined
        );
      }
      if (is.isClassLikeDeclaration(current) || is.isSourceFile(current)) return false;
    }
    return false;
  }

  private isFreshAllocation(node: Node): boolean {
    const is = this.is;
    return (
      is.isArrayLiteralExpression(node) ||
      is.isObjectLiteralExpression(node) ||
      is.isNewExpression(node)
    );
  }

  private isLexicallyInside(node: Node, ancestor: Node): boolean {
    for (let current: Node | undefined = node; current; current = current.parent) {
      if (current === ancestor) return true;
    }
    return false;
  }

  // ---- runtime wrappers ---------------------------------------------------

  private collectRuntimeWrappers(sourceFile: Node): readonly RuntimeWrapper[] {
    const is = this.is;
    const wrappers: RuntimeWrapper[] = [];
    const visit = (node: Node): void => {
      if (is.isCallExpression(node)) {
        const wrapper = this.runtimeWrapperOf(node, sourceFile);
        if (wrapper) wrappers.push(wrapper);
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
    return wrappers;
  }

  private runtimeWrapperNameOf(callee: Node): string | undefined {
    const is = this.is;
    if (!is.isIdentifier(callee)) return undefined;
    const qualified = this.importedQualifiedNameOf(callee);
    return qualified ? RUNTIME_WRAPPER_NAMES.get(qualified) : undefined;
  }

  private runtimeWrapperOf(node: Node, sourceFile: Node): RuntimeWrapper | undefined {
    const wrapper = this.runtimeWrapperNameOf(node.expression);
    if (!wrapper) return undefined;
    const args = [...(node.arguments ?? [])];
    const spec = args[0];
    const handlerArgument = args[1];
    const handler = this.sameFileHandlerOf(handlerArgument);
    const capabilities = this.literalCapabilityListOf(spec);
    const budget = this.literalBudgetOf(spec);
    return {
      location: this.locationOf(sourceFile, node),
      wrapper,
      ...(capabilities ? { capabilities } : {}),
      ...(budget ? { budget } : {}),
      ...(handler ? { handler } : { unmatchedReason: "handler-not-in-this-file" as const }),
    };
  }

  private sameFileHandlerOf(argument: Node): SymbolId | undefined {
    if (!argument || !this.is.isIdentifier(argument)) return undefined;
    let symbol = this.checker.getSymbolAtLocation(argument);
    if (symbol && (symbol.flags & this.SymbolFlags.Alias) !== 0) {
      symbol = this.checker.getAliasedSymbol(symbol);
    }
    const declaration = this.implementationDeclarationOf(symbol);
    return declaration ? this.declaredNodeToId.get(declaration) : undefined;
  }

  private specProperty(spec: Node, name: string): Node | undefined {
    const is = this.is;
    if (!spec || !is.isObjectLiteralExpression(spec)) return undefined;
    for (const property of spec.properties) {
      if (!is.isPropertyAssignment(property)) continue;
      if (!property.name || !is.isIdentifier(property.name)) continue;
      if (property.name.text === name) return property.initializer;
    }
    return undefined;
  }

  private literalCapabilityListOf(spec: Node): readonly string[] | undefined {
    const is = this.is;
    const value = this.specProperty(spec, "capabilities");
    if (!value || !is.isArrayLiteralExpression(value)) return undefined;
    const capabilities: string[] = [];
    for (const element of value.elements) {
      if (!is.isStringLiteral(element) && !is.isNoSubstitutionTemplateLiteral(element)) {
        return undefined;
      }
      capabilities.push(element.text);
    }
    return capabilities;
  }

  private literalBudgetOf(spec: Node): WrapperBudget | undefined {
    const is = this.is;
    if (!spec || !is.isObjectLiteralExpression(spec)) return undefined;
    const value = this.specProperty(spec, "budget");
    if (!value) {
      // A spec that writes no budget at all fixes it as absent.
      return { kind: "absent" };
    }
    if (!is.isObjectLiteralExpression(value)) return undefined;
    const budget: { calls?: number; ms?: number; onExceed?: string } = {};
    for (const property of value.properties) {
      if (!is.isPropertyAssignment(property)) return undefined;
      if (!property.name || !is.isIdentifier(property.name)) return undefined;
      const key = property.name.text;
      const initializer = property.initializer;
      if (key === "calls" || key === "ms") {
        const numeric = this.numericLiteralOf(initializer);
        if (numeric === undefined) return undefined;
        budget[key] = numeric;
      } else if (key === "onExceed") {
        if (!is.isStringLiteral(initializer)) return undefined;
        if (!isOnExceed(initializer.text)) return undefined;
        budget.onExceed = initializer.text;
      } else {
        return undefined;
      }
    }
    return { kind: "literal", ...budget } as WrapperBudget;
  }

  private numericLiteralOf(node: Node): number | undefined {
    const is = this.is;
    if (is.isNumericLiteral(node)) return Number(node.text);
    if (is.isPrefixUnaryExpression(node) && node.operator === this.K.MinusToken) {
      const inner = this.numericLiteralOf(node.operand);
      return inner === undefined ? undefined : -inner;
    }
    return undefined;
  }
}
