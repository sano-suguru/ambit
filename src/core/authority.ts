import { type Capability, formatCapability } from "./capability.ts";
import type { ContractOperation, ContractViaEntry } from "./diagnostic.ts";
import type { KnownEffect } from "./effects.ts";
import type { SourceLocation } from "./location.ts";
import type { UnresolvedOperationReason } from "./summary.ts";
import type { SymbolId } from "./symbol-id.ts";

/**
 * One function's authority, as `ambit check --format json` emits it
 * (DESIGN.md §5.1's `kind: "authority"` record) and as `ambit diff` compares
 * it.
 *
 * "Authority" here is what a function may act with, not what a diagnostic
 * says about it: a record is emitted for every analyzed function, including
 * the ones nothing is wrong with. It is a checker-side artifact — nothing at
 * runtime reads it, so ADR-0005's objection to shipping contract data to the
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
   * The operations in **this function's own body** the analysis could not
   * resolve, as a sorted multiset (DESIGN.md §5.1, §6.4).
   *
   * Body-local and never propagated. `effects.unknown` is the propagated
   * claim and is not derived from this: a function whose own body resolves
   * completely is still `unknown` when a callee is, and then this list is
   * empty. The two answer different questions — "is what I know about this
   * function complete" and "what, here, did I fail to read".
   *
   * Empty for a `@boundary` function. Its body is excluded from analysis by
   * declaration (§4.6), so a call inside it is isolated rather than
   * unresolved, and listing it would price an explicit decision as a failure.
   *
   * This is what makes §6.4's second shape comparable at all: without it a
   * record carries a boolean, and a symbol that is `unknown` on both sides
   * compares equal however many opaque operations were added to it.
   */
  readonly unresolved: readonly UnresolvedOperation[];
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
  /**
   * What each **owned body** holds on its own, for a symbol that owns more
   * than one (DESIGN.md §4.1 (a)'s inline-callback owner). Absent for every
   * ordinary function, and read as one body holding the record's own
   * effective authority when absent, so an ordinary record is unchanged.
   *
   * `ambit diff` compares authority as a multiset over these (§6.3): an
   * authority is *added* when more bodies hold it than did. For one body that
   * is exactly today's set comparison — 0 to 1 is an increase, 1 to 1 is not
   * — so the rule is the same one, stated over a set of bodies rather than
   * assuming there is one. Without it a symbol standing for several bodies
   * would report nothing when a second body gained an effect a first already
   * had, which is the merge into silence §6.4 forbids.
   *
   * The union of these is the record's own `observed` / `required`; nothing
   * here widens what the symbol holds.
   */
  readonly bodies?: readonly AuthorityBody[];
}

/**
 * One owned body's authority — see {@link AuthorityRecord.bodies}.
 *
 * A body has no declaration of its own (it has no declaration site at all),
 * so there is no `declared` half: what it holds is what it was inferred to
 * do.
 */
export interface AuthorityBody {
  readonly effects: readonly KnownEffect[];
  readonly capabilities: readonly string[];
  /** Propagation reached a call it could not resolve from this body. */
  readonly unknown: boolean;
  /**
   * The operations **in this body alone** the analysis could not resolve, in
   * the same shape and order as the record's own {@link
   * AuthorityRecord.unresolved} — of which these are the parts.
   *
   * Carried for the same reason the rest of this interface is: without it,
   * two bodies that are both `unknown` read as interchangeable, and an opaque
   * operation moving from one handler to another would be a merge into
   * silence (§6.4's third shape). `unknown` is a boolean about the propagated
   * result and does not answer "what, here, did I fail to read".
   */
  readonly unresolved: readonly UnresolvedOperation[];
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

/**
 * One kind of unresolvable operation in a function's body, and how many of it
 * there are.
 *
 * Identity is `(reason, operation)` and deliberately carries **no position**:
 * re-indenting a file or moving a call within a function must report nothing,
 * which is the property that keeps `ambit diff` silent on an unmodified tree
 * (DESIGN.md §6.4).
 *
 * `count` is part of the value rather than a display detail. A second call to
 * the same unresolvable operation is a second operation, and a comparison that
 * dropped the count would read a function's third opaque write as no change —
 * an unanalyzed addition reported as nothing, which §3.4 forbids.
 *
 * `operation` is the qualified name the stub tables would key on, omitted
 * where the call has none: a callback parameter, an `any` receiver, `eval`.
 * No placeholder stands in for a name that does not exist (§5.3).
 */
export interface UnresolvedOperation {
  readonly reason: UnresolvedOperationReason;
  readonly operation?: string;
  readonly count: number;
}

/**
 * The identity of an unresolvable operation, as a string a map can key on.
 *
 * The reason comes first and is a fixed token containing no `":"`, so the
 * joiner never collides with a qualified name that contains one.
 */
export function unresolvedOperationKey(operation: UnresolvedOperation): string {
  return `${operation.reason}:${operation.operation ?? ""}`;
}

/**
 * One unresolvable operation as a reader recognizes it: the name where the
 * call has one, the reason either way, and the count only where it is not one
 * — `axios.get x3` says something, `axios.get x1` says only that a reader has
 * to divide by one.
 */
export function formatUnresolvedOperation(operation: UnresolvedOperation): string {
  const named = operation.operation ?? `<unnamed>`;
  const times = operation.count === 1 ? "" : ` x${operation.count}`;
  return `${named}${times} (${operation.reason})`;
}

/**
 * Sort operations into the one order two runs over the same tree both
 * produce, so a diff never reports ordering as change (DESIGN.md §5.1).
 */
export function sortUnresolvedOperations(
  operations: readonly UnresolvedOperation[],
): readonly UnresolvedOperation[] {
  return operations.toSorted((a, b) => {
    const left = unresolvedOperationKey(a);
    const right = unresolvedOperationKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
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

/**
 * The bodies a record's authority is compared over (DESIGN.md §6.3).
 *
 * A record with no `bodies` owns one, and what that body holds is the
 * record's own *effective* authority — declared where a declaration exists,
 * inferred otherwise, exactly as {@link effectiveEffects} defines it. That is
 * what makes the multiset comparison a restatement of the old set comparison
 * rather than a second rule beside it: widening a tag still reads as an
 * increase, because the one body's authority is the declared set.
 */
export function authorityBodies(record: AuthorityRecord): readonly AuthorityBody[] {
  return (
    record.bodies ?? [
      {
        effects: effectiveEffects(record),
        capabilities: effectiveCapabilities(record),
        unknown: record.effects.unknown || record.capabilities.unknown,
        unresolved: record.unresolved,
      },
    ]
  );
}
