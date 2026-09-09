import { execFileSync } from "node:child_process";
import process from "node:process";

/**
 * What both §3.5 gate-4 probes count, and how they report it.
 *
 * The counts exist to prove the two backends did the same work. If `calls` or
 * `resolved` differ between them, the timings below are not comparable and the
 * comparison script says so rather than printing a ratio.
 */
export interface ProbeCounts {
  files: number;
  functions: number;
  contractTags: number;
  calls: number;
  resolved: number;
  defaultLib: number;
  external: number;
  local: number;
}

export function emptyCounts(): ProbeCounts {
  return {
    files: 0,
    functions: 0,
    contractTags: 0,
    calls: 0,
    resolved: 0,
    defaultLib: 0,
    external: 0,
    local: 0,
  };
}

/** The tags Ambit reads off a declaration (DESIGN.md §4.1). */
export const CONTRACT_TAGS: ReadonlySet<string> = new Set([
  "effects",
  "capabilities",
  "budget",
  "entrypoint",
  "boundary",
]);

/**
 * Peak RSS of this process's own child processes, in MiB.
 *
 * A backend that runs the analysis out of process pays for two heaps, and
 * §3.5 gate 4 asks for 「親子プロセスを含むメモリ」. The client exposes no pid,
 * so the children are found through the process table; a backend with no child
 * simply reports 0.
 */
export function childRssMiB(): number {
  try {
    const pids = execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (pids.length === 0) return 0;
    const rss = execFileSync("ps", ["-o", "rss=", "-p", pids.join(",")], { encoding: "utf8" });
    const kib = rss
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    return kib.reduce((a, b) => a + b, 0) / 1024;
  } catch {
    return 0;
  }
}

export function nodeRssMiB(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}
