import { describe, expect, it } from "vitest";
import { type DiffResult, formatDiffGithub, formatDiffText } from "../src/cli/diff.ts";
import type { AuthorityRecord, RenamedFiles, SymbolId } from "../src/core/index.ts";
import { diffAuthority, parseApprovals, reviewIncreases } from "../src/core/index.ts";

/**
 * The rendering is a function of the comparison, and the comparison is a
 * function of two dumps, so nothing here needs a repository either.
 */
function record(symbol: string, parts: Partial<AuthorityRecord> = {}): AuthorityRecord {
  return {
    kind: "authority",
    symbol: symbol as SymbolId,
    location: { file: symbol.split("#")[0] ?? "", line: 4, col: 1, endLine: 4, endCol: 2 },
    entrypoint: false,
    effects: { declared: null, observed: [], unknown: false },
    capabilities: { declared: null, required: [], unknown: false },
    unresolved: [],
    paths: [],
    ...parts,
  };
}

interface Ledgers {
  /** The ledger text on each side, as `ambit diff` reads it (DESIGN.md §6.3). */
  readonly base?: string;
  readonly head?: string;
  readonly renames?: RenamedFiles;
  readonly over?: string;
}

function result(
  base: readonly AuthorityRecord[],
  head: readonly AuthorityRecord[],
  ledgers: Ledgers = {},
): DiffResult {
  const diff = diffAuthority(base, head, ledgers.renames);
  const baseLedger = parseApprovals(ledgers.base ?? "");
  const headLedger = parseApprovals(ledgers.head ?? "");
  return {
    diff,
    review: reviewIncreases(diff, baseLedger.approvals, headLedger.approvals),
    malformedApprovals: headLedger.malformed,
    ...(ledgers.head === undefined ? {} : { approvalsFile: "ambit.approvals.md" }),
    ref: "main",
    baseCommit: "0123456789abcdef0123456789abcdef01234567",
    subdir: ledgers.over ?? "src",
    dir: process.cwd(),
  };
}

function render(
  base: readonly AuthorityRecord[],
  head: readonly AuthorityRecord[],
  ledgers: Ledgers = {},
): string {
  return formatDiffText(result(base, head, ledgers));
}

const WIDENED_HEAD = record("pricing.ts#priceOrder", {
  effects: { declared: ["network"], observed: ["network"], unknown: false },
  paths: [
    {
      authority: "network",
      kind: "effect",
      via: [
        { symbol: "tax.ts#applyTax" as SymbolId, file: "tax.ts", line: 3 },
        { symbol: "rates.ts#currentRate" as SymbolId, file: "rates.ts", line: 3 },
      ],
      operation: { qualifiedName: "fetch", file: "rates.ts", line: 4 },
    },
  ],
});
const WIDENED_BASE = record("pricing.ts#priceOrder", {
  effects: { declared: [], observed: ["network"], unknown: false },
});

describe("formatDiffText", () => {
  it("leads with what increased, before anything else", () => {
    const output = render(
      [
        WIDENED_BASE,
        record("old.ts#gone", { effects: { declared: ["fs_read"], observed: [], unknown: false } }),
      ],
      [WIDENED_HEAD],
    );
    const lines = output.split("\n");
    const increased = lines.findIndex((line) => line.includes("increased without approval"));
    const gone = lines.findIndex((line) => line.includes("no longer present"));
    const unchanged = lines.findIndex((line) => line.includes("unchanged, out of"));

    expect(increased).toBeGreaterThan(-1);
    expect(increased).toBeLessThan(gone);
    expect(increased).toBeLessThan(unchanged);
  });

  it("gives each increase the call path that introduced it", () => {
    const output = render([WIDENED_BASE], [WIDENED_HEAD]);
    expect(output).toContain("pricing.ts#priceOrder");
    expect(output).toContain("    + network");
    expect(output).toContain("      -> applyTax (tax.ts:3)");
    expect(output).toContain("      -> currentRate (rates.ts:3)");
    expect(output).toContain("      operation: fetch (rates.ts:4)");
  });

  it("names a capability increase as a capability, not as an effect", () => {
    const output = render(
      [record("a.ts#f", { capabilities: { declared: [], required: [], unknown: false } })],
      [
        record("a.ts#f", {
          capabilities: { declared: ["http:get:api.example.com"], required: [], unknown: false },
        }),
      ],
    );
    expect(output).toContain("+ capability http:get:api.example.com");
  });

  it("marks a symbol that did not exist on the base side", () => {
    const output = render(
      [],
      [record("new.ts#f", { effects: { declared: ["network"], observed: [], unknown: false } })],
    );
    expect(output).toContain("new.ts#f");
    expect(output).toContain("[new symbol]");
  });

  it("does not print a call path for an authority the body does not reach", () => {
    // Declared but never exercised: there is no path, and none is invented.
    const output = render(
      [record("over.ts#f")],
      [record("over.ts#f", { effects: { declared: ["network"], observed: [], unknown: false } })],
    );
    expect(output).toContain("+ network");
    expect(output).not.toContain("->");
    expect(output).not.toContain("operation:");
  });

  it("says plainly when nothing increased, and still reports the decrease", () => {
    const output = render(
      [
        record("a.ts#f", {
          effects: { declared: ["network", "fs_read"], observed: [], unknown: false },
        }),
      ],
      [record("a.ts#f", { effects: { declared: ["network"], observed: [], unknown: false } })],
    );
    expect(output).toContain("No authority increased.");
    expect(output).toContain("Authority decreased in 1 symbol:");
    expect(output).toContain("    - fs_read");
  });

  it("reports a range that stopped being analyzable without calling it an increase", () => {
    const output = render(
      [record("u.ts#f")],
      [record("u.ts#f", { effects: { declared: null, observed: [], unknown: true } })],
    );
    expect(output).toContain("No authority increased.");
    expect(output).toContain("could not resolve in 1 symbol");
    expect(output).toContain("is not counted as an increase");
    expect(output).toContain("  u.ts#f");
  });

  it("counts the unchanged rather than listing their contracts", () => {
    const unchanged = Array.from({ length: 40 }, (_, i) =>
      record(`m${i}.ts#f`, { effects: { declared: ["db_read"], observed: [], unknown: false } }),
    );
    const output = render(unchanged, unchanged);
    expect(output).toContain("40 symbols unchanged, out of 40 symbols compared.");
    expect(output).not.toContain("db_read");
    // The whole no-change report fits on a screen.
    expect(output.split("\n").length).toBeLessThan(10);
  });

  it("prints the approval line to add for an increase nothing approves", () => {
    const output = render([WIDENED_BASE], [WIDENED_HEAD]);
    expect(output).toContain("1 authority increased without approval:");
    expect(output).toContain("    - `pricing.ts#priceOrder` `effect:network` —");
    expect(output).toContain("ambit.approvals.md");
  });

  it("still prints an approved increase in full, with the reason and where it came from", () => {
    // An increase nobody sees is what the ledger exists to prevent, so an
    // approval moves it out of the failing section, not out of the report.
    const output = render([WIDENED_BASE], [WIDENED_HEAD], {
      head: "- `pricing.ts#priceOrder` `effect:network` — rates moved behind an HTTP API",
    });
    expect(output).toContain("1 authority increased, approved in this change:");
    expect(output).not.toContain("without approval");
    expect(output).toContain("    + network");
    expect(output).toContain("      -> applyTax (tax.ts:3)");
    expect(output).toContain("      approved: rates moved behind an HTTP API");
    expect(output).toContain("(ambit.approvals.md:1)");
  });

  it("reports a ledger line that granted nothing", () => {
    const output = render([record("a.ts#f")], [record("a.ts#f")], {
      head: "- `gone.ts#g` `effect:network` — nothing here gained that",
    });
    expect(output).toContain("1 approval added here matched no increase and granted nothing:");
    expect(output).toContain("ambit.approvals.md:1  gone.ts#g effect:network");
  });

  it("reports a ledger line that did not parse, and what it said", () => {
    const output = render([record("a.ts#f")], [record("a.ts#f")], {
      head: "- a.ts#f effect:network — no code spans",
    });
    expect(output).toContain("did not parse as an approval and granted nothing:");
    expect(output).toContain("line 1: - a.ts#f effect:network — no code spans");
  });

  it("names a moved symbol by both of its paths rather than calling it new", () => {
    const output = render(
      [record("old/a.ts#f", { effects: { declared: ["network"], observed: [], unknown: false } })],
      [record("new/a.ts#f", { effects: { declared: ["network"], observed: [], unknown: false } })],
      { renames: new Map([["old/a.ts", "new/a.ts"]]) },
    );
    expect(output).toContain("No authority increased.");
    expect(output).toContain("1 symbol moved with a renamed file");
    expect(output).toContain("  old/a.ts#f -> new/a.ts#f");
    expect(output).not.toContain("no longer present");
  });

  it("names the base ref, its commit and the directory compared", () => {
    const output = render([record("a.ts#f")], [record("a.ts#f")], { over: "src" });
    expect(output.split("\n")[0]).toBe("base main (0123456) vs the working tree, over src");
  });
});

describe("formatDiffGithub", () => {
  it("emits one annotation per authority gained, with the path folded in", () => {
    const output = formatDiffGithub(result([WIDENED_BASE], [WIDENED_HEAD]));
    const annotations = output.split("\n").filter((line) => line.startsWith("::"));
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toContain("::error file=pricing.ts,line=4,col=1,title=ambit diff::");
    expect(annotations[0]).toContain("priceOrder gained network since main");
    // `:` terminates a property value, not the body, so hops keep their colon.
    expect(annotations[0]).toContain("%0A-> applyTax (tax.ts:3)");
    expect(annotations[0]).toContain("%0Aoperation: fetch (rates.ts:4)");
  });

  it("emits one annotation per authority, not one per symbol", () => {
    // Two authorities gained by one function are two decisions for a
    // reviewer, so they are two annotations.
    const output = formatDiffGithub(
      result(
        [record("a.ts#f")],
        [
          record("a.ts#f", {
            effects: { declared: ["network", "fs_write"], observed: [], unknown: false },
          }),
        ],
      ),
    );
    const annotations = output.split("\n").filter((line) => line.startsWith("::"));
    expect(annotations).toHaveLength(2);
    expect(annotations.some((a) => a.includes("gained network"))).toBe(true);
    expect(annotations.some((a) => a.includes("gained fs_write"))).toBe(true);
  });

  it("annotates a new symbol that holds authority, and says it is new", () => {
    const output = formatDiffGithub(
      result(
        [],
        [record("n.ts#f", { effects: { declared: ["llm"], observed: [], unknown: false } })],
      ),
    );
    const annotations = output.split("\n").filter((line) => line.startsWith("::"));
    // `llm` implies `network` (DESIGN.md §4.2), so the declared set expands.
    expect(annotations.length).toBeGreaterThanOrEqual(1);
    expect(output).toContain("(new symbol)");
  });

  it("annotates an approved increase as a notice carrying the reason, not as an error", () => {
    const output = formatDiffGithub(
      result([WIDENED_BASE], [WIDENED_HEAD], {
        head: "- `pricing.ts#priceOrder` `effect:network` — rates moved behind an HTTP API",
      }),
    );
    const annotations = output.split("\n").filter((line) => line.startsWith("::"));
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toContain("::notice file=pricing.ts,");
    expect(annotations[0]).toContain("approved in this change: rates moved behind an HTTP API");
  });

  it("carries the ledger line to add in the annotation for an unapproved increase", () => {
    const output = formatDiffGithub(result([WIDENED_BASE], [WIDENED_HEAD]));
    expect(output).toContain("::error file=pricing.ts,");
    expect(output).toContain("add to ambit.approvals.md: - `pricing.ts#priceOrder`");
  });

  it("annotates nothing for a symbol that only moved", () => {
    const output = formatDiffGithub(
      result(
        [
          record("old/a.ts#f", {
            effects: { declared: ["network"], observed: [], unknown: false },
          }),
        ],
        [
          record("new/a.ts#f", {
            effects: { declared: ["network"], observed: [], unknown: false },
          }),
        ],
        { renames: new Map([["old/a.ts", "new/a.ts"]]) },
      ),
    );
    expect(output).toBe("");
  });

  it("annotates nothing when nothing increased", () => {
    const decrease = formatDiffGithub(
      result(
        [record("a.ts#f", { effects: { declared: ["network"], observed: [], unknown: false } })],
        [record("a.ts#f", { effects: { declared: [], observed: [], unknown: false } })],
      ),
    );
    expect(decrease).toBe("");

    const deletion = formatDiffGithub(
      result(
        [record("a.ts#f", { effects: { declared: ["network"], observed: [], unknown: false } })],
        [],
      ),
    );
    expect(deletion).toBe("");
  });
});
