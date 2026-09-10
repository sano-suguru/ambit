import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runDiff } from "../src/cli/diff.ts";
import { authorityIncreases } from "../src/core/index.ts";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.join(import.meta.dirname, "..");
const SRC = path.join(REPO_ROOT, "src");

/**
 * The commit this branch started from — the last one before `ambit diff`
 * existed. Pinned rather than computed: an e2e about real history needs a
 * fixed base, and `HEAD~n` moves with every commit.
 */
const BEFORE_DIFF = "9843155";

/**
 * `ambit diff` against this repository's own history.
 *
 * Deliberately the only test that runs git: the comparison itself is a pure
 * function over two dumps and is unit tested in `authority-diff.test.ts`
 * without a repository. What is left to check here is the part that cannot
 * be checked without one — that a base ref is materialized, that both sides
 * are analyzed the same way, and that the worktree is gone afterwards.
 */
async function worktreeCount(): Promise<number> {
  const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: REPO_ROOT });
  return stdout.trim().split("\n").filter(Boolean).length;
}

describe("ambit diff against this repository's history", () => {
  it("reports the authority the diff command itself introduced, and removes the worktree", async () => {
    const before = await worktreeCount();
    const result = await runDiff(BEFORE_DIFF, SRC);
    expect(await worktreeCount()).toBe(before);

    expect(result.subdir).toBe("src");
    expect(result.baseCommit).toMatch(/^[0-9a-f]{40}$/);

    const increases = authorityIncreases(result.diff);
    expect(increases.length).toBeGreaterThan(0);

    // `git` is the helper `ambit diff` shells out through. It did not exist
    // at the pinned commit, it holds `process`, and it lasts as long as the
    // command does.
    const gitHelper = increases.find((entry) => entry.symbol === "cli/worktree.ts#git");
    expect(gitHelper?.status).toBe("new");
    expect(gitHelper?.added).toContainEqual({ kind: "effect", name: "process" });
  }, 120_000);

  it("finds no increase when the base ref is the commit the working tree is on", async () => {
    // Committed source only: whatever is staged or unstaged in `src` at the
    // time is the one thing this cannot assume, so it asserts the shape of
    // the result rather than an empty one.
    const before = await worktreeCount();
    const result = await runDiff("HEAD", SRC);
    expect(await worktreeCount()).toBe(before);
    expect(result.ref).toBe("HEAD");
    expect(result.diff.symbols.length).toBeGreaterThan(0);
  }, 120_000);

  it("leaves no worktree behind when the ref does not exist", async () => {
    const before = await worktreeCount();
    await expect(runDiff("no-such-ref-for-ambit-diff", SRC)).rejects.toThrow();
    expect(await worktreeCount()).toBe(before);
  }, 120_000);

  it("leaves no worktree behind when the analysis fails on one side", async () => {
    const before = await worktreeCount();
    await expect(
      runDiff("HEAD", path.join(REPO_ROOT, "test", "fixtures", "zero-functions")),
    ).rejects.toThrow(/no analyzable functions found/);
    expect(await worktreeCount()).toBe(before);
  }, 120_000);
});
