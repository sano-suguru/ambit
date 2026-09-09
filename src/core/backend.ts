import type { SourceLocation } from "./location.ts";
import type { SymbolId } from "./symbol-id.ts";

/**
 * Why a call's target — or its effects — could not be resolved
 * (DESIGN.md §4.2 rule 6, and rule 4 for `callback-parameter`).
 *
 * `import-binding`, `builtin-method`, and `external-module` sub-classify
 * what was previously reported as a bare `unresolved-symbol`, so `ambit
 * check --coverage` can show *why* a call is unresolved instead of a single
 * undifferentiated count:
 * - `import-binding`: the callee is a call to an imported identifier whose
 *   alias could not be followed to any declaration at all — the module
 *   specifier doesn't resolve, or the named export doesn't exist
 *   (`checker.getAliasedSymbol()` returns TypeScript's `unknownSymbol`).
 *   Distinct from `unresolved-symbol` in that the shape is known (an import
 *   binding) even though the target is not; unlike `unresolved-symbol`, a
 *   stub match may still apply if the qualified name happens to be
 *   recognized (see `classifyCall`).
 * - `builtin-method`: the callee resolved to an ambient declaration from
 *   TypeScript's default lib (e.g. `Array.prototype.map`, `Set.prototype.has`)
 *   whose call site (a method on a local value) `qualifiedNameOf` cannot
 *   turn into a name the stub table can key on.
 * - `external-module`: same shape, but the ambient declaration lives in a
 *   third-party package's `.d.ts` under `node_modules` (e.g. an ORM client
 *   installed as a dependency) rather than the default lib.
 * - `ambient-declaration`: the callee resolved to a declaration in a `.d.ts`
 *   that is part of the project itself — a hand-written `declare module "pg"`
 *   or a `declare function`, neither shipped with the compiler nor installed
 *   as a package. Distinct from `external-module` because the two are fixed
 *   differently: the first is the project's own file to annotate, the second
 *   needs a bundled or package-provided stub.
 * `unresolved-symbol` remains the residual case: either no declaration could
 * be found at all, or one was found but the call still cannot be followed to
 * an extracted function — a nested function declaration, or a receiver with no
 * single object literal certainly behind it (a parameter, a `let` binding, a
 * literal carrying a spread). In the latter shapes the call target may be
 * fully known to the compiler and may even declare its own `@effects`; the
 * call site simply has no one `SymbolId` it can honestly propagate from.
 */
export type UnresolvedReason =
  | "dynamic-import"
  | "eval"
  | "new-function"
  | "any-typed"
  | "callback-parameter"
  | "overload-without-body"
  | "import-binding"
  | "builtin-method"
  | "external-module"
  | "ambient-declaration"
  | "unresolved-symbol";

/**
 * What kind of function-like node was seen but not extracted (DESIGN.md
 * §4.3's coverage concern, and the connector layer's documented slice
 * boundary — see `collectFunctionLikeDeclarations` in
 * `src/checker/backend/legacy-ts.ts`). Purely descriptive; carries no
 * compiler-specific node, so it can cross the `TsBackend` boundary freely.
 *
 * `class-declaration` is not a function-like node at all; it appears only as
 * the reason a contract written on a `class` cannot be carried — the contract
 * belongs on the class's constructor. It is reported through
 * `uncarriedContracts` and deliberately not counted in `skippedFunctions`,
 * which counts function-like nodes.
 *
 * `object-literal-method` is narrower than its name: a member of a module-scope
 * `const` literal with an identifier name *is* extracted. What remains are the
 * members that have no stable declaration path (a computed, string, or numeric
 * key) or no path at all (a nested literal, one declared inside a function
 * body, one passed inline as an argument, or one bound by `let`).
 */
export type SkippedFunctionKind =
  | "class-declaration"
  | "getter-setter"
  | "object-literal-method"
  | "anonymous-default-export"
  | "callback-argument"
  | "nested-function"
  | "other";

/**
 * What the connector layer could read statically from one call argument.
 *
 * Carries no compiler object, so it crosses the `TsBackend` boundary freely
 * (DESIGN.md §3.4). Two consumers need it, and both need the same distinction
 * between "this is the whole value" and "this is only how the value starts":
 * `src/stubs/data-clients.ts` reads a SQL statement's leading keyword, and
 * `src/stubs/http-capabilities.ts` reads a URL's host. A template literal's
 * static head is enough for both, and is enough for neither to claim it saw
 * the whole string — hence {@link complete}.
 */
export interface LiteralArgument {
  /**
   * A string literal's value, or a template literal's static leading text.
   * Absent when the argument is not a string at all (an object literal, say —
   * see {@link properties}).
   */
  readonly text?: string;
  /**
   * False when {@link text} is only a prefix (a template literal with a
   * substitution). Absent when there is no `text`.
   */
  readonly complete?: boolean;
  /**
   * An object literal's string-literal properties, for an options argument
   * like `fetch(url, { method: "POST" })`. Only identifier-named properties
   * whose value is a string literal appear; anything else is left out rather
   * than guessed at.
   */
  readonly properties?: ReadonlyMap<string, string>;
}

/**
 * One call expression found while walking a function's body.
 *
 * `resolvedCallee` is set only for a project-local call. `calleeQualifiedName`
 * is a best-effort textual name (e.g. `"fetch"`, `"fs.readFileSync"`) used by
 * `src/stubs/node-builtins.ts` to recognize known standard-library/library
 * calls; it carries no meaning on its own and is never treated as a resolved
 * call target. `pureBuiltinName` is a separate, checker-derived name
 * (`checker.getFullyQualifiedName()` form, e.g. `"Set.has"`) set only when
 * `calleeQualifiedName` could not be produced (a builtin method reached
 * through a local value, e.g. `set.has(...)`) — it is checked against
 * `src/stubs/pure-builtins.ts`'s allowlist, a different namespace from
 * `calleeQualifiedName`'s module-specifier keys; the two must never be
 * merged or compared. `unresolvedReason` may accompany either name as the
 * reason to fall back to if no match is found (`src/checker/summarize.ts`'s
 * `toCall`) — the connector layer already knows, from the callee's own
 * declaration, whether a miss would mean "unresolved-symbol" or something
 * more specific (e.g. `builtin-method`). `callbackByReference` is set when
 * one of the call's arguments is a callable passed by reference rather than
 * written inline (`arr.forEach(handler)`, not `arr.forEach(x => ...)`): an
 * inline callback's body is walked by `collectCalls` and its effects
 * attributed to the enclosing function, but a callback passed by reference
 * is never visited, so `pureBuiltinName` must not be trusted as pure when
 * this is set (DESIGN.md §4.2 rule 4) — regardless of what
 * `src/stubs/pure-builtins.ts` says about the method name itself.
 */
export interface CallSite {
  readonly location: SourceLocation;
  readonly resolvedCallee?: SymbolId;
  readonly calleeQualifiedName?: string;
  readonly pureBuiltinName?: string;
  readonly callbackByReference?: true;
  /**
   * What each argument was, statically, indexed by position — `undefined`
   * where nothing could be read. Present only when `calleeQualifiedName` is:
   * the arguments matter to a stub table keyed on that name, and to nothing
   * else.
   */
  readonly literalArguments?: readonly (LiteralArgument | undefined)[];
  /**
   * Set on a construction (`new X(...)`, `super(...)`, a derived class's
   * implicit base call) that passes no arguments. `src/stubs/constructors.ts`
   * needs it to tell `new Date()` (reads the clock — `env`) from
   * `new Date(2020, 0, 1)` (a pure conversion of its arguments). Absent on a
   * plain call.
   */
  readonly constructedWithoutArguments?: true;
  readonly unresolvedReason?: UnresolvedReason;
}

/** Raw JSDoc tag text for one function declaration, before contract parsing. */
export interface RawJsDoc {
  readonly tags: ReadonlyMap<string, string>;
  /**
   * Where each tag was written, so a fix can replace the tag itself rather
   * than guess at a line (DESIGN.md §5.3: `fixes[].edits` must be a concrete,
   * applicable patch). Same 1-based, end-exclusive convention as every other
   * `SourceLocation`; `diagnose.ts` converts to the 0-based edit range §5.3
   * specifies. Character offsets are UTF-16 units, which is what the
   * compiler already reports.
   */
  readonly tagLocations: ReadonlyMap<string, SourceLocation>;
}

/** Everything the connector layer can extract about one function/method declaration. */
export interface ExtractedFunction {
  readonly id: SymbolId;
  readonly location: SourceLocation;
  /**
   * Where the declaration itself begins (`export async function …`, not the
   * name), so `ambit init` can insert a JSDoc block above it at the right
   * indentation. `location` points at the name, which is the right place for
   * a diagnostic and the wrong place for an edit.
   */
  readonly declarationStart: SourceLocation;
  /**
   * The single JSDoc block attached to this declaration, when there is
   * exactly one — so a fix can add a tag to the comment that is already there
   * instead of stacking a second block above it. Independent of whether that
   * block contains any tags: a purely descriptive comment is the common case
   * `ambit init` has to add to.
   */
  readonly jsDocRange?: SourceLocation;
  /**
   * Set on a class's construction entry when the class writes no constructor.
   * The entry is real — property initializers and the base constructor still
   * run, and their effects still propagate — but it has no declaration site,
   * so no contract can be attached to it. A proposal to declare one would be
   * a patch that changes nothing, which is worse than no proposal.
   */
  readonly implicitConstructor?: true;
  readonly jsDoc: RawJsDoc | undefined;
  readonly calls: readonly CallSite[];
}

export interface ExtractedFile {
  readonly filePath: string;
  readonly functions: readonly ExtractedFunction[];
}

/**
 * A contract written on a function-like node the backend did not extract, and
 * which therefore cannot carry one. Reported as `AMB-E003` rather than
 * dropped: a declaration that silently does nothing is the opposite of what
 * Ambit is for (DESIGN.md §3.4 — 解析失敗を「違反なし」に変換しない).
 *
 * `kind` is the same classification `skippedFunctions` counts, so the message
 * can say *why* the node cannot carry the contract.
 */
export interface UncarriedContract {
  readonly location: SourceLocation;
  readonly kind: SkippedFunctionKind;
  readonly tag: string;
  readonly raw: string;
}

/**
 * Everything `extractProject` produces for one run: the extracted files, how
 * many function-like nodes it saw but did not extract (by kind), and any
 * contract written on one of those nodes.
 *
 * The count exists so "no violations" and "nothing was analyzed" stay
 * distinguishable (DESIGN.md §3.4) — a file made entirely of, say, callback
 * arguments would otherwise vanish from `files` with no trace.
 *
 * Both fields are required, not optional: a backend that omitted them would
 * silently under-report what it could not analyze, which is the failure mode
 * they exist to prevent.
 */
export interface ExtractedProject {
  readonly files: readonly ExtractedFile[];
  readonly skippedFunctions: ReadonlyMap<SkippedFunctionKind, number>;
  readonly uncarriedContracts: readonly UncarriedContract[];
}

/**
 * The connector layer's contract with the rest of Ambit (DESIGN.md §3.4,
 * §3.5). No TypeScript-specific object (`ts.Node`, `ts.Symbol`, `ts.Type`,
 * a compiler-internal id, ...) may cross this boundary in either direction.
 *
 * Implementations live under `src/checker/backend/`. The only implementation
 * in this slice, `legacy-ts.ts`, is a throwaway (DESIGN.md §3.5 has not run
 * yet) and must stay the only file that imports `typescript`.
 */
export interface TsBackend {
  readonly name: string;
  readonly version: string;
  extractProject(rootDir: string): Promise<ExtractedProject>;
}
