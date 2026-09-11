import type { UnresolvedReason } from "./backend.ts";
import type { Budget } from "./budget.ts";
import type { Capability, CapabilitySet } from "./capability.ts";
import type { EffectSet, KnownEffect } from "./effects.ts";
import type { SourceLocation } from "./location.ts";
import type { SymbolId } from "./symbol-id.ts";

/** A call resolved to another function Ambit has a summary for. */
export interface ResolvedCall {
  readonly kind: "resolved";
  readonly location: SourceLocation;
  readonly callee: SymbolId;
}

/**
 * A call matched against a known stub (`src/stubs/`); its effects are known
 * directly.
 *
 * `effects` is a set, not one effect, because an operation's direction is not
 * always decidable from the source: `pool.query(sql)` with a non-literal
 * statement may read or write, and the stub table answers with both rather
 * than picking one (DESIGN.md §4.2, "Operations whose read/write direction is
 * not statically determined"). One call site produces one
 * `StubCall` whatever the size of that set — never one per effect, which
 * would double-count it in `--coverage`.
 */
export interface StubCall {
  readonly kind: "stub";
  readonly location: SourceLocation;
  readonly effects: readonly KnownEffect[];
  readonly qualifiedName: string;
  /**
   * The capability this call requires, when the stub tables know of a target
   * and the source fixes it — a literal URL's host (DESIGN.md §4.4's static
   * half). Absent when the operation has no target this layer claims to know.
   */
  readonly requiredCapability?: Capability;
  /**
   * Set when the operation *has* a target the runtime will match but the
   * source does not fix it (a URL built at runtime). Distinct from having no
   * requirement at all: the caller's capability requirement is then not fully
   * known, which is `AMB-W003`, not silence.
   */
  readonly capabilityTargetUnknown?: true;
}

/**
 * A call matched against the pure-builtins allowlist (`src/stubs/
 * pure-builtins.ts`) — a default-lib method (e.g. `Set.has`, `Array.map`)
 * known to have no effect. `qualifiedName` is in that allowlist's own
 * namespace (`checker.getFullyQualifiedName()` form), a different space from
 * `StubCall.qualifiedName`'s module-specifier form — never compare the two.
 */
export interface KnownPureCall {
  readonly kind: "known-pure";
  readonly location: SourceLocation;
  readonly qualifiedName: string;
}

/**
 * A call whose target or effects could not be determined (DESIGN.md §4.2
 * rule 6). `qualifiedName` is carried through from a stub-lookup miss (see
 * `summarize.ts`'s `toCall`) so `src/checker/coverage.ts` can report which
 * unresolved names recur most — the signal for "what to stub next".
 */
export interface UnresolvedCall {
  readonly kind: "unresolved";
  readonly location: SourceLocation;
  readonly reason: UnresolvedReason;
  readonly qualifiedName?: string;
}

/**
 * A site that changes a value in place (DESIGN.md §4.2, "Local mutation and
 * `pure`") — a mutating builtin method (`src/stubs/mutating-builtins.ts`)
 * or an assignment / `++` / `delete` targeting a property.
 *
 * `escaping` is the whole decision: `false` means the mutated value was
 * allocated inside the function, so no caller can observe the change and the
 * site carries no effect; `true` means the root is a parameter, `this`, a
 * module-scope binding, or something the analysis could not pin down, and the
 * site carries `state_write`. The undecidable case is over-approximated to
 * `true`, matching the `db_read`/`db_write` rule in §4.2.
 *
 * `unknownCallback` is a mutator handed a callback by reference
 * (`xs.sort(cmp)`): the mutation is known, the callback's own effects are not
 * (§4.2 rule 4), so the site is both `state_write` and `unknown`.
 */
export interface MutationCall {
  readonly kind: "mutation";
  readonly location: SourceLocation;
  readonly escaping: boolean;
  readonly qualifiedName?: string;
  readonly unknownCallback?: true;
}

export type Call =
  | ResolvedCall
  | StubCall
  | KnownPureCall
  | InlinedCall
  | UnresolvedCall
  | MutationCall;

/**
 * A call to a function written inside this same function's body, whose calls
 * `collectCalls` already recorded here (`CallSite.inlinedCallee`).
 *
 * Contributes nothing on its own — everything it does is in this summary
 * already — and is a kind of its own rather than a `known-pure`, because the
 * two claim different things: that one says the callee performs no effect,
 * this one says the callee's effects are counted somewhere else in this list.
 * A tally that merged them would report a nested `fetch` as proven pure.
 */
export interface InlinedCall {
  readonly kind: "inlined";
  readonly location: SourceLocation;
}

/**
 * Whether a call site leaves the caller's effect set incomplete — an
 * unresolved call, or a mutator whose callback was passed by reference.
 * Both mean "there may be more effects here than are listed".
 */
export function callLeavesUnknown(call: Call): boolean {
  return call.kind === "unresolved" || (call.kind === "mutation" && call.unknownCallback === true);
}

/**
 * The two call kinds {@link callLeavesUnknown} accepts, as a type. Written as
 * a predicate over that function rather than as a second condition, so the set
 * reported on and the set `propagate` derives `unknown` from cannot drift
 * apart.
 */
export type BlockingCall = UnresolvedCall | MutationCall;

export function isBlockingCall(call: Call): call is BlockingCall {
  return callLeavesUnknown(call);
}

/**
 * Why one operation could not be resolved — an {@link UnresolvedReason}, plus
 * the one blocking shape that is not an `UnresolvedCall`.
 *
 * A mutator handed a callback by reference (`xs.sort(cmp)`) has no
 * `UnresolvedReason` of its own, but it makes the caller `unknown` for the
 * same reason `callback-parameter` does — the actual argument is what decides
 * (DESIGN.md §4.2 rule 4) — so it is labelled in the same namespace rather
 * than left out.
 *
 * Lives here rather than beside either consumer because `ambit init`'s
 * `AMB-I002` and §5.1's `unresolved` field must name the same set: one reports
 * why a contract cannot be proposed, the other is what `ambit diff` compares
 * (§6.4), and a reason in one and not the other would be a hole in whichever
 * lacked it.
 */
export type UnresolvedOperationReason = UnresolvedReason | "callback-by-reference";

export function unresolvedReasonOf(call: BlockingCall): UnresolvedOperationReason {
  return call.kind === "unresolved" ? call.reason : "callback-by-reference";
}

/**
 * Whether a function declared `@effects`, and what.
 *
 * `{ kind: "none" }` is distinct from a declared empty set: it means no tag
 * was present at all (undeclared), which this slice treats as a coverage
 * concern rather than as `unknown` in propagation (DESIGN.md §4.2:
 * "Undeclared" and "`unknown`" are not the same thing).
 *
 * `{ kind: "invalid" }` means a tag was present but contained a token that is
 * neither `pure` nor a known effect (a typo, e.g. `@effects netwrok`) — see
 * `AMB-E002` in `diagnose.ts`. Treated the same as `"none"` everywhere except
 * diagnosis: a broken declaration must not silently collapse to `pure` (an
 * empty set), and its caller must not trust it as a boundary either.
 */
export type DeclaredEffects =
  | { readonly kind: "none" }
  | { readonly kind: "invalid"; readonly raw: string }
  | { readonly kind: "declared"; readonly effects: EffectSet };

/**
 * Whether a function declared `@capabilities`, and what. Mirrors
 * {@link DeclaredEffects}: `"invalid"` is a tag that was present but did not
 * parse, and is treated as undeclared everywhere except diagnosis, so a broken
 * declaration never reads as a narrower grant than was written.
 */
export type DeclaredCapabilities =
  | { readonly kind: "none" }
  | { readonly kind: "invalid"; readonly raw: string }
  | { readonly kind: "declared"; readonly capabilities: CapabilitySet };

/** Whether a function declared `@budget`, and what. */
export type DeclaredBudget =
  | { readonly kind: "none" }
  | { readonly kind: "invalid"; readonly raw: string }
  | { readonly kind: "declared"; readonly budget: Budget };

/**
 * Whether a function declared `@boundary` (DESIGN.md §4.6) — an explicit
 * statement that its body is not statically checked and that the contract it
 * declares to the outside is to be trusted instead.
 *
 * `reason` is required by §4.6, so a tag without one is `"invalid"`: an
 * unexplained hole in the analysis is the thing the tag exists to make
 * visible.
 */
export type DeclaredBoundary =
  | { readonly kind: "none" }
  | { readonly kind: "invalid"; readonly raw: string }
  | { readonly kind: "declared"; readonly reason: string };

/**
 * One tag where JSDoc and `ambit.config.ts` both declared something and the
 * two did not agree (DESIGN.md §4.1: "If a symbol has both JSDoc and config,
 * JSDoc wins and the difference is warned about"). Reported as `AMB-W005`.
 *
 * Both sides are held as their formatted text, not as parsed objects: the
 * comparison has already happened, and what the message needs is the two
 * declarations as a reader would recognize them.
 */
export interface ContractDivergence {
  /** The contract tag: `effects`, `capabilities`, `budget`, `entrypoint` or `boundary`. */
  readonly tag: string;
  readonly jsDoc: string;
  readonly config: string;
}

/**
 * Where one declaration came from.
 *
 * `"spec"` is a `withAmbit` / `ambitHandler` registration in the same file as
 * the handler it names, whose `capabilities` / `budget` the source fixes as
 * literals (DESIGN.md §4.4). It is a declaration, not an observation: the
 * runtime establishes exactly that set, so the source has already said what
 * the contract is and the JSDoc tag beside it would only repeat it.
 *
 * Only `"jsdoc"` and `"config"` can ever appear on {@link
 * ContractOrigins.effects}: `@effects` is never delivered to the runtime and
 * so has no place in a spec.
 */
export type DeclarationOrigin = "jsdoc" | "config" | "spec";

/**
 * Which side supplied each contract tag, for the tags anything supplied.
 *
 * Per tag rather than per function because the sides fill different tags: a
 * function can take `@effects` from its JSDoc and its capability set from the
 * registration beside it, and `--coverage`'s `declared-by` breakdown counts
 * the `effects` half (DESIGN.md §4.1, "Out-of-code declarations").
 */
export interface ContractOrigins {
  readonly effects?: DeclarationOrigin;
  readonly capabilities?: DeclarationOrigin;
  readonly budget?: DeclarationOrigin;
}

/** Ambit's own representation of one function, independent of any backend. */
export interface FunctionSummary {
  readonly id: SymbolId;
  readonly location: SourceLocation;
  /**
   * Where each contract tag was written, carried through from
   * {@link RawJsDoc.tagLocations} so a fix can rewrite the tag in place
   * instead of guessing at a line (DESIGN.md §5.3).
   */
  readonly tagLocations: ReadonlyMap<string, SourceLocation>;
  /** Where a new contract comment would go (see {@link ExtractedFunction.declarationStart}). */
  readonly declarationStart: SourceLocation;
  /** The existing JSDoc block, when there is exactly one — a tag can be added to it. */
  readonly jsDocRange?: SourceLocation;
  /** A class's construction with no constructor written: real, but with nowhere to hang a contract. */
  readonly implicitConstructor?: true;
  /** Only `ambit.config.ts` can declare this symbol — see {@link ExtractedFunction.configOnly}. */
  readonly configOnly?: true;
  /**
   * Which side supplied each declared tag, when anything did. Absent for a
   * function nothing declared anything for. `--coverage` counts the `effects`
   * half apart so a codebase can see how much of its contract surface lives
   * outside the code (DESIGN.md §4.1, "Out-of-code declarations").
   */
  readonly declaredBy?: ContractOrigins;
  /** Tags JSDoc and config both declared and disagreed on. JSDoc is what {@link FunctionSummary} carries. */
  readonly divergences?: readonly ContractDivergence[];
  readonly declared: DeclaredEffects;
  readonly capabilities: DeclaredCapabilities;
  readonly budget: DeclaredBudget;
  readonly boundary: DeclaredBoundary;
  /** `@entrypoint` (DESIGN.md §4.1): where the runtime establishes a context. */
  readonly entrypoint: boolean;
  readonly calls: readonly Call[];
}
