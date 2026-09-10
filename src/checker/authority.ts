import type { AuthorityPath, AuthorityRecord, KnownEffect, SymbolId } from "../core/index.ts";
import { formatCapability, KNOWN_EFFECTS } from "../core/index.ts";
import { operationSite } from "./diagnose.ts";
import {
  capabilityWitnessChain,
  chainToVia,
  type PropagatedFunction,
  witnessChain,
} from "./propagate.ts";

/**
 * Every analyzed function's authority, in the order `ambit check --format
 * json` emits it and `ambit diff` compares it (DESIGN.md §5.1).
 *
 * Built from the propagated state alone, so it says the same thing the
 * diagnostics say — a function's record and the diagnostic about it can never
 * disagree about what its effects are. Records are sorted by symbol id, and
 * every list inside one is sorted too, so two runs over the same tree produce
 * byte-identical output and a diff never reports ordering as change.
 */
export function buildAuthorityRecords(
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
): readonly AuthorityRecord[] {
  return [...state.values()]
    .map((propagated) => buildRecord(propagated, state))
    .toSorted((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
}

function buildRecord(
  propagated: PropagatedFunction,
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
): AuthorityRecord {
  const { summary } = propagated;
  const declaredEffects = summary.declared;
  const declaredCapabilities = summary.capabilities;
  const observed = KNOWN_EFFECTS.filter((effect) => propagated.observed.effects.has(effect));
  const required = propagated.required.capabilities.map(formatCapability).toSorted();

  return {
    kind: "authority",
    symbol: summary.id,
    location: summary.location,
    entrypoint: summary.entrypoint,
    effects: {
      // An `@effects` tag that did not parse is no declaration at all, the
      // same reading `AMB-E002` and propagation give it: a broken tag must
      // never be read as a narrower grant than the author wrote.
      declared:
        declaredEffects.kind === "declared"
          ? KNOWN_EFFECTS.filter((effect) => declaredEffects.effects.effects.has(effect))
          : null,
      observed,
      unknown: propagated.observed.unknown,
    },
    capabilities: {
      declared:
        declaredCapabilities.kind === "declared"
          ? declaredCapabilities.capabilities.capabilities.map(formatCapability).toSorted()
          : null,
      required,
      unknown: propagated.required.unknown,
    },
    paths: [
      ...effectPaths(propagated, observed, state),
      ...capabilityPaths(summary.id, required, state),
    ],
  };
}

/**
 * The call path for each effect the function reaches, plus the operation site
 * inside the function at the end of that path — exactly what `AMB-E001` puts
 * in `contract.via` / `contract.operation`, computed the same way so a
 * diff-rendered path and a check-rendered path are the same path.
 *
 * An effect the function performs itself has an empty `via` and still carries
 * an operation, so the reader is sent to the `fetch(...)` line either way.
 */
function effectPaths(
  propagated: PropagatedFunction,
  observed: readonly KnownEffect[],
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
): readonly AuthorityPath[] {
  const owner = propagated.summary.id;
  return observed.map((effect) => {
    const chain = witnessChain(owner, effect, state);
    const operation = operationSite(effect, chain[chain.length - 1] ?? owner, state);
    return {
      authority: effect,
      kind: "effect" as const,
      via: chainToVia(chain, state),
      ...(operation ? { operation } : {}),
    };
  });
}

/**
 * The call path for each capability the function requires. No operation site:
 * a capability requirement is established by a declaration or by an
 * operation's target, and the latter is already the effect's operation — a
 * second, differently-derived site would be a guess (DESIGN.md §5.3).
 */
function capabilityPaths(
  owner: SymbolId,
  required: readonly string[],
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
): readonly AuthorityPath[] {
  return required.map((capability) => ({
    authority: capability,
    kind: "capability" as const,
    via: chainToVia(capabilityWitnessChain(owner, capability, state), state),
  }));
}
