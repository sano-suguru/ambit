import { describe, expect, it } from "vitest";
import type { AuthorityRecord, SymbolId } from "../src/core/index.ts";
import {
  diffAuthority,
  formatApprovalLine,
  parseApprovals,
  reviewIncreases,
} from "../src/core/index.ts";

/**
 * The approval ledger, as a pure function (DESIGN.md §6.3).
 *
 * Text and two authority dumps in, a decision out. No repository is involved
 * here for the same reason `authority-diff.test.ts` needs none: the rule that
 * decides whether a pull request passes must be testable without one.
 */
function record(symbol: string, declared: readonly string[] | null = null): AuthorityRecord {
  return {
    kind: "authority",
    symbol: symbol as SymbolId,
    location: { file: symbol.split("#")[0] ?? "", line: 1, col: 1, endLine: 1, endCol: 2 },
    entrypoint: false,
    effects: {
      declared: declared as AuthorityRecord["effects"]["declared"],
      observed: [],
      unknown: false,
    },
    capabilities: { declared: null, required: [], unknown: false },
    unresolved: [],
    paths: [],
  };
}

/** A tree where `a.ts#f` gained `network`, which is what every case below approves or does not. */
function gainedNetwork() {
  return diffAuthority([record("a.ts#f", [])], [record("a.ts#f", ["network"])]);
}

const APPROVES_NETWORK = "- `a.ts#f` `effect:network` — the rate table moved behind an HTTP API";

describe("parseApprovals", () => {
  it("reads a symbol id, an authority and a reason", () => {
    const { approvals, malformed } = parseApprovals(`# Approvals\n\n${APPROVES_NETWORK}\n`);
    expect(malformed).toHaveLength(0);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.symbol).toBe("a.ts#f");
    expect(approvals[0]?.authority).toEqual({ kind: "effect", name: "network" });
    expect(approvals[0]?.reason).toBe("the rate table moved behind an HTTP API");
    expect(approvals[0]?.line).toBe(3);
  });

  it("keeps a capability token whole, colons and glob included", () => {
    const { approvals } = parseApprovals("- `a.ts#f` `capability:http:get:*.example.com` — why\n");
    expect(approvals[0]?.authority).toEqual({
      kind: "capability",
      name: "http:get:*.example.com",
    });
  });

  it("reads a path containing spaces, because a code span is not whitespace-delimited", () => {
    const { approvals, malformed } = parseApprovals("- `my dir/a.ts#f` `effect:network` — why\n");
    expect(malformed).toHaveLength(0);
    expect(approvals[0]?.symbol).toBe("my dir/a.ts#f");
  });

  it("reads only the lines below the Approvals heading, so prose above may use bullets", () => {
    const { approvals, malformed } = parseApprovals(
      [
        "# Authority approvals",
        "",
        "- **Append; do not edit.** What is counted is how many lines name a pair.",
        "- A line counts only in the comparison that adds it.",
        "",
        "## Approvals",
        "",
        APPROVES_NETWORK,
      ].join("\n"),
    );
    expect(malformed).toHaveLength(0);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.line).toBe(8);
  });

  it("reads a file with no heading as approvals throughout", () => {
    const { approvals, malformed } = parseApprovals(`${APPROVES_NETWORK}\n`);
    expect(malformed).toHaveLength(0);
    expect(approvals).toHaveLength(1);
  });

  it("ignores prose, whatever it says", () => {
    const { approvals, malformed } = parseApprovals(
      "# Approvals\n\nEvery `- ` line below approves one increase.\n\n| a | b |\n",
    );
    expect(approvals).toHaveLength(0);
    expect(malformed).toHaveLength(0);
  });

  it("reports a `-` line that is not an approval instead of demoting it to prose", () => {
    // A typo in an approval that reads as prose is an approval that does
    // nothing and says nothing (DESIGN.md §3.4).
    const { approvals, malformed } = parseApprovals(
      [
        "## Approvals",
        "- `a.ts#f` effect:network — no code span",
        "- `a.ts#f` `network` — no kind prefix",
        "- `a.ts#f` `effect:network`",
        "- `a.ts#f` `budget:timeMs` — not an authority kind",
      ].join("\n"),
    );
    expect(approvals).toHaveLength(0);
    expect(malformed.map((entry) => entry.line)).toEqual([2, 3, 4, 5]);
  });

  it("does not validate the effect name, because a config file can define one", () => {
    const { approvals } = parseApprovals("- `a.ts#f` `effect:telemetry` — a user-defined effect\n");
    expect(approvals[0]?.authority).toEqual({ kind: "effect", name: "telemetry" });
  });

  it("round-trips the line ambit diff prints", () => {
    const line = formatApprovalLine("a.ts#f" as SymbolId, { kind: "effect", name: "network" }, "r");
    const { approvals, malformed } = parseApprovals(line);
    expect(malformed).toHaveLength(0);
    expect(approvals[0]?.symbol).toBe("a.ts#f");
    expect(approvals[0]?.authority).toEqual({ kind: "effect", name: "network" });
  });
});

describe("reviewIncreases", () => {
  it("fails an increase with an empty ledger on both sides", () => {
    const review = reviewIncreases(gainedNetwork(), [], []);
    expect(review.unapproved).toHaveLength(1);
    expect(review.approved).toHaveLength(0);
  });

  it("passes an increase whose approval was added in this comparison", () => {
    const head = parseApprovals(APPROVES_NETWORK).approvals;
    const review = reviewIncreases(gainedNetwork(), [], head);
    expect(review.unapproved).toHaveLength(0);
    expect(review.approved).toHaveLength(1);
    expect(review.approved[0]?.approval.reason).toBe("the rate table moved behind an HTTP API");
  });

  it("does not let an approval already in the base grant anything", () => {
    // The whole of the design: an approval is valid only in the comparison
    // that adds it, so a merged line cannot cover a later reintroduction.
    const both = parseApprovals(APPROVES_NETWORK).approvals;
    const review = reviewIncreases(gainedNetwork(), both, both);
    expect(review.approved).toHaveLength(0);
    expect(review.unapproved).toHaveLength(1);
  });

  it("re-approves the same pair when a second identical line is appended", () => {
    const base = parseApprovals(APPROVES_NETWORK).approvals;
    const head = parseApprovals(`${APPROVES_NETWORK}\n${APPROVES_NETWORK}`).approvals;
    const review = reviewIncreases(gainedNetwork(), base, head);
    expect(review.approved).toHaveLength(1);
    // The line that counts is the appended one, not the one already merged.
    expect(review.approved[0]?.approval.line).toBe(2);
    expect(review.unapproved).toHaveLength(0);
  });

  it("cannot be made to grant by deleting a line", () => {
    const base = parseApprovals(`${APPROVES_NETWORK}\n${APPROVES_NETWORK}`).approvals;
    const head = parseApprovals(APPROVES_NETWORK).approvals;
    const review = reviewIncreases(gainedNetwork(), base, head);
    expect(review.approved).toHaveLength(0);
    expect(review.unapproved).toHaveLength(1);
  });

  it("approves one increase per line, not every increase of that pair", () => {
    const diff = diffAuthority(
      [record("a.ts#f", []), record("b.ts#g", [])],
      [record("a.ts#f", ["network"]), record("b.ts#g", ["network"])],
    );
    const review = reviewIncreases(diff, [], parseApprovals(APPROVES_NETWORK).approvals);
    expect(review.approved.map((item) => item.entry.symbol)).toEqual(["a.ts#f"]);
    expect(review.unapproved.map((item) => item.entry.symbol)).toEqual(["b.ts#g"]);
  });

  it("matches an authority as exact text, so a wider capability does not cover a narrower one", () => {
    // Containment is how a grant relates to a requirement (§4.4). An approval
    // is neither, and one line must not quietly cover a family of increases.
    const diff = diffAuthority(
      [
        {
          ...record("a.ts#f"),
          capabilities: { declared: [], required: [], unknown: false },
        },
      ],
      [
        {
          ...record("a.ts#f"),
          capabilities: {
            declared: ["http:get:api.example.com"],
            required: [],
            unknown: false,
          },
        },
      ],
    );
    const wide = parseApprovals("- `a.ts#f` `capability:http:get:*` — too wide").approvals;
    expect(reviewIncreases(diff, [], wide).unapproved).toHaveLength(1);

    const exact = parseApprovals(
      "- `a.ts#f` `capability:http:get:api.example.com` — exact",
    ).approvals;
    expect(reviewIncreases(diff, [], exact).approved).toHaveLength(1);
  });

  it("reports a new approval that matched no increase, without failing on it alone", () => {
    const stray = parseApprovals("- `nowhere.ts#g` `effect:fs_write` — typo").approvals;
    const review = reviewIncreases(
      diffAuthority([record("a.ts#f")], [record("a.ts#f")]),
      [],
      stray,
    );
    expect(review.unused).toHaveLength(1);
    expect(review.unused[0]?.symbol).toBe("nowhere.ts#g");
    expect(review.unapproved).toHaveLength(0);
  });

  it("does not report an approval already in the base as unused", () => {
    // Old lines are history. Warning on every one of them, every run, would
    // bury the line that actually needs attention.
    const both = parseApprovals("- `nowhere.ts#g` `effect:fs_write` — long merged").approvals;
    const review = reviewIncreases(
      diffAuthority([record("a.ts#f")], [record("a.ts#f")]),
      both,
      both,
    );
    expect(review.unused).toHaveLength(0);
  });

  it("approves each authority of a symbol separately", () => {
    const diff = diffAuthority([record("a.ts#f", [])], [record("a.ts#f", ["network", "fs_write"])]);
    const review = reviewIncreases(diff, [], parseApprovals(APPROVES_NETWORK).approvals);
    expect(review.approved.map((item) => item.ref.name)).toEqual(["network"]);
    expect(review.unapproved.map((item) => item.ref.name)).toEqual(["fs_write"]);
  });
});
