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
 * than picking one (DESIGN.md §4.2, スタブの効果表). One call site produces one
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

export type Call = ResolvedCall | StubCall | KnownPureCall | UnresolvedCall;

/**
 * Whether a function declared `@effects`, and what.
 *
 * `{ kind: "none" }` is distinct from a declared empty set: it means no tag
 * was present at all (undeclared), which this slice treats as a coverage
 * concern rather than as `unknown` in propagation — see the plan's note on
 * DESIGN.md §4.2/§4.3.
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
  readonly declared: DeclaredEffects;
  readonly capabilities: DeclaredCapabilities;
  readonly budget: DeclaredBudget;
  readonly boundary: DeclaredBoundary;
  /** `@entrypoint` (DESIGN.md §4.1): where the runtime establishes a context. */
  readonly entrypoint: boolean;
  readonly calls: readonly Call[];
}
