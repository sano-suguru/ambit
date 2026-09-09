/**
 * DESIGN.md §3.5 gate 4 — the backend performance and memory comparison.
 *
 * Not part of `pnpm test`. It spawns a Go engine and takes wall-clock
 * measurements, both of which belong to a deliberate, quiet-machine run rather
 * than to CI. `docs/status.md` records the numbers and the environment; this
 * file is the procedure that produced them.
 *
 *     node scripts/m05-backend-compare.ts --corpus src --runs 5
 *     node scripts/m05-backend-compare.ts --corpus <dir> --runs 5 --format json
 *
 * What is compared
 * ----------------
 * The same *semantic* work on both backends, which §3.5 gate 4 requires
 * (「構文解析のみと型解析を含む検査を速度比較しない」). Both probes walk every
 * project-local source file and, for each one:
 *
 *   - read the JSDoc tags of every function-like declaration (contract
 *     extraction), and
 *   - for every call expression, resolve the callee to a symbol, follow an
 *     import alias when there is one, take the resulting declaration, and
 *     classify the file it lives in (default lib / external package / project).
 *
 * That is the primitive set `src/checker/backend/legacy-ts.ts` is built from.
 * Ambit's own classification on top of it is plain JavaScript, identical
 * whichever backend produced the inputs, so it is left out of both sides
 * rather than counted on one.
 *
 * The counts each probe reports (`files`, `functions`, `calls`, `resolved`,
 * `defaultLib`, `external`, `local`) are printed with the timings on purpose:
 * two backends that disagree on them did not do the same work, and comparing
 * their speed would be meaningless.
 *
 * Each measurement runs in its own Node process, and the backends are
 * interleaved run by run so that a machine that gets busier partway through
 * does not favour whichever went first.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

export interface Measurement {
  readonly backend: string;
  readonly engineVersion: string;
  /** Compiler load plus program/snapshot construction, in ms. */
  readonly startupMs: number;
  /** The semantic walk described in this file's header, in ms. */
  readonly extractMs: number;
  readonly totalMs: number;
  /** Peak RSS of the Node process, in MiB. */
  readonly nodeRssMiB: number;
  /** Peak RSS of the analysis child process, in MiB; 0 when there is none. */
  readonly childRssMiB: number;
  readonly counts: Readonly<Record<string, number>>;
  /** Present only for a backend that talks to a separate process. */
  readonly ipc?: {
    readonly requests: number;
    readonly bytesSent: number;
    readonly bytesReceived: number;
    readonly serverMs: number;
    readonly transportMs: number;
  };
}

function parseArgs(argv: readonly string[]): {
  corpus: string;
  runs: number;
  backends: readonly string[];
  format: "text" | "json";
} {
  let corpus = "src";
  let runs = 5;
  let backends: readonly string[] = ["legacy", "native"];
  let format: "text" | "json" = "text";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--corpus") corpus = argv[++i] ?? corpus;
    else if (arg === "--runs") runs = Number(argv[++i] ?? runs);
    else if (arg === "--backend") backends = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (arg === "--format") format = argv[++i] === "json" ? "json" : "text";
  }
  return { corpus: path.resolve(REPO_ROOT, corpus), runs, backends, format };
}

function runOnce(backend: string, corpus: string): Promise<Measurement> {
  const probe = path.join(HERE, "m05-probe", `${backend}.ts`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [probe, corpus], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${backend} probe exited ${code}\n${err}`));
        return;
      }
      try {
        resolve(JSON.parse(out) as Measurement);
      } catch {
        reject(new Error(`${backend} probe did not print JSON:\n${out}\n${err}`));
      }
    });
  });
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

const ms = (n: number) => `${n.toFixed(1)} ms`;

function report(corpus: string, results: ReadonlyMap<string, readonly Measurement[]>): void {
  console.log(`corpus: ${path.relative(REPO_ROOT, corpus) || corpus}`);
  console.log(`node: ${process.version}  platform: ${process.platform}/${process.arch}`);

  // §3.5 gate 4 compares the same work. Two backends that resolved different
  // numbers of calls did not do the same work, and the faster one may simply
  // have done less of it — so this is said before any timing is printed, not
  // in a footnote after it.
  const firsts = [...results].flatMap(([backend, runs]) =>
    runs[0] ? [[backend, runs[0].counts] as const] : [],
  );
  const baseline = firsts[0];
  const disagreeing = firsts.filter(
    ([, counts]) => JSON.stringify(counts) !== JSON.stringify(baseline?.[1]),
  );
  if (baseline && disagreeing.length > 0) {
    console.log("\nNOT COMPARABLE: the backends resolved different amounts of this corpus.");
    for (const [backend, counts] of firsts) {
      const deltas = Object.entries(counts)
        .filter(([key, value]) => value !== (baseline[1] as Record<string, number>)[key])
        .map(
          ([key, value]) => `${key} ${value} (vs ${(baseline[1] as Record<string, number>)[key]})`,
        );
      if (deltas.length > 0) console.log(`  ${backend}: ${deltas.join(", ")}`);
    }
    console.log("  Timings below describe different workloads; do not read them as a ratio.");
  }
  for (const [backend, runs] of results) {
    const first = runs[0];
    if (!first) continue;
    console.log(`\n## ${backend} (${first.engineVersion})`);
    console.log(`  counts: ${JSON.stringify(first.counts)}`);
    const differing = runs.filter((r) => JSON.stringify(r.counts) !== JSON.stringify(first.counts));
    if (differing.length > 0) {
      console.log(`  WARNING: ${differing.length} run(s) produced different counts`);
    }
    console.log(
      `  startup: median ${ms(median(runs.map((r) => r.startupMs)))}  all ${runs.map((r) => r.startupMs.toFixed(0)).join(" / ")}`,
    );
    console.log(
      `  extract: median ${ms(median(runs.map((r) => r.extractMs)))}  all ${runs.map((r) => r.extractMs.toFixed(0)).join(" / ")}`,
    );
    console.log(
      `  total:   median ${ms(median(runs.map((r) => r.totalMs)))}  all ${runs.map((r) => r.totalMs.toFixed(0)).join(" / ")}`,
    );
    console.log(
      `  peak RSS: node median ${median(runs.map((r) => r.nodeRssMiB)).toFixed(1)} MiB, child median ${median(runs.map((r) => r.childRssMiB)).toFixed(1)} MiB`,
    );
    const ipc = first.ipc;
    if (ipc) {
      console.log(
        `  IPC (first run): ${ipc.requests} requests, sent ${(ipc.bytesSent / 1024).toFixed(0)} KiB, received ${(ipc.bytesReceived / 1024).toFixed(0)} KiB`,
      );
      console.log(
        `  IPC time: server ${ms(median(runs.map((r) => r.ipc?.serverMs ?? 0)))}, transport ${ms(median(runs.map((r) => r.ipc?.transportMs ?? 0)))} (medians)`,
      );
    }
  }
}

async function main(): Promise<number> {
  const { corpus, runs, backends, format } = parseArgs(process.argv.slice(2));
  const results = new Map<string, Measurement[]>();
  for (const backend of backends) results.set(backend, []);

  // Interleaved: run 1 of every backend, then run 2, and so on. A machine that
  // gets busier partway through then costs every backend the same, instead of
  // whichever happened to be measured last.
  for (let run = 0; run < runs; run++) {
    for (const backend of backends) {
      results.get(backend)?.push(await runOnce(backend, corpus));
    }
  }

  if (format === "json") {
    console.log(JSON.stringify({ corpus, node: process.version, results: [...results] }, null, 2));
  } else {
    report(corpus, results);
  }
  return 0;
}

process.exitCode = await main();
