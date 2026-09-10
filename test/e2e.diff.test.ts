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

async function runCli(args: readonly string[]): Promise<{ stdout: string; exitCode: number }> {
  const cli = path.join(REPO_ROOT, "src", "cli", "main.ts");
  try {
    const { stdout } = await execFileAsync("node", [cli, ...args], { cwd: REPO_ROOT });
    return { stdout, exitCode: 0 };
  } catch (error) {
    const e = error as { stdout?: string; code?: number };
    return { stdout: e.stdout ?? "", exitCode: e.code ?? 1 };
  }
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

  it("runs against HEAD and removes the worktree", async () => {
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

  it("exits 1 when authority increased, and annotates each increase", async () => {
    const before = await worktreeCount();
    const { stdout, exitCode } = await runCli(["diff", BEFORE_DIFF, "src"]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Authority increased in");
    expect(await worktreeCount()).toBe(before);

    const github = await runCli(["diff", BEFORE_DIFF, "src", "--format", "github"]);
    expect(github.exitCode).toBe(1);
    const annotations = github.stdout.split("\n").filter((line) => line.startsWith("::error "));
    expect(annotations.length).toBeGreaterThan(0);
    for (const annotation of annotations) {
      expect(annotation).toContain("title=ambit diff");
      expect(annotation).toMatch(/ gained [a-z_]+ since /);
    }
    expect(await worktreeCount()).toBe(before);
  }, 180_000);

  it("exits 2, not 0, when the comparison could not be made", async () => {
    // "Could not compare" must never come out as "nothing increased".
    const before = await worktreeCount();
    const { exitCode } = await runCli(["diff", "no-such-ref-for-ambit-diff", "src"]);
    expect(exitCode).toBe(2);
    expect(await worktreeCount()).toBe(before);
  }, 120_000);

  it("exits 2 when given no ref at all", async () => {
    const { exitCode } = await runCli(["diff"]);
    expect(exitCode).toBe(2);
  }, 60_000);

  it("exits 2 rather than silently ignoring a flag it does not act on", async () => {
    // `--strict` accepted and dropped would make a green diff read as
    // "strict found nothing" (DESIGN.md §3.4).
    for (const flag of [["--coverage"], ["--strict"], ["--config"], ["--format", "json"]]) {
      const { exitCode } = await runCli(["diff", "HEAD", "src", ...flag]);
      expect(exitCode, `diff should reject ${flag.join(" ")}`).toBe(2);
    }
    const supported = await runCli(["diff", "HEAD", "src", "--format", "github"]);
    expect(supported.exitCode).toBe(0);
  }, 180_000);
});
