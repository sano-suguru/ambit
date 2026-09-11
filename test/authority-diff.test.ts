import { describe, expect, it } from "vitest";
import type { AuthorityRecord, SymbolId } from "../src/core/index.ts";
import {
  attributionUnmatched,
  authorityDecreases,
  authorityIncreases,
  deletedSymbols,
  diffAuthority,
  hasAuthorityIncrease,
  hasUnresolvedWidening,
  movedSymbols,
  pathFor,
  unchangedSymbols,
  unknownGained,
  unresolvedGains,
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
    unresolved?: AuthorityRecord["unresolved"];
    paths?: AuthorityRecord["paths"];
    bodies?: AuthorityRecord["bodies"];
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
    unresolved: parts.unresolved ?? [],
    paths: parts.paths ?? [],
    ...(parts.bodies ? { bodies: parts.bodies } : {}),
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

  it("a deletion alone is not an increase, and neither is a decrease alone", () => {
    // The two cases DESIGN.md §6 reports and passes: exit 0, not silence.
    const deletionOnly = diffAuthority([record("src/a.ts#f", { declared: ["network"] })], []);
    expect(hasAuthorityIncrease(deletionOnly)).toBe(false);
    expect(deletedSymbols(deletionOnly)).toHaveLength(1);

    const decreaseOnly = diffAuthority(
      [record("src/a.ts#f", { declared: ["network"] })],
      [record("src/a.ts#f", { declared: [] })],
    );
    expect(hasAuthorityIncrease(decreaseOnly)).toBe(false);
    expect(authorityDecreases(decreaseOnly)).toHaveLength(1);
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

/**
 * Carrying a symbol across a file git reported as renamed (DESIGN.md §6.3).
 *
 * The rename map is an input, not something derived here: this module runs no
 * git, and matching two symbols on anything weaker than git's own report
 * would be a guess about identity.
 */
describe("diffAuthority with renamed files", () => {
  const renames = new Map([["old/tax.ts", "new/tax.ts"]]);

  it("compares a moved function against its old path instead of reporting a new symbol", () => {
    const diff = diffAuthority(
      [record("old/tax.ts#applyTax", { declared: ["network"] })],
      [record("new/tax.ts#applyTax", { declared: ["network"] })],
      renames,
    );
    expect(hasAuthorityIncrease(diff)).toBe(false);
    expect(deletedSymbols(diff)).toHaveLength(0);
    expect(movedSymbols(diff)).toHaveLength(1);
    expect(movedSymbols(diff)[0]?.movedFrom).toBe("old/tax.ts#applyTax");
    expect(unchangedSymbols(diff)).toHaveLength(1);
  });

  it("reports only what a move widened, not the authority it carried along", () => {
    const diff = diffAuthority(
      [record("old/tax.ts#applyTax", { declared: ["network"] })],
      [record("new/tax.ts#applyTax", { declared: ["network", "fs_write"] })],
      renames,
    );
    const increases = authorityIncreases(diff);
    expect(increases).toHaveLength(1);
    expect(increases[0]?.status).toBe("moved");
    expect(increases[0]?.added).toEqual([{ kind: "effect", name: "fs_write" }]);
  });

  it("still reports a moved function that lost authority as a decrease, not a deletion", () => {
    const diff = diffAuthority(
      [record("old/tax.ts#applyTax", { declared: ["network", "fs_write"] })],
      [record("new/tax.ts#applyTax", { declared: ["network"] })],
      renames,
    );
    expect(hasAuthorityIncrease(diff)).toBe(false);
    expect(authorityDecreases(diff)).toHaveLength(1);
    expect(deletedSymbols(diff)).toHaveLength(0);
  });

  it("does not excuse a different function in the renamed file", () => {
    // The file moved; `helper` did not exist in it before. Nothing about a
    // rename says a symbol that was never there is not new.
    const diff = diffAuthority(
      [record("old/tax.ts#applyTax", { declared: ["network"] })],
      [
        record("new/tax.ts#applyTax", { declared: ["network"] }),
        record("new/tax.ts#helper", { declared: ["fs_write"] }),
      ],
      renames,
    );
    const increases = authorityIncreases(diff);
    expect(increases).toHaveLength(1);
    expect(increases[0]?.symbol).toBe("new/tax.ts#helper");
    expect(increases[0]?.status).toBe("new");
  });

  it("leaves a symbol alone when the remapped id would collide with one the base already has", () => {
    // Unreachable through git, which cannot report a rename onto a path that
    // existed on the base side. Resolving the collision by guessing which
    // record wins is the one answer that could hide an increase, so neither
    // is remapped.
    const diff = diffAuthority(
      [record("old/tax.ts#f", { declared: ["network"] }), record("new/tax.ts#f")],
      [record("new/tax.ts#f", { declared: ["network"] })],
      renames,
    );
    expect(movedSymbols(diff)).toHaveLength(0);
    expect(authorityIncreases(diff)).toHaveLength(1);
    expect(deletedSymbols(diff)).toHaveLength(1);
  });

  it("ignores a rename of a file neither side has a record for", () => {
    const diff = diffAuthority(
      [record("src/a.ts#f")],
      [record("src/a.ts#f")],
      new Map([["src/gone.ts", "src/arrived.ts"]]),
    );
    expect(movedSymbols(diff)).toHaveLength(0);
    expect(unchangedSymbols(diff)).toHaveLength(1);
  });
});

/**
 * DESIGN.md §6.3: authority is compared as a multiset over the bodies a
 * symbol owns. A record carrying no `bodies` owns one, whose authority is the
 * record's own — which is why every case above, written without the field,
 * means what it used to.
 */
describe("a symbol that owns more than one body", () => {
  const body = (effects: readonly string[] = [], capabilities: readonly string[] = []) =>
    ({ effects, capabilities, unknown: false, unresolved: [] }) as NonNullable<
      AuthorityRecord["bodies"]
    >[number];

  it("counts a second holder of an effect the first already had as an increase", () => {
    const diff = diffAuthority(
      [
        record("r.ts#<inline callbacks>", {
          observed: ["network"],
          bodies: [body(["network"]), body()],
        }),
      ],
      [
        record("r.ts#<inline callbacks>", {
          observed: ["network"],
          bodies: [body(["network"]), body(["network"])],
        }),
      ],
    );
    // The record's own `observed` is identical on both sides. Only the number
    // of bodies holding it moved, and that is the increase a merged owner
    // would otherwise report as nothing.
    expect(authorityIncreases(diff)[0]?.added).toEqual([{ kind: "effect", name: "network" }]);
  });

  it("reports a body that stopped holding one as a decrease, never a failure", () => {
    const diff = diffAuthority(
      [
        record("r.ts#<inline callbacks>", {
          observed: ["network"],
          bodies: [body(["network"]), body(["network"])],
        }),
      ],
      [
        record("r.ts#<inline callbacks>", {
          observed: ["network"],
          bodies: [body(["network"]), body()],
        }),
      ],
    );
    expect(hasAuthorityIncrease(diff)).toBe(false);
    expect(authorityDecreases(diff)[0]?.removed).toEqual([{ kind: "effect", name: "network" }]);
  });

  it("refuses to call a body swap unchanged, because it cannot tell it from a reorder", () => {
    // The whole of §6.4's third shape. `[network, pure]` becoming
    // `[pure, network]` is one of two stories: the handlers were reordered, or
    // the authority moved from the first to the second. The bodies have no
    // names, so the two are the same pair of sequences — and one of them is a
    // public route that can now reach the network. Calling it unchanged would
    // be the guess §3.4 forbids.
    const diff = diffAuthority(
      [
        record("r.ts#<inline callbacks>", {
          observed: ["network"],
          bodies: [body(["network"]), body()],
        }),
      ],
      [
        record("r.ts#<inline callbacks>", {
          observed: ["network"],
          bodies: [body(), body(["network"])],
        }),
      ],
    );
    expect(hasAuthorityIncrease(diff)).toBe(false);
    expect(attributionUnmatched(diff).map((entry) => entry.symbol)).toEqual([
      "r.ts#<inline callbacks>",
    ]);
    expect(hasUnresolvedWidening(diff)).toBe(true);
    expect(unchangedSymbols(diff)).toHaveLength(0);
  });

  it("says so even when an increase was also found in the same symbol", () => {
    // One edit can raise one authority and relocate another. The increase's
    // report says nothing about the relocation, so the two are reported apart.
    const diff = diffAuthority(
      [
        record("r.ts#<inline callbacks>", {
          observed: ["network"],
          bodies: [body(["network"]), body()],
        }),
      ],
      [
        record("r.ts#<inline callbacks>", {
          observed: ["network", "db_write"],
          bodies: [body(), body(["db_write", "network"])],
        }),
      ],
    );
    expect(authorityIncreases(diff)[0]?.added).toEqual([{ kind: "effect", name: "db_write" }]);
    expect(attributionUnmatched(diff)).toHaveLength(1);
  });

  it("catches authority changing hands when no whole body stayed the same", () => {
    // `[{network}, {db_write}]` becoming `[{network, db_write}, {}]`. Both
    // counts stay at one, and no body is unchanged, so matching whole bodies
    // sees nothing — but `db_write` went from the second handler to the first.
    const diff = diffAuthority(
      [
        record("r.ts#<inline callbacks>", {
          observed: ["network", "db_write"],
          bodies: [body(["network"]), body(["db_write"])],
        }),
      ],
      [
        record("r.ts#<inline callbacks>", {
          observed: ["network", "db_write"],
          bodies: [body(["db_write", "network"]), body()],
        }),
      ],
    );
    expect(hasAuthorityIncrease(diff)).toBe(false);
    expect(authorityDecreases(diff)).toHaveLength(0);
    expect(attributionUnmatched(diff)).toHaveLength(1);
    expect(unchangedSymbols(diff)).toHaveLength(0);
    expect(hasUnresolvedWidening(diff)).toBe(true);
  });

  it("catches the same shape in capabilities", () => {
    const diff = diffAuthority(
      [
        record("r.ts#<inline callbacks>", {
          capRequired: ["http:get:a.example", "http:post:b.example"],
          bodies: [body([], ["http:get:a.example"]), body([], ["http:post:b.example"])],
        }),
      ],
      [
        record("r.ts#<inline callbacks>", {
          capRequired: ["http:get:a.example", "http:post:b.example"],
          bodies: [body([], ["http:get:a.example", "http:post:b.example"]), body()],
        }),
      ],
    );
    expect(hasAuthorityIncrease(diff)).toBe(false);
    expect(attributionUnmatched(diff)).toHaveLength(1);
  });

  it("stays silent when a body gained something no other body had", () => {
    // The control for the two above: `db_write` is held by one more body than
    // it was, so it did not change hands — it is an ordinary increase, and
    // saying "it may have moved" beside that report would be noise.
    const diff = diffAuthority(
      [
        record("r.ts#<inline callbacks>", {
          observed: ["network"],
          bodies: [body(["network"]), body()],
        }),
      ],
      [
        record("r.ts#<inline callbacks>", {
          observed: ["network", "db_write"],
          bodies: [body(["db_write", "network"]), body()],
        }),
      ],
    );
    expect(authorityIncreases(diff)[0]?.added).toEqual([{ kind: "effect", name: "db_write" }]);
    expect(attributionUnmatched(diff)).toHaveLength(0);
  });

  it("stays silent when every authority-bearing body sits where one already did", () => {
    // A body holding nothing inserted between two that are unchanged: the
    // common prefix and suffix match index for index, and what is left holds
    // no authority, so nothing moved. This is what keeps adding a route from
    // reporting the routes below it.
    const diff = diffAuthority(
      [
        record("r.ts#<inline callbacks>", {
          observed: ["network"],
          bodies: [body(), body(["network"])],
        }),
      ],
      [
        record("r.ts#<inline callbacks>", {
          observed: ["network"],
          bodies: [body(), body(), body(["network"])],
        }),
      ],
    );
    expect(attributionUnmatched(diff)).toHaveLength(0);
    expect(unchangedSymbols(diff)).toHaveLength(1);
  });

  it("stays silent for an ordinary one-body symbol, which has no attribution question", () => {
    const diff = diffAuthority(
      [record("a.ts#f", { observed: ["network"] })],
      [record("a.ts#f", { observed: ["network"] })],
    );
    expect(attributionUnmatched(diff)).toHaveLength(0);
  });

  it("catches a grant narrowing while it changes hands", () => {
    // `admin: http:get:*` → `public: http:get:api.example.com`. The total
    // narrowed, so `removed` names `http:get:*` and nothing increased — but a
    // public route can now reach a host only an admin route could, and that is
    // what the third shape is for. Read as raw tokens this looks like one
    // capability disappearing and another appearing; read as §4.4's
    // containment, `http:get:api.example.com` is held by one body on each side
    // and by a different one.
    const diff = diffAuthority(
      [
        record("r.ts#<inline callbacks>", {
          capRequired: ["http:get:*"],
          bodies: [body([], ["http:get:*"]), body()],
        }),
      ],
      [
        record("r.ts#<inline callbacks>", {
          capRequired: ["http:get:api.example.com"],
          bodies: [body(), body([], ["http:get:api.example.com"])],
        }),
      ],
    );
    expect(hasAuthorityIncrease(diff)).toBe(false);
    expect(authorityDecreases(diff)[0]?.removed).toEqual([
      { kind: "capability", name: "http:get:*" },
    ]);
    expect(attributionUnmatched(diff)).toHaveLength(1);
    expect(hasUnresolvedWidening(diff)).toBe(true);
    expect(unchangedSymbols(diff)).toHaveLength(0);
  });

  it("catches a grant widening while it changes hands, which is also an increase", () => {
    const diff = diffAuthority(
      [
        record("r.ts#<inline callbacks>", {
          capRequired: ["http:get:api.example.com"],
          bodies: [body([], ["http:get:api.example.com"]), body()],
        }),
      ],
      [
        record("r.ts#<inline callbacks>", {
          capRequired: ["http:get:*"],
          bodies: [body(), body([], ["http:get:*"])],
        }),
      ],
    );
    expect(authorityIncreases(diff)[0]?.added).toEqual([
      { kind: "capability", name: "http:get:*" },
    ]);
    expect(attributionUnmatched(diff)).toHaveLength(1);
  });

  it("stays silent when a grant narrows without changing hands", () => {
    // The control: the same body keeps it, so nothing moved and the narrowing
    // is reported as the decrease it is.
    const diff = diffAuthority(
      [
        record("r.ts#<inline callbacks>", {
          capRequired: ["http:get:*"],
          bodies: [body([], ["http:get:*"]), body()],
        }),
      ],
      [
        record("r.ts#<inline callbacks>", {
          capRequired: ["http:get:api.example.com"],
          bodies: [body([], ["http:get:api.example.com"]), body()],
        }),
      ],
    );
    expect(hasAuthorityIncrease(diff)).toBe(false);
    expect(attributionUnmatched(diff)).toHaveLength(0);
  });

  it("keeps capability containment, so narrowing a grant is still not an increase", () => {
    const diff = diffAuthority(
      [
        record("r.ts#<inline callbacks>", {
          capRequired: ["http:get:*"],
          bodies: [body([], ["http:get:*"]), body()],
        }),
      ],
      [
        record("r.ts#<inline callbacks>", {
          capRequired: ["http:get:api.example.com"],
          bodies: [body([], ["http:get:api.example.com"]), body()],
        }),
      ],
    );
    expect(hasAuthorityIncrease(diff)).toBe(false);
  });

  it("counts a second body that became unresolvable, which one boolean could not", () => {
    const unknownBody = { effects: [], capabilities: [], unknown: true, unresolved: [] };
    const diff = diffAuthority(
      [record("r.ts#<inline callbacks>", { unknown: true, bodies: [unknownBody, body()] })],
      [record("r.ts#<inline callbacks>", { unknown: true, bodies: [unknownBody, unknownBody] })],
    );
    expect(unknownGained(diff)).toHaveLength(1);
  });
});

/**
 * DESIGN.md §6.4's third shape is about *attribution*, not only about
 * authority: an operation the analysis could not read moving from one
 * anonymous handler to another is the same sentence about a different place,
 * and the counts do not move.
 */
describe("an unresolvable operation moving between anonymous bodies", () => {
  const opaque = (operation: string) => [
    { reason: "external-module" as const, operation, count: 1 },
  ];
  const unknownBody = (unresolved: AuthorityRecord["unresolved"] = []) => ({
    effects: [],
    capabilities: [],
    unknown: true,
    unresolved,
  });
  const plainBody = { effects: [], capabilities: [], unknown: false, unresolved: [] };

  it("is reported when the `unknown` body and the resolved one swap places", () => {
    const diff = diffAuthority(
      [record("r.ts#<inline callbacks>", { unknown: true, bodies: [unknownBody(), plainBody] })],
      [record("r.ts#<inline callbacks>", { unknown: true, bodies: [plainBody, unknownBody()] })],
    );
    expect(hasAuthorityIncrease(diff)).toBe(false);
    expect(unknownGained(diff)).toHaveLength(0);
    expect(attributionUnmatched(diff)).toHaveLength(1);
    expect(hasUnresolvedWidening(diff)).toBe(true);
  });

  it("is reported when the same opaque operation moves, at the same count", () => {
    const base = record("r.ts#<inline callbacks>", {
      unknown: true,
      unresolved: opaque("client.delete"),
      bodies: [unknownBody(opaque("client.delete")), plainBody],
    });
    const head = record("r.ts#<inline callbacks>", {
      unknown: true,
      unresolved: opaque("client.delete"),
      bodies: [plainBody, unknownBody(opaque("client.delete"))],
    });
    const diff = diffAuthority([base], [head]);
    // The owner's own multiset is identical, so §6.4's second shape says
    // nothing — which is correct, and is why the third shape has to exist.
    expect(unresolvedGains(diff)).toHaveLength(0);
    expect(attributionUnmatched(diff)).toHaveLength(1);
  });

  it("is reported when two different opaque operations swap, both bodies unknown", () => {
    const bodies = (first: string, second: string) => [
      unknownBody(opaque(first)),
      unknownBody(opaque(second)),
    ];
    const both = [
      { reason: "external-module" as const, operation: "client.delete", count: 1 },
      { reason: "external-module" as const, operation: "client.read", count: 1 },
    ];
    const diff = diffAuthority(
      [
        record("r.ts#<inline callbacks>", {
          unknown: true,
          unresolved: both,
          bodies: bodies("client.delete", "client.read"),
        }),
      ],
      [
        record("r.ts#<inline callbacks>", {
          unknown: true,
          unresolved: both,
          bodies: bodies("client.read", "client.delete"),
        }),
      ],
    );
    // Both bodies are `unknown` on both sides, so the boolean cannot tell them
    // apart; their own operations can.
    expect(unknownGained(diff)).toHaveLength(0);
    expect(unresolvedGains(diff)).toHaveLength(0);
    expect(attributionUnmatched(diff)).toHaveLength(1);
  });

  it("says nothing twice when the operation was added rather than moved", () => {
    // §6.4's second shape already names it, so the third does not repeat it.
    const diff = diffAuthority(
      [record("r.ts#<inline callbacks>", { unknown: true, bodies: [unknownBody(), plainBody] })],
      [
        record("r.ts#<inline callbacks>", {
          unknown: true,
          unresolved: opaque("client.delete"),
          bodies: [unknownBody(), unknownBody(opaque("client.delete"))],
        }),
      ],
    );
    expect(unresolvedGains(diff)).toHaveLength(1);
    expect(attributionUnmatched(diff)).toHaveLength(0);
  });
});
