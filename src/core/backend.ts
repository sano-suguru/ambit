import type { BudgetInput } from "./budget.ts";
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
 *
 * `bodyless-declaration` is a function-like node that declares a signature and
 * no code: an overload signature, an `abstract` member, or an ambient
 * `declare` written in a `.ts` file. It is skipped because it is not a
 * function — the implementation is (DESIGN.md §4.1, "Overloads and bodyless
 * declarations"). Indexing one would give two declarations the same declaration
 * path, and the first of them has no body to infer effects from, so every
 * caller would read as `pure` whatever the implementation does.
 */
export type SkippedFunctionKind =
  | "class-declaration"
  | "getter-setter"
  | "object-literal-method"
  | "anonymous-default-export"
  | "callback-argument"
  | "nested-function"
  | "bodyless-declaration"
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
 * written inline (`arr.forEach(handler)`, not `arr.forEach(x => ...)`) **and
 * that reference could not be followed to a function this project extracted**:
 * an inline callback's body is walked by `collectCalls` and its effects
 * attributed to the enclosing function, and a resolvable reference becomes a
 * {@link CallSite.callbackTargets} edge, but a callback that is neither is
 * never visited, so `pureBuiltinName` must not be trusted as pure when this is
 * set (DESIGN.md §4.2 rule 4) — regardless of what
 * `src/stubs/pure-builtins.ts` says about the method name itself.
 */
export interface CallSite {
  readonly location: SourceLocation;
  readonly resolvedCallee?: SymbolId;
  readonly calleeQualifiedName?: string;
  readonly pureBuiltinName?: string;
  readonly callbackByReference?: true;
  /**
   * The callable arguments passed *by reference* that do resolve to a
   * function this project extracted (`arr.map(toCall)` where `toCall` is a
   * declaration in the analyzed tree).
   *
   * DESIGN.md §4.2 rule 4 asks for exactly this — "the effects of a callback
   * parameter are inferred from the actual argument at the call site" — and
   * the actual argument here is a function whose body was analyzed. Recorded
   * apart from {@link CallSite.callbackByReference}, which is what remains
   * when the argument is *not* resolvable and the call therefore still has to
   * fall to `unknown`.
   *
   * It is a fact about the call, not a verdict: `src/checker/summarize.ts`
   * turns these into call-graph edges only where the callee itself is known
   * to invoke what it is handed — a higher-order allowlisted builtin, or a
   * mutating one whose verdict covers only its receiver (`arr.sort(cmp)`) —
   * so a method that merely inspects a function value (`Array.isArray(fn)`)
   * gains no edge it does not have.
   */
  readonly callbackTargets?: readonly SymbolId[];
  /**
   * Set when this site mutates a value in place (DESIGN.md §4.2, "Local
   * mutation and `pure`") — a mutating builtin method, or an assignment / `++` /
   * `delete` on a property. An assignment is not a call, but it propagates
   * exactly like one, so it rides in the same array rather than in a parallel
   * channel every consumer would have to remember to read. `escaping` is
   * false only when the mutated value was allocated inside the function.
   */
  readonly mutation?: {
    readonly escaping: boolean;
    readonly qualifiedName?: string;
    readonly unknownCallback?: true;
  };
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
  /**
   * Set when the callee is a function written inside the declaration being
   * summarized — a nested `function`, or a `const` holding an arrow. Nothing
   * inside a function body is indexed, so there is no `resolvedCallee` to
   * name; but the body is not missing either, because `collectCalls` walked
   * through it and recorded its calls in this same summary.
   *
   * The site therefore contributes nothing of its own. It is not
   * `unresolved`: that would report a body the analysis actually read as one
   * it could not reach, which overstates `unknown` exactly as badly as the
   * reverse understates it (DESIGN.md §3.4).
   */
  readonly inlinedCallee?: true;
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
  /**
   * Set on a declaration only `ambit.config.ts` can name (DESIGN.md §4.1
   * (a)): a `get`/`set` accessor, or an anonymous `export default`.
   *
   * The declaration is extracted and propagates like any other — its body's
   * effects are real — but {@link ExtractedFunction.jsDoc} is left undefined
   * for it on purpose: §4.1 (a) keeps the config namespace a superset of the
   * JSDoc one, so a contract comment here is inert and is reported as
   * `AMB-E003` instead (with the config key that would work).
   */
  readonly configOnly?: true;
  /**
   * Set on the entry that owns a file's unowned inline callbacks (DESIGN.md
   * §4.1 (a), "The inline-callback owner"). The third tier: analyzed and
   * compared like any other function, and declarable by nobody — there is no
   * declaration site for JSDoc and no single function for a config key to
   * name, so neither `ambit init` nor `ambit init --config` proposes one.
   *
   * Apart from {@link configOnly}, which marks a declaration JSDoc cannot
   * carry but config still can.
   */
  readonly undeclarable?: true;
  readonly jsDoc: RawJsDoc | undefined;
  readonly calls: readonly CallSite[];
  /**
   * {@link calls} partitioned by the body each call is in, one group per owned
   * body — set on the inline-callback owner (DESIGN.md §4.1 (a)) and on
   * nothing else, so a file with a single inline callback has one group.
   * Concatenating the groups reproduces {@link calls} exactly.
   *
   * Absent for every ordinary function, which owns one body: a comparison
   * reads an absent field as "one body, holding everything this record
   * holds", so nothing about an ordinary record changes. What it buys is the
   * only thing a merged owner would otherwise lose — authority is compared as
   * a multiset over the owned bodies (§6.3), so a second body gaining an
   * effect a first body already had is an increase, exactly as it would be if
   * the two bodies were two named functions.
   */
  readonly bodies?: readonly (readonly CallSite[])[];
}

/**
 * A call that establishes an entrypoint's context, as the source shows it: a
 * hand-written `withAmbit(spec, handler)` from `ambit-ts/runtime`, or a framework
 * adapter's registration (`ambitHandler(spec, handler, decode)` from
 * `ambit-ts/runtime/hono`) — DESIGN.md §4.4, "Mapping contracts to handlers".
 *
 * Ambit reads it to check one thing only: that the capability list the runtime
 * would establish is the one the handler's JSDoc declares. Written twice, the
 * two drift, and nothing noticed before this existed.
 *
 * The check is **on the source alone**. §12's "Mapping contracts to handlers" —
 * a build that strips comments, a bundle that moves the handler — is not
 * solved here, and `unmatchedReason` exists so a wrapper this comparison
 * cannot reach is reported rather than passed over.
 */
export interface RuntimeWrapper {
  /** The call itself: where a mismatch is reported. */
  readonly location: SourceLocation;
  /**
   * The exported name that was called (`withAmbit`, `ambitHandler`), so a
   * diagnostic names what the source actually wrote. Not the module specifier:
   * the reader is looking at the call, not the import.
   */
  readonly wrapper: string;
  /**
   * The capability strings in the spec's literal `capabilities` array. An
   * empty array is a real grant of nothing, not a missing one — that case is
   * `unmatchedReason` instead.
   */
  readonly capabilities?: readonly string[];
  /**
   * The spec's `budget` as the source fixes it, or absent when the source does
   * not fix it. Independent of {@link RuntimeWrapper.capabilities}: a spec can
   * write one half as a literal and build the other at runtime, and each half
   * is compared — or reported as uncompared — on its own.
   */
  readonly budget?: WrapperBudget;
  /** The wrapped handler, when it is an identifier naming a declaration extracted from the same file. */
  readonly handler?: SymbolId;
  /** Why this wrapper could not be compared, when it could not. */
  readonly unmatchedReason?: "handler-not-in-this-file";
}

/**
 * A `spec.budget` the source fixes, in the shape the source wrote it
 * ({@link BudgetInput}).
 *
 * `absent` is a spec that writes no budget at all, which the handler's JSDoc
 * can agree or disagree with; it is not the same as the field being missing,
 * which means the source did not fix the budget and nothing can be compared.
 *
 * Both sides are defaulted to `throw` before they are compared —
 * `parseBudgetTag` already writes the default into a parsed `@budget`, so the
 * JSDoc side has no absent state to compare an absent spec key against.
 */
export type WrapperBudget =
  | { readonly kind: "absent" }
  | ({ readonly kind: "literal" } & BudgetInput);

export interface ExtractedFile {
  readonly filePath: string;
  /**
   * Every entry's {@link ExtractedFunction.id} is distinct. This is a
   * requirement on the backend, not an observation about one: `propagate`
   * argues its termination from each `SymbolId` naming exactly one summary
   * (its state map is keyed by id, and its worklist iterates the summaries).
   * Two entries sharing an id overwrite each other's state on every pass, so
   * the fixed-point loop never settles and `ambit check` does not return.
   *
   * The shape that breaks it is an overload set — several declarations, one
   * declaration path — which is why only the implementation is extracted
   * (see {@link SkippedFunctionKind}'s `bodyless-declaration`).
   * `test/backend.conformance.test.ts` asserts it for every fixture root.
   */
  readonly functions: readonly ExtractedFunction[];
  /**
   * Required, not optional, for the reason {@link ExtractedProject}'s counts
   * are: a backend that omitted them would report "no wrappers" and "wrappers
   * not looked for" identically.
   */
  readonly runtimeWrappers: readonly RuntimeWrapper[];
}

/**
 * A contract written on a function-like node the backend did not extract, and
 * which therefore cannot carry one. Reported as `AMB-E003` rather than
 * dropped: a declaration that silently does nothing is the opposite of what
 * Ambit is for (DESIGN.md §3.4 — do not convert an analysis failure into "no
 * violations").
 *
 * `kind` is the same classification `skippedFunctions` counts, so the message
 * can say *why* the node cannot carry the contract.
 */
export interface UncarriedContract {
  readonly location: SourceLocation;
  readonly kind: SkippedFunctionKind;
  readonly tag: string;
  readonly raw: string;
  /**
   * The `ambit.config.ts` key that *would* carry this contract, when one
   * exists (DESIGN.md §4.1 (a) — an accessor or an anonymous default export).
   * Absent for a node config cannot name either, where the only honest advice
   * is to restructure the code.
   */
  readonly configKey?: string;
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
 * Implementations live under `src/checker/backend/`. The only one is
 * `legacy-ts.ts`, adopted as the default by DESIGN.md §3.5
 * and ADR-0001, and it must stay the only file that imports
 * `typescript`. `test/backend.conformance.test.ts` states what any
 * implementation of this interface has to satisfy.
 */
export interface TsBackend {
  readonly name: string;
  readonly version: string;
  extractProject(rootDir: string): Promise<ExtractedProject>;
}
