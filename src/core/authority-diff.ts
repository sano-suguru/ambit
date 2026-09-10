import type { AuthorityPath, AuthorityRecord, AuthorityRef } from "./authority.ts";
import {
  capabilityRef,
  effectiveCapabilities,
  effectiveEffects,
  effectRef,
  formatAuthorityRef,
  holdsAuthority,
} from "./authority.ts";
import { capabilityCovers, parseCapability } from "./capability.ts";
import type { KnownEffect } from "./effects.ts";
import type { SymbolId } from "./symbol-id.ts";

/**
 * Whether a symbol exists on both sides of the comparison, only on the new
 * side, or only on the old one.
 *
 * A symbol id contains the file path (DESIGN.md §5.3), so a function that
 * moved or was renamed is a `"deleted"` and a `"new"` symbol, not a moved
 * one. Nothing here tries to match them up: a guess about identity would put
 * a fabricated "unchanged" in front of a reader whose function may in fact
 * have gained authority on the way.
 */
export type SymbolStatus = "present" | "new" | "deleted";

/** What changed about one symbol's authority between two dumps. */
export interface SymbolAuthorityDiff {
  readonly symbol: SymbolId;
  readonly status: SymbolStatus;
  /** Authority the new side has that the old side did not grant. */
  readonly added: readonly AuthorityRef[];
  /** Authority the old side had that the new side does not. */
  readonly removed: readonly AuthorityRef[];
  readonly unchanged: readonly AuthorityRef[];
  /**
   * The analysis reached something it could not resolve on the new side but
   * not on the old one — the opposite for `unknownLost`.
   *
   * Reported, never counted as an increase: `unknown` is not authority
   * (DESIGN.md §4.3). Reported all the same, because a range that stopped
   * being analyzable must not come out as "nothing increased here".
   */
  readonly unknownGained: boolean;
  readonly unknownLost: boolean;
  /** The new side's record, for rendering the path of an increase. Absent for a deleted symbol. */
  readonly head?: AuthorityRecord;
  /** The old side's record. Absent for a new symbol. */
  readonly base?: AuthorityRecord;
}

export interface AuthorityDiff {
  /** Every symbol either side knows about, sorted by symbol id. */
  readonly symbols: readonly SymbolAuthorityDiff[];
}

/**
 * Compare two authority dumps (DESIGN.md §5.1's `kind: "authority"` records).
 *
 * Pure: two arrays in, one result out. It never reads a file, runs git, or
 * asks a backend anything, which is what lets the whole comparison be unit
 * tested without a repository — `ambit diff` is only the part that produces
 * the two arrays.
 *
 * What is compared is *effective* authority (see `effectiveEffects`): what a
 * function declares, or what its body was inferred to do when it declares
 * nothing. Widening a tag therefore reads as an increase even though the body
 * did not move, which is the case this comparison exists for.
 */
export function diffAuthority(
  base: readonly AuthorityRecord[],
  head: readonly AuthorityRecord[],
): AuthorityDiff {
  const baseById = indexBySymbol(base, "base");
  const headById = indexBySymbol(head, "head");

  const symbols = [...new Set([...baseById.keys(), ...headById.keys()])]
    .toSorted()
    .map((symbol) => compareSymbol(symbol as SymbolId, baseById.get(symbol), headById.get(symbol)));

  return { symbols };
}

function indexBySymbol(
  records: readonly AuthorityRecord[],
  side: string,
): ReadonlyMap<string, AuthorityRecord> {
  const byId = new Map<string, AuthorityRecord>();
  for (const record of records) {
    // Two records for one id would make the comparison silently depend on
    // input order. The backend contract already forbids it
    // (test/backend.conformance.test.ts), so this is a broken input, not a
    // case to paper over with last-write-wins.
    if (byId.has(record.symbol)) {
      throw new Error(`duplicate authority record for ${record.symbol} on the ${side} side`);
    }
    byId.set(record.symbol, record);
  }
  return byId;
}

function compareSymbol(
  symbol: SymbolId,
  base: AuthorityRecord | undefined,
  head: AuthorityRecord | undefined,
): SymbolAuthorityDiff {
  if (head === undefined) {
    if (base === undefined) throw new Error(`no record for ${symbol} on either side`);
    return {
      symbol,
      status: "deleted",
      added: [],
      removed: authorityOf(base),
      unchanged: [],
      unknownGained: false,
      unknownLost: isUnknown(base),
      base,
    };
  }
  if (base === undefined) {
    return {
      symbol,
      status: "new",
      added: authorityOf(head),
      removed: [],
      unchanged: [],
      unknownGained: isUnknown(head),
      unknownLost: false,
      head,
    };
  }

  const addedEffects = missingEffects(effectiveEffects(base), effectiveEffects(head));
  const removedEffects = missingEffects(effectiveEffects(head), effectiveEffects(base));
  const addedCapabilities = uncoveredCapabilities(
    effectiveCapabilities(base),
    effectiveCapabilities(head),
  );
  const removedCapabilities = uncoveredCapabilities(
    effectiveCapabilities(head),
    effectiveCapabilities(base),
  );

  const added = [...addedEffects.map(effectRef), ...addedCapabilities.map(capabilityRef)];
  const removed = [...removedEffects.map(effectRef), ...removedCapabilities.map(capabilityRef)];
  const addedNames = new Set(added.map(formatAuthorityRef));
  const unchanged = authorityOf(head).filter((ref) => !addedNames.has(formatAuthorityRef(ref)));

  return {
    symbol,
    status: "present",
    added,
    removed,
    unchanged,
    unknownGained: isUnknown(head) && !isUnknown(base),
    unknownLost: isUnknown(base) && !isUnknown(head),
    head,
    base,
  };
}

function authorityOf(record: AuthorityRecord): readonly AuthorityRef[] {
  return [
    ...effectiveEffects(record).map(effectRef),
    ...effectiveCapabilities(record).map((capability) => capabilityRef(capability)),
  ];
}

function isUnknown(record: AuthorityRecord): boolean {
  return record.effects.unknown || record.capabilities.unknown;
}

/** Effects in `candidate` that `reference` does not contain. Plain set difference. */
function missingEffects(
  reference: readonly KnownEffect[],
  candidate: readonly KnownEffect[],
): readonly KnownEffect[] {
  const have = new Set(reference);
  return candidate.filter((effect) => !have.has(effect));
}

/**
 * Capabilities in `candidate` that nothing in `reference` permits.
 *
 * Containment, not string equality, because `<resource>:<action>:<target>`
 * has a glob in `target` (DESIGN.md §4.4) and the same rule that governs
 * caller-to-callee narrowing governs this comparison. Narrowing
 * `http:get:*` to `http:get:api.example.com` is therefore not an increase,
 * while widening it back is: nothing in `[api.example.com]` covers `*`.
 *
 * A token neither side can parse falls back to exact text. It came from a
 * dump this codebase wrote, so this is unreachable in practice; treating an
 * unparseable token as covered would be the one wrong answer, since it would
 * hide an increase.
 */
function uncoveredCapabilities(
  reference: readonly string[],
  candidate: readonly string[],
): readonly string[] {
  const grants = reference.map((text) => ({ text, parsed: parseCapability(text) }));
  return candidate.filter((text) => {
    const required = parseCapability(text);
    return !grants.some((grant) =>
      grant.parsed && required ? capabilityCovers(grant.parsed, required) : grant.text === text,
    );
  });
}

/** Symbols whose authority grew, and new symbols that hold any — what fails a check (DESIGN.md §6). */
export function authorityIncreases(diff: AuthorityDiff): readonly SymbolAuthorityDiff[] {
  return diff.symbols.filter(
    (entry) =>
      (entry.status === "present" && entry.added.length > 0) ||
      (entry.status === "new" && entry.head !== undefined && holdsAuthority(entry.head)),
  );
}

/** Symbols that lost authority without disappearing. Reported; never a failure. */
export function authorityDecreases(diff: AuthorityDiff): readonly SymbolAuthorityDiff[] {
  return diff.symbols.filter((entry) => entry.status === "present" && entry.removed.length > 0);
}

/** Symbols the new side no longer has. Reported; never a failure. */
export function deletedSymbols(diff: AuthorityDiff): readonly SymbolAuthorityDiff[] {
  return diff.symbols.filter((entry) => entry.status === "deleted");
}

/** Symbols present on both sides whose authority is exactly the same. */
export function unchangedSymbols(diff: AuthorityDiff): readonly SymbolAuthorityDiff[] {
  return diff.symbols.filter(
    (entry) => entry.status === "present" && entry.added.length === 0 && entry.removed.length === 0,
  );
}

/**
 * Symbols whose analysis went from resolved to unresolved. Not an increase —
 * `unknown` is not authority — but never silence either: a range that stopped
 * being analyzable is exactly what must not be reported as "not increased".
 */
export function unknownGained(diff: AuthorityDiff): readonly SymbolAuthorityDiff[] {
  return diff.symbols.filter((entry) => entry.unknownGained);
}

export function hasAuthorityIncrease(diff: AuthorityDiff): boolean {
  return authorityIncreases(diff).length > 0;
}

/**
 * The call path a record carries for one authority, if it carries one.
 *
 * Absent when the function declares an authority its body does not reach:
 * there is no path to show and none is invented (DESIGN.md §5.3).
 */
export function pathFor(
  record: AuthorityRecord | undefined,
  ref: AuthorityRef,
): AuthorityPath | undefined {
  return record?.paths.find((path) => path.kind === ref.kind && path.authority === ref.name);
}
