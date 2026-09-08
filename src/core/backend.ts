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
 * - `import-binding`: the callee resolved to an `ImportSpecifier`/
 *   `ImportClause` rather than the declaration behind it — today's known
 *   cross-module resolution gap (the connector layer does not yet follow
 *   `checker.getAliasedSymbol()`). Should trend toward 0 as that gap closes.
 * - `builtin-method`: the callee resolved to an ambient declaration from
 *   TypeScript's default lib (e.g. `Array.prototype.map`, `Set.prototype.has`)
 *   whose call site (a method on a local value) `qualifiedNameOf` cannot
 *   turn into a name the stub table can key on.
 * - `external-module`: same shape, but the ambient declaration lives in a
 *   third-party package's `.d.ts` (e.g. an ORM client) rather than the
 *   default lib.
 * `unresolved-symbol` remains the residual case: no declaration could be
 * found at all.
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
  | "unresolved-symbol";

/**
 * What kind of function-like node was seen but not extracted (DESIGN.md
 * §4.3's coverage concern, and the connector layer's documented slice
 * boundary — see `collectFunctionLikeDeclarations` in
 * `src/checker/backend/legacy-ts.ts`). Purely descriptive; carries no
 * compiler-specific node, so it can cross the `TsBackend` boundary freely.
 */
export type SkippedFunctionKind =
  | "getter-setter"
  | "object-literal-method"
  | "anonymous-default-export"
  | "callback-argument"
  | "nested-function"
  | "other";

/**
 * One call expression found while walking a function's body.
 *
 * `resolvedCallee` is set only for a project-local call. `calleeQualifiedName`
 * is a best-effort textual name (e.g. `"fetch"`, `"fs.readFileSync"`) used by
 * `src/stubs/` to recognize known standard-library/library calls; it carries
 * no meaning on its own and is never treated as a resolved call target.
 * `unresolvedReason` may accompany `calleeQualifiedName` as the reason to
 * fall back to if no stub matches that name (`src/checker/summarize.ts`'s
 * `toCall`) — the connector layer already knows, from the callee's own
 * declaration, whether a stub miss would mean "unresolved-symbol" or
 * something more specific (e.g. `builtin-method`).
 */
export interface CallSite {
  readonly location: SourceLocation;
  readonly resolvedCallee?: SymbolId;
  readonly calleeQualifiedName?: string;
  readonly unresolvedReason?: UnresolvedReason;
}

/** Raw JSDoc tag text for one function declaration, before contract parsing. */
export interface RawJsDoc {
  readonly tags: ReadonlyMap<string, string>;
}

/** Everything the connector layer can extract about one function/method declaration. */
export interface ExtractedFunction {
  readonly id: SymbolId;
  readonly location: SourceLocation;
  readonly jsDoc: RawJsDoc | undefined;
  readonly calls: readonly CallSite[];
}

export interface ExtractedFile {
  readonly filePath: string;
  readonly functions: readonly ExtractedFunction[];
}

/**
 * Everything `extractProject` produces for one run: the extracted files, plus
 * how many function-like nodes it saw but did not extract, by kind
 * (`SkippedFunctionKind`). The count exists so "no violations" and "nothing
 * was analyzed" stay distinguishable (DESIGN.md §3.4) — a file made entirely
 * of, say, object-literal methods would otherwise vanish from `files` with no
 * trace.
 */
export interface ExtractedProject {
  readonly files: readonly ExtractedFile[];
  readonly skippedFunctions: ReadonlyMap<SkippedFunctionKind, number>;
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
