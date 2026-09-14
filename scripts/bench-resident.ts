/**
 * Phase 5 of `docs/resident-check-path.md`: the resident check path measured
 * against a cold `analyze()`, per subject and per mutation.
 *
 *     node scripts/bench-resident.ts [--subjects a,b] [--mutations x,y]
 *         [--scenarios s,t] [--iterations N] [--warmup W]
 *         [--immich <checkout>] [--outline <checkout>] [--out file.json]
 *
 * **What it compares.** For one subject and one mutation, five scenarios, each
 * in a child process of its own so that `maxRSS` is that scenario's peak and
 * nothing one scenario cached is visible to another:
 *
 * - `cold` — `analyze()` on the mutated tree, every iteration. ADR-0014's
 *   architecture A, and the only baseline "faster" is said against. It has no
 *   phase breakdown; `full-noold` is the closest one — a whole re-extraction
 *   on a program built from nothing, which is the work a cold run does.
 * - `full` — `session.update()` with no change set: a caller that does not
 *   track changes, which forces a whole re-extraction on a held program.
 * - `partial` — `session.update(changes)` with what the mutation changed.
 *   Whether it *was* partial is the session's verdict, recorded per run.
 * - `full-noold` / `partial-noold` — the same two with `oldProgram` withheld,
 *   through `openProjectForMeasurement`. The difference is what `oldProgram`
 *   actually buys; nothing else separates it.
 *
 * **Nothing under `.corpus/` or the source tree is edited.** Every child copies
 * its subject into a temporary directory and mutates the copy. Dependencies are
 * reached through a `node_modules` symlink, never installed into a copy.
 *
 * Iterations: `warmup` unmeasured, then `iterations` measured. Every iteration
 * applies a *new* variant of the mutation, so every measured update has a real
 * change to process; the warmup absorbs the first application, which is the
 * one that shifts line numbers. Timings are reported as min / p25 / median /
 * p75 / max over the measured iterations — never as a best-of.
 *
 * Outside `pnpm test` and outside `tsconfig.json`'s `include`, like every
 * other script: the corpus copies come from `scripts/corpus.ts`, which fetches.
 *
 * @effects fs_read, fs_write, process
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  legacyTsBackend,
  openProjectForMeasurement,
  type ProjectUpdatePhases,
} from "../src/checker/backend/legacy-ts.ts";
import { ResidentSession, type ResidentStore, type UpdateResult } from "../src/checker/resident.ts";
import { analyze } from "../src/cli/analyze.ts";
import type { TsBackend } from "../src/core/index.ts";
import { renderAnalysis } from "../test/support/render-analysis.ts";
import {
  applyMutation,
  LEAF_MARK,
  MUTATIONS,
  type MutationKind,
  type MutationPlan,
  seedDeletionFiles,
} from "./bench-resident/mutations.ts";
import { ensureCorpus } from "./corpus.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = fileURLToPath(import.meta.url);

/** immich at the revision `docs/measurements/2026-09-11-second-third-party-validation-immich.md` used. */
const IMMICH_COMMIT = "2a626220415ea4f22da6846e26d37852664254bf";
/** outline at the revision `docs/measurements/2026-09-11-third-third-party-validation-outline.md` used. */
const OUTLINE_COMMIT = "35dd15b9718bcb8e547b86c1428d55170b49250b";

const SCENARIOS = ["cold", "full", "partial", "full-noold", "partial-noold"] as const;
type Scenario = (typeof SCENARIOS)[number];

// ---- subjects --------------------------------------------------------------

interface SubjectSpec {
  readonly name: string;
  readonly what: string;
  /** Build a fresh copy under `dir`; returns the analysis root inside it. */
  readonly prepare: (dir: string) => string;
  /**
   * Copy-relative directory holding tsconfig project files outside the
   * analysis root, for the `outside-root` mutation. Absent when the root is the
   * whole project.
   */
  readonly outsideRootDir?: string;
}

function copy(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true, dereference: false });
}

function writePackageJsonIfAbsent(dir: string): void {
  const file = path.join(dir, "package.json");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `${JSON.stringify({ name: "ambit-bench-subject", private: true })}\n`);
  }
}

function subjects(immich: string | undefined, outline: string | undefined): readonly SubjectSpec[] {
  const corpus = new Map(ensureCorpus().map((target) => [target.name, target] as const));
  const corpusSubject = (name: string, what: string): SubjectSpec => {
    const target = corpus.get(name);
    if (target === undefined) throw new Error(`corpus target ${name} is not in corpus.json`);
    return {
      name,
      what,
      prepare(dir) {
        copy(path.join(repoRoot, ".corpus", name, target.subdir), dir);
        writePackageJsonIfAbsent(dir);
        return dir;
      },
    };
  };
  const list: SubjectSpec[] = [
    {
      name: "ambit-src",
      what: "this repository's src/, with its own tsconfig (src + test) and node_modules",
      outsideRootDir: "test",
      prepare(dir) {
        for (const entry of ["src", "test", "tsconfig.json", "package.json", "pnpm-lock.yaml"]) {
          copy(path.join(repoRoot, entry), path.join(dir, entry));
        }
        fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"), "dir");
        return path.join(dir, "src");
      },
    },
    {
      name: "realistic-api",
      what: "test/fixtures/realistic-api, no dependencies",
      prepare(dir) {
        copy(path.join(repoRoot, "test", "fixtures", "realistic-api"), dir);
        writePackageJsonIfAbsent(dir);
        return dir;
      },
    },
    corpusSubject("got", "corpus, small"),
    corpusSubject("trpc-server", "corpus, medium"),
    corpusSubject("drizzle-orm", "corpus, large"),
  ];
  if (immich !== undefined) {
    list.push({
      name: "immich-server",
      what: `immich server/src @${IMMICH_COMMIT.slice(0, 8)}, dependencies installed`,
      outsideRootDir: "test",
      prepare(dir) {
        const server = path.join(immich, "server");
        for (const entry of ["src", "test", "tsconfig.json", "package.json"]) {
          copy(path.join(server, entry), path.join(dir, entry));
        }
        fs.symlinkSync(path.join(server, "node_modules"), path.join(dir, "node_modules"), "dir");
        return path.join(dir, "src");
      },
    });
  }
  if (outline !== undefined) {
    list.push({
      name: "outline-server",
      what: `outline server/ @${OUTLINE_COMMIT.slice(0, 8)} under the root tsconfig (app, shared, plugins), dependencies installed`,
      outsideRootDir: "shared",
      prepare(dir) {
        for (const entry of [
          "app",
          "server",
          "shared",
          "plugins",
          "tsconfig.json",
          "package.json",
          "vitest.d.ts",
        ]) {
          copy(path.join(outline, entry), path.join(dir, entry));
        }
        fs.symlinkSync(path.join(outline, "node_modules"), path.join(dir, "node_modules"), "dir");
        return path.join(dir, "server");
      },
    });
  }
  return list;
}

// ---- mutations -------------------------------------------------------------

// ---- statistics ------------------------------------------------------------

interface Stats {
  readonly n: number;
  readonly min: number;
  readonly p25: number;
  readonly median: number;
  readonly p75: number;
  readonly max: number;
}

function stats(values: readonly number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => {
    if (sorted.length === 0) return Number.NaN;
    const position = (sorted.length - 1) * q;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const a = sorted[lower] ?? Number.NaN;
    const b = sorted[upper] ?? Number.NaN;
    return a + (b - a) * (position - lower);
  };
  return {
    n: sorted.length,
    min: at(0),
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    max: at(1),
  };
}

// ---- the child: selection --------------------------------------------------

/** @effects fs_read, fs_write, process */
async function selectChild(subject: SubjectSpec, copyDir: string): Promise<MutationPlan> {
  const root = subject.prepare(copyDir);
  const session = await ResidentSession.open(root);
  try {
    const store = session.committed().store;
    const withFunctions = [...store.files.entries()]
      .filter(
        ([file, entry]) => (entry.extracted?.functions.length ?? 0) > 0 && !file.endsWith(".d.ts"),
      )
      .map(([file]) => file)
      .toSorted();
    const closureSize = (file: string): number => importerClosureSize(file, store);

    const leaves = withFunctions
      .filter((file) => (store.reverseImports.get(file)?.size ?? 0) === 0)
      .map((file) => ({ file, functions: store.files.get(file)?.extracted?.functions.length ?? 0 }))
      .toSorted((a, b) => a.functions - b.functions || a.file.localeCompare(b.file));
    const middle = Math.floor((leaves.length - 1) / 2);
    const leaf = leaves[middle]?.file;
    if (leaf === undefined) throw new Error(`${subject.name}: no file without importers`);
    const rotation = leaves.slice(Math.max(0, middle - 2), middle + 3).map((entry) => entry.file);

    // An outside-root project file, verified by editing it and seeing the
    // session refuse partial work — a file the program does not load would
    // measure a no-op.
    let outsideRoot: string | undefined;
    if (subject.outsideRootDir !== undefined) {
      const candidates = listTs(path.join(copyDir, subject.outsideRootDir))
        .map((file) => path.relative(copyDir, file))
        .filter((rel) => !/(^|\/)(fixtures|__mocks__)\//.test(rel))
        .toSorted();
      const ordered = [
        ...candidates.slice(Math.floor(candidates.length / 2)),
        ...candidates.slice(0, Math.floor(candidates.length / 2)),
      ];
      for (const rel of ordered.slice(0, 10)) {
        const file = path.join(copyDir, rel);
        const text = fs.readFileSync(file, "utf8");
        fs.writeFileSync(
          file,
          `${text}\n${LEAF_MARK}\nexport function __ambitBench(): number { return 0; }\n`,
        );
        const result = await session.update([]);
        fs.writeFileSync(file, text);
        await session.update([]);
        if (result.ok && result.full) {
          outsideRoot = rel;
          break;
        }
      }
    }

    const hubs = [...store.files.keys()]
      .filter((file) => !file.endsWith(".d.ts"))
      .map((file) => ({ file, closure: closureSize(file) }))
      .toSorted((a, b) => b.closure - a.closure || a.file.localeCompare(b.file));
    const hub = hubs[0];
    if (hub === undefined) throw new Error(`${subject.name}: no files`);

    // The JSDoc target: an undocumented function other functions call, in the
    // file with the widest importer closure that has one — so the contract edit
    // has callers to propagate into. Verified by applying it and reading the
    // summary back, because a line the comment does not attach to would
    // measure a no-op.
    const candidates: { file: string; line: number; id: string; score: number }[] = [];
    for (const file of withFunctions) {
      for (const fn of store.files.get(file)?.extracted?.functions ?? []) {
        if (fn.jsDoc !== undefined || fn.configOnly || fn.bodies !== undefined) continue;
        const callers = store.reverseCalls.get(fn.id)?.size ?? 0;
        if (callers === 0) continue;
        candidates.push({
          file,
          line: fn.declarationStart.line,
          id: fn.id,
          score: closureSize(file) * 1000 + callers,
        });
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    let jsdoc: MutationPlan["jsdoc"] | undefined;
    for (const candidate of candidates.slice(0, 25)) {
      const file = path.join(root, candidate.file);
      const text = fs.readFileSync(file, "utf8");
      const lines = text.split("\n");
      lines.splice(candidate.line - 1, 0, "/** @effects fs_read */");
      fs.writeFileSync(file, lines.join("\n"));
      const result = await session.update([{ kind: "changed", path: candidate.file }]);
      const attached = declaredKind(session, candidate.id) === "declared";
      fs.writeFileSync(file, text);
      await session.update([{ kind: "changed", path: candidate.file }]);
      if (!result.ok) continue;
      if (attached) {
        jsdoc = { file: candidate.file, line: candidate.line, id: candidate.id };
        break;
      }
    }
    if (jsdoc === undefined) throw new Error(`${subject.name}: no JSDoc target attached`);

    const copyRoot = copyDir;
    const existingConfig = ["ambit.config.ts"].find((name) => fs.existsSync(path.join(root, name)));
    const configAbsolute = path.join(
      existingConfig === undefined ? copyRoot : root,
      "ambit.config.ts",
    );
    const configRel = path.relative(root, configAbsolute);
    const tsconfig = findUp(root, "tsconfig.json", copyRoot);
    if (tsconfig === undefined) throw new Error(`${subject.name}: no tsconfig.json`);
    return {
      leaf,
      leaves: rotation,
      outsideRoot,
      hub: hub.file,
      hubClosure: hub.closure,
      jsdoc,
      configFile: path.relative(copyRoot, configAbsolute),
      configExisted: existingConfig !== undefined,
      configInStore: store.files.has(configRel) ? configRel : undefined,
      tsconfig: path.relative(copyRoot, tsconfig),
    };
  } finally {
    session.close();
  }
}

/** The committed summary's `declared.kind` for `id`. */
function declaredKind(session: ResidentSession, id: string): string | undefined {
  return session.committed().store.state.get(id)?.summary.declared.kind;
}

function importerClosureSize(file: string, store: ResidentStore): number {
  const reached = new Set([file]);
  const queue = [file];
  for (let head = 0; head < queue.length; head += 1) {
    for (const importer of store.reverseImports.get(queue[head] ?? "") ?? []) {
      if (reached.has(importer)) continue;
      reached.add(importer);
      queue.push(importer);
    }
  }
  return reached.size;
}

function listTs(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listTs(full));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) found.push(full);
  }
  return found;
}

function findUp(start: string, name: string, stopAt: string): string | undefined {
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
    if (dir === stopAt) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// ---- the child: one scenario -----------------------------------------------

interface RunRecord {
  readonly totalMs: number;
  readonly projectUpdateMs?: number;
  readonly configLoadMs?: number;
  readonly createProgramMs?: number;
  readonly typeCheckerMs?: number;
  readonly baselineMs?: number;
  readonly externalFiles?: number;
  readonly externalChars?: number;
  /** `extraction` minus `projectUpdate`: the walk itself. */
  readonly extractionMs?: number;
  readonly summarizeMs?: number;
  readonly impactMs?: number;
  readonly propagateMs?: number;
  readonly reportMs?: number;
  /** Total minus every reported phase: the fingerprint, `loadConfig`, and the plan. */
  readonly unattributedMs?: number;
  readonly full?: boolean;
  readonly narrowing?: string;
  readonly files?: number;
  readonly functions?: number;
  readonly changedFiles?: number;
  readonly reextracted?: number;
  readonly s?: number;
  readonly i?: number;
}

interface ScenarioResult {
  readonly subject: string;
  readonly mutation: MutationKind;
  readonly scenario: Scenario;
  readonly runs: readonly RunRecord[];
  readonly maxRssKb: number;
  /** For resident scenarios: the last partial answer compared byte-for-byte with a cold `analyze()`. */
  readonly equalToCold?: boolean;
}

function recordOf(
  result: UpdateResult,
  totalMs: number,
  changedFiles: number,
  phases: ProjectUpdatePhases | undefined,
): RunRecord {
  if (!result.ok) throw result.error;
  const t = result.timings;
  const extractionMs = t.extraction - (t.projectUpdate ?? 0);
  const attributed = t.extraction + t.summarize + t.impact + t.propagate + t.report + t.transfer;
  return {
    totalMs,
    ...(t.projectUpdate === undefined ? {} : { projectUpdateMs: t.projectUpdate }),
    ...(phases === undefined
      ? {}
      : {
          configLoadMs: phases.configLoad,
          createProgramMs: phases.createProgram,
          typeCheckerMs: phases.typeChecker,
          baselineMs: phases.baseline,
          externalFiles: phases.externalFiles,
          externalChars: phases.externalChars,
        }),
    extractionMs,
    summarizeMs: t.summarize,
    impactMs: t.impact,
    propagateMs: t.propagate,
    reportMs: t.report,
    unattributedMs: totalMs - attributed,
    full: result.full,
    narrowing: result.narrowing.kind,
    functions: result.impact.totalFunctions,
    changedFiles,
    reextracted: result.reextracted.length,
    s: result.impact.changed.length,
    i: result.impact.impacted.length,
  };
}

/**
 * The legacy backend driven through the measurement seam. The breakdown never
 * reaches the resident session — `ResidentExtractedUpdate` has no field for it —
 * so it is captured here, on the way past, into `sink`.
 */
function backendFor(
  scenario: Scenario,
  sink: { phases: ProjectUpdatePhases | undefined },
): TsBackend {
  const reuseOldProgram = !scenario.endsWith("-noold");
  return {
    ...legacyTsBackend,
    async openProject(rootDir: string) {
      const session = await openProjectForMeasurement(rootDir, { reuseOldProgram });
      return {
        // Every argument forwarded: a wrapper that drops `narrowTo` measures
        // the closure while the product narrows, and nothing would say so.
        async update(changed, reextract, narrowTo?: readonly string[]) {
          const { projectUpdatePhases, ...productUpdate } = await session.update(
            changed,
            reextract,
            narrowTo,
          );
          sink.phases = projectUpdatePhases;
          return productUpdate;
        },
        close() {
          session.close();
        },
      };
    },
  };
}

/** @effects fs_read, fs_write, process */
async function scenarioChild(
  subject: SubjectSpec,
  plan: MutationPlan,
  kind: MutationKind,
  scenario: Scenario,
  copyDir: string,
  warmup: number,
  iterations: number,
): Promise<ScenarioResult> {
  const root = subject.prepare(copyDir);
  const originals = new Map<string, string>();
  // The config mutation needs a config before the session opens: creating one
  // afterwards would be a file addition, not a config edit.
  if (kind === "config") applyMutation(kind, plan, copyDir, root, originals, 0);
  if (kind === "deletion") seedDeletionFiles(root, warmup + iterations);
  const runs: RunRecord[] = [];

  if (scenario === "cold") {
    for (let n = 0; n < warmup + iterations; n += 1) {
      applyMutation(kind, plan, copyDir, root, originals, n + 1);
      const started = performance.now();
      await analyze(root);
      const totalMs = performance.now() - started;
      if (n >= warmup) runs.push({ totalMs });
    }
    return {
      subject: subject.name,
      mutation: kind,
      scenario,
      runs,
      maxRssKb: process.resourceUsage().maxRSS,
    };
  }

  const sink: { phases: ProjectUpdatePhases | undefined } = { phases: undefined };
  const session = await ResidentSession.open(root, { backend: backendFor(scenario, sink) });
  let last: UpdateResult | undefined;
  try {
    for (let n = 0; n < warmup + iterations; n += 1) {
      const applied = applyMutation(kind, plan, copyDir, root, originals, n + 1);
      const started = performance.now();
      const result = scenario.startsWith("partial")
        ? await session.update(applied.changes)
        : await session.update();
      const totalMs = performance.now() - started;
      if (!result.ok) throw result.error;
      const phases = sink.phases;
      last = result;
      if (n >= warmup) {
        runs.push({
          ...recordOf(result, totalMs, applied.changes.length, phases),
          files: session.committed().store.files.size,
        });
      }
    }
    let equalToCold: boolean | undefined;
    if (last?.ok) {
      equalToCold = renderAnalysis(last.analysis) === renderAnalysis(await analyze(root));
    }
    return {
      subject: subject.name,
      mutation: kind,
      scenario,
      runs,
      maxRssKb: process.resourceUsage().maxRSS,
      ...(equalToCold === undefined ? {} : { equalToCold }),
    };
  } finally {
    session.close();
  }
}

// ---- the parent ------------------------------------------------------------

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function tempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ambit-bench-${label}-`));
}

/** @effects process */
function runChild(payload: object): unknown {
  const child = spawnSync(process.execPath, [scriptPath, "--child", JSON.stringify(payload)], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (child.status !== 0) {
    throw new Error(`child failed (${child.status}): ${child.stderr.slice(-4000)}`);
  }
  const lines = child.stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1] ?? "null");
}

function fmt(value: number | undefined): string {
  return value === undefined || Number.isNaN(value) ? "—" : value.toFixed(1);
}

function median(runs: readonly RunRecord[], key: keyof RunRecord): number | undefined {
  const values = runs.map((run) => run[key]).filter((v): v is number => typeof v === "number");
  return values.length === 0 ? undefined : stats(values).median;
}

/** @effects fs_read, fs_write, process */
async function parent(): Promise<void> {
  const immich = argValue("--immich");
  const outline = argValue("--outline");
  if (outline !== undefined) {
    const head = spawnSync("git", ["-C", outline, "rev-parse", "HEAD"], { encoding: "utf8" });
    if (head.stdout.trim() !== OUTLINE_COMMIT) {
      throw new Error(
        `--outline ${outline} is at ${head.stdout.trim()}, expected ${OUTLINE_COMMIT}`,
      );
    }
  }
  if (immich !== undefined) {
    const head = spawnSync("git", ["-C", immich, "rev-parse", "HEAD"], { encoding: "utf8" });
    if (head.stdout.trim() !== IMMICH_COMMIT) {
      throw new Error(`--immich ${immich} is at ${head.stdout.trim()}, expected ${IMMICH_COMMIT}`);
    }
  }
  const all = subjects(immich, outline);
  const wantedScenarios = (argValue("--scenarios")?.split(",") ?? [...SCENARIOS]) as Scenario[];
  const wantedSubjects = argValue("--subjects")?.split(",");
  const wantedMutations = (argValue("--mutations")?.split(",") ?? [...MUTATIONS]) as MutationKind[];
  const warmup = Number(argValue("--warmup") ?? 2);
  const iterations = Number(argValue("--iterations") ?? 7);
  const out = argValue("--out");

  const results: ScenarioResult[] = [];
  const plans: Record<string, MutationPlan> = {};
  for (const subject of all) {
    if (wantedSubjects !== undefined && !wantedSubjects.includes(subject.name)) continue;
    process.stderr.write(`[${subject.name}] selecting mutations\n`);
    const selectDir = tempDir(subject.name);
    const plan = runChild({
      mode: "select",
      subject: subject.name,
      immich,
      outline,
      dir: selectDir,
    }) as MutationPlan;
    fs.rmSync(selectDir, { recursive: true, force: true });
    plans[subject.name] = plan;
    process.stderr.write(`[${subject.name}] ${JSON.stringify(plan)}\n`);
    for (const kind of wantedMutations) {
      if (kind === "outside-root" && plan.outsideRoot === undefined) {
        process.stderr.write(`[${subject.name}] outside-root: no project file outside the root\n`);
        continue;
      }
      for (const scenario of wantedScenarios) {
        const dir = tempDir(subject.name);
        const started = performance.now();
        const result = runChild({
          mode: "scenario",
          subject: subject.name,
          immich,
          outline,
          dir,
          plan,
          kind,
          scenario,
          warmup,
          iterations,
        }) as ScenarioResult;
        fs.rmSync(dir, { recursive: true, force: true });
        results.push(result);
        process.stderr.write(
          `[${subject.name}] ${kind} ${scenario}: median ${fmt(median(result.runs, "totalMs"))} ms` +
            ` (${((performance.now() - started) / 1000).toFixed(1)} s)` +
            `${result.equalToCold === false ? " NOT EQUAL TO COLD" : ""}\n`,
        );
      }
    }
  }

  const document = {
    date: new Date().toISOString(),
    node: process.version,
    typescript: legacyTsBackend.version,
    platform: `${os.platform()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model,
    cores: os.cpus().length,
    memoryGiB: Math.round(os.totalmem() / 1024 ** 3),
    warmup,
    iterations,
    plans,
    results: results.map((result) => ({
      ...result,
      stats: Object.fromEntries(
        (Object.keys(result.runs[0] ?? {}) as (keyof RunRecord)[])
          .filter((key) => typeof result.runs[0]?.[key] === "number")
          .map((key) => [
            key,
            stats(
              result.runs.map((run) => run[key]).filter((v): v is number => typeof v === "number"),
            ),
          ]),
      ),
    })),
  };
  if (out !== undefined) fs.writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);

  console.log(
    "| subject | mutation | scenario | total p50 [min–max] | project-update | createProgram | typeChecker | baseline | extraction | summarize | impact | propagate | report | unattributed | verdict | re-extracted | S | I | peak RSS MiB | = cold |",
  );
  console.log(
    "|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---|",
  );
  for (const result of results) {
    const total = stats(result.runs.map((run) => run.totalMs));
    const first = result.runs[0];
    console.log(
      `| ${result.subject} | ${result.mutation} | ${result.scenario} | ${fmt(total.median)} [${fmt(total.min)}–${fmt(total.max)}] | ` +
        `${fmt(median(result.runs, "projectUpdateMs"))} | ${fmt(median(result.runs, "createProgramMs"))} | ` +
        `${fmt(median(result.runs, "typeCheckerMs"))} | ${fmt(median(result.runs, "baselineMs"))} | ` +
        `${fmt(median(result.runs, "extractionMs"))} | ${fmt(median(result.runs, "summarizeMs"))} | ` +
        `${fmt(median(result.runs, "impactMs"))} | ${fmt(median(result.runs, "propagateMs"))} | ` +
        `${fmt(median(result.runs, "reportMs"))} | ${fmt(median(result.runs, "unattributedMs"))} | ` +
        `${first?.full === undefined ? "—" : first.full ? "full" : `partial${first.narrowing === "contract-only" ? " (contract-only)" : ""}`} | ` +
        `${first?.reextracted === undefined ? "—" : `${first.reextracted}/${first.files}`} | ` +
        `${first?.s ?? "—"} | ${first?.i === undefined ? "—" : `${first.i}/${first.functions}`} | ` +
        `${(result.maxRssKb / 1024).toFixed(0)} | ${result.equalToCold === undefined ? "—" : result.equalToCold} |`,
    );
  }
}

// ---- entry -----------------------------------------------------------------

const childIndex = process.argv.indexOf("--child");
if (childIndex === -1) {
  await parent();
} else {
  const payload = JSON.parse(process.argv[childIndex + 1] ?? "{}") as {
    mode: "select" | "scenario";
    subject: string;
    immich?: string;
    outline?: string;
    dir: string;
    plan?: MutationPlan;
    kind?: MutationKind;
    scenario?: Scenario;
    warmup?: number;
    iterations?: number;
  };
  const subject = subjects(payload.immich, payload.outline).find(
    (candidate) => candidate.name === payload.subject,
  );
  if (subject === undefined) throw new Error(`unknown subject ${payload.subject}`);
  const output =
    payload.mode === "select"
      ? await selectChild(subject, payload.dir)
      : await scenarioChild(
          subject,
          payload.plan as MutationPlan,
          payload.kind as MutationKind,
          payload.scenario as Scenario,
          payload.dir,
          payload.warmup ?? 2,
          payload.iterations ?? 7,
        );
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
