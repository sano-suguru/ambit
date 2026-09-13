/**
 * What edits the resident check path would actually be handed, classified the
 * way the product classifies them, with the closure each would re-extract and
 * the cost of an edit of that shape measured on the resident session.
 *
 *     node scripts/observe-resident-workload.ts trace --sessions <dir> [--iterations N] [--noold] --out trace.json
 *     node scripts/observe-resident-workload.ts git [--range a..b] --out git.json
 *     node scripts/observe-resident-workload.ts summary trace.json git.json
 *
 * **Two sources, never merged.**
 *
 * - `trace` reads agent session logs (Claude Code JSONL, one file per session
 *   or subagent) whose Edit and Write results carry the file's text before the
 *   edit. Every edit to this repository is reconstructed as a before/after pair
 *   and classified with the backend's own {@link classifyJsDocEdit}. Nobody ran
 *   the resident path during those sessions, so the check cadence is assumed,
 *   at two grains: every tool call is a batch (`call`), and the edits between
 *   two Bash calls are a batch (`bash`). The texts are old; the closure and the
 *   latency are **estimated on the current tree**: each batch's shape — which
 *   files, code or contract edits — is re-applied as a synthetic edit of the
 *   same kind to the same files and measured through `ResidentSession`.
 * - `git` replays first-parent commits of this repository: the parent's tree is
 *   opened as a session and the commit's own diff is the update. Exact trees,
 *   one sample per commit, and commits here are squash-merged pull requests —
 *   a commit workload proxy, not an editor one.
 *
 * Nothing about the sessions leaves the machine, and the artifact holds no
 * source text: stream ids are hashed and paths are repository-relative.
 *
 * @effects fs_read, fs_write, process
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  classifyJsDocEdit,
  legacyTsBackend,
  openProjectForMeasurement,
  type ProjectUpdatePhases,
} from "../src/checker/backend/legacy-ts.ts";
import {
  type FileChange,
  ResidentSession,
  type ResidentStore,
  type UpdateResult,
} from "../src/checker/resident.ts";
import type { TsBackend } from "../src/core/index.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = fileURLToPath(import.meta.url);
const CONTRACT_TAG = /@(effects|capabilities|budget|entrypoint|boundary)\b.*$/gm;

// ---- taxonomy ---------------------------------------------------------------

type Area = "root" | "root-dts" | "outside-root" | "config" | "none";
type FileClass =
  | "contract-only"
  | "code-only"
  | "mixed-file"
  | "no-op"
  | "added"
  | "deleted"
  | "unknown";
type BatchClass =
  | "contract-only"
  | "code-only"
  | "mixed-contract-code"
  | "add-delete-rename"
  | "config"
  | "outside-root"
  | "other-unknown"
  | "no-project-change";

const CONFIG_FILES = new Set([
  "tsconfig.json",
  "package.json",
  "pnpm-lock.yaml",
  "ambit.config.ts",
  "src/ambit.config.ts",
]);

/** Where a repository-relative path sits relative to `check src` on this repository's tsconfig. */
function areaOf(rel: string): Area {
  if (CONFIG_FILES.has(rel) || /^tsconfig[^/]*\.json$/.test(rel)) return "config";
  if (rel.startsWith("src/") && /\.d\.[cm]?ts$/.test(rel)) return "root-dts";
  if (rel.startsWith("src/") && /\.[cm]?tsx?$/.test(rel)) return "root";
  if (rel.startsWith("test/") && !rel.startsWith("test/fixtures/") && /\.[cm]?tsx?$/.test(rel)) {
    return "outside-root";
  }
  return "none";
}

function tagLines(text: string): string {
  return [...text.matchAll(CONTRACT_TAG)]
    .map((m) => m[0].trim())
    .toSorted()
    .join("\n");
}

/**
 * One file's edit. `code-only` and `mixed-file` are both the classifier's
 * `unsafe`; they are split by whether any contract-tag line moved — a text
 * signal, reported as such. `code-only` therefore includes description and
 * `@param` edits the classifier refuses.
 */
function classifyFile(
  rel: string,
  before: string | null,
  after: string | null,
): { cls: FileClass; reason?: string } {
  if (before === null && after === null)
    return { cls: "unknown", reason: "no text on either side" };
  if (before === null) return { cls: "added" };
  if (after === null) return { cls: "deleted" };
  if (before === after) return { cls: "no-op" };
  const verdict = classifyJsDocEdit(rel, before, after);
  if (verdict.kind === "contract-only") return { cls: "contract-only" };
  if (/^(before|after): /.test(verdict.reason)) return { cls: "unknown", reason: "does not parse" };
  return tagLines(before) === tagLines(after) ? { cls: "code-only" } : { cls: "mixed-file" };
}

interface FileRecord {
  readonly path: string;
  readonly area: Area;
  readonly cls: FileClass;
  readonly reason?: string;
  readonly closure?: number;
}

/** The batch's class, and what the in-root part alone would be. Precedence is the §6.2 table's: the widest row wins. */
function classifyBatch(
  files: readonly FileRecord[],
  unknownOps: number,
): { cls: BatchClass; rootPart: BatchClass } {
  const root = files.filter((f) => f.area === "root" && f.cls !== "no-op");
  let rootPart: BatchClass = "no-project-change";
  if (root.some((f) => f.cls === "added" || f.cls === "deleted")) rootPart = "add-delete-rename";
  else if (root.some((f) => f.cls === "unknown")) rootPart = "other-unknown";
  else if (root.length > 0) {
    const contract = root.some((f) => f.cls === "contract-only");
    const code = root.some((f) => f.cls === "code-only");
    const mixed = root.some((f) => f.cls === "mixed-file");
    rootPart =
      mixed || (contract && code)
        ? "mixed-contract-code"
        : contract
          ? "contract-only"
          : "code-only";
  }
  const touched = files.filter((f) => f.cls !== "no-op");
  if (touched.some((f) => f.area === "config")) return { cls: "config", rootPart };
  if (rootPart === "add-delete-rename") return { cls: rootPart, rootPart };
  if (
    unknownOps > 0 ||
    rootPart === "other-unknown" ||
    touched.some((f) => f.area === "root-dts")
  ) {
    return { cls: "other-unknown", rootPart };
  }
  if (touched.some((f) => f.area === "outside-root")) return { cls: "outside-root", rootPart };
  return { cls: rootPart, rootPart };
}

// ---- the resident session under measurement --------------------------------

function backendFor(
  reuseOldProgram: boolean,
  sink: { phases: ProjectUpdatePhases | undefined },
): TsBackend {
  return {
    ...legacyTsBackend,
    async openProject(rootDir: string) {
      const session = await openProjectForMeasurement(rootDir, { reuseOldProgram });
      return {
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

interface Measured {
  readonly totalMs: number;
  readonly projectUpdateMs?: number;
  readonly createProgramMs?: number;
  readonly typeCheckerMs?: number;
  readonly baselineMs?: number;
  readonly extractionMs: number;
  readonly summarizeMs: number;
  readonly impactMs: number;
  readonly propagateMs: number;
  readonly reportMs: number;
  readonly verdict: string;
  readonly reextracted: number;
  readonly files: number;
  readonly functions: number;
  readonly s: number;
  readonly i: number;
}

function measuredOf(
  result: UpdateResult,
  totalMs: number,
  phases: ProjectUpdatePhases | undefined,
  files: number,
): Measured {
  if (!result.ok) throw result.error;
  const t = result.timings;
  return {
    totalMs,
    ...(t.projectUpdate === undefined ? {} : { projectUpdateMs: t.projectUpdate }),
    ...(phases === undefined
      ? {}
      : {
          createProgramMs: phases.createProgram,
          typeCheckerMs: phases.typeChecker,
          baselineMs: phases.baseline,
        }),
    extractionMs: t.extraction - (t.projectUpdate ?? 0),
    summarizeMs: t.summarize,
    impactMs: t.impact,
    propagateMs: t.propagate,
    reportMs: t.report,
    verdict: result.full
      ? "full"
      : result.narrowing.kind === "contract-only"
        ? "contract-only"
        : "partial",
    reextracted: result.reextracted.length,
    files,
    functions: result.impact.totalFunctions,
    s: result.impact.changed.length,
    i: result.impact.impacted.length,
  };
}

function closureOf(seeds: readonly string[], store: ResidentStore): number {
  const reached = new Set(seeds);
  const queue = [...seeds];
  for (let head = 0; head < queue.length; head += 1) {
    for (const importer of store.reverseImports.get(queue[head] ?? "") ?? []) {
      if (reached.has(importer)) continue;
      reached.add(importer);
      queue.push(importer);
    }
  }
  return reached.size;
}

/** A copy of this repository's `src` project in `dir`; returns the analysis root. */
function prepareCopy(dir: string): string {
  for (const entry of ["src", "test", "tsconfig.json", "package.json"]) {
    fs.cpSync(path.join(repoRoot, entry), path.join(dir, entry), { recursive: true });
  }
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"), "dir");
  return path.join(dir, "src");
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = (sorted.length - 1) / 2;
  return ((sorted[Math.floor(mid)] ?? Number.NaN) + (sorted[Math.ceil(mid)] ?? Number.NaN)) / 2;
}

// ---- trace: reading the sessions ---------------------------------------------

interface RawEdit {
  readonly rel: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly at: number;
}
type Event =
  | { readonly kind: "edit"; readonly edit: RawEdit }
  | { readonly kind: "bash"; readonly at: number; readonly touchesSrc: boolean };

function jsonlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsonlFiles(full));
    else if (entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out.toSorted();
}

/** Repository-relative, with a worktree prefix removed; `undefined` for a path outside this repository. */
function relOf(file: string): string | undefined {
  if (!file.startsWith(`${repoRoot}/`)) return undefined;
  return file.slice(repoRoot.length + 1).replace(/^\.claude\/worktrees\/[^/]+\//, "");
}

function eventsOf(file: string): Event[] {
  const events: Event[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.length === 0) continue;
    let record: {
      timestamp?: string;
      message?: { content?: unknown };
      toolUseResult?: {
        filePath?: string;
        originalFile?: string | null;
        oldString?: string;
        newString?: string;
        replaceAll?: boolean;
        content?: string;
        type?: string;
      };
    };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(record.timestamp ?? "") || 0;
    const content = record.message?.content;
    if (Array.isArray(content)) {
      for (const block of content as {
        type?: string;
        name?: string;
        input?: { command?: string };
      }[]) {
        if (block.type !== "tool_use" || block.name !== "Bash") continue;
        const command = block.input?.command ?? "";
        const touchesSrc =
          /\bsrc\//.test(command) &&
          /\b(rm|mv|git (checkout|restore|stash|reset|apply)|sed -i|patch)\b/.test(command);
        events.push({ kind: "bash", at, touchesSrc });
      }
    }
    const result = record.toolUseResult;
    if (result === undefined || typeof result !== "object" || typeof result.filePath !== "string")
      continue;
    const rel = relOf(result.filePath);
    if (rel === undefined) continue;
    const original = result.originalFile ?? null;
    if (typeof result.oldString === "string" && typeof result.newString === "string") {
      if (original === null || !original.includes(result.oldString)) {
        events.push({ kind: "edit", edit: { rel, before: null, after: null, at } });
        continue;
      }
      const newString = result.newString;
      const after = result.replaceAll
        ? original.split(result.oldString).join(newString)
        : original.replace(result.oldString, () => newString);
      events.push({ kind: "edit", edit: { rel, before: original, after, at } });
    } else if (typeof result.content === "string") {
      events.push({ kind: "edit", edit: { rel, before: original, after: result.content, at } });
    }
  }
  return events;
}

interface TraceBatch {
  readonly stream: string;
  readonly grain: "call" | "bash";
  readonly startAt: number;
  readonly endAt: number;
  readonly files: FileRecord[];
  readonly unknownOps: number;
  readonly cls: BatchClass;
  readonly rootPart: BatchClass;
  readonly unionClosure?: number;
  readonly shape?: string;
  readonly codeSubsetShape?: string;
}

function batchesOf(
  stream: string,
  events: readonly Event[],
  grain: "call" | "bash",
): Omit<TraceBatch, "files" | "cls" | "rootPart">[] &
  { edits: Map<string, { before: string | null; after: string | null }> }[] {
  const out: (Omit<TraceBatch, "files" | "cls" | "rootPart"> & {
    edits: Map<string, { before: string | null; after: string | null }>;
  })[] = [];
  let current:
    | {
        edits: Map<string, { before: string | null; after: string | null }>;
        startAt: number;
        endAt: number;
        unknownOps: number;
      }
    | undefined;
  const flush = (): void => {
    if (current !== undefined) out.push({ stream, grain, ...current });
    current = undefined;
  };
  for (const event of events) {
    if (event.kind === "bash") {
      flush();
      if (event.touchesSrc)
        out.push({
          stream,
          grain,
          startAt: event.at,
          endAt: event.at,
          unknownOps: 1,
          edits: new Map(),
        });
      continue;
    }
    current ??= { edits: new Map(), startAt: event.edit.at, endAt: event.edit.at, unknownOps: 0 };
    const previous = current.edits.get(event.edit.rel);
    const unreconstructed = event.edit.before === null && event.edit.after === null;
    current.edits.set(event.edit.rel, {
      before: previous === undefined ? event.edit.before : previous.before,
      after:
        unreconstructed ||
        (previous !== undefined && previous.after === null && previous.before !== null)
          ? null
          : event.edit.after,
    });
    if (unreconstructed) current.unknownOps += 1;
    current.endAt = event.edit.at;
    if (grain === "call") flush();
  }
  flush();
  return out as never;
}

// ---- trace: measuring shapes on the current tree ------------------------------

interface Shape {
  readonly code: readonly string[];
  readonly contract: readonly string[];
  readonly full: boolean;
}

function shapeKey(shape: Shape): string {
  if (shape.full) return "full";
  return `code:${shape.code.join(",")}|contract:${shape.contract.join(",")}`;
}

const FUNCTION_LINE = /^(export )?(async )?function \w/;

/** Apply a synthetic edit of `shape`'s kind; `undefined` when a contract file has no top-level function to attach a tag to. */
function applyShape(
  root: string,
  shape: Shape,
  variant: number,
  originals: Map<string, string>,
): FileChange[] | undefined {
  const touched = new Set([...shape.code, ...shape.contract]);
  const texts = new Map<string, string>();
  for (const rel of touched) {
    const file = path.join(root, rel);
    const original = originals.get(rel) ?? fs.readFileSync(file, "utf8");
    originals.set(rel, original);
    let text = original;
    if (shape.contract.includes(rel)) {
      const lines = text.split("\n");
      const at = lines.findIndex((line) => FUNCTION_LINE.test(line));
      if (at === -1) return undefined;
      lines.splice(at, 0, `/** @effects ${variant % 2 === 0 ? "fs_read" : "fs_write"} */`);
      text = lines.join("\n");
    }
    if (shape.code.includes(rel)) {
      text = `${text}\n// ambit-observe\nexport function __ambitObserve(): number { return ${variant}; }\n`;
    }
    texts.set(rel, text);
  }
  for (const [rel, text] of texts) fs.writeFileSync(path.join(root, rel), text);
  return [...touched].map((rel) => ({ kind: "changed", path: rel }));
}

function restore(root: string, originals: Map<string, string>): FileChange[] {
  const changes: FileChange[] = [];
  for (const [rel, text] of originals) {
    fs.writeFileSync(path.join(root, rel), text);
    changes.push({ kind: "changed", path: rel });
  }
  originals.clear();
  return changes;
}

async function measureShapes(
  shapes: readonly Shape[],
  reuseOldProgram: boolean,
  iterations: number,
): Promise<Record<string, Measured | { unavailable: string }>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ambit-observe-"));
  const root = prepareCopy(dir);
  const sink: { phases: ProjectUpdatePhases | undefined } = { phases: undefined };
  const session = await ResidentSession.open(root, { backend: backendFor(reuseOldProgram, sink) });
  const out: Record<string, Measured | { unavailable: string }> = {};
  try {
    await session.update([]);
    for (const shape of shapes) {
      const key = shapeKey(shape);
      if (key in out) continue;
      const runs: Measured[] = [];
      for (let n = 0; n < iterations + 1; n += 1) {
        const originals = new Map<string, string>();
        const changes = shape.full ? [] : applyShape(root, shape, n, originals);
        if (changes === undefined) {
          restore(root, originals);
          out[key] = { unavailable: "no top-level function to attach a contract tag to" };
          break;
        }
        const started = performance.now();
        const result = shape.full ? await session.update() : await session.update(changes);
        const totalMs = performance.now() - started;
        if (n > 0)
          runs.push(measuredOf(result, totalMs, sink.phases, session.committed().store.files.size));
        const restored = restore(root, originals);
        if (restored.length > 0) await session.update(restored);
      }
      if (runs.length > 0) {
        const pick = runs.toSorted((a, b) => a.totalMs - b.totalMs)[
          Math.floor((runs.length - 1) / 2)
        ] as Measured;
        out[key] = { ...pick, totalMs: median(runs.map((r) => r.totalMs)) };
      }
      process.stderr.write(
        `[${reuseOldProgram ? "old" : "noold"}] ${Object.keys(out).length} shapes\n`,
      );
    }
  } finally {
    session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function traceMode(): Promise<void> {
  const sessionsDir = argValue("--sessions");
  if (sessionsDir === undefined) throw new Error("trace needs --sessions <dir>");
  const iterations = Number(argValue("--iterations") ?? 3);
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ambit-observe-probe-"));
  const probeRoot = prepareCopy(probeDir);
  const probe = await ResidentSession.open(probeRoot);
  const store = probe.committed().store;
  const project = {
    files: store.files.size,
    functions: [...store.files.values()].reduce(
      (n, e) => n + (e.extracted?.functions.length ?? 0),
      0,
    ),
  };
  probe.close();
  fs.rmSync(probeDir, { recursive: true, force: true });

  const batches: TraceBatch[] = [];
  let streams = 0;
  let streamsWithEdits = 0;
  for (const file of jsonlFiles(sessionsDir)) {
    const events = eventsOf(file);
    streams += 1;
    if (!events.some((e) => e.kind === "edit")) continue;
    streamsWithEdits += 1;
    const stream = createHash("sha1")
      .update(path.relative(sessionsDir, file))
      .digest("hex")
      .slice(0, 10);
    for (const grain of ["call", "bash"] as const) {
      for (const raw of batchesOf(stream, events, grain) as unknown as (Omit<
        TraceBatch,
        "files" | "cls" | "rootPart"
      > & { edits: Map<string, { before: string | null; after: string | null }> })[]) {
        const files: FileRecord[] = [...raw.edits].map(([rel, { before, after }]) => {
          const area = areaOf(rel);
          const { cls, reason } =
            area === "none"
              ? { cls: "no-op" as FileClass, reason: undefined }
              : classifyFile(rel, before, after);
          const rootRel = rel.slice("src/".length);
          const closure =
            area === "root" && store.files.has(rootRel) ? closureOf([rootRel], store) : undefined;
          return {
            path: rel,
            area,
            cls,
            ...(reason === undefined ? {} : { reason }),
            ...(closure === undefined ? {} : { closure }),
          };
        });
        const { cls, rootPart } = classifyBatch(files, raw.unknownOps);
        const rootFiles = files.filter((f) => f.area === "root" && f.cls !== "no-op");
        const seeds = rootFiles.map((f) => f.path.slice("src/".length));
        const allKnown = seeds.every((s) => store.files.has(s));
        const unionClosure = seeds.length > 0 && allKnown ? closureOf(seeds, store) : undefined;
        let shape: string | undefined;
        let codeSubsetShape: string | undefined;
        if (cls === "config" || cls === "outside-root" || cls === "add-delete-rename")
          shape = "full";
        else if (
          (cls === "contract-only" || cls === "code-only" || cls === "mixed-contract-code") &&
          allKnown
        ) {
          const code = rootFiles
            .filter((f) => f.cls !== "contract-only")
            .map((f) => f.path.slice(4))
            .toSorted();
          const contract = rootFiles
            .filter((f) => f.cls !== "code-only")
            .map((f) => f.path.slice(4))
            .toSorted();
          shape = shapeKey({ code, contract, full: false });
          if (cls === "mixed-contract-code")
            codeSubsetShape = shapeKey({ code, contract: [], full: false });
        }
        const { edits: _edits, ...rest } = raw;
        batches.push({
          ...rest,
          files,
          cls,
          rootPart,
          ...(unionClosure === undefined ? {} : { unionClosure }),
          ...(shape === undefined ? {} : { shape }),
          ...(codeSubsetShape === undefined ? {} : { codeSubsetShape }),
        });
      }
    }
  }
  const shapeSet = new Map<string, Shape>();
  for (const batch of batches) {
    for (const key of [batch.shape, batch.codeSubsetShape]) {
      if (key === undefined || shapeSet.has(key)) continue;
      if (key === "full") shapeSet.set(key, { code: [], contract: [], full: true });
      else {
        const [code, contract] = key.split("|").map((part) =>
          part
            .slice(part.indexOf(":") + 1)
            .split(",")
            .filter(Boolean),
        );
        shapeSet.set(key, { code: code ?? [], contract: contract ?? [], full: false });
      }
    }
  }
  const shapes = [...shapeSet.values()];
  const measured = await measureShapes(shapes, true, iterations);
  const measuredNoOld = process.argv.includes("--noold")
    ? await measureShapes(shapes, false, iterations)
    : undefined;
  write({
    source: "trace",
    streams,
    streamsWithEdits,
    project,
    iterations,
    batches,
    measured,
    ...(measuredNoOld === undefined ? {} : { measuredNoOld }),
  });
}

function write(body: object): void {
  const out = argValue("--out");
  const document = {
    date: new Date().toISOString(),
    node: process.version,
    typescript: legacyTsBackend.version,
    platform: `${os.platform()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model,
    commit: git(["rev-parse", "--short", "HEAD"]).trim(),
    ...body,
  };
  if (out === undefined) throw new Error("--out <file> is required");
  fs.writeFileSync(out, `${JSON.stringify(document, null, 1)}\n`);
}

// ---- git: replaying commits ---------------------------------------------------

function git(args: readonly string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function show(sha: string, rel: string): string | null {
  const result = spawnSync("git", ["-C", repoRoot, "show", `${sha}:${rel}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : null;
}

interface CommitRecord {
  readonly commit: string;
  readonly files: FileRecord[];
  readonly cls: BatchClass;
  readonly rootPart: BatchClass;
  readonly unionClosure?: number;
  readonly reported: "change-set" | "none";
  readonly measured?: Measured;
  readonly error?: string;
}

async function commitChild(sha: string, dir: string): Promise<CommitRecord> {
  const parent = `${sha}^`;
  const entries = git([
    "ls-tree",
    "--name-only",
    parent,
    "src",
    "test",
    "tsconfig.json",
    "package.json",
  ])
    .trim()
    .split("\n")
    .filter(Boolean);
  execFileSync("sh", [
    "-c",
    `git -C "${repoRoot}" archive ${parent} ${entries.join(" ")} | tar -x -C "${dir}"`,
  ]);
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"), "dir");
  const root = path.join(dir, "src");
  const diff = git(["diff", "--name-status", "-M", parent, sha]).trim().split("\n").filter(Boolean);
  const files: FileRecord[] = [];
  const writes: { rel: string; text: string | null }[] = [];
  for (const line of diff) {
    const [status = "", a = "", b] = line.split("\t");
    const pairs: [string, string | null, string | null][] = status.startsWith("R")
      ? [
          [a, show(parent, a), null],
          [b ?? "", null, show(sha, b ?? "")],
        ]
      : [[a, status === "A" ? null : show(parent, a), status === "D" ? null : show(sha, a)]];
    for (const [rel, before, after] of pairs) {
      const area = areaOf(rel);
      const { cls, reason } =
        area === "none"
          ? { cls: "no-op" as FileClass, reason: undefined }
          : classifyFile(rel, before, after);
      files.push({ path: rel, area, cls, ...(reason === undefined ? {} : { reason }) });
      if (area !== "none") writes.push({ rel, text: after });
    }
  }
  const { cls, rootPart } = classifyBatch(files, 0);
  if (cls === "no-project-change")
    return { commit: sha.slice(0, 7), files, cls, rootPart, reported: "none" };
  const sink: { phases: ProjectUpdatePhases | undefined } = { phases: undefined };
  let session: ResidentSession;
  try {
    session = await ResidentSession.open(root, { backend: backendFor(true, sink) });
  } catch (error) {
    return {
      commit: sha.slice(0, 7),
      files,
      cls,
      rootPart,
      reported: "none",
      error: `open: ${(error as Error).message.slice(0, 200)}`,
    };
  }
  try {
    const store = session.committed().store;
    const seeds = files
      .filter((f) => f.area === "root" && f.cls !== "no-op" && store.files.has(f.path.slice(4)))
      .map((f) => f.path.slice(4));
    const withClosure = files.map((f) =>
      f.area === "root" && store.files.has(f.path.slice(4))
        ? { ...f, closure: closureOf([f.path.slice(4)], store) }
        : f,
    );
    await session.update([]);
    for (const { rel, text } of writes) {
      const file = path.join(dir, rel);
      if (text === null) fs.rmSync(file, { force: true });
      else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      }
    }
    // A caller reports in-root changes; an out-of-root project file cannot be
    // reported, and §6.2 makes it a whole rebuild, so that batch reports nothing.
    const changes: FileChange[] = files
      .filter(
        (f) =>
          f.area === "root" ||
          f.area === "root-dts" ||
          (f.area === "config" && f.path.startsWith("src/")),
      )
      .filter((f) => f.cls !== "no-op")
      .map((f) => ({
        kind: f.cls === "added" ? "added" : f.cls === "deleted" ? "deleted" : "changed",
        path: f.path.slice(4),
      }));
    const reportNothing = cls === "outside-root";
    const started = performance.now();
    const result = reportNothing ? await session.update() : await session.update(changes);
    const totalMs = performance.now() - started;
    const base = {
      commit: sha.slice(0, 7),
      files: withClosure,
      cls,
      rootPart,
      ...(seeds.length > 0 ? { unionClosure: closureOf(seeds, store) } : {}),
      reported: reportNothing ? ("none" as const) : ("change-set" as const),
    };
    if (!result.ok) return { ...base, error: `update: ${result.error.message.slice(0, 200)}` };
    return {
      ...base,
      measured: measuredOf(result, totalMs, sink.phases, session.committed().store.files.size),
    };
  } finally {
    session.close();
  }
}

async function gitMode(): Promise<void> {
  const range = argValue("--range") ?? "HEAD";
  const commits = git([
    "rev-list",
    "--first-parent",
    "--reverse",
    range,
    "--",
    "src",
    "test",
    "tsconfig.json",
    "package.json",
    "pnpm-lock.yaml",
  ])
    .trim()
    .split("\n")
    .filter(Boolean);
  const records: CommitRecord[] = [];
  for (const sha of commits) {
    if (git(["rev-list", "--parents", "-n", "1", sha]).trim().split(" ").length < 2) continue;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ambit-observe-git-"));
    const child = spawnSync(process.execPath, [scriptPath, "--child", sha, dir], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    fs.rmSync(dir, { recursive: true, force: true });
    if (child.status !== 0) {
      records.push({
        commit: sha.slice(0, 7),
        files: [],
        cls: "other-unknown",
        rootPart: "other-unknown",
        reported: "none",
        error: `child: ${child.stderr.slice(-200)}`,
      });
    } else {
      records.push(JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "null"));
    }
    process.stderr.write(`[git] ${records.length}/${commits.length} ${records.at(-1)?.cls}\n`);
  }
  write({ source: "git", range, commits: records });
}

// ---- summary -------------------------------------------------------------------

function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;
}

const CLASSES: readonly BatchClass[] = [
  "contract-only",
  "code-only",
  "mixed-contract-code",
  "add-delete-rename",
  "config",
  "outside-root",
  "other-unknown",
];

function fmt(n: number | undefined): string {
  return n === undefined || Number.isNaN(n) ? "—" : n >= 100 ? n.toFixed(0) : n.toFixed(1);
}

function table(
  title: string,
  rows: readonly {
    cls: BatchClass;
    rootPart: BatchClass;
    unionClosure?: number;
    cost?: Measured;
    saving?: number;
  }[],
): void {
  const counted = rows.filter((r) => r.cls !== "no-project-change");
  const totalCost = counted.reduce((n, r) => n + (r.cost?.totalMs ?? 0), 0);
  console.log(`\n### ${title}\n\n${rows.length} batches, ${counted.length} touching the project\n`);
  console.log(
    "| class | n | % | closure p50 / p75 / p90 / max | total ms p50 / max | project-update ms p50 | extraction ms p50 | re-extracted p50 | Σ cost ms | Σ cost % | measured |",
  );
  console.log("|---|---:|---:|---|---|---:|---:|---:|---:|---:|---:|");
  for (const cls of CLASSES) {
    const group = counted.filter((r) => r.cls === cls);
    if (group.length === 0) continue;
    const closures = group.map((r) => r.unionClosure).filter((v): v is number => v !== undefined);
    const costs = group.map((r) => r.cost).filter((v): v is Measured => v !== undefined);
    const sum = costs.reduce((n, c) => n + c.totalMs, 0);
    const pick = (key: keyof Measured) =>
      quantile(
        costs.map((c) => c[key]).filter((v): v is number => typeof v === "number"),
        0.5,
      );
    console.log(
      `| ${cls} | ${group.length} | ${((100 * group.length) / counted.length).toFixed(1)} | ${closures.length === 0 ? "—" : `${quantile(closures, 0.5)} / ${quantile(closures, 0.75)} / ${quantile(closures, 0.9)} / ${Math.max(...closures)} (n=${closures.length})`} | ${fmt(pick("totalMs"))} / ${fmt(Math.max(...costs.map((c) => c.totalMs)))} | ${fmt(pick("projectUpdateMs"))} | ${fmt(pick("extractionMs"))} | ${fmt(pick("reextracted"))} | ${fmt(sum)} | ${totalCost === 0 ? "—" : ((100 * sum) / totalCost).toFixed(1)} | ${costs.length} |`,
    );
  }
  const outside = counted.filter((r) => r.cls === "outside-root");
  if (outside.length > 0) {
    const parts = Object.entries(Object.groupBy(outside, (r) => r.rootPart)).map(
      ([k, v]) => `${k} ${v?.length}`,
    );
    console.log(`\noutside-root batches by their in-root part: ${parts.join(", ")}`);
  }
  const mixed = counted.filter((r) => r.cls === "mixed-contract-code" && r.saving !== undefined);
  if (mixed.length > 0) {
    console.log(
      `\nmixed narrowing upper bound (mixed shape − its code-only subset, measured): Σ ${fmt(mixed.reduce((n, r) => n + (r.saving ?? 0), 0))} ms over ${mixed.length} batches = ${((100 * mixed.reduce((n, r) => n + (r.saving ?? 0), 0)) / totalCost).toFixed(1)}% of Σ cost`,
    );
  }
  const partial = counted
    .map((r) => r.cost)
    .filter((c): c is Measured => c !== undefined && c.verdict !== "full");
  const pu = partial.reduce((n, c) => n + (c.projectUpdateMs ?? 0), 0);
  const cp = partial.reduce((n, c) => n + (c.createProgramMs ?? 0) + (c.typeCheckerMs ?? 0), 0);
  const fullSum = counted
    .map((r) => r.cost)
    .filter((c): c is Measured => c?.verdict === "full")
    .reduce((n, c) => n + c.totalMs, 0);
  console.log(
    `\nΣ cost ${fmt(totalCost)} ms: full-verdict updates ${fmt(fullSum)} ms (${((100 * fullSum) / totalCost).toFixed(1)}%); partial/contract-only project-update ${fmt(pu)} ms (${((100 * pu) / totalCost).toFixed(1)}%), of which createProgram + getTypeChecker ${fmt(cp)} ms`,
  );
  const top = Object.entries(
    Object.groupBy(
      counted.filter((r) => r.cost !== undefined),
      (r) => `${r.cls} / ${r.cost?.verdict}`,
    ),
  )
    .map(
      ([k, v]) =>
        [k, (v ?? []).reduce((n, r) => n + (r.cost?.totalMs ?? 0), 0), v?.length ?? 0] as const,
    )
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 3);
  console.log(
    `\ntop shapes by Σ cost: ${top.map(([k, s, n]) => `${k}: ${fmt(s)} ms over ${n}`).join("; ")}`,
  );
}

function summaryMode(): void {
  for (const file of process.argv.slice(3)) {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    console.log(
      `\n## ${doc.source} — ${doc.date}, ${doc.node}, ${doc.typescript}, ${doc.platform}, ${doc.cpu}, at ${doc.commit}`,
    );
    if (doc.source === "trace") {
      console.log(
        `streams ${doc.streams}, with edits ${doc.streamsWithEdits}; current project ${doc.project.files} files / ${doc.project.functions} functions`,
      );
      for (const [label, measured] of [
        ["", doc.measured],
        [" (oldProgram withheld)", doc.measuredNoOld],
      ] as const) {
        if (measured === undefined) continue;
        for (const grain of ["call", "bash"]) {
          const batches = (doc.batches as TraceBatch[]).filter((b) => b.grain === grain);
          const costOf = (key: string | undefined): Measured | undefined => {
            const m = key === undefined ? undefined : measured[key];
            return m !== undefined && "totalMs" in m ? m : undefined;
          };
          table(
            `trace, grain ${grain}${label}`,
            batches.map((b) => {
              const cost = costOf(b.shape);
              const subset = costOf(b.codeSubsetShape);
              return {
                ...b,
                ...(cost === undefined ? {} : { cost }),
                ...(cost !== undefined && subset !== undefined
                  ? { saving: Math.max(0, cost.totalMs - subset.totalMs) }
                  : {}),
              };
            }),
          );
          if (grain === "bash" && label === "") {
            const touching = batches
              .filter((b) => b.cls !== "no-project-change")
              .toSorted((a, b) => a.startAt - b.startAt);
            const gaps: number[] = [];
            for (let i = 1; i < touching.length; i += 1) {
              const a = touching[i - 1] as TraceBatch;
              const b = touching[i] as TraceBatch;
              if (a.stream === b.stream && b.startAt > a.endAt)
                gaps.push((b.startAt - a.endAt) / 1000);
            }
            console.log(
              `\ngap between consecutive project-touching bash batches in one stream (s): n=${gaps.length} p50 ${fmt(quantile(gaps, 0.5))} p90 ${fmt(quantile(gaps, 0.9))}`,
            );
            const unavailable = Object.values(measured).filter(
              (m) => !("totalMs" in (m as object)),
            ).length;
            console.log(
              `shapes measured ${Object.keys(measured).length}, unavailable ${unavailable}`,
            );
          }
        }
      }
    } else {
      const commits = doc.commits as CommitRecord[];
      table(
        `git, first-parent commits (${doc.range})`,
        commits.map((c) => ({ ...c, ...(c.measured === undefined ? {} : { cost: c.measured }) })),
      );
      const errors = commits.filter((c) => c.error !== undefined);
      console.log(
        `\nerrors ${errors.length}: ${errors.map((c) => `${c.commit} ${c.cls} ${c.error?.slice(0, 80)}`).join(" | ")}`,
      );
    }
  }
}

// ---- entry -----------------------------------------------------------------------

const childIndex = process.argv.indexOf("--child");
if (childIndex !== -1) {
  const record = await commitChild(
    process.argv[childIndex + 1] ?? "",
    process.argv[childIndex + 2] ?? "",
  );
  process.stdout.write(`${JSON.stringify(record)}\n`);
} else if (process.argv[2] === "trace") await traceMode();
else if (process.argv[2] === "git") await gitMode();
else if (process.argv[2] === "summary") summaryMode();
else throw new Error("usage: observe-resident-workload.ts trace|git|summary");
