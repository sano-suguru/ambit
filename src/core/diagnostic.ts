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
 * Where an effect is actually performed: the operation's own call site, inside
 * the last function of `via` (or inside the reported function itself, when
 * `via` is empty).
 *
 * `via` names functions, and a function's location is its declaration — not
 * the `fetch(...)` or `readFileSync(...)` line inside it. This field carries
 * that line, so a reader of a diagnostic never has to open the file to find
 * the operation the contract was broken by.
 *
 * `qualifiedName` is the operation as the stub tables name it (`fetch`,
 * `node:fs.readFileSync`), in `StubCall.qualifiedName`'s module-specifier
 * namespace.
 */
export interface ContractOperation {
  readonly qualifiedName: string;
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
  /**
   * Absent when the operation site is not known: the effect came from a
   * callee's `@effects` declaration with no matching operation in its body, or
   * from a mutation, which has no operation to name. Never synthesized — an
   * unknown site stays absent rather than falling back to the function's
   * declaration line (DESIGN.md §5.3).
   */
  readonly operation?: ContractOperation;
}

/**
 * DESIGN.md §5.1 `contract` field for the `capabilities` category. Same
 * declared/observed/via shape as {@link EffectsContract}; `required` is the
 * capability set the body actually needs, and `excess` narrows it to the ones
 * the declaration does not grant (§4.4: capabilities may only narrow from
 * caller to callee).
 */
export interface CapabilitiesContract {
  readonly declared: readonly string[];
  readonly required: readonly string[];
  readonly excess: readonly string[];
  readonly via: readonly ContractViaEntry[];
}

export type DiagnosticContract = EffectsContract | CapabilitiesContract;

/**
 * Narrow a diagnostic's `contract` to the effects shape. The union carries no
 * discriminant field on purpose: DESIGN.md §5.1 fixes the wire shape of a
 * `contract`, and an extra key invented for TypeScript's convenience would be
 * a schema change nobody asked for. `category` already tells a consumer which
 * shape to expect; this is the in-process equivalent.
 */
export function isEffectsContract(contract: DiagnosticContract): contract is EffectsContract {
  return "observed" in contract;
}

export function isCapabilitiesContract(
  contract: DiagnosticContract,
): contract is CapabilitiesContract {
  return "required" in contract;
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
 * The analysis backend that produced a diagnostic (DESIGN.md §3.4: "診断・
 * coverage・性能記録に解析エンジンとそのバージョンを識別できる情報を持たせる").
 * Only the engine identity is captured here; the schema version and Ambit's
 * own version that §5.2 groups alongside it are not yet defined.
 */
export interface DiagnosticEngine {
  readonly name: string;
  readonly version: string;
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
  readonly contract?: DiagnosticContract;
  /** Empty when no concrete, applicable patch could be generated (§5.3). */
  readonly fixes: readonly DiagnosticFix[];
  readonly docs?: string;
  readonly engine: DiagnosticEngine;
}
