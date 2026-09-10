import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runDiff } from "../src/cli/diff.ts";
import { movedSymbols } from "../src/core/index.ts";

const execFileAsync = promisify(execFile);
const CLI = path.join(import.meta.dirname, "..", "src", "cli", "main.ts");

/**
 * The approval ledger and rename detection against a real repository
 * (DESIGN.md §6.3).
 *
 * `e2e.diff.test.ts` runs against this repository's own history, which cannot
 * be made to contain a controlled case — a file renamed between two specific
 * commits, or a ledger that has a line on one side and not the other. So each
 * case here builds a repository of its own. What is being tested is the part
 * that needs one: that `git diff --find-renames` is read correctly, and that
 * the ledger is picked up from both sides.
 */
const repositories: string[] = [];

afterEach(() => {
  for (const repo of repositories.splice(0)) {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2023",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  },
  include: ["**/*.ts"],
});

/** A function whose declared effects are the whole of its authority — no operation needed. */
function source(effects: string): string {
  return `/**\n * A rate lookup.\n *\n * @effects ${effects}\n */\nexport function currentRate(): number {\n  return 1;\n}\n`;
}

async function git(cwd: string, ...args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd });
}

/** A repository whose `src/rates.ts` declares `pure`, committed. */
async function makeRepo(): Promise<string> {
  // `realpath` because macOS puts the temporary directory behind a symlink,
  // and `git rev-parse --show-toplevel` reports the resolved path — the two
  // have to agree for the checked subdirectory to come out as `src`.
  const root = fs.realpathSync(await fs.promises.mkdtemp(path.join(os.tmpdir(), "ambit-appr-")));
  repositories.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "tsconfig.json"), TSCONFIG);
  fs.writeFileSync(path.join(root, "src", "rates.ts"), source("pure"));
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.email", "test@example.invalid");
  await git(root, "config", "user.name", "test");
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "one");
  return root;
}

function writeLedger(root: string, text: string): void {
  fs.writeFileSync(path.join(root, "ambit.approvals.md"), text);
}

const APPROVES_NETWORK = "- `rates.ts#currentRate` `effect:network` — the rate table is now remote";

async function runCli(root: string, args: readonly string[]): Promise<number> {
  try {
    await execFileAsync("node", [CLI, ...args], { cwd: root });
    return 0;
  } catch (error) {
    return (error as { code?: number }).code ?? 1;
  }
}

describe("ambit diff and the approval ledger", () => {
  it("fails a widened declaration when no ledger approves it", async () => {
    const root = await makeRepo();
    fs.writeFileSync(path.join(root, "src", "rates.ts"), source("network"));

    const result = await runDiff("HEAD", path.join(root, "src"));
    expect(result.review.unapproved).toHaveLength(1);
    expect(result.review.unapproved[0]?.entry.symbol).toBe("rates.ts#currentRate");
    expect(result.approvalsFile).toBeUndefined();
    expect(await runCli(root, ["diff", "HEAD", "src"])).toBe(1);
  }, 120_000);

  it("passes the same widening when the ledger line is added in the same change", async () => {
    const root = await makeRepo();
    fs.writeFileSync(path.join(root, "src", "rates.ts"), source("network"));
    writeLedger(root, `# Approvals\n\n${APPROVES_NETWORK}\n`);

    const result = await runDiff("HEAD", path.join(root, "src"));
    expect(result.review.unapproved).toHaveLength(0);
    expect(result.review.approved).toHaveLength(1);
    expect(result.review.approved[0]?.approval.reason).toBe("the rate table is now remote");
    expect(result.approvalsFile).toBe("ambit.approvals.md");
    expect(await runCli(root, ["diff", "HEAD", "src"])).toBe(0);
  }, 120_000);

  it("stops granting once the line is in the base, so a reintroduction needs a new one", async () => {
    const root = await makeRepo();
    fs.writeFileSync(path.join(root, "src", "rates.ts"), source("network"));
    writeLedger(root, `${APPROVES_NETWORK}\n`);
    await git(root, "add", "-A");
    await git(root, "commit", "-qm", "widen, approved");

    // The widening merged. Take it away, then put it back: the line that
    // approved it the first time is spent.
    fs.writeFileSync(path.join(root, "src", "rates.ts"), source("pure"));
    await git(root, "add", "-A");
    await git(root, "commit", "-qm", "narrow again");
    fs.writeFileSync(path.join(root, "src", "rates.ts"), source("network"));

    const spent = await runDiff("HEAD", path.join(root, "src"));
    expect(spent.review.approved).toHaveLength(0);
    expect(spent.review.unapproved).toHaveLength(1);
    expect(await runCli(root, ["diff", "HEAD", "src"])).toBe(1);

    // Appending an identical second line is how it is approved again.
    writeLedger(root, `${APPROVES_NETWORK}\n${APPROVES_NETWORK}\n`);
    const reapproved = await runDiff("HEAD", path.join(root, "src"));
    expect(reapproved.review.approved).toHaveLength(1);
    expect(reapproved.review.approved[0]?.approval.line).toBe(2);
    expect(await runCli(root, ["diff", "HEAD", "src"])).toBe(0);
  }, 180_000);

  it("reports a new line that granted nothing without failing on it", async () => {
    const root = await makeRepo();
    writeLedger(root, "- `rates.ts#noSuchFunction` `effect:network` — a typo\n");

    const result = await runDiff("HEAD", path.join(root, "src"));
    expect(result.review.unused).toHaveLength(1);
    expect(result.review.unapproved).toHaveLength(0);
    expect(await runCli(root, ["diff", "HEAD", "src"])).toBe(0);
  }, 120_000);

  it("reports a line that did not parse, and still fails the increase it meant to approve", async () => {
    const root = await makeRepo();
    fs.writeFileSync(path.join(root, "src", "rates.ts"), source("network"));
    writeLedger(root, "- rates.ts#currentRate effect:network — no code spans\n");

    const result = await runDiff("HEAD", path.join(root, "src"));
    expect(result.malformedApprovals).toHaveLength(1);
    expect(result.malformedApprovals[0]?.line).toBe(1);
    expect(result.review.unapproved).toHaveLength(1);
    expect(await runCli(root, ["diff", "HEAD", "src"])).toBe(1);
  }, 120_000);
});

describe("ambit diff and renamed files", () => {
  it("carries a symbol across a rename git reports, needing no approval", async () => {
    const root = await makeRepo();
    fs.mkdirSync(path.join(root, "src", "pricing"));
    await git(root, "mv", "src/rates.ts", "src/pricing/rates.ts");

    const result = await runDiff("HEAD", path.join(root, "src"));
    expect(result.review.unapproved).toHaveLength(0);
    const moved = movedSymbols(result.diff);
    expect(moved).toHaveLength(1);
    expect(moved[0]?.movedFrom).toBe("rates.ts#currentRate");
    expect(moved[0]?.symbol).toBe("pricing/rates.ts#currentRate");
    expect(await runCli(root, ["diff", "HEAD", "src"])).toBe(0);
  }, 120_000);

  it("still reports what a move widened", async () => {
    const root = await makeRepo();
    fs.mkdirSync(path.join(root, "src", "pricing"));
    await git(root, "mv", "src/rates.ts", "src/pricing/rates.ts");
    fs.writeFileSync(path.join(root, "src", "pricing", "rates.ts"), source("network"));
    await git(root, "add", "-A");

    const result = await runDiff("HEAD", path.join(root, "src"));
    expect(result.review.unapproved).toHaveLength(1);
    expect(result.review.unapproved[0]?.entry.status).toBe("moved");
    expect(result.review.unapproved[0]?.ref).toEqual({ kind: "effect", name: "network" });
  }, 120_000);

  it("does not see a move whose destination is untracked", async () => {
    // Rename detection compares tracked paths against the base commit, so a
    // file that has not been `git add`ed has nothing to be similar to. This
    // over-reports, which is the direction §3.4 requires — CI always has a
    // tracked tree.
    const root = await makeRepo();
    fs.renameSync(path.join(root, "src", "rates.ts"), path.join(root, "src", "rate-table.ts"));
    fs.writeFileSync(path.join(root, "src", "rate-table.ts"), source("network"));

    const result = await runDiff("HEAD", path.join(root, "src"));
    expect(movedSymbols(result.diff)).toHaveLength(0);
    expect(result.review.unapproved[0]?.entry.status).toBe("new");
  }, 120_000);

  it("treats a file renamed in from outside the checked directory as new", async () => {
    // The pathspec restricts the comparison to `src`, and a symbol that
    // entered `src` did increase what `src` is trusted with, whatever the
    // rest of the repository did.
    const root = await makeRepo();
    fs.mkdirSync(path.join(root, "lib"));
    fs.writeFileSync(path.join(root, "lib", "outside.ts"), source("network"));
    await git(root, "add", "-A");
    await git(root, "commit", "-qm", "two");
    await git(root, "mv", "lib/outside.ts", "src/outside.ts");

    const result = await runDiff("HEAD", path.join(root, "src"));
    expect(movedSymbols(result.diff)).toHaveLength(0);
    expect(result.review.unapproved).toHaveLength(1);
    expect(result.review.unapproved[0]?.entry.symbol).toBe("outside.ts#currentRate");
    expect(result.review.unapproved[0]?.entry.status).toBe("new");
  }, 120_000);
});
