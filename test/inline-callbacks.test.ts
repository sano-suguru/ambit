import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { analyze } from "../src/cli/analyze.ts";
import type { AuthorityRecord, SymbolAuthorityDiff } from "../src/core/index.ts";
import {
  attributionUnmatched,
  authorityIncreases,
  diffAuthority,
  formatApprovalLine,
  hasUnresolvedWidening,
  parseApprovals,
  reviewIncreases,
  unresolvedGains,
} from "../src/core/index.ts";

/**
 * DESIGN.md §4.1 (a), "The inline-callback owner": a function expression
 * written directly as a call argument at module scope belongs to no
 * declaration, and before this existed nothing walked it at all — authority
 * added inside one was reported nowhere, which is the silence §6.4 names as
 * the outcome that must not happen.
 *
 * Measured on a real repository as E6 in
 * `docs/measurements/2026-09-11-third-third-party-validation-outline.md`: 226
 * routes registered that way, `fetch` added inside one of them, exit 0 in both
 * modes and `--coverage` byte-identical.
 *
 * Two properties are asserted throughout and are the whole design:
 *
 * - the owner's id holds no position and no ordinal, so re-indenting, editing
 *   a neighbour, or inserting a sibling leaves it alone;
 * - authority is compared as a **multiset over the owned bodies** (§6.3), so a
 *   second callback gaining what a first already had is still an increase.
 *   Without that half, one symbol standing for many bodies would be a merge
 *   into silence — the same defect in a narrower place.
 */

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2023",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    skipLibCheck: true,
    types: [],
  },
  include: ["src"],
});

/** The router the fixtures register on: no framework, just a call taking a function. */
const ROUTER = `declare const router: {
  post(name: string, handler: (ctx: { url: string }) => Promise<void>): void;
  use(...handlers: Array<(ctx: { url: string }) => Promise<void>>): void;
};
`;

let workspace: string;

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ambit-inline-"));
  return async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  };
});

let counter = 0;

/** Analyze one source tree of a single `src/routes.ts`, plus an optional config. */
async function analyzeTree(source: string, config?: string) {
  const root = path.join(workspace, `t${counter++}`);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "tsconfig.json"), TSCONFIG);
  await fs.writeFile(path.join(root, "src", "routes.ts"), source);
  if (config !== undefined) await fs.writeFile(path.join(root, "ambit.config.mjs"), config);
  return analyze(root);
}

async function records(source: string): Promise<readonly AuthorityRecord[]> {
  return (await analyzeTree(source)).authority;
}

async function compare(base: string, head: string): Promise<readonly SymbolAuthorityDiff[]> {
  const [before, after] = await Promise.all([records(base), records(head)]);
  return diffAuthority(before, after).symbols;
}

/** The increases `ambit diff` would fail on, as `<symbol> <authority>` text. */
function increases(symbols: readonly SymbolAuthorityDiff[]): readonly string[] {
  return authorityIncreases({ symbols }).flatMap((entry) =>
    entry.added.map((ref) => `${entry.symbol} ${ref.kind}:${ref.name}`),
  );
}

const OWNER = "src/routes.ts#<inline callbacks>";

/** A file that always has one ordinary declaration, so "no functions found" never fires. */
function file(...body: readonly string[]): string {
  return `${ROUTER}
export function version(): number {
  return 1;
}

${body.join("\n\n")}
`;
}

const QUIET_HANDLER = `router.post("a", async (ctx) => {
  void ctx;
});`;

const FETCHING_HANDLER = `router.post("a", async (ctx) => {
  void ctx;
  await fetch("https://example.com/one");
});`;

describe("a function written inline as a call argument", () => {
  it("is analyzed under an owner symbol, and gaining authority in it fails the diff", async () => {
    const symbols = await compare(file(QUIET_HANDLER), file(FETCHING_HANDLER));
    expect(increases(symbols)).toEqual([
      `${OWNER} effect:network`,
      `${OWNER} capability:http:get:example.com`,
    ]);
  });

  it("carries the operation's own position, which the owner's location cannot", async () => {
    const head = await records(file(FETCHING_HANDLER));
    const owner = head.find((record) => record.symbol === OWNER);
    // The owner stands for bodies scattered through the file, so its own
    // location is the file. The path is what sends a reader to the call.
    expect(owner?.location.line).toBe(1);
    expect(owner?.paths.find((p) => p.authority === "network")?.operation).toMatchObject({
      qualifiedName: "fetch",
    });
  });

  it("works for a `function` expression exactly as for an arrow", async () => {
    const quiet = file(`router.post("a", async function (ctx) {
  void ctx;
});`);
    const loud = file(`router.post("a", async function (ctx) {
  void ctx;
  await fetch("https://example.com/one");
});`);
    expect(increases(await compare(quiet, loud))).toContain(`${OWNER} effect:network`);
  });

  it("is not created where a file has no unowned inline callback", async () => {
    const head = await records(file("export const port = 3000;"));
    expect(head.map((record) => record.symbol)).not.toContain(OWNER);
  });

  it("leaves a callback inside a named function attributed to that function", async () => {
    const head = await records(
      file(`export async function register(): Promise<void> {
  router.post("a", async (ctx) => {
    void ctx;
    await fetch("https://example.com/one");
  });
}`),
    );
    expect(head.map((record) => record.symbol)).not.toContain(OWNER);
    const register = head.find((record) => record.symbol === "src/routes.ts#register");
    expect(register?.effects.observed).toContain("network");
  });

  it("propagates through a named callee, not only through a direct operation", async () => {
    const base = file(
      `export async function ping(): Promise<void> {
  await fetch("https://example.com/one");
}`,
      QUIET_HANDLER,
    );
    const head = file(
      `export async function ping(): Promise<void> {
  await fetch("https://example.com/one");
}`,
      `router.post("a", async (ctx) => {
  void ctx;
  await ping();
});`,
    );
    expect(increases(await compare(base, head))).toContain(`${OWNER} effect:network`);
  });
});

describe("several inline callbacks in one file", () => {
  const twoQuiet = file(
    `router.post("a", async (ctx) => {
  void ctx;
});`,
    `router.post("b", async (ctx) => {
  void ctx;
});`,
  );

  it("tells a second callback's gain from the first one's, though they share an id", async () => {
    // The case a per-file *set* would merge into silence: `b` gains exactly
    // what `a` already holds, down to the URL. Compared as a multiset over
    // the bodies, one holder becomes two, and that is an increase.
    const base = file(
      `router.post("a", async (ctx) => {
  void ctx;
  await fetch("https://example.com/one");
});`,
      `router.post("b", async (ctx) => {
  void ctx;
});`,
    );
    const head = file(
      `router.post("a", async (ctx) => {
  void ctx;
  await fetch("https://example.com/one");
});`,
      `router.post("b", async (ctx) => {
  void ctx;
  await fetch("https://example.com/one");
});`,
    );
    expect(increases(await compare(base, head))).toEqual([
      `${OWNER} effect:network`,
      `${OWNER} capability:http:get:example.com`,
    ]);
  });

  it("distinguishes two callbacks passed to one call", async () => {
    const base = file(`router.use(
  async (ctx) => {
    void ctx;
    await fetch("https://example.com/one");
  },
  async (ctx) => {
    void ctx;
  },
);`);
    const head = file(`router.use(
  async (ctx) => {
    void ctx;
    await fetch("https://example.com/one");
  },
  async (ctx) => {
    void ctx;
    await fetch("https://example.com/one");
  },
);`);
    expect(increases(await compare(base, head))).toContain(`${OWNER} effect:network`);
  });

  it("gives a nested callback no identity of its own — it is part of the outer body", async () => {
    const base = file(`router.post("a", async (ctx) => {
  await Promise.all(
    [ctx.url].map(async (url) => {
      void url;
    }),
  );
});`);
    const head = file(`router.post("a", async (ctx) => {
  await Promise.all(
    [ctx.url].map(async (url) => {
      await fetch(url);
    }),
  );
});`);
    const symbols = await compare(base, head);
    const owners = symbols.filter((entry) => entry.symbol.includes("<inline callbacks"));
    expect(owners).toHaveLength(1);
    expect(increases(symbols)).toContain(`${OWNER} effect:network`);
  });

  it("reports nothing when a sibling is inserted above an untouched one", async () => {
    const withOneMore = file(
      `router.post("z", async (ctx) => {
  void ctx;
});`,
      `router.post("a", async (ctx) => {
  void ctx;
});`,
      `router.post("b", async (ctx) => {
  void ctx;
});`,
    );
    const symbols = await compare(twoQuiet, withOneMore);
    expect(increases(symbols)).toEqual([]);
    // And no §6.4 attribution report either: the inserted body holds nothing,
    // so every authority-bearing body is still where one already was.
    expect(attributionUnmatched({ symbols })).toEqual([]);
  });

  it("reports nothing when a sibling is removed from between two others", async () => {
    const three = file(
      `router.post("a", async (ctx) => {
  void ctx;
});`,
      `router.post("mid", async (ctx) => {
  void ctx;
});`,
      `router.post("b", async (ctx) => {
  void ctx;
});`,
    );
    const symbols = await compare(three, twoQuiet);
    expect(increases(symbols)).toEqual([]);
    expect(attributionUnmatched({ symbols })).toEqual([]);
  });

  it("reports nothing for a formatting-only change", async () => {
    const reflowed = file(
      `router.post(
  "a",
  async (ctx) => {
    void ctx;
  },
);`,
      `router.post("b", async (ctx) => { void ctx; });`,
    );
    const symbols = await compare(twoQuiet, reflowed);
    expect(increases(symbols)).toEqual([]);
    expect(attributionUnmatched({ symbols })).toEqual([]);
  });

  it("reports nothing for an unrelated edit above the callbacks", async () => {
    const edited = `${ROUTER}
export function version(): number {
  return 2;
}

export const name = "routes";

${twoQuiet.split("\n\n").slice(2).join("\n\n")}`;
    const symbols = await compare(twoQuiet, edited);
    expect(increases(symbols)).toEqual([]);
    expect(attributionUnmatched({ symbols })).toEqual([]);
  });

  it("reports nothing at all for an unchanged tree", async () => {
    const symbols = await compare(twoQuiet, twoQuiet);
    expect(increases(symbols)).toEqual([]);
    expect(attributionUnmatched({ symbols })).toEqual([]);
    expect(hasUnresolvedWidening({ symbols })).toBe(false);
    expect(symbols.every((entry) => entry.status === "present")).toBe(true);
  });
});

/**
 * DESIGN.md §6.4's third shape. The owner's bodies are anonymous, so
 * "authority moved from one handler to another" and "the handlers were
 * reordered" reach the comparison as the same two sequences. One of them is a
 * public route that can now reach the network, and calling the pair unchanged
 * would be exactly the guess §3.4 forbids.
 */
describe("authority moving between two anonymous handlers", () => {
  const withNetworkIn = (admin: boolean) =>
    file(
      `router.post("/admin", async (ctx) => {
  void ctx;${admin ? '\n  await fetch("https://internal.example");' : ""}
});`,
      `router.post("/public", async (ctx) => {
  void ctx;${admin ? "" : '\n  await fetch("https://internal.example");'}
});`,
    );

  it("is not reported as unchanged, though the total did not grow", async () => {
    const symbols = await compare(withNetworkIn(true), withNetworkIn(false));
    const diff = { symbols };
    // Nothing was granted — one handler holds network on each side — so there
    // is no increase and no approval line to write.
    expect(increases(symbols)).toEqual([]);
    // But the analysis cannot say it is the same handler, and says so.
    expect(attributionUnmatched(diff).map((entry) => entry.symbol)).toEqual([OWNER]);
    expect(hasUnresolvedWidening(diff)).toBe(true);
  });

  it("is reported when the authority merges into one handler instead of swapping", async () => {
    // The counterexample to matching whole bodies: `/a` keeps `network` and
    // takes `state_write` from `/b`, which is left holding nothing. Both
    // counts stay at one, and neither body is what it was.
    const tree = (merged: boolean) =>
      `${ROUTER}
export function version(): number {
  return 1;
}

const store: { data: number } = { data: 0 };

router.post("/a", async (ctx) => {
  void ctx;
  await fetch("https://x.example");${merged ? "\n  store.data = 1;" : ""}
});

router.post("/b", async (ctx) => {
  void ctx;${merged ? "" : "\n  store.data = 1;"}
});
`;
    const symbols = await compare(tree(false), tree(true));
    const diff = { symbols };
    expect(increases(symbols)).toEqual([]);
    expect(attributionUnmatched(diff).map((entry) => entry.symbol)).toEqual([OWNER]);
    expect(hasUnresolvedWidening(diff)).toBe(true);
  });

  it("is reported the same way whichever direction it moved", async () => {
    const symbols = await compare(withNetworkIn(false), withNetworkIn(true));
    expect(increases(symbols)).toEqual([]);
    expect(attributionUnmatched({ symbols })).toHaveLength(1);
  });

  it("says nothing when the handler that holds it is left alone", async () => {
    // The control: the same file, edited somewhere that holds no authority.
    const base = withNetworkIn(true);
    const head = base.replace("  void ctx;\n});", "  void ctx;\n  void 0;\n});");
    expect(base).not.toBe(head);
    const symbols = await compare(base, head);
    expect(increases(symbols)).toEqual([]);
    expect(attributionUnmatched({ symbols })).toHaveLength(0);
  });
});

/**
 * §6.4's third shape is about attribution, not only about authority. An
 * operation the analysis could not read moving from one anonymous handler to
 * another is §6.4's own sentence about a different place, and every count
 * stays where it was.
 */
describe("an unresolvable operation moving between anonymous handlers", () => {
  const OPAQUE = `declare const opaque: { run(): void };`;

  const withOpaqueIn = (admin: boolean) =>
    `${ROUTER}${OPAQUE}

export function version(): number {
  return 1;
}

router.post("/admin", async (ctx) => {
  void ctx;${admin ? "\n  opaque.run();" : ""}
});

router.post("/public", async (ctx) => {
  void ctx;${admin ? "" : "\n  opaque.run();"}
});
`;

  it("is reported when the opaque call itself moves, at the same count", async () => {
    const symbols = await compare(withOpaqueIn(true), withOpaqueIn(false));
    const diff = { symbols };
    // The owner's own `unresolved` multiset is identical — one opaque call
    // before, one after — so §6.4's second shape says nothing, correctly.
    expect(increases(symbols)).toEqual([]);
    expect(unresolvedGains(diff)).toEqual([]);
    expect(attributionUnmatched(diff).map((entry) => entry.symbol)).toEqual([OWNER]);
    expect(hasUnresolvedWidening(diff)).toBe(true);
  });

  it("is reported when the body is `unknown` only through a callee", async () => {
    // No unresolvable operation in the handler's own body, so nothing but the
    // `unknown` boolean distinguishes the two bodies — and the count of
    // `unknown` bodies does not move either.
    const tree = (admin: boolean) =>
      `${ROUTER}${OPAQUE}

export function reach(): void {
  opaque.run();
}

router.post("/admin", async (ctx) => {
  void ctx;${admin ? "\n  reach();" : ""}
});

router.post("/public", async (ctx) => {
  void ctx;${admin ? "" : "\n  reach();"}
});
`;
    const symbols = await compare(tree(true), tree(false));
    expect(increases(symbols)).toEqual([]);
    expect(attributionUnmatched({ symbols })).toHaveLength(1);
  });

  it("says nothing when the opaque call is added rather than moved", async () => {
    // §6.4's second shape names it, so the third does not repeat it: the two
    // ambiguous windows have no body in common.
    const symbols = await compare(
      withOpaqueIn(true),
      withOpaqueIn(true).replace(
        'router.post("/public", async (ctx) => {\n  void ctx;',
        'router.post("/public", async (ctx) => {\n  void ctx;\n  opaque.run();',
      ),
    );
    expect(increases(symbols)).toEqual([]);
    expect(unresolvedGains({ symbols })).toHaveLength(1);
    expect(attributionUnmatched({ symbols })).toEqual([]);
  });
});

describe("what the owner does not change", () => {
  it("keeps an unresolvable operation unresolvable — §6.4, not an increase", async () => {
    const base = file(`router.post("a", async (ctx) => {
  void ctx;
});`);
    const head = file(`router.post("a", async (ctx) => {
  const client = (ctx as unknown as { client: { send(to: string): Promise<void> } }).client;
  await client.send("somewhere");
});`);
    const symbols = await compare(base, head);
    // §4.3: what the analysis could not read is not authority, and §6.4 is
    // what reports it — at exit 0 by default, exit 1 only under --strict.
    expect(increases(symbols)).toEqual([]);
    expect(unresolvedGains({ symbols }).map((entry) => entry.symbol)).toEqual([OWNER]);
    expect(hasUnresolvedWidening({ symbols })).toBe(true);
  });

  it("reports a contract written on one of the callbacks as AMB-E003", async () => {
    const { diagnostics } = await analyzeTree(
      file(`router.post("a", /** @effects pure */ async (ctx) => {
  void ctx;
});`),
    );
    expect(diagnostics.filter((d) => d.id === "AMB-E003")).toHaveLength(1);
  });

  it("refuses a config key naming the owner, and says the contract is not in force", async () => {
    const { diagnostics, authority } = await analyzeTree(
      file(FETCHING_HANDLER),
      `export default {
  contracts: {
    "src/routes.ts#<inline callbacks>": { effects: [] },
    "src/routes.ts#version": { effects: ["fs_read"] },
  },
};
`,
    );
    // The key is writable — it is a declaration path like any other — so the
    // refusal has to be deliberate and visible, not an accident of matching.
    expect(diagnostics.some((d) => d.message.includes("matches no analyzed declaration"))).toBe(
      true,
    );
    const owner = authority.find((record) => record.symbol === OWNER);
    expect(owner?.effects.declared).toBeNull();
    expect(owner?.effects.observed).toContain("network");
    // The neighbouring key on an ordinary function still works, so what is
    // refused is the owner and not the config.
    expect(
      authority.find((record) => record.symbol === "src/routes.ts#version")?.effects.declared,
    ).toEqual(["fs_read"]);
  });

  it("does not adopt a contract written on one of the callbacks", async () => {
    const head = await records(
      file(`router.post(
  "a",
  /** @effects pure */
  async (ctx) => {
    void ctx;
    await fetch("https://example.com/one");
  },
);`),
    );
    const owner = head.find((record) => record.symbol === OWNER);
    // The tag names a function with no declaration site; adopting it would
    // let a comment declare several bodies `pure` at once.
    expect(owner?.effects.declared).toBeNull();
    expect(owner?.effects.observed).toContain("network");
  });
});

/**
 * DESIGN.md §6.3: the identity exists so that an approval line written for it
 * matches. The owner's id is the first to contain characters no declaration
 * path had — angle brackets and a space — so the round trip is asserted, not
 * assumed.
 */
describe("approving an increase on the owner", () => {
  const base = file(`router.post("a", async (ctx) => {
  void ctx;
});`);
  const head = file(`router.post("a", async (ctx) => {
  void ctx;
  await fetch("https://example.com/one");
});`);

  it("closes the gate when the printed line is copied into the ledger", async () => {
    const symbols = await compare(base, head);
    const diff = { symbols };
    const printed = authorityIncreases(diff).flatMap((entry) =>
      entry.added.map((ref) => formatApprovalLine(entry.symbol, ref, "reviewed")),
    );
    expect(printed[0]).toBe("- `src/routes.ts#<inline callbacks>` `effect:network` — reviewed");

    const ledger = parseApprovals(["# Approvals", "", ...printed].join("\n"));
    expect(ledger.malformed).toEqual([]);
    const review = reviewIncreases(diff, [], ledger.approvals);
    expect(review.unapproved).toEqual([]);
    expect(review.unused).toEqual([]);
    expect(review.approved).toHaveLength(printed.length);
  });

  it("costs one line however many bodies gained the authority", async () => {
    // The multiset decides *that* something grew; it is not carried into what
    // the increase is. Two handlers gaining `fetch` in one change is one
    // `(symbol, authority)` pair, so one line closes it.
    const twoMore = file(
      `router.post("a", async (ctx) => {
  void ctx;
  await fetch("https://example.com/one");
});`,
      `router.post("b", async (ctx) => {
  void ctx;
  await fetch("https://example.com/one");
});`,
    );
    const symbols = await compare(base, twoMore);
    const diff = { symbols };
    const networkIncreases = authorityIncreases(diff).flatMap((entry) =>
      entry.added.filter((ref) => ref.name === "network"),
    );
    expect(networkIncreases).toHaveLength(1);

    const ledger = parseApprovals(
      [
        "# Approvals",
        "",
        formatApprovalLine(OWNER as never, networkIncreases[0]!, "reviewed"),
      ].join("\n"),
    );
    const review = reviewIncreases(diff, [], ledger.approvals);
    expect(review.unapproved.map((item) => item.ref.name)).not.toContain("network");
  });
});
