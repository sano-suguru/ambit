import type {
  AuthorityPath,
  AuthorityRecord,
  AuthorityRef,
  UnresolvedOperation,
} from "./authority.ts";
import {
  capabilityRef,
  effectiveCapabilities,
  effectiveEffects,
  effectRef,
  formatAuthorityRef,
  holdsAuthority,
  sortUnresolvedOperations,
  unresolvedOperationKey,
} from "./authority.ts";
import { capabilityCovers, parseCapability } from "./capability.ts";
import type { KnownEffect } from "./effects.ts";
import type { SymbolId } from "./symbol-id.ts";

/**
 * Whether a symbol exists on both sides of the comparison, only on the new
 * side, only on the old one, or on both under different paths.
 *
 * A symbol id contains the file path (DESIGN.md §5.3), so a function whose
 * file moved would be a `"deleted"` and a `"new"` symbol. `"moved"` is that
 * pair recombined, and only ever on evidence git supplied: the caller passes
 * the renames git reported, and nothing here guesses at identity beyond them.
 * A guess would put a fabricated "unchanged" in front of a reader whose
 * function may in fact have gained authority on the way (DESIGN.md §6.3).
 */
export type SymbolStatus = "present" | "new" | "deleted" | "moved";

/** What changed about one symbol's authority between two dumps. */
export interface SymbolAuthorityDiff {
  readonly symbol: SymbolId;
  readonly status: SymbolStatus;
  /** For a `"moved"` symbol, the id it had on the base side. Absent otherwise. */
  readonly movedFrom?: SymbolId;
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
  /**
   * Operations the new side's body could not resolve and the old side's
   * either did not hold or held fewer of — DESIGN.md §6.4's second shape.
   * `count` is the difference, not the new side's total.
   *
   * Not authority, and never merged into {@link added}: what it reports is
   * that the verified extent of this symbol got smaller, which §4.3 keeps
   * apart from a permission. Computed only where the two sides are a real
   * comparison; a *new* symbol's whole body is unresolved-to-the-base by
   * definition, and it is {@link unknownGained} that says so.
   */
  readonly unresolvedGained: readonly UnresolvedOperation[];
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
 * Files git reported as renamed between the two sides, base path to head
 * path, each relative to the checked directory and separated by `"/"`.
 *
 * Supplied by the caller because this module runs no git (see
 * {@link diffAuthority}); `ambit diff` reads it from
 * `git diff --find-renames`.
 */
export type RenamedFiles = ReadonlyMap<string, string>;

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
  renames: RenamedFiles = new Map(),
): AuthorityDiff {
  const rebased = rebaseRenamed(base, renames);
  const baseById = indexBySymbol(rebased.records, "base");
  const headById = indexBySymbol(head, "head");

  const symbols = [...new Set([...baseById.keys(), ...headById.keys()])]
    .toSorted()
    .map((symbol) =>
      compareSymbol(
        symbol as SymbolId,
        baseById.get(symbol),
        headById.get(symbol),
        rebased.movedFrom.get(symbol),
      ),
    );

  return { symbols };
}

/**
 * Re-express the base side's symbol ids under the head side's paths, for the
 * files git reported as renamed.
 *
 * This is the whole of move handling: once `old.ts#f` is called `new.ts#f`,
 * the ordinary comparison does the rest, and a move that also widened a
 * contract still reports exactly the widening. A remap that would collide
 * with an id the base side already has is dropped rather than resolved —
 * git cannot report a rename onto a path that existed on the base side, so
 * this is unreachable, and guessing which of the two records wins is the one
 * answer that could hide an increase.
 */
function rebaseRenamed(
  base: readonly AuthorityRecord[],
  renames: RenamedFiles,
): { records: readonly AuthorityRecord[]; movedFrom: ReadonlyMap<string, SymbolId> } {
  if (renames.size === 0) return { records: base, movedFrom: new Map() };

  const existing = new Set(base.map((record) => record.symbol));
  const movedFrom = new Map<string, SymbolId>();
  const records = base.map((record) => {
    const hash = record.symbol.indexOf("#");
    if (hash < 0) return record;
    const renamed = renames.get(record.symbol.slice(0, hash));
    if (renamed === undefined) return record;
    const moved = `${renamed}${record.symbol.slice(hash)}` as SymbolId;
    if (existing.has(moved) || movedFrom.has(moved)) return record;
    movedFrom.set(moved, record.symbol);
    return { ...record, symbol: moved };
  });
  return { records, movedFrom };
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
  movedFrom: SymbolId | undefined,
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
      unresolvedGained: [],
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
      unresolvedGained: [],
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
    status: movedFrom === undefined ? "present" : "moved",
    ...(movedFrom === undefined ? {} : { movedFrom }),
    added,
    removed,
    unchanged,
    unknownGained: isUnknown(head) && !isUnknown(base),
    unknownLost: isUnknown(base) && !isUnknown(head),
    unresolvedGained: gainedUnresolved(base.unresolved, head.unresolved),
    head,
    base,
  };
}

/**
 * Multiset difference over unresolvable operations: for each `(reason,
 * operation)` the head side holds, how many more of it there are than on the
 * base side (DESIGN.md §6.4).
 *
 * Plain subtraction, in the one direction. An operation the head side holds
 * *fewer* of is the analysis reaching further than it did, which is the
 * direction this command does not watch — the same rule §6 states for
 * authority that only decreased.
 */
function gainedUnresolved(
  base: readonly UnresolvedOperation[],
  head: readonly UnresolvedOperation[],
): readonly UnresolvedOperation[] {
  if (head.length === 0) return [];
  const before = new Map(base.map((operation) => [unresolvedOperationKey(operation), operation]));
  const gained = head.flatMap((operation) => {
    const had = before.get(unresolvedOperationKey(operation))?.count ?? 0;
    const delta = operation.count - had;
    return delta > 0 ? [{ ...operation, count: delta }] : [];
  });
  return sortUnresolvedOperations(gained);
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

/**
 * Present under the same id on both sides, or under a renamed path — the two
 * statuses whose `added` / `removed` are a real comparison rather than the
 * whole of one side's authority.
 */
function comparable(entry: SymbolAuthorityDiff): boolean {
  return entry.status === "present" || entry.status === "moved";
}

/**
 * Symbols whose authority grew, and new symbols that hold any — the increases
 * an approval is written for (DESIGN.md §6.3).
 *
 * A symbol that only moved is not here: it is compared against its own base
 * record, so `added` is empty unless the move also widened something, and then
 * only the widening is reported.
 */
export function authorityIncreases(diff: AuthorityDiff): readonly SymbolAuthorityDiff[] {
  return diff.symbols.filter(
    (entry) =>
      (comparable(entry) && entry.added.length > 0) ||
      (entry.status === "new" && entry.head !== undefined && holdsAuthority(entry.head)),
  );
}

/** Symbols that lost authority without disappearing. Reported; never a failure. */
export function authorityDecreases(diff: AuthorityDiff): readonly SymbolAuthorityDiff[] {
  return diff.symbols.filter((entry) => comparable(entry) && entry.removed.length > 0);
}

/** Symbols carried across a file git reported as renamed. Reported; never a failure on its own. */
export function movedSymbols(diff: AuthorityDiff): readonly SymbolAuthorityDiff[] {
  return diff.symbols.filter((entry) => entry.status === "moved");
}

/** Symbols the new side no longer has. Reported; never a failure. */
export function deletedSymbols(diff: AuthorityDiff): readonly SymbolAuthorityDiff[] {
  return diff.symbols.filter((entry) => entry.status === "deleted");
}

/**
 * Symbols present on both sides that this comparison has nothing to say about.
 *
 * Authority equal on both sides is necessary but not sufficient: a symbol
 * named under §6.4 — the analysis stopped reaching it, or its body gained an
 * operation that cannot be resolved — is counted out, because the footer's
 * "N unchanged" sits below those sections and must not contradict them.
 */
export function unchangedSymbols(diff: AuthorityDiff): readonly SymbolAuthorityDiff[] {
  return diff.symbols.filter(
    (entry) =>
      comparable(entry) &&
      entry.added.length === 0 &&
      entry.removed.length === 0 &&
      !entry.unknownGained &&
      entry.unresolvedGained.length === 0,
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

/**
 * Symbols whose own body gained an operation the analysis could not resolve
 * (DESIGN.md §6.4, second shape).
 *
 * Reported always, and a failure only under `ambit diff --strict`: an
 * unresolvable operation is not authority (§4.3), so it does not belong in
 * `ambit.approvals.md` and cannot be approved by a line there.
 */
export function unresolvedGains(diff: AuthorityDiff): readonly SymbolAuthorityDiff[] {
  return diff.symbols.filter((entry) => entry.unresolvedGained.length > 0);
}

/**
 * Whether the comparison widened what the analysis cannot see, in either of
 * §6.4's two shapes — what `ambit diff --strict` exits 1 on and what the
 * default run reports at exit 0.
 */
export function hasUnresolvedWidening(diff: AuthorityDiff): boolean {
  return unknownGained(diff).length > 0 || unresolvedGains(diff).length > 0;
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
