/**
 * Effects a function can have on the outside world (DESIGN.md §4.2).
 *
 * `pure` is not a member of this list — it is the empty {@link EffectSet}
 * (§4.2: "`pure` は空集合の別名"). `unknown` is likewise not a member; it is
 * a separate flag on {@link EffectSet}, because "this function might have
 * more effects than listed" and "this function definitely has these
 * effects" are different guarantees and must not collapse into one value.
 */
export const KNOWN_EFFECTS = [
  "network",
  "db_read",
  "db_write",
  "fs_read",
  "fs_write",
  // Mutation of a value reachable from outside the function (DESIGN.md
  // §4.2, 「ローカル変異と `pure`」). Mutating a value the function itself
  // allocated is not this effect — it is not observable to a caller.
  "state_write",
  "llm",
  "env",
  "process",
] as const;

export type KnownEffect = (typeof KNOWN_EFFECTS)[number];

export function isKnownEffect(value: string): value is KnownEffect {
  return (KNOWN_EFFECTS as readonly string[]).includes(value);
}

/**
 * The effects a function has, plus whether the set might be incomplete.
 *
 * `unknown: true` means propagation reached a call that could not be
 * resolved (DESIGN.md §4.2 rule 6) — the function's true effect set could
 * include anything. It is tracked separately from `effects` so a diagnostic
 * can distinguish "declares pure but definitely does X" (§AMB-E001) from
 * "declares pure but calls something unanalyzable" (§AMB-W001).
 */
export interface EffectSet {
  readonly effects: ReadonlySet<KnownEffect>;
  readonly unknown: boolean;
}

export function emptyEffectSet(): EffectSet {
  return { effects: new Set(), unknown: false };
}

export function unknownEffectSet(): EffectSet {
  return { effects: new Set(), unknown: true };
}

export function effectSetOf(...effects: readonly KnownEffect[]): EffectSet {
  return withImpliedEffects({ effects: new Set(effects), unknown: false });
}

/**
 * `llm` implies `network` (DESIGN.md §4.2: "`llm` ... `network` を含意し"):
 * expand a raw effect set so the containment relation always holds, no
 * matter where the set was built.
 */
export function withImpliedEffects(set: EffectSet): EffectSet {
  if (!set.effects.has("llm") || set.effects.has("network")) return set;
  return { effects: new Set([...set.effects, "network"]), unknown: set.unknown };
}

export function unionEffectSets(a: EffectSet, b: EffectSet): EffectSet {
  return withImpliedEffects({
    effects: new Set([...a.effects, ...b.effects]),
    unknown: a.unknown || b.unknown,
  });
}

export function effectSetsEqual(a: EffectSet, b: EffectSet): boolean {
  if (a.unknown !== b.unknown) return false;
  if (a.effects.size !== b.effects.size) return false;
  for (const effect of a.effects) {
    if (!b.effects.has(effect)) return false;
  }
  return true;
}

/** Effects present in `observed` but not covered by `declared` (§4.2 rule 1). */
export function excessEffects(declared: EffectSet, observed: EffectSet): ReadonlySet<KnownEffect> {
  const excess = new Set<KnownEffect>();
  for (const effect of observed.effects) {
    if (!declared.effects.has(effect)) excess.add(effect);
  }
  return excess;
}
