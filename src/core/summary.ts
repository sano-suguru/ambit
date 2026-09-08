import type { UnresolvedReason } from "./backend.ts";
import type { EffectSet, KnownEffect } from "./effects.ts";
import type { SourceLocation } from "./location.ts";
import type { SymbolId } from "./symbol-id.ts";

/** A call resolved to another function Ambit has a summary for. */
export interface ResolvedCall {
  readonly kind: "resolved";
  readonly location: SourceLocation;
  readonly callee: SymbolId;
}

/** A call matched against a known stub (`src/stubs/`); its effect is known directly. */
export interface StubCall {
  readonly kind: "stub";
  readonly location: SourceLocation;
  readonly effect: KnownEffect;
  readonly qualifiedName: string;
}

/** A call whose target or effects could not be determined (DESIGN.md §4.2 rule 6). */
export interface UnresolvedCall {
  readonly kind: "unresolved";
  readonly location: SourceLocation;
  readonly reason: UnresolvedReason;
}

export type Call = ResolvedCall | StubCall | UnresolvedCall;

/**
 * Whether a function declared `@effects`, and what.
 *
 * `{ kind: "none" }` is distinct from a declared empty set: it means no tag
 * was present at all (undeclared), which this slice treats as a coverage
 * concern rather than as `unknown` in propagation — see the plan's note on
 * DESIGN.md §4.2/§4.3.
 */
export type DeclaredEffects =
  | { readonly kind: "none" }
  | { readonly kind: "declared"; readonly effects: EffectSet };

/** Ambit's own representation of one function, independent of any backend. */
export interface FunctionSummary {
  readonly id: SymbolId;
  readonly location: SourceLocation;
  readonly declared: DeclaredEffects;
  readonly calls: readonly Call[];
}
