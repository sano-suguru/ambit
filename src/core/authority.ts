import { type Capability, formatCapability } from "./capability.ts";
import type { ContractOperation, ContractViaEntry } from "./diagnostic.ts";
import type { KnownEffect } from "./effects.ts";
import type { SourceLocation } from "./location.ts";
import type { SymbolId } from "./symbol-id.ts";

/**
 * One function's authority, as `ambit check --format json` emits it
 * (DESIGN.md §5.1's `kind: "authority"` record) and as `ambit diff` compares
 * it.
 *
 * "Authority" here is what a function may act with, not what a diagnostic
 * says about it: a record is emitted for every analyzed function, including
 * the ones nothing is wrong with. It is a checker-side artifact — nothing at
 * runtime reads it, so §4.4 案 2's objection to shipping contract data to the
 * runtime does not apply.
 *
 * Both halves of each contract are carried, and neither is derived from the
 * other, because they answer different questions: `declared` is what the
 * source claims, `observed` / `required` is what the body was inferred to
 * do. {@link effectiveEffects} states which one a comparison uses.
 */
export interface AuthorityRecord {
  readonly kind: "authority";
  readonly symbol: SymbolId;
  readonly location: SourceLocation;
  /** `@entrypoint` (DESIGN.md §4.1): where the runtime establishes a context. */
  readonly entrypoint: boolean;
  readonly effects: AuthorityEffects;
  readonly capabilities: AuthorityCapabilities;
  /**
   * For an authority this function actually reaches, the call path that
   * carries it — the same hops `--format github` folds into an annotation
   * (§5.1). `ambit diff` renders the path of an *increase* from here, so the
   * reader sees what introduced it without re-running the check.
   *
   * Only authority with a witness appears. An effect a function declares but
   * whose body does not reach has no path, and none is synthesized (§5.3).
   */
  readonly paths: readonly AuthorityPath[];
}

/**
 * `declared` is `null` when no `@effects` tag was written, and also when one
 * was written but did not parse (`AMB-E002`): a declaration that does not
 * mean what it says must not read as a narrower one than the author intended,
 * which is how every other consumer treats `{ kind: "invalid" }`.
 *
 * `pure` never appears here; it is the empty list (DESIGN.md §4.2). The two
 * are distinguishable because `declared: []` is a declared empty set while
 * `declared: null` is no declaration at all.
 */
export interface AuthorityEffects {
  readonly declared: readonly KnownEffect[] | null;
  readonly observed: readonly KnownEffect[];
  /** Propagation reached a call it could not resolve, so `observed` may be incomplete. */
  readonly unknown: boolean;
}

/** The capability half, in the same shape. Capabilities are `<resource>:<action>:<target>` text. */
export interface AuthorityCapabilities {
  readonly declared: readonly string[] | null;
  readonly required: readonly string[];
  readonly unknown: boolean;
}

/** Which lattice an authority token belongs to — the two do not share a namespace. */
export type AuthorityKind = "effect" | "capability";

/** The call path that brings one authority into one function. */
export interface AuthorityPath {
  readonly authority: string;
  readonly kind: AuthorityKind;
  readonly via: readonly ContractViaEntry[];
  /** The operation's own call site, when one is known. Absent, never guessed (§5.3). */
  readonly operation?: ContractOperation;
}

/**
 * One authority, named so that an effect and a capability can never collide
 * in the same set: `effect:network`, `capability:http:get:api.example.com`.
 */
export interface AuthorityRef {
  readonly kind: AuthorityKind;
  readonly name: string;
}

export function effectRef(effect: KnownEffect): AuthorityRef {
  return { kind: "effect", name: effect };
}

export function capabilityRef(capability: Capability | string): AuthorityRef {
  return {
    kind: "capability",
    name: typeof capability === "string" ? capability : formatCapability(capability),
  };
}

export function formatAuthorityRef(ref: AuthorityRef): string {
  return `${ref.kind}:${ref.name}`;
}

/**
 * The effects a record's function is trusted with: what it declared, or —
 * when it declared nothing — what its body was inferred to do.
 *
 * This is the rule `propagate` already applies to a callee (a declaration is
 * believed; an undeclared function contributes its own inferred effects), so
 * a change here is exactly a change in what the rest of the codebase is
 * entitled to assume. It is also what makes widening a tag visible: declaring
 * `network` where `pure` was declared raises the effective set even though
 * the body did not move.
 */
export function effectiveEffects(record: AuthorityRecord): readonly KnownEffect[] {
  return record.effects.declared ?? record.effects.observed;
}

/** The capability half of {@link effectiveEffects}, on the same rule. */
export function effectiveCapabilities(record: AuthorityRecord): readonly string[] {
  return record.capabilities.declared ?? record.capabilities.required;
}

/**
 * Every authority a record's function is trusted with, as refs.
 *
 * `unknown` is deliberately absent: it is not an authority but a statement
 * that the analysis is incomplete (DESIGN.md §4.3), and counting it as one
 * would report an unanalyzable call as a permission. `ambit diff` reports
 * `unknown` transitions separately, so an unanalyzable range is still never
 * silently reported as unchanged.
 */
export function effectiveAuthority(record: AuthorityRecord): readonly AuthorityRef[] {
  return [
    ...effectiveEffects(record).map(effectRef),
    ...effectiveCapabilities(record).map((capability) => capabilityRef(capability)),
  ];
}

/** Whether the function holds any authority at all — what makes a *new* symbol worth failing on. */
export function holdsAuthority(record: AuthorityRecord): boolean {
  return effectiveAuthority(record).length > 0;
}
