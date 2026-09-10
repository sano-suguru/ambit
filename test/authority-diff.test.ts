import { describe, expect, it } from "vitest";
import type { AuthorityRecord, SymbolId } from "../src/core/index.ts";
import {
  authorityDecreases,
  authorityIncreases,
  deletedSymbols,
  diffAuthority,
  hasAuthorityIncrease,
  pathFor,
  unchangedSymbols,
  unknownGained,
} from "../src/core/index.ts";

/**
 * The comparison is a pure function over two dumps, so every case here is
 * built by hand. No repository, no worktree, no git — that boundary is the
 * point: `ambit diff` only produces the two arrays these tests write out.
 */
function record(
  symbol: string,
  parts: {
    declared?: readonly string[] | null;
    observed?: readonly string[];
    unknown?: boolean;
    capDeclared?: readonly string[] | null;
    capRequired?: readonly string[];
    capUnknown?: boolean;
    entrypoint?: boolean;
    paths?: AuthorityRecord["paths"];
  } = {},
): AuthorityRecord {
  return {
    kind: "authority",
    symbol: symbol as SymbolId,
    location: { file: symbol.split("#")[0] ?? "", line: 1, col: 1, endLine: 1, endCol: 2 },
    entrypoint: parts.entrypoint ?? false,
    effects: {
      declared: (parts.declared ?? null) as AuthorityRecord["effects"]["declared"],
      observed: (parts.observed ?? []) as AuthorityRecord["effects"]["observed"],
      unknown: parts.unknown ?? false,
    },
    capabilities: {
      declared: parts.capDeclared ?? null,
      required: parts.capRequired ?? [],
      unknown: parts.capUnknown ?? false,
    },
    paths: parts.paths ?? [],
  };
}

describe("diffAuthority", () => {
  it("reports a widened @effects tag as an increase, though the body did not move", () => {
    // The README's priceOrder case: the tag goes pure -> network while the
    // body keeps reaching the same fetch. `check` goes green; this must not.
    const base = [record("src/pricing.ts#priceOrder", { declared: [], observed: ["network"] })];
    const head = [
      record("src/pricing.ts#priceOrder", { declared: ["network"], observed: ["network"] }),
    ];

    const diff = diffAuthority(base, head);
    const increases = authorityIncreases(diff);
    expect(increases).toHaveLength(1);
    expect(increases[0]?.symbol).toBe("src/pricing.ts#priceOrder");
    expect(increases[0]?.added).toEqual([{ kind: "effect", name: "network" }]);
    expect(hasAuthorityIncrease(diff)).toBe(true);
  });

  it("reports a new effect in an undeclared function as an increase", () => {
    const base = [record("src/util.ts#helper", { observed: [] })];
    const head = [record("src/util.ts#helper", { observed: ["fs_read"] })];

    expect(authorityIncreases(diffAuthority(base, head))[0]?.added).toEqual([
      { kind: "effect", name: "fs_read" },
    ]);
  });

  it("reports removing a declaration from a function whose body has the effect", () => {
    // Deleting `@effects pure` from a function that reaches network raises
    // what the rest of the codebase is entitled to assume about it.
    const base = [record("src/util.ts#helper", { declared: [], observed: ["network"] })];
    const head = [record("src/util.ts#helper", { declared: null, observed: ["network"] })];

    expect(authorityIncreases(diffAuthority(base, head))[0]?.added).toEqual([
      { kind: "effect", name: "network" },
    ]);
  });

  it("classifies a narrowed declaration as a decrease, not an increase", () => {
    const base = [record("src/util.ts#helper", { declared: ["network", "fs_write"] })];
    const head = [record("src/util.ts#helper", { declared: ["network"] })];

    const diff = diffAuthority(base, head);
    expect(hasAuthorityIncrease(diff)).toBe(false);
    const decreases = authorityDecreases(diff);
    expect(decreases).toHaveLength(1);
    expect(decreases[0]?.removed).toEqual([{ kind: "effect", name: "fs_write" }]);
    expect(decreases[0]?.unchanged).toEqual([{ kind: "effect", name: "network" }]);
  });

  it("classifies an unchanged symbol as unchanged, with neither side empty", () => {
    const same = { declared: ["db_read"], capDeclared: ["db:read:users"] } as const;
    const diff = diffAuthority([record("src/a.ts#read", same)], [record("src/a.ts#read", same)]);

    expect(hasAuthorityIncrease(diff)).toBe(false);
    expect(unchangedSymbols(diff)).toHaveLength(1);
    expect(unchangedSymbols(diff)[0]?.unchanged).toEqual([
      { kind: "effect", name: "db_read" },
      { kind: "capability", name: "db:read:users" },
    ]);
  });

  it("marks a symbol only the new side has as new, and one only the old side has as deleted", () => {
    const diff = diffAuthority(
      [record("src/gone.ts#old", { declared: ["network"] })],
      [record("src/fresh.ts#added", { declared: ["fs_write"] })],
    );

    const added = diff.symbols.find((s) => s.symbol === "src/fresh.ts#added");
    const gone = diff.symbols.find((s) => s.symbol === "src/gone.ts#old");
    expect(added?.status).toBe("new");
    expect(added?.added).toEqual([{ kind: "effect", name: "fs_write" }]);
    expect(gone?.status).toBe("deleted");
    expect(gone?.removed).toEqual([{ kind: "effect", name: "network" }]);
    expect(deletedSymbols(diff)).toHaveLength(1);
  });

  it("counts a new symbol that holds authority as an increase, and a pure one as not", () => {
    const withAuthority = diffAuthority([], [record("src/n.ts#f", { declared: ["network"] })]);
    const withoutAuthority = diffAuthority([], [record("src/n.ts#f", { declared: [] })]);

    expect(hasAuthorityIncrease(withAuthority)).toBe(true);
    expect(hasAuthorityIncrease(withoutAuthority)).toBe(false);
    expect(withoutAuthority.symbols[0]?.status).toBe("new");
  });

  it("does not count gaining unknown as an increase, but does report it", () => {
    const base = [record("src/u.ts#f", { declared: [], unknown: false })];
    const head = [record("src/u.ts#f", { declared: [], unknown: true })];

    const diff = diffAuthority(base, head);
    expect(hasAuthorityIncrease(diff)).toBe(false);
    expect(unknownGained(diff).map((s) => s.symbol)).toEqual(["src/u.ts#f"]);
    expect(diff.symbols[0]?.unknownLost).toBe(false);
  });

  it("narrowing a capability glob is not an increase; widening it is", () => {
    const narrowed = diffAuthority(
      [record("src/c.ts#f", { capDeclared: ["http:get:*.example.com"] })],
      [record("src/c.ts#f", { capDeclared: ["http:get:api.example.com"] })],
    );
    expect(hasAuthorityIncrease(narrowed)).toBe(false);
    expect(authorityDecreases(narrowed)[0]?.removed).toEqual([
      { kind: "capability", name: "http:get:*.example.com" },
    ]);

    const widened = diffAuthority(
      [record("src/c.ts#f", { capDeclared: ["http:get:api.example.com"] })],
      [record("src/c.ts#f", { capDeclared: ["http:get:*.example.com"] })],
    );
    expect(authorityIncreases(widened)[0]?.added).toEqual([
      { kind: "capability", name: "http:get:*.example.com" },
    ]);
  });

  it("a capability under a different action is an increase even with the same target", () => {
    const diff = diffAuthority(
      [record("src/c.ts#f", { capDeclared: ["http:get:api.example.com"] })],
      [
        record("src/c.ts#f", {
          capDeclared: ["http:get:api.example.com", "http:post:api.example.com"],
        }),
      ],
    );
    expect(authorityIncreases(diff)[0]?.added).toEqual([
      { kind: "capability", name: "http:post:api.example.com" },
    ]);
  });

  it("keeps effects and capabilities in separate namespaces", () => {
    // A capability whose text happens to match an effect name must not
    // cancel it out.
    const diff = diffAuthority(
      [record("src/c.ts#f", { declared: ["network"] })],
      [record("src/c.ts#f", { declared: [], capDeclared: ["network:x:y"] })],
    );
    const entry = diff.symbols[0];
    expect(entry?.added).toEqual([{ kind: "capability", name: "network:x:y" }]);
    expect(entry?.removed).toEqual([{ kind: "effect", name: "network" }]);
  });

  it("carries the call path of an increase through from the new side's record", () => {
    const head = record("src/pricing.ts#priceOrder", {
      declared: ["network"],
      observed: ["network"],
      paths: [
        {
          authority: "network",
          kind: "effect",
          via: [{ symbol: "src/rates.ts#currentRate" as SymbolId, file: "src/rates.ts", line: 3 }],
          operation: { qualifiedName: "fetch", file: "src/rates.ts", line: 4 },
        },
      ],
    });
    const diff = diffAuthority(
      [record("src/pricing.ts#priceOrder", { declared: [], observed: ["network"] })],
      [head],
    );

    const increase = authorityIncreases(diff)[0];
    const path = pathFor(increase?.head, { kind: "effect", name: "network" });
    expect(path?.via.map((hop) => hop.symbol)).toEqual(["src/rates.ts#currentRate"]);
    expect(path?.operation).toEqual({ qualifiedName: "fetch", file: "src/rates.ts", line: 4 });
  });

  it("has no path for an authority the function declares but does not reach", () => {
    const head = record("src/over.ts#f", { declared: ["network"], observed: [], paths: [] });
    const diff = diffAuthority([record("src/over.ts#f", { declared: [] })], [head]);
    expect(
      pathFor(authorityIncreases(diff)[0]?.head, { kind: "effect", name: "network" }),
    ).toBeUndefined();
  });

  it("sorts symbols by id so two runs over the same trees agree", () => {
    const diff = diffAuthority(
      [record("src/b.ts#f"), record("src/a.ts#f")],
      [record("src/c.ts#f"), record("src/a.ts#f")],
    );
    expect(diff.symbols.map((s) => s.symbol)).toEqual(["src/a.ts#f", "src/b.ts#f", "src/c.ts#f"]);
  });

  it("rejects a dump that names one symbol twice rather than silently taking one", () => {
    expect(() => diffAuthority([record("src/a.ts#f"), record("src/a.ts#f")], [])).toThrow(
      /duplicate authority record for src\/a\.ts#f on the base side/,
    );
    expect(() => diffAuthority([], [record("src/a.ts#f"), record("src/a.ts#f")])).toThrow(
      /on the head side/,
    );
  });

  it("comparing a dump with itself reports no change at all", () => {
    const dump = [
      record("src/a.ts#f", { declared: ["network"], observed: ["network"] }),
      record("src/b.ts#g", { observed: ["fs_read"], unknown: true }),
    ];
    const diff = diffAuthority(dump, dump);
    expect(hasAuthorityIncrease(diff)).toBe(false);
    expect(authorityDecreases(diff)).toHaveLength(0);
    expect(deletedSymbols(diff)).toHaveLength(0);
    expect(unknownGained(diff)).toHaveLength(0);
    expect(unchangedSymbols(diff)).toHaveLength(2);
  });
});
