/**
 * Checks out the fixed analysis-quality corpus described by
 * `test/corpus/corpus.json`.
 *
 * The corpus is real third-party source, so it is not committed here; it is
 * fetched into `.corpus/` (gitignored) from pinned commits. Two pins are
 * verified on every run: the commit SHA that is fetched, and the git tree
 * object of the measured subtree. The second is what makes the "the corpus was
 * not altered after optimization began" claim checkable — a tree object id is a
 * hash of the whole subtree's content, so any edit under it changes the id.
 *
 * Dependencies are deliberately not installed. A call into a package whose
 * types are absent stays unresolved, so the measurement can only be pessimistic
 * about third-party code, never flattering.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface CorpusTarget {
  readonly name: string;
  readonly repo: string;
  readonly commit: string;
  readonly subdir: string;
  readonly what: string;
  /**
   * Compiler options merged over the shared corpus tsconfig for this target
   * only. It exists for one thing: reproducing a repository's own module
   * resolution (a `paths` alias defined in a tsconfig outside the measured
   * subtree). Without it the target would measure module resolution rather
   * than contract analysis. It is part of the fixed corpus, pinned alongside
   * the commit, and is not a place to put anything the analyzer reads.
   */
  readonly compilerOptions?: Record<string, unknown>;
  /** The git tree object id of `subdir` at `commit`, once a checkout has been verified. */
  readonly tree?: string;
}

export interface CorpusManifest {
  readonly tsconfig: unknown;
  readonly targets: readonly CorpusTarget[];
}

export interface CheckedOutTarget extends CorpusTarget {
  /** Absolute path of the subtree `ambit check` is pointed at. */
  readonly dir: string;
  /** The git tree object id observed in the checkout. */
  readonly observedTree: string;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, "test", "corpus", "corpus.json");

export function loadManifest(): CorpusManifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as CorpusManifest;
}

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Fetch one target at its pinned commit, checking out only the measured
 * subtree. `--filter=blob:none` plus a sparse checkout keeps this to the files
 * that are actually analyzed rather than the whole repository history.
 */
function fetchTarget(target: CorpusTarget, dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "remote", "add", "origin", target.repo);
  git(dir, "config", "core.sparseCheckout", "true");
  git(dir, "sparse-checkout", "set", "--no-cone", `/${target.subdir}/*`);
  git(dir, "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", target.commit);
  git(dir, "checkout", "-q", "FETCH_HEAD");
}

/**
 * The corpus tsconfig, written into the measured subtree so that TypeScript
 * loads exactly the files the manifest names — not whatever an ancestor
 * tsconfig in the repository happens to say, which usually extends a package
 * that is not installed.
 *
 * Written after the tree object is verified, and refused if the subtree already
 * carries a tsconfig of its own: overwriting one would be an edit to corpus
 * source, which the pinning exists to rule out.
 */
function writeCorpusTsconfig(manifest: CorpusManifest, target: CorpusTarget, dir: string): void {
  // Whether a `tsconfig.json` belongs to the corpus is a question git can
  // answer exactly: the pinned tree either contains one or it does not.
  // Comparing file contents instead would make a reformatting of the manifest
  // look like an edit to corpus source.
  if (tracked(path.join(repoRoot, ".corpus", target.name), `${target.subdir}/tsconfig.json`)) {
    throw new Error(
      `corpus target ${target.name}: ${target.subdir}/tsconfig.json exists at the pinned commit; the corpus tsconfig would overwrite it`,
    );
  }
  writeFileSync(path.join(dir, "tsconfig.json"), renderTsconfig(manifest, target));
}

/** Whether the pinned commit tracks `relativePath`. */
function tracked(repoDir: string, relativePath: string): boolean {
  try {
    git(repoDir, "cat-file", "-e", `HEAD:${relativePath}`);
    return true;
  } catch {
    return false;
  }
}

function renderTsconfig(manifest: CorpusManifest, target: CorpusTarget): string {
  const base = manifest.tsconfig as { compilerOptions?: Record<string, unknown> };
  const merged = {
    ...base,
    compilerOptions: { ...base.compilerOptions, ...target.compilerOptions },
  };
  return `${JSON.stringify(merged, null, 2)}\n`;
}

/**
 * Check out every target that is not already present and verified, and return
 * where each one landed.
 *
 * A checkout whose tree object does not match the manifest is re-fetched once
 * and then, if it still does not match, is a hard failure: the alternative is
 * measuring code nobody pinned.
 */
export function ensureCorpus(): readonly CheckedOutTarget[] {
  const manifest = loadManifest();
  const root = path.join(repoRoot, ".corpus");
  mkdirSync(root, { recursive: true });

  const checkedOut: CheckedOutTarget[] = [];
  for (const target of manifest.targets) {
    const repoDir = path.join(root, target.name);
    const subtree = path.join(repoDir, target.subdir);
    let observedTree = treeOf(repoDir, target);
    if (observedTree === undefined) {
      fetchTarget(target, repoDir);
      observedTree = treeOf(repoDir, target);
    }
    if (observedTree === undefined) {
      throw new Error(
        `corpus target ${target.name}: could not read ${target.commit}:${target.subdir}`,
      );
    }
    if (target.tree !== undefined && target.tree !== observedTree) {
      throw new Error(
        `corpus target ${target.name}: subtree ${target.subdir} is ${observedTree}, manifest pins ${target.tree}`,
      );
    }
    writeCorpusTsconfig(manifest, target, subtree);
    checkedOut.push({ ...target, dir: subtree, observedTree });
  }
  return checkedOut;
}

function treeOf(repoDir: string, target: CorpusTarget): string | undefined {
  if (!existsSync(path.join(repoDir, ".git"))) return undefined;
  try {
    const head = git(repoDir, "rev-parse", "HEAD").trim();
    if (head !== target.commit) return undefined;
    return git(repoDir, "rev-parse", `HEAD:${target.subdir}`).trim();
  } catch {
    return undefined;
  }
}
