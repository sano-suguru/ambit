import type { SourceLocation } from "./location.ts";
import type { SymbolId } from "./symbol-id.ts";

/**
 * Why a call's target — or its effects — could not be resolved
 * (DESIGN.md §4.2 rule 6, and rule 4 for `callback-parameter`).
 */
export type UnresolvedReason =
  | "dynamic-import"
  | "eval"
  | "new-function"
  | "any-typed"
  | "callback-parameter"
  | "overload-without-body"
  | "unresolved-symbol";

/**
 * One call expression found while walking a function's body.
 *
 * Exactly one of `resolvedCallee` and `unresolvedReason` should be set when
 * the call could not be matched to a stub. `calleeQualifiedName` is a
 * best-effort textual name (e.g. `"fetch"`, `"fs.readFileSync"`) used by
 * `src/stubs/` to recognize known standard-library/library calls; it carries
 * no meaning on its own and is never treated as a resolved call target.
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
  extractProject(rootDir: string): Promise<readonly ExtractedFile[]>;
}
