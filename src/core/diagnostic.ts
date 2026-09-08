import type { KnownEffect } from "./effects.ts";
import type { SourceLocation } from "./location.ts";
import type { SymbolId } from "./symbol-id.ts";

export type Severity = "error" | "warning" | "info";

export type DiagnosticCategory = "effects" | "capabilities" | "budget" | "boundary" | "types";

/** One step of the call path from a declaring function to where an effect was found. */
export interface ContractViaEntry {
  readonly symbol: SymbolId;
  readonly file: string;
  readonly line: number;
}

/**
 * DESIGN.md §5.1 `contract` field, for the `effects` category.
 *
 * `declared` uses `"pure"` as a literal spelling for the declared empty set
 * (matching the §5.1 example: `"declared": ["pure"]`), rather than `[]` —
 * `EffectSet`'s internal representation collapses `pure` to an empty
 * `effects` set (DESIGN.md §4.2 rule 2), but that internal choice should not
 * leak into what a human or an agent reads back from the diagnostic.
 */
export interface EffectsContract {
  readonly declared: readonly (KnownEffect | "pure")[];
  readonly observed: readonly KnownEffect[];
  readonly via: readonly ContractViaEntry[];
}

export interface FixEdit {
  readonly file: string;
  readonly range: readonly [readonly [number, number], readonly [number, number]];
  readonly replacement: string;
}

export interface FixImpact {
  readonly callersAffected?: readonly SymbolId[];
  readonly pureCallersBroken?: number;
}

/**
 * A fix candidate. `edits` must be a concrete, applicable patch — never a
 * summary-only or elided candidate (DESIGN.md §5.3). `consistentWithContract`
 * separates a fix that preserves the declared contract from one that widens
 * it (§5.2).
 */
export interface DiagnosticFix {
  readonly rank: number;
  readonly kind: "widen" | "narrow";
  readonly summary: string;
  readonly confidence: number;
  readonly consistentWithContract: boolean;
  readonly edits: readonly FixEdit[];
  readonly impact?: FixImpact;
}

/**
 * One diagnostic, matching the shape in DESIGN.md §5.1. `ambit check
 * --format json` emits one of these per line (NDJSON).
 */
export interface Diagnostic {
  readonly id: string;
  readonly severity: Severity;
  readonly category: DiagnosticCategory;
  readonly message: string;
  readonly location: SourceLocation;
  readonly contract?: EffectsContract;
  /** Empty when no concrete, applicable patch could be generated (§5.3). */
  readonly fixes: readonly DiagnosticFix[];
  readonly docs?: string;
}
