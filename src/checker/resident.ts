/**
 * The resident check path (DESIGN.md §6.2) — a session that holds Ambit's own
 * analysis state across updates, so a re-check after an edit does not cost
 * what the first check cost.
 *
 * The architecture is `docs/adr/0014-the-resident-check-path.md` and the
 * implementation plan is `docs/resident-check-path.md`. **This file is the
 * plan's phase 2**: the store, the generation lifecycle, the fingerprint, and
 * an `update` that recomputes everything. There is no scoped fixed point here
 * and no incremental extraction; both are phases 3 and 4, and the point of the
 * order is that the differential equivalence suite
 * (`test/resident.differential.test.ts`) goes green *before* any speed change
 * lands, so the first update that breaks §6.2's equivalence law names itself.
 *
 * Two rules this file exists to keep:
 *
 * - **Nothing snapshot-bound is retained.** No compiler node, type, signature
 *   or internal id reaches the store — `test/architecture.test.ts` forbids this
 *   file from importing `typescript` at all, and the differential suite asserts
 *   the committed store survives `structuredClone`, which a leaked compiler
 *   object or a retained closure would not.
 * - **A failed update is a failure, not an answer.** A generation is committed
 *   only once every phase completed; a throw anywhere leaves the previous
 *   generation exactly as it was, and {@link ResidentSession.current} refuses
 *   to serve it as a description of the tree that failed (§6.2, §3.4).
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ExtractedFile,
  ExtractedModule,
  FunctionSummary,
  SkippedFunctionKind,
  SymbolId,
  TsBackend,
} from "../core/index.ts";
import { legacyTsBackend } from "./backend/legacy-ts.ts";
import { configDependencies, loadConfig, type ResolvedConfig, resolveConfig } from "./config.ts";
import { changedSymbols, impactClosure } from "./impact.ts";
import { type PropagatedFunction, propagate, propagateScoped } from "./propagate.ts";
import { type AnalysisResult, buildReport } from "./report.ts";
import { summarizeFiles } from "./summarize.ts";

// ---- what the caller tells the session -------------------------------------

/**
 * One in-root change the caller knows about. Paths are root-relative, always.
 *
 * The session does not trust this to be complete: every update recomputes
 * {@link ProjectFingerprint} from disk before doing anything else, so a
 * tsconfig, an `ambit.config.ts` or an installed dependency nobody reported is
 * still caught. What the caller owes is the in-root change set, and a caller
 * that over-reports costs time rather than correctness.
 */
export type FileChange =
  | { readonly kind: "changed"; readonly path: string }
  | { readonly kind: "added"; readonly path: string }
  | { readonly kind: "deleted"; readonly path: string };

// ---- what a generation costs -----------------------------------------------

/**
 * §6.2's phases, in milliseconds. The initial check reports the same shape as
 * a re-check, so the two are comparable without subtracting one schema from
 * another.
 *
 * `undefined` is not zero. It means *this backend cannot separate this phase*,
 * and it is a distinct value for the reason §3.4 keeps "nothing was found" and
 * "nothing was looked for" distinct: a phase reported as 0 ms reads as free.
 * `transfer` is genuinely 0 in-process and is reported as 0, so a
 * process-separated backend fills the same field with a real number.
 */
export interface PhaseTimings {
  /**
   * Bringing the engine's state up to date. `undefined` through the
   * full-rebuild adapter, which reaches the engine only through
   * `extractProject` and so cannot see where project construction ends and
   * extraction begins — the two are reported together under {@link extraction}.
   */
  readonly projectUpdate?: number;
  readonly extraction: number;
  readonly impact: number;
  readonly summarize: number;
  readonly propagate: number;
  readonly report: number;
  readonly transfer: number;
}

// ---- the fingerprint -------------------------------------------------------

/**
 * The cheap test for "can anything be reused at all" (§6.2's full-rebuild
 * rows).
 *
 * It is not trying to be a complete model of what a project depends on. It is
 * trying to be **never wrong in the permissive direction**: anything it cannot
 * answer goes in {@link undecidable} and forces a rebuild. Widening a trigger
 * is always allowed; narrowing one needs evidence.
 */
export interface ProjectFingerprint {
  readonly engineName: string;
  readonly engineVersion: string;
  /** Absolute, or `undefined` where the backend falls back to walking the root. */
  readonly tsconfigPath: string | undefined;
  /** The tsconfig's own text. See {@link undecidable} for what it deliberately cannot cover. */
  readonly tsconfigHash: string;
  /**
   * `ambit.config.ts` **and every file it imports**, transitively — not the
   * config file's text alone.
   *
   * A config is a module, so its value is a function of its whole dependency
   * closure. Hashing the config file by itself reports an edit to a helper it
   * imports as "nothing changed", which is the one direction §6.2 forbids this
   * fingerprint from being wrong in. Only relative specifiers are followed: a
   * bare one names a package, and a change there is a resolution change, which
   * {@link resolutionHash} and §6.2's own table already answer with a whole
   * rebuild.
   */
  readonly configHash: string;
  /** `package.json` and the lockfile beside it — the resolution inputs readable as text. */
  readonly resolutionHash: string;
  /**
   * Why this fingerprint cannot decide reuse, one reason per entry. A
   * non-empty list means "rebuild", whatever every other field says.
   *
   * `tsconfigHash` covers the tsconfig's *text*, and a tsconfig with an
   * `extends` chain, or one whose resolved options this layer cannot see
   * without a compiler, is exactly the case the text does not cover. The design
   * note calls the resolved options (without `fileNames`) part of this hash;
   * supplying them needs the backend, which is phase 4's `openProject`. Until
   * then the honest answer is that this fingerprint does not know, and the
   * honest consequence is a rebuild.
   */
  readonly undecidable: readonly string[];
}

/**
 * Whether two fingerprints permit reuse.
 *
 * Undecidable on *either* side is false. An unknown is never turned into a
 * "nothing changed" (§3.4): the direction this function is allowed to be wrong
 * in is "rebuilt something it need not have".
 */
export function fingerprintPermitsReuse(a: ProjectFingerprint, b: ProjectFingerprint): boolean {
  if (a.undecidable.length > 0 || b.undecidable.length > 0) return false;
  return (
    a.engineName === b.engineName &&
    a.engineVersion === b.engineVersion &&
    a.tsconfigPath === b.tsconfigPath &&
    a.tsconfigHash === b.tsconfigHash &&
    a.configHash === b.configHash &&
    a.resolutionHash === b.resolutionHash
  );
}

const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock"];

const CONFIG_FILENAMES = [
  "ambit.config.ts",
  "ambit.config.mts",
  "ambit.config.js",
  "ambit.config.mjs",
];

/** @effects fs_read */
export function computeFingerprint(rootDir: string, engine: TsBackend): ProjectFingerprint {
  const absoluteRoot = path.resolve(rootDir);
  const undecidable: string[] = [];

  const tsconfigPath = findUpward(absoluteRoot, (dir) => {
    const candidate = path.join(dir, "tsconfig.json");
    return isFile(candidate) ? candidate : undefined;
  });
  const tsconfigText = tsconfigPath === undefined ? "" : readOrUndefined(tsconfigPath);
  if (tsconfigPath !== undefined && tsconfigText === undefined) {
    undecidable.push(`cannot read ${tsconfigPath}`);
  }
  // An `extends` chain is a file this layer would have to resolve the way the
  // compiler does, and a second resolution model is a second way to be wrong.
  if (tsconfigText !== undefined && /"extends"\s*:/.test(tsconfigText)) {
    undecidable.push(`${tsconfigPath} has an "extends" chain this layer cannot follow`);
  }
  // What the compiler resolves the options to is not visible from here at all.
  // Phase 4's `openProject` is what supplies it; until then, say so rather than
  // letting a text hash stand in for an answer it does not have.
  undecidable.push("resolved compiler options are not available without a backend session");

  const configPath = findUpward(
    absoluteRoot,
    (dir) => {
      for (const name of CONFIG_FILENAMES) {
        const candidate = path.join(dir, name);
        if (isFile(candidate)) return candidate;
      }
      return undefined;
    },
    true,
  );
  // The config's whole dependency closure, not its own text: see `configHash`.
  // Anything the closure walk could not decide — a specifier resolving to no
  // file, a dynamic import — is carried straight through to `undecidable`,
  // because an incomplete closure makes an unchanged hash meaningless.
  const configParts: string[] = [];
  if (configPath !== undefined) {
    const dependencies = configDependencies(configPath);
    undecidable.push(...dependencies.undecidable);
    for (const file of dependencies.files) {
      const text = readOrUndefined(file);
      if (text === undefined) {
        undecidable.push(`cannot read ${file}`);
        continue;
      }
      configParts.push(file, text);
    }
  }

  const packageJsonPath = findUpward(absoluteRoot, (dir) => {
    const candidate = path.join(dir, "package.json");
    return isFile(candidate) ? candidate : undefined;
  });
  const resolutionParts: string[] = [];
  if (packageJsonPath !== undefined) {
    resolutionParts.push(packageJsonPath, readOrUndefined(packageJsonPath) ?? "");
    const packageDir = path.dirname(packageJsonPath);
    for (const lockfile of LOCKFILES) {
      const candidate = path.join(packageDir, lockfile);
      if (isFile(candidate)) resolutionParts.push(candidate, readOrUndefined(candidate) ?? "");
    }
  }

  return {
    engineName: engine.name,
    engineVersion: engine.version,
    tsconfigPath,
    tsconfigHash: hash(tsconfigText ?? ""),
    configHash: hash(configParts.join("\n\u0000\n")),
    resolutionHash: hash(resolutionParts.join("\n\u0000\n")),
    undecidable,
  };
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** @effects fs_read */
function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** @effects fs_read */
function readOrUndefined(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Walk up from `startDir` applying `pick`, returning the first hit.
 *
 * `stopAtProjectBoundary` mirrors §4.1 (c)'s rule for `ambit.config.ts` — stop
 * after the first directory holding a `package.json` or `.git`, so a config
 * outside the project is never picked up. A tsconfig has no such rule, because
 * `ts.findConfigFile` has none either, and the fingerprint has to look where
 * the backend looks.
 *
 * @effects fs_read
 */
function findUpward(
  startDir: string,
  pick: (dir: string) => string | undefined,
  stopAtProjectBoundary = false,
): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    const found = pick(dir);
    if (found !== undefined) return found;
    if (
      stopAtProjectBoundary &&
      (isFile(path.join(dir, "package.json")) || fs.existsSync(path.join(dir, ".git")))
    ) {
      return undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// ---- the store -------------------------------------------------------------

/**
 * One source file's slice of the committed generation.
 *
 * {@link extracted} is absent for a file that declared no function and
 * registered no runtime wrapper — a barrel. The entry exists anyway, for
 * {@link ExtractedModule.imports}: a store built from `ExtractedFile` alone
 * would hold no import edge for a barrel, so editing it would invalidate
 * nothing and every importer would keep a stale resolution.
 *
 * There is deliberately no `order` field. Phase 0 made diagnostics, authority
 * records and the coverage count maps functions of the findings rather than of
 * the order files were discovered in, so nothing downstream needs the store to
 * remember a position.
 */
export interface FileEntry {
  readonly module: ExtractedModule;
  readonly extracted?: ExtractedFile;
  readonly summaries: readonly FunctionSummary[];
  /**
   * The exact `ambit.config.ts` keys the symbols in this file matched.
   *
   * Per file rather than per generation because `AMB-W006` must be derivable
   * from a **union over the files**, not from a whole-project run's
   * accumulated state: `ResolvedConfig` records matches as a side effect of
   * every lookup, so a generation that re-summarized only some files would
   * report every key the others matched as unmatched. Phase 3 still
   * re-summarizes everything, and the union is computed anyway — a field first
   * exercised by the phase that needs it is a field nobody has watched fail.
   */
  readonly matchedConfigKeys: readonly string[];
}

/**
 * The committed generation: Ambit's own representation of one tree, and
 * nothing the compiler owns.
 *
 * Everything here is plain data — strings, numbers, arrays, `Map`s and `Set`s
 * of those. The differential suite asserts it by cloning the store with
 * `structuredClone`, which throws on a function and therefore on any retained
 * compiler object or closure over one.
 */
export interface ResidentStore {
  readonly rootDir: string;
  readonly engine: { readonly name: string; readonly version: string };
  readonly generation: number;
  readonly fingerprint: ProjectFingerprint;
  /** Keyed by root-relative path. One entry per source file under the root. */
  readonly files: ReadonlyMap<string, FileEntry>;
  /** The last committed fixed point. */
  readonly state: ReadonlyMap<SymbolId, PropagatedFunction>;
  /** imported file → the files importing it. Inverted from {@link ExtractedModule.imports}. */
  readonly reverseImports: ReadonlyMap<string, ReadonlySet<string>>;
  /** callee → the functions calling it. Inverted from the summaries' resolved calls. */
  readonly reverseCalls: ReadonlyMap<SymbolId, ReadonlySet<SymbolId>>;
  /**
   * Exact `ambit.config.ts` keys that named no extracted symbol, for AMB-W006.
   *
   * Computed as `ResolvedConfig.exactKeys()` minus the union of every
   * {@link FileEntry.matchedConfigKeys}, in the config's own key order — not
   * from `ResolvedConfig.unmatchedExactKeys()`, whose answer is only correct
   * after a whole project has been looked up through that one object.
   */
  readonly unmatchedExactKeys: readonly string[];
}

// ---- the backend seam ------------------------------------------------------

/** What one {@link TsProjectSession.update} produced. */
export interface ExtractedUpdate {
  /** Re-extracted files. A file absent here keeps the entry the store holds. */
  readonly files: readonly ExtractedFile[];
  /** One per re-extracted source file, including files absent from {@link files}. */
  readonly modules: readonly ExtractedModule[];
  /** Files deleted from the project — not "stopped contributing". */
  readonly removed: readonly string[];
  /** True when this is the whole project and the store is replaced, not patched. */
  readonly full: boolean;
  /** `undefined` where the backend cannot separate project construction from extraction. */
  readonly projectUpdateMs?: number;
}

/**
 * A backend held open across updates. Optional on `TsBackend`: a backend that
 * does not implement `openProject` is driven through
 * {@link fullRebuildSession}, which calls `extractProject` and reports a full
 * rebuild every time (ADR-0014's architecture A).
 */
export interface TsProjectSession {
  update(changed: readonly FileChange[]): Promise<ExtractedUpdate>;
  close(): void;
}

/**
 * The adapter every backend gets for free, and the only one phase 2 uses.
 *
 * It re-extracts the whole project on every update. That is not a placeholder
 * standing in for the real thing: §6.2's invalidation table falls back to
 * exactly this for a tsconfig change, an added file, a `.d.ts` and an installed
 * dependency, so this path stays in the product after phases 3 and 4 land —
 * which is why it shares no code with them and a bug in one cannot hide in the
 * other.
 */
export function fullRebuildSession(backend: TsBackend, rootDir: string): TsProjectSession {
  return {
    async update(): Promise<ExtractedUpdate> {
      const project = await backend.extractProject(rootDir);
      return {
        files: project.files,
        modules: project.modules,
        removed: [],
        full: true,
        // `projectUpdateMs` left undefined on purpose: through `extractProject`
        // there is no boundary between building the program and walking it, and
        // reporting 0 would say the first was free.
      };
    },
    close(): void {
      // Nothing is held open.
    },
  };
}

// ---- the session -----------------------------------------------------------

export interface ResidentSessionOptions {
  /** `--strict`: promote the `unknown` warnings to errors (DESIGN.md §4.2 rule 3). */
  readonly strict?: boolean;
  /**
   * The connection layer to extract with. Defaults to `legacyTsBackend`, the
   * backend §3.5 adopted. Present for the same measurement reason
   * `AnalyzeOptions.backend` is, and with the same rule: passing one does not
   * make it authoritative.
   */
  readonly backend?: TsBackend;
}

/**
 * What one generation's impact analysis decided — phase 3's `S` and `I`.
 *
 * Reported so that a caller, and the differential suite, can see *that* the
 * scoped path ran and how far it reached. Both lists are sorted by symbol id:
 * they are sets, and a stable order is what makes them comparable between runs.
 */
export interface ImpactReport {
  /** `S` — symbols added, removed, or whose summary is not `summariesEqual`. */
  readonly changed: readonly SymbolId[];
  /** `I` — `S` closed under callers over the union of the old and new reverse call graphs. */
  readonly impacted: readonly SymbolId[];
  /** Functions in the new generation. `impacted.length < totalFunctions` is the scoped path doing something. */
  readonly totalFunctions: number;
  /**
   * Whether the fixed point was scoped to `I`. False for the first generation,
   * which has no previous state to reuse and runs `propagate` whole.
   */
  readonly scoped: boolean;
}

/** What one {@link ResidentSession.update} produced, or why it produced nothing. */
export type UpdateResult =
  | {
      readonly ok: true;
      /** The generation this update committed. */
      readonly generation: number;
      readonly analysis: AnalysisResult;
      readonly timings: PhaseTimings;
      /** What the scoped fixed point recomputed, and what it reused. */
      readonly impact: ImpactReport;
      /** False once phase 4 lands and an update patches the store instead of replacing it. */
      readonly full: boolean;
    }
  | {
      readonly ok: false;
      /** The generation still committed — the previous one, untouched. */
      readonly generation: number;
      readonly error: Error;
      readonly timings: PhaseTimings;
    };

/**
 * A resident analysis of one directory.
 *
 * Opened with {@link openResidentSession}, which runs the first check. Every
 * later {@link ResidentSession.update} runs a generation and either commits it
 * whole or commits nothing.
 */
export class ResidentSession {
  readonly #rootDir: string;
  readonly #backend: TsBackend;
  readonly #strict: boolean;
  readonly #projectSession: TsProjectSession;
  #store: ResidentStore;
  #analysis: AnalysisResult;
  /** Set when the last update failed. The committed generation stays; the answer does not. */
  #failure: Error | undefined;
  #closed = false;

  private constructor(
    rootDir: string,
    backend: TsBackend,
    strict: boolean,
    projectSession: TsProjectSession,
    store: ResidentStore,
    analysis: AnalysisResult,
  ) {
    this.#rootDir = rootDir;
    this.#backend = backend;
    this.#strict = strict;
    this.#projectSession = projectSession;
    this.#store = store;
    this.#analysis = analysis;
  }

  /**
   * Open a session and run the first check.
   *
   * Throws exactly where a cold `analyze()` would, and for the same reason: a
   * session that could not analyze the tree must not exist reporting no
   * violations (§3.4).
   *
   * @effects fs_read, process
   */
  static async open(
    rootDir: string,
    options: ResidentSessionOptions = {},
  ): Promise<ResidentSession> {
    const backend = options.backend ?? legacyTsBackend;
    const projectSession = backend.openProject
      ? await backend.openProject(rootDir)
      : fullRebuildSession(backend, rootDir);
    try {
      const generation = await runGeneration({
        rootDir,
        backend,
        strict: options.strict ?? false,
        projectSession,
        generationNumber: 1,
      });
      return new ResidentSession(
        rootDir,
        backend,
        options.strict ?? false,
        projectSession,
        generation.store,
        generation.analysis,
      );
    } catch (error) {
      projectSession.close();
      throw error;
    }
  }

  /**
   * Run one generation over the current tree.
   *
   * `changes` is what the caller knows changed under the root. In phase 2 it is
   * recorded and not otherwise used — every update is a full rebuild — and the
   * fingerprint is recomputed from disk regardless, because §6.2 makes the
   * session responsible for noticing what the caller did not report.
   *
   * All-or-nothing: the new generation is built entirely in locals and assigned
   * in one place at the end, so a throw anywhere leaves the committed
   * generation exactly as it was.
   *
   * `state_write` is the commit itself — the assignment to the session's own
   * fields, which is the whole reason this object exists and is exactly the
   * authority a resident path holds that a one-shot run does not. `process` is
   * `loadConfig`'s, as on every other entry point here.
   *
   * @effects fs_read, state_write, process
   */
  async update(changes: readonly FileChange[] = []): Promise<UpdateResult> {
    if (this.#closed) throw new Error("resident session is closed");
    const started = now();
    try {
      const generation = await runGeneration({
        rootDir: this.#rootDir,
        backend: this.#backend,
        strict: this.#strict,
        projectSession: this.#projectSession,
        generationNumber: this.#store.generation + 1,
        changes,
        previous: this.#store,
      });
      // The commit. Everything above this line is a local.
      this.#store = generation.store;
      this.#analysis = generation.analysis;
      this.#failure = undefined;
      return {
        ok: true,
        generation: generation.store.generation,
        analysis: generation.analysis,
        timings: generation.timings,
        impact: generation.impact,
        full: generation.full,
      };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.#failure = failure;
      return {
        ok: false,
        generation: this.#store.generation,
        error: failure,
        // A failed update still cost time. Reporting it as a run that took no
        // phases would hide the cost of failing.
        timings: {
          extraction: now() - started,
          impact: 0,
          summarize: 0,
          propagate: 0,
          report: 0,
          transfer: 0,
        },
      };
    }
  }

  /**
   * The analysis of the tree as the session last saw it.
   *
   * **Throws after a failed update.** The previous generation is still
   * committed — {@link ResidentSession.committed} is how a caller reaches it —
   * but it describes an earlier tree, and §6.2 forbids re-serving it as though
   * it described this one: "The previous generation's diagnostics are never
   * re-served as though they described the current tree."
   */
  current(): AnalysisResult {
    if (this.#failure) {
      throw new Error(
        `the last resident update failed and no generation describes the current tree: ${this.#failure.message}`,
      );
    }
    return this.#analysis;
  }

  /**
   * The last generation that committed, whether or not a later update failed.
   *
   * For transactionality checks and for a caller that wants to say "the last
   * good answer was generation N" — never for answering "what does the tree say
   * now", which is {@link ResidentSession.current}'s job and which refuses
   * after a failure.
   */
  committed(): { readonly store: ResidentStore; readonly analysis: AnalysisResult } {
    return { store: this.#store, analysis: this.#analysis };
  }

  /** The error the last update failed with, or `undefined` if it succeeded. */
  lastFailure(): Error | undefined {
    return this.#failure;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#projectSession.close();
  }
}

/** @effects fs_read, process */
export async function openResidentSession(
  rootDir: string,
  options: ResidentSessionOptions = {},
): Promise<ResidentSession> {
  return await ResidentSession.open(rootDir, options);
}

// ---- one generation --------------------------------------------------------

interface Generation {
  readonly store: ResidentStore;
  readonly analysis: AnalysisResult;
  readonly timings: PhaseTimings;
  readonly impact: ImpactReport;
  readonly full: boolean;
}

interface GenerationInput {
  readonly rootDir: string;
  readonly backend: TsBackend;
  readonly strict: boolean;
  readonly projectSession: TsProjectSession;
  readonly generationNumber: number;
  readonly changes?: readonly FileChange[];
  /** The committed generation this one follows, or absent for the first check. */
  readonly previous?: ResidentStore;
}

/**
 * §6.2's lifecycle for one generation, in its phase order. Every value it
 * produces is a local; the caller is what commits.
 *
 * `process` is `loadConfig`'s — see `analyze`'s contract for why a config that
 * imports another module is evaluated in a thread of its own.
 *
 * @effects fs_read, process
 */
async function runGeneration(input: GenerationInput): Promise<Generation> {
  const { rootDir, backend, strict, projectSession } = input;

  // 1. Fingerprint. Recomputed from disk every generation, whatever the caller
  //    reported — §6.2 makes the session, not its caller, responsible for
  //    noticing a tsconfig, a config file or an installed dependency that
  //    changed.
  const fingerprint = computeFingerprint(rootDir, backend);
  // In this phase the answer has no consequence: every update is a full
  // rebuild, so `false` is what the path does anyway. It is computed and
  // recorded rather than skipped because a fingerprint first exercised by the
  // code that depends on it is a fingerprint nobody has watched fail.
  //
  // **What it will gate is extraction reuse, which is phase 4 — not phase 3.**
  // Saying "phase 3 branches on this" would be a trap: `undecidable` carries a
  // permanent entry until `openProject` can report the resolved compiler
  // options, so reuse is refused on every update, and a phase 3 written inside
  // this branch would never execute.
  //
  // It does not need to, and the reason is not that a refused fingerprint makes
  // every summary count as changed — it does not. A compiler option can differ
  // while a given function extracts, resolves and summarizes to exactly what it
  // did before. Phase 3 is independent because it **reuses no compiler or
  // extraction result at all**: it re-extracts and re-summarizes the whole
  // project from the new snapshot, then compares those Ambit-owned summaries
  // against the previous generation's. Only a summary whose propagation inputs
  // actually moved enters the changed set; one that did not move needs no
  // invalidation merely because the fingerprint refused compiler-level reuse.
  // Phase 4 is where this verdict begins gating anything.
  const reusePermitted =
    input.previous !== undefined &&
    fingerprintPermitsReuse(input.previous.fingerprint, fingerprint) &&
    !(input.changes ?? []).some((change) => change.kind === "added");
  void reusePermitted;

  // The config is loaded per generation and **before extraction**, never
  // carried. Two reasons, and both matter:
  //
  // - `ResolvedConfig` accumulates matched keys as a side effect of every
  //   lookup, so a carried one would report keys as unmatched that an earlier
  //   generation matched.
  // - The cold path loads it here too, so a broken config stops the run before
  //   any work is reported (§3.4). A tree whose tsconfig *and* config are both
  //   broken has to fail the same way on both paths, or §6.2's "the same
  //   distinction a one-shot run would give it" is not met.
  const loaded = await loadConfig(rootDir);
  const config: ResolvedConfig | undefined = loaded ? resolveConfig(loaded, rootDir) : undefined;

  // 2/3. project-update and extraction, which the full-rebuild adapter cannot
  //      separate. See `PhaseTimings.projectUpdate`.
  const extractionStarted = now();
  const update = await projectSession.update(input.changes ?? []);
  const extractionMs = now() - extractionStarted;
  if (!update.full) {
    // Phase 2 has no patching path. A backend reporting a partial update here
    // would be answering a question this generation cannot ask, and treating it
    // as a whole project would silently drop every file it left out (§3.4).
    throw new Error(
      "the resident path does not patch the store yet: a partial ExtractedUpdate cannot be committed",
    );
  }

  // The same refusal the cold path makes, in the same place and for the same
  // reason: "nothing analyzable was found" must not read as "checked, no
  // violations" (§3.4).
  const functionsFound = update.files.reduce((total, file) => total + file.functions.length, 0);
  if (functionsFound === 0) {
    throw new Error(`no analyzable functions found under ${rootDir}`);
  }

  // 4. summarize. Whole-project in this phase: extraction is not reused, so
  //    there is no subset to summarize. The per-file matched config keys are
  //    what `AMB-W006` is rebuilt from, instead of from `ResolvedConfig`'s
  //    accumulated state.
  const summarizeStarted = now();
  const { summaries, matchedConfigKeys } = summarizeFiles(update.files, config);
  const summarizeMs = now() - summarizeStarted;

  // 5. impact. The changed-summary comparison and the reverse-call closure,
  //    including building the new generation's reverse-call graph — that graph
  //    is one of the two the closure is taken over, so its cost belongs here
  //    and not in the store construction below.
  const impactStarted = now();
  const reverseCalls = buildReverseCalls(summaries);
  const previous = input.previous;
  const scope = previous === undefined ? undefined : scopeOf(previous, summaries, reverseCalls);
  const impactMs = now() - impactStarted;

  // 6. propagate. Scoped to `I` whenever there is a committed generation to
  //    reuse; the whole fixed point on the first check, which has nothing to
  //    reuse. The two are separate functions on purpose — `propagate` stays the
  //    oracle the differential suite asserts the scoped one against.
  const propagateStarted = now();
  const state =
    scope === undefined
      ? propagate(summaries)
      : propagateScoped({
          summaries,
          previous: previous?.state ?? new Map(),
          impacted: scope.impacted,
        });
  const propagateMs = now() - propagateStarted;

  // 7. report. Whole-tree by design (ADR-0014): diagnostics, authority records
  //    and coverage are pure functions of the state with no compiler in them,
  //    and scoping them would buy a fraction of a phase for a second equality
  //    proof.
  const reportStarted = now();
  // The union of what the files matched, subtracted from the config's own exact
  // keys, in the config's key order. Not `ResolvedConfig.unmatchedExactKeys()`:
  // that answer is only correct once a whole project has been looked up through
  // that one object, and phase 4 re-summarizes a subset.
  const unmatchedExactKeys = config ? unmatchedFrom(config, matchedConfigKeys) : [];
  const analysis = buildReport({
    state,
    summaries,
    // Re-summed from the per-file slices rather than taken from the project
    // aggregate: this is the path phase 4 will take when only some files were
    // re-extracted, and exercising it now is what makes the equivalence suite
    // an assertion about it rather than about `extractProject`.
    uncarriedContracts: update.modules.flatMap((module) => [...module.uncarriedContracts]),
    runtimeWrappers: update.files.flatMap((file) => [...file.runtimeWrappers]),
    unmatchedExactKeys,
    filesAnalyzed: update.files.length,
    skippedFunctions: sumSkipped(update.modules),
    engine: { name: backend.name, version: backend.version },
    config,
    strict,
  });
  const reportMs = now() - reportStarted;

  const store: ResidentStore = {
    rootDir,
    engine: { name: backend.name, version: backend.version },
    generation: input.generationNumber,
    fingerprint,
    files: buildFileEntries(update.modules, update.files, summaries, matchedConfigKeys),
    state,
    reverseImports: buildReverseImports(update.modules),
    reverseCalls,
    unmatchedExactKeys,
  };

  return {
    store,
    analysis,
    timings: {
      ...(update.projectUpdateMs === undefined ? {} : { projectUpdate: update.projectUpdateMs }),
      extraction: extractionMs,
      impact: impactMs,
      summarize: summarizeMs,
      propagate: propagateMs,
      report: reportMs,
      // In-process. Zero, and reported as zero, so a process-separated backend
      // fills the same field with a real number (§6.2).
      transfer: 0,
    },
    impact: {
      // `toSorted`, not `sort`: an in-place sort is a mutation Ambit cannot
      // prove local on a value it did not watch being allocated, so it reads
      // as an escaping `state_write` this function does not declare.
      changed: scope ? [...scope.changed].toSorted() : summaries.map((s) => s.id).toSorted(),
      impacted: scope ? [...scope.impacted].toSorted() : summaries.map((s) => s.id).toSorted(),
      totalFunctions: summaries.length,
      scoped: scope !== undefined,
    },
    full: update.full,
  };
}

/**
 * `S` and `I` for one generation, against the generation it follows.
 *
 * The previous generation's summaries are read off its committed state rather
 * than out of its `files` entries: `propagate` puts exactly one entry per
 * summary into the state and carries the summary on it, so the state is the
 * complete id set — which is what makes a *deleted* id visible.
 */
function scopeOf(
  previous: ResidentStore,
  summaries: readonly FunctionSummary[],
  reverseCalls: ReadonlyMap<SymbolId, ReadonlySet<SymbolId>>,
): { readonly changed: ReadonlySet<SymbolId>; readonly impacted: ReadonlySet<SymbolId> } {
  const previousSummaries = new Map<SymbolId, FunctionSummary>();
  for (const [id, propagated] of previous.state) previousSummaries.set(id, propagated.summary);
  const nextSummaries = new Map(summaries.map((summary) => [summary.id, summary] as const));
  const changed = changedSymbols(previousSummaries, nextSummaries);
  return {
    changed,
    impacted: impactClosure(changed, previous.reverseCalls, reverseCalls),
  };
}

/**
 * The config's exact keys that nothing matched, in the order the config
 * declares them — `AMB-W006` is emitted per key and §6.2 compares the order.
 */
function unmatchedFrom(
  config: ResolvedConfig,
  matchedConfigKeys: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const matched = new Set<string>();
  for (const keys of matchedConfigKeys.values()) {
    for (const key of keys) matched.add(key);
  }
  return config.exactKeys().filter((key) => !matched.has(key));
}

/**
 * The project-level `skippedFunctions` re-summed from the per-file slices.
 *
 * This is phase 1's acceptance test expressed as code: the resident path reads
 * the slices and the cold path reads the aggregate, and `check --coverage`
 * printing the same counts on both is what says they agree.
 */
function sumSkipped(modules: readonly ExtractedModule[]): ReadonlyMap<SkippedFunctionKind, number> {
  const summed = new Map<SkippedFunctionKind, number>();
  for (const module of modules) {
    for (const [kind, count] of module.skippedFunctions) {
      summed.set(kind, (summed.get(kind) ?? 0) + count);
    }
  }
  return summed;
}

function buildFileEntries(
  modules: readonly ExtractedModule[],
  files: readonly ExtractedFile[],
  summaries: readonly FunctionSummary[],
  matchedConfigKeys: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, FileEntry> {
  const extractedByPath = new Map(files.map((file) => [file.filePath, file] as const));
  // Grouped by the id's own file half rather than by walking `files` again: a
  // summary's id is `<root-relative path>#<declaration path>` (§5.3), so the
  // grouping is a property of the id and needs nothing the snapshot owns.
  //
  // Accumulated by replacing each bucket rather than by pushing into one: a
  // `push` onto a value that came back from `Map.get` is a mutation Ambit
  // cannot follow to a local allocation, so it reads as an escaping
  // `state_write` and this function's `fs_read` caller fails its own contract.
  // Ambit checking its own source is the point of running it on `src`, and the
  // honest response to a mutation it cannot prove local is to not make one —
  // not to widen the declaration past what the function actually does. The
  // cost is one array per summary over a few hundred summaries.
  const summariesByPath = new Map<string, readonly FunctionSummary[]>();
  for (const summary of summaries) {
    const file = summary.id.slice(0, summary.id.indexOf("#"));
    summariesByPath.set(file, [...(summariesByPath.get(file) ?? []), summary]);
  }

  const entries = new Map<string, FileEntry>();
  for (const module of modules) {
    const extracted = extractedByPath.get(module.filePath);
    entries.set(module.filePath, {
      module,
      ...(extracted ? { extracted } : {}),
      summaries: summariesByPath.get(module.filePath) ?? [],
      matchedConfigKeys: matchedConfigKeys.get(module.filePath) ?? [],
    });
  }
  return entries;
}

/**
 * imported file → importing files.
 *
 * Decides which files are **re-extracted**, because a change to what a module
 * exports changes how its importers' calls resolve. Never merged with
 * {@link buildReverseCalls}'s graph: propagation follows calls, extraction
 * follows imports, and a single graph would be wrong in both directions.
 */
function buildReverseImports(
  modules: readonly ExtractedModule[],
): ReadonlyMap<string, ReadonlySet<string>> {
  // Replaced rather than mutated in place, for the reason `buildFileEntries`
  // spells out: a mutation of a value that came back from `Map.get` is one
  // Ambit cannot prove local, and widening this function's contract to say
  // `state_write` would claim authority it does not exercise.
  const reverse = new Map<string, ReadonlySet<string>>();
  for (const module of modules) {
    for (const target of module.imports) {
      reverse.set(target, new Set([...(reverse.get(target) ?? []), module.filePath]));
    }
  }
  return reverse;
}

/**
 * callee → the functions calling it.
 *
 * Decides which functions are **re-propagated**: effects and capabilities flow
 * backwards along calls, which is what §6.2's "walk the contract dependencies
 * backwards" names.
 */
function buildReverseCalls(
  summaries: readonly FunctionSummary[],
): ReadonlyMap<SymbolId, ReadonlySet<SymbolId>> {
  // Same shape, same reason as {@link buildReverseImports}.
  const reverse = new Map<SymbolId, ReadonlySet<SymbolId>>();
  for (const summary of summaries) {
    for (const call of summary.calls) {
      if (call.kind !== "resolved") continue;
      reverse.set(call.callee, new Set([...(reverse.get(call.callee) ?? []), summary.id]));
    }
  }
  return reverse;
}

function now(): number {
  return performance.now();
}
