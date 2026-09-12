/**
 * Installing a corpus target's declared dependencies, so the shadow comparison
 * can be run on the project as its own users would compile it.
 *
 * `test/corpus/corpus.json` installs nothing, and says that this "moves the
 * measurement in the conservative direction only". For the benchmark it
 * describes — one backend's `unknown` rate — that holds: a call into a package
 * whose types are absent stays unresolved, and unresolved is the safe answer.
 *
 * It does **not** hold for a parity measurement between two backends. The
 * absent types are exactly the receiver and type origins the two could disagree
 * about, so removing them can hide a divergence as easily as create one.
 * Measured on `drizzle-orm`: 43 divergences without dependencies, 167 with —
 * see `docs/measurements/2026-09-12-ts7-shadow-hardening.md`.
 *
 * Three properties keep this from weakening the corpus's pinning:
 *
 * - **The version ranges come from the pinned commit's own manifest**, read
 *   with `git show <commit>:<package dir>/package.json`. Nothing here invents a
 *   version.
 * - **Only packages the measured subtree actually imports** are installed. The
 *   rest of a 44-entry `devDependencies` is test tooling that no source file
 *   names.
 * - **Nothing is written into the pinned tree.** The install lands in
 *   `.corpus/<target>/.deps/` and is reached through a `node_modules` symlink
 *   beside the subtree, which git does not track — `ensureCorpus`'s tree check
 *   reads the commit's tree and is unaffected.
 *
 * A dependency install is not reproducible the way the corpus is: ranges like
 * `>=8` resolve to whatever is published today. So a `--with-deps` run is an
 * **experiment**, never a baseline, and the resolved versions are printed with
 * the result so a reading can be compared with the versions that produced it.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { CheckedOutTarget } from "../corpus.ts";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

/** Package specifiers a subtree imports: bare, not `node:`, not the aliases the project uses for itself. */
function importedPackages(dir: string): readonly string[] {
  const found = new Set<string>();
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        visit(full);
        continue;
      }
      if (!/\.(ts|tsx|mts|cts)$/.test(entry.name)) continue;
      const text = readFileSync(full, "utf8");
      for (const match of text.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
        const specifier = match[1] ?? "";
        if (specifier.startsWith(".") || specifier.startsWith("~") || specifier.startsWith("#")) {
          continue;
        }
        if (specifier.startsWith("node:") || specifier.startsWith("bun:")) continue;
        const scoped = specifier.startsWith("@");
        const parts = specifier.split("/");
        found.add(scoped ? parts.slice(0, 2).join("/") : (parts[0] ?? ""));
      }
    }
  };
  visit(dir);
  found.delete("");
  return [...found].toSorted();
}

/** The package manifest at the pinned commit, for the directory the subtree lives in. */
function pinnedManifest(target: CheckedOutTarget): Record<string, Record<string, string>> {
  const repoDir = path.join(repoRoot, ".corpus", target.name);
  const packageDir = path.dirname(target.subdir);
  const manifestPath = packageDir === "." ? "package.json" : `${packageDir}/package.json`;
  const json = execFileSync("git", ["show", `${target.commit}:${manifestPath}`], {
    cwd: repoDir,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(json) as Record<string, Record<string, string>>;
}

export interface InstalledDeps {
  /** `name -> version` as the installer actually resolved them. */
  readonly resolved: ReadonlyMap<string, string>;
  /** Packages the subtree imports that the pinned manifest does not declare. */
  readonly undeclared: readonly string[];
}

/**
 * Install what `target`'s subtree imports, at the ranges its own manifest
 * declares, and make it resolvable from the subtree.
 *
 * Throws rather than continuing on a failed install: a "with dependencies" run
 * whose dependencies are absent is a reading that means the opposite of what it
 * says, which is the failure DESIGN.md §3.4 names.
 */
export function installCorpusDeps(target: CheckedOutTarget): InstalledDeps {
  const manifest = pinnedManifest(target);
  const declared = {
    ...(manifest.peerDependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
    ...(manifest.dependencies ?? {}),
  };
  const imported = importedPackages(target.dir);
  const wanted: Record<string, string> = {};
  const undeclared: string[] = [];
  for (const name of imported) {
    if (name === manifest.name) continue;
    const range = declared[name];
    if (range === undefined) {
      undeclared.push(name);
      continue;
    }
    // `*` is not a range an installer can pin from; ask for the current
    // release and report which one it got.
    wanted[name] = range === "*" || range === "" ? "latest" : range;
  }

  const depsDir = path.join(repoRoot, ".corpus", target.name, ".deps");
  mkdirSync(depsDir, { recursive: true });
  writeFileSync(
    path.join(depsDir, "package.json"),
    `${JSON.stringify(
      { name: `corpus-deps-${target.name}`, private: true, version: "0.0.0", dependencies: wanted },
      null,
      1,
    )}\n`,
  );
  // `--ignore-workspace` is load-bearing rather than tidy: `.deps` sits inside
  // this repository, so without it pnpm walks up, finds Ambit's own
  // `pnpm-lock.yaml`, decides the directory is part of that workspace and
  // installs **nothing** — a "with dependencies" run whose dependencies are
  // absent. Observed, not predicted.
  execFileSync(
    "pnpm",
    [
      "install",
      "--ignore-workspace",
      "--ignore-scripts",
      "--config.strict-peer-dependencies=false",
      "--no-frozen-lockfile",
    ],
    { cwd: depsDir, stdio: "pipe" },
  );

  const link = path.join(target.dir, "..", "node_modules");
  if (!existsSync(link)) symlinkSync(path.join(depsDir, "node_modules"), link, "dir");

  const resolved = new Map<string, string>();
  for (const name of Object.keys(wanted)) {
    const installed = path.join(depsDir, "node_modules", name, "package.json");
    if (!existsSync(installed)) continue;
    const { version } = JSON.parse(readFileSync(installed, "utf8")) as { version: string };
    resolved.set(name, version);
  }
  if (resolved.size === 0 && Object.keys(wanted).length > 0) {
    throw new Error(`${target.name}: --with-deps installed nothing; the reading would be false`);
  }
  return { resolved, undeclared };
}

/** Where the symlink this module creates lives, so a caller can take it back out. */
export function corpusDepsLink(target: CheckedOutTarget): string {
  return path.join(target.dir, "..", "node_modules");
}
