import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { DiffResult } from "../src/cli/diff.ts";
import { failsStrict, formatDiffGithub, formatDiffText } from "../src/cli/diff.ts";
import type { AuthorityRecord, SymbolId } from "../src/core/index.ts";
import {
  diffAuthority,
  hasUnresolvedWidening,
  parseApprovals,
  reviewIncreases,
  unchangedSymbols,
  unknownGained,
  unresolvedGains,
} from "../src/core/index.ts";

/**
 * DESIGN.md §6.4: what `ambit diff` says when a symbol gains an operation the
 * analysis cannot resolve.
 *
 * The near neighbour is deliberately re-asserted here as well: a *known*
 * effect added inside an `unknown` symbol is an ordinary authority increase
 * and must keep failing. The measured miss (ADR-0012) is only the
 * unresolvable gain, and a change that widened it into the working gate would
 * be a regression this file has to catch.
 */

const execFileAsync = promisify(execFile);
const CLI_PATH = path.join(import.meta.dirname, "..", "src", "cli", "main.ts");
const FIXTURE = path.join(import.meta.dirname, "fixtures", "init-unresolved");

function record(symbol: string, parts: Partial<AuthorityRecord> = {}): AuthorityRecord {
  return {
    kind: "authority",
    symbol: symbol as SymbolId,
    location: { file: symbol.split("#")[0] ?? "", line: 7, col: 1, endLine: 7, endCol: 2 },
    entrypoint: false,
    effects: { declared: null, observed: [], unknown: true },
    capabilities: { declared: null, required: [], unknown: false },
    unresolved: [],
    paths: [],
    ...parts,
  };
}

/** `n` calls to one unresolvable operation, as the record carries them. */
function opaque(operation: string, count = 1): AuthorityRecord["unresolved"] {
  return [{ reason: "external-module", operation, count }];
}

function result(base: readonly AuthorityRecord[], head: readonly AuthorityRecord[]): DiffResult {
  const diff = diffAuthority(base, head);
  const empty = parseApprovals("");
  return {
    diff,
    review: reviewIncreases(diff, empty.approvals, empty.approvals),
    malformedApprovals: [],
    ref: "main",
    baseCommit: "0123456789abcdef0123456789abcdef01234567",
    subdir: "src",
    dir: process.cwd(),
  };
}

describe("an unresolvable gain, compared (DESIGN.md §6.4)", () => {
  it("names the operation a symbol gained while `unknown` on both sides", () => {
    // The measured miss: `axios.get` added to a function that was already
    // `unknown`. Before §6.4 this compared equal to itself.
    const diff = diffAuthority(
      [record("a.ts#f")],
      [record("a.ts#f", { unresolved: opaque("axios.get") })],
    );

    const gained = unresolvedGains(diff);
    expect(gained.map((entry) => entry.symbol)).toEqual(["a.ts#f"]);
    expect(gained[0]?.unresolvedGained).toEqual([
      { reason: "external-module", operation: "axios.get", count: 1 },
    ]);
    // Not authority, and not an increase: nothing to approve, nothing to fail
    // on without `--strict` (§4.3).
    expect(gained[0]?.added).toEqual([]);
    expect(gained[0]?.unknownGained).toBe(false);
  });

  it("counts a second call to the same operation as a second operation", () => {
    const diff = diffAuthority(
      [record("a.ts#f", { unresolved: opaque("axios.get", 1) })],
      [record("a.ts#f", { unresolved: opaque("axios.get", 3) })],
    );
    // The delta, not the head side's total: two were added.
    expect(unresolvedGains(diff)[0]?.unresolvedGained).toEqual([
      { reason: "external-module", operation: "axios.get", count: 2 },
    ]);
  });

  it("says nothing when the two sides hold the same operations", () => {
    const diff = diffAuthority(
      [record("a.ts#f", { unresolved: opaque("axios.get", 2) })],
      [record("a.ts#f", { unresolved: opaque("axios.get", 2) })],
    );
    expect(unresolvedGains(diff)).toEqual([]);
    expect(hasUnresolvedWidening(diff)).toBe(false);
  });

  it("says nothing when the analysis resolved more than it did", () => {
    // A stub landing is the analysis reaching further. §6 does not watch the
    // decreasing direction, here for the same reason it does not for authority.
    const diff = diffAuthority(
      [record("a.ts#f", { unresolved: opaque("ky.post", 2) })],
      [record("a.ts#f", { unresolved: opaque("ky.post", 1) })],
    );
    expect(unresolvedGains(diff)).toEqual([]);
  });

  it("distinguishes operations by name and by reason", () => {
    const diff = diffAuthority(
      [record("a.ts#f", { unresolved: opaque("axios.get") })],
      [
        record("a.ts#f", {
          unresolved: [
            { reason: "external-module", operation: "axios.get", count: 1 },
            { reason: "external-module", operation: "axios.post", count: 1 },
            { reason: "any-typed", count: 1 },
          ],
        }),
      ],
    );
    expect(unresolvedGains(diff)[0]?.unresolvedGained).toEqual([
      { reason: "any-typed", count: 1 },
      { reason: "external-module", operation: "axios.post", count: 1 },
    ]);
  });

  it("keeps operations distinct when the name itself contains the key's joiner", () => {
    // `node:fs.writeFileSync` is a real qualified name in these tables, and the
    // multiset's key is `<reason>:<name>`. It stays unambiguous because a
    // reason is a fixed token with no `":"` in it, so the first colon is always
    // the joiner — asserted rather than assumed, since a collision here would
    // silently merge two operations and hide one of them.
    const diff = diffAuthority(
      [
        record("a.ts#f", {
          unresolved: [{ reason: "external-module", operation: "node:fs.writeFileSync", count: 1 }],
        }),
      ],
      [
        record("a.ts#f", {
          unresolved: [
            { reason: "external-module", operation: "node:fs.writeFileSync", count: 1 },
            { reason: "external-module", operation: "node:fs.readFileSync", count: 1 },
            { reason: "import-binding", operation: "node:fs.writeFileSync", count: 1 },
          ],
        }),
      ],
    );
    expect(unresolvedGains(diff)[0]?.unresolvedGained).toEqual([
      { reason: "external-module", operation: "node:fs.readFileSync", count: 1 },
      { reason: "import-binding", operation: "node:fs.writeFileSync", count: 1 },
    ]);
  });

  it("leaves a new symbol to the shape that already covers it", () => {
    // A new `unknown` symbol is `unknownGained` — §6.4's first shape. Naming
    // its whole body as "gained" as well would report one event twice.
    const diff = diffAuthority([], [record("a.ts#f", { unresolved: opaque("axios.get") })]);
    expect(unresolvedGains(diff)).toEqual([]);
    expect(unknownGained(diff).map((entry) => entry.symbol)).toEqual(["a.ts#f"]);
  });

  it("reports nothing for a symbol that only disappeared", () => {
    const diff = diffAuthority([record("a.ts#f", { unresolved: opaque("axios.get") })], []);
    expect(unresolvedGains(diff)).toEqual([]);
    expect(hasUnresolvedWidening(diff)).toBe(false);
  });

  it("does not count a widened symbol as unchanged", () => {
    // The footer's "N unchanged" sits under the section naming this symbol,
    // and the two must not contradict each other.
    const diff = diffAuthority(
      [record("a.ts#f"), record("a.ts#g")],
      [record("a.ts#f", { unresolved: opaque("axios.get") }), record("a.ts#g")],
    );
    expect(unchangedSymbols(diff).map((entry) => entry.symbol)).toEqual(["a.ts#g"]);
  });

  it("keeps a known effect added inside an `unknown` symbol an authority increase", () => {
    // ADR-0012's context, asserted rather than described: E4's `del()`. This
    // fails as an increase and is not reclassified into §6.4.
    const diff = diffAuthority(
      [record("a.ts#f", { effects: { declared: null, observed: ["db_read"], unknown: true } })],
      [
        record("a.ts#f", {
          effects: { declared: null, observed: ["db_read", "db_write"], unknown: true },
          unresolved: opaque("axios.get"),
        }),
      ],
    );
    expect(diff.symbols[0]?.added).toEqual([{ kind: "effect", name: "db_write" }]);
    expect(unresolvedGains(diff)).toHaveLength(1);
  });
});

describe("--strict (DESIGN.md §6.4)", () => {
  const WIDENED = result(
    [record("a.ts#f")],
    [record("a.ts#f", { unresolved: opaque("axios.get") })],
  );

  it("reports at exit 0 by default and fails only under the flag", () => {
    expect(failsStrict(WIDENED)).toBe(false);
    expect(failsStrict(WIDENED, { strict: true })).toBe(true);
  });

  it("fails on the first shape under the same flag", () => {
    // A symbol the analysis used to reach and no longer does is the worse
    // event of the two; a flag that failed on one and not the other would be
    // a classification rather than a rule.
    const stopped = result(
      [record("a.ts#f", { effects: { declared: null, observed: [], unknown: false } })],
      [record("a.ts#f")],
    );
    expect(failsStrict(stopped)).toBe(false);
    expect(failsStrict(stopped, { strict: true })).toBe(true);
  });

  it("passes an unchanged comparison with the flag on", () => {
    const same = result([record("a.ts#f")], [record("a.ts#f")]);
    expect(failsStrict(same, { strict: true })).toBe(false);
  });

  it("names the operation in the text output, and asks for no approval", () => {
    const text = formatDiffText(WIDENED);
    expect(text).toContain("1 symbol gained an operation the analysis could not resolve");
    expect(text).toContain("? axios.get (external-module)");
    expect(text).toContain("This is not authority");
    // The one thing it must never print: a line to paste into the ledger.
    expect(text).not.toContain("ambit.approvals.md:");
    expect(text).not.toMatch(/^\s*- `a\.ts#f`/m);
  });

  it("says which run the reader is looking at", () => {
    expect(formatDiffText(WIDENED)).not.toContain("--strict:");
    // One shape fired, so the line names one section — a reader sent looking
    // for a second one that is not there reads the whole report as truncated.
    expect(formatDiffText(WIDENED, { strict: true })).toContain(
      "--strict: the section above fails this comparison",
    );
    const both = result(
      [record("a.ts#f", { effects: { declared: null, observed: [], unknown: false } })],
      [record("a.ts#f", { unresolved: opaque("axios.get") })],
    );
    expect(formatDiffText(both, { strict: true })).toContain(
      "--strict: the two sections above fail this comparison",
    );
  });

  it("annotates for GitHub only under the flag", () => {
    expect(formatDiffGithub(WIDENED)).toBe("");
    const annotated = formatDiffGithub(WIDENED, { strict: true });
    expect(annotated).toContain("::error ");
    expect(annotated).toContain("axios.get");
  });
});

/**
 * The record half. `unresolved` is built from the function's own body, so the
 * fixture that already holds one function per unresolvable reason
 * (`AMB-I002`'s) is what pins it.
 */
describe("the `unresolved` field of an authority record (DESIGN.md §5.1)", () => {
  async function records(): Promise<ReadonlyMap<string, AuthorityRecord>> {
    const { stdout } = await execFileAsync("node", [
      CLI_PATH,
      "check",
      FIXTURE,
      "--format",
      "json",
    ]);
    const entries = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuthorityRecord & { kind?: string })
      .filter((entry) => entry.kind === "authority")
      .map((entry) => [entry.symbol.split("#")[1] ?? "", entry] as const);
    return new Map(entries);
  }

  it("names the operations a function's own body could not resolve", async () => {
    const byName = await records();
    expect(byName.get("callsExternalModule")?.unresolved).toEqual([
      { reason: "external-module", operation: "node:path.resolve", count: 1 },
    ]);
    // A call with no qualified name carries the reason alone — no placeholder
    // stands in for a name that does not exist (§5.3).
    expect(byName.get("callsAnyTyped")?.unresolved).toEqual([{ reason: "any-typed", count: 1 }]);
    expect(byName.get("sortsWithCallbackByReference")?.unresolved).toEqual([
      { reason: "callback-by-reference", operation: "Array.sort", count: 1 },
    ]);
  });

  it("is empty for a function that is `unknown` only through a callee", async () => {
    // The field is body-local. `inheritsUnknown` is `unknown` and resolved
    // everything it calls directly; the work is at the leaf.
    const byName = await records();
    expect(byName.get("inheritsUnknown")?.effects.unknown).toBe(true);
    expect(byName.get("inheritsUnknown")?.unresolved).toEqual([]);
  });

  it("is empty for a `@boundary` function", async () => {
    // §4.6 excludes the body from analysis by declaration, so a call inside it
    // is isolated rather than unresolved. Listing it would price an explicit
    // decision as an analysis failure.
    const byName = await records();
    expect(byName.get("isolated")?.unresolved).toEqual([]);
  });

  it("is empty for a function nothing about which is unresolved", async () => {
    const byName = await records();
    expect(byName.get("resolvable")?.unresolved).toEqual([]);
    expect(byName.get("resolvable")?.effects.unknown).toBe(false);
  });
});
