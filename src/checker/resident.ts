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
import {
  configDependencies,
  type LoadedConfig,
  loadConfig,
  type ResolvedConfig,
  resolveConfig,
} from "./config.ts";
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
  /**
   * The subset of {@link undecidable} that is about the project — the tsconfig
   * and the resolution inputs. Non-empty means **extraction** cannot be
   * reused.
   */
  readonly projectUndecidable: readonly string[];
  /**
   * The subset of {@link undecidable} that is about `ambit.config.ts`'s
   * dependency closure.
   *
   * Separate because a config cannot change how a call resolves — no contract
   * reaches `extractProject`, which is why §6.2's table answers a config change
   * with "re-summarize every file; extraction untouched". A closure this layer
   * could not walk therefore says nothing about extraction, and folding it into
   * one flat verdict would turn a dynamic `import()` in a config into a whole
   * program rebuild on every keystroke.
   *
   * It does not gate summaries either, and the reason is that nothing needs it
   * to: the resident store compares the **loaded config's own value**
   * (`configValueHash`), which is direct evidence and not a proxy for one.
   */
  readonly configUndecidable: readonly string[];
}

/**
 * Whether two fingerprints permit reuse.
 *
 * Undecidable on *either* side is false. An unknown is never turned into a
 * "nothing changed" (§3.4): the direction this function is allowed to be wrong
 * in is "rebuilt something it need not have".
 *
 * This is the whole-fingerprint verdict, config included. What gates extraction
 * is {@link fingerprintPermitsExtractionReuse}; what gates summaries is the
 * config value hash the store keeps beside this record.
 */
export function fingerprintPermitsReuse(a: ProjectFingerprint, b: ProjectFingerprint): boolean {
  if (a.undecidable.length > 0 || b.undecidable.length > 0) return false;
  return fingerprintPermitsExtractionReuse(a, b) && a.configHash === b.configHash;
}

/**
 * Whether two fingerprints permit **extraction** to be reused — the disk-side
 * half of the resident path's reuse gate.
 *
 * The other half is the backend's, and it is the half that can see a program:
 * the resolved compiler options, the root-name delta, and every input the
 * program read that is not an in-root implementation file — `node_modules`
 * typings included, which is how a package rewritten in place is caught even
 * though neither the lockfile nor `package.json` moved. A partial extraction
 * happens only when **both** halves permit it, and the backend's half is what
 * lets this record stop reporting "resolved compiler options are not
 * available" as a permanent unknown (`docs/resident-check-path.md`,
 * correction 5).
 *
 * `configHash` is deliberately not compared: no contract in `ambit.config.ts`
 * reaches `extractProject`, and §6.2's table says so — "re-summarize every
 * file; extraction untouched".
 */
export function fingerprintPermitsExtractionReuse(
  a: ProjectFingerprint,
  b: ProjectFingerprint,
): boolean {
  if (a.projectUndecidable.length > 0 || b.projectUndecidable.length > 0) return false;
  return (
    a.engineName === b.engineName &&
    a.engineVersion === b.engineVersion &&
    a.tsconfigPath === b.tsconfigPath &&
    a.tsconfigHash === b.tsconfigHash &&
    a.resolutionHash === b.resolutionHash
  );
}

/**
 * A hash of the config **as it was loaded**, not of the text it came from.
 *
 * This is what decides whether every file has to be re-summarized, and it is
 * direct evidence rather than a proxy: `configHash` follows only the relative
 * specifiers a config imports, so a config that imports a *package* rewritten
 * in place would hash the same while meaning something else
 * (`docs/resident-check-path.md`, correction 7, "what this does not close").
 * The loaded value cannot hide that, because the config is re-evaluated from a
 * fresh module registry every generation.
 *
 * `AmbitConfig` is plain data (`src/core/config.ts`), so serializing it is
 * total in practice. A value that still cannot be serialized — a consumer's
 * config is arbitrary code — yields `undefined`, which is never equal to
 * anything and so can only force a re-summarization, never permit a reuse.
 */
function hashConfigValue(loaded: LoadedConfig | undefined): string | undefined {
  if (loaded === undefined) return hash("\u0000no-config");
  try {
    return hash(
      [loaded.configPath, loaded.sourceText, JSON.stringify(loaded.config)].join("\n\u0000\n"),
    );
  } catch {
    return undefined;
  }
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
  const projectUndecidable: string[] = [];
  const configUndecidable: string[] = [];

  const tsconfigPath = findUpward(absoluteRoot, (dir) => {
    const candidate = path.join(dir, "tsconfig.json");
    return isFile(candidate) ? candidate : undefined;
  });
  const tsconfigText = tsconfigPath === undefined ? "" : readOrUndefined(tsconfigPath);
  if (tsconfigPath !== undefined && tsconfigText === undefined) {
    projectUndecidable.push(`cannot read ${tsconfigPath}`);
  }
  // An `extends` chain is a file this layer would have to resolve the way the
  // compiler does, and a second resolution model is a second way to be wrong.
  //
  // The backend session *does* compare the resolved options, so an edit to a
  // base config is caught there — this entry is kept anyway, because narrowing
  // a full-rebuild trigger needs evidence and this one costs a rebuild on a
  // shape nothing has measured (`docs/resident-check-path.md`).
  if (tsconfigText !== undefined && /"extends"\s*:/.test(tsconfigText)) {
    projectUndecidable.push(`${tsconfigPath} has an "extends" chain this layer cannot follow`);
  }

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
    configUndecidable.push(...dependencies.undecidable);
    for (const file of dependencies.files) {
      const text = readOrUndefined(file);
      if (text === undefined) {
        configUndecidable.push(`cannot read ${file}`);
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
    undecidable: [...projectUndecidable, ...configUndecidable],
    projectUndecidable,
    configUndecidable,
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
  /**
   * The loaded `ambit.config.ts` value's hash — what decides whether every file
   * has to be re-summarized. See `hashConfigValue`.
   */
  readonly configValueHash: string | undefined;
  /**
   * Keyed by root-relative path, **in the backend's own file order**. One entry
   * per source file under the root.
   *
   * The order is load-bearing from phase 4 on: every list the report reads —
   * the summaries, the runtime wrappers, the uncarried contracts — is derived
   * by walking this map, and a cold run walks the program. A partial update
   * therefore patches entries in place (`Map.set` on an existing key keeps its
   * position) and never removes and re-adds one.
   */
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
  /**
   * Run one generation of the engine's own state.
   *
   * `reextract` is the root-relative closure the resident layer decided it is
   * safe to re-extract — the reverse-import closure of what changed. **Absent
   * means "extract everything"**, and a backend may answer any call with a full
   * project: the resident layer owns *what* a partial update would cover, the
   * backend owns *whether* its own state permits one (a compiler option, an
   * installed dependency, a `.d.ts` rewritten in place). A backend that
   * answers `full: false` must have extracted exactly `reextract` — the caller
   * checks, because a backend quietly extracting fewer files is a silent drop
   * (§3.4).
   */
  update(changed: readonly FileChange[], reextract?: readonly string[]): Promise<ExtractedUpdate>;
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
      /** False when the store was patched rather than replaced. */
      readonly full: boolean;
      /**
       * The files this generation re-extracted, root-relative and sorted.
       *
       * On a full rebuild it is every file in the store; on a partial update it
       * is the reverse-import closure. Reported so a caller — and the
       * differential suite — can assert the closure rather than infer it from a
       * timing.
       */
      readonly reextracted: readonly string[];
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
   * `changes` is what the caller knows changed under the root, and **omitting
   * it is not the same as passing an empty array**. An empty array is a caller
   * saying "nothing under the root moved", which is a claim a partial update
   * can be built on; omitting the argument is a caller that does not track
   * changes at all, and the only safe answer to that is to re-extract
   * everything. The distinction is the one honest gap §6.2 leaves open — a
   * change under the root that the caller never reports — made explicit at the
   * one place a caller can see it.
   *
   * The fingerprint is recomputed from disk regardless, because §6.2 makes the
   * session, not its caller, responsible for noticing a tsconfig, an
   * `ambit.config.ts` or an installed dependency that changed.
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
  async update(changes?: readonly FileChange[]): Promise<UpdateResult> {
    if (this.#closed) throw new Error("resident session is closed");
    const started = now();
    try {
      const generation = await runGeneration({
        rootDir: this.#rootDir,
        backend: this.#backend,
        strict: this.#strict,
        projectSession: this.#projectSession,
        generationNumber: this.#store.generation + 1,
        ...(changes === undefined ? {} : { changes }),
        previous: this.#store,
        // A generation that failed left the backend's own baseline one step
        // ahead of the committed store — it built a program the store never
        // adopted. Comparing the next update against that baseline would read
        // a change that happened before the failure as "nothing moved", so the
        // first update after a failure re-extracts everything and re-baselines
        // both layers at once.
        recoveringFromFailure: this.#failure !== undefined,
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
        reextracted: generation.reextracted,
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
  readonly reextracted: readonly string[];
}

interface GenerationInput {
  readonly rootDir: string;
  readonly backend: TsBackend;
  readonly strict: boolean;
  readonly projectSession: TsProjectSession;
  readonly generationNumber: number;
  /**
   * What the caller reported. **Absent means the caller does not report
   * changes**, which forces a full re-extraction; an empty array is a caller
   * asserting that nothing under the root moved.
   */
  readonly changes?: readonly FileChange[];
  /** The committed generation this one follows, or absent for the first check. */
  readonly previous?: ResidentStore;
  /** True when the previous update failed — see `ResidentSession.update`. */
  readonly recoveringFromFailure?: boolean;
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
  const configValueHash = hashConfigValue(loaded);

  const previous = input.previous;
  const plan = planUpdate({
    previous,
    fingerprint,
    configValueHash,
    changes: input.changes,
    recoveringFromFailure: input.recoveringFromFailure ?? false,
    // `ambit.config.ts` is itself a `.ts` file under the root when it sits
    // there, so the extraction has a module record for it like any other file.
    // A caller reporting "nothing under the root moved" while the config's
    // value did is a caller that is right about the code and wrong about the
    // config, so the config's own path is seeded into the closure rather than
    // trusted to the change set.
    configPath: loaded === undefined ? undefined : path.relative(rootDir, loaded.configPath),
  });

  // 2/3. project-update and extraction. The legacy backend separates the two
  //      and reports `projectUpdateMs`; the full-rebuild adapter cannot, and
  //      says so by leaving the field absent (see `PhaseTimings.projectUpdate`).
  const extractionStarted = now();
  const update = await projectSession.update(
    input.changes ?? [],
    plan.kind === "partial" ? plan.reextract : undefined,
  );
  const extractionMs = now() - extractionStarted;

  // 4. Patch or replace. Either way the result is one `files` map in the
  //    backend's own file order, and everything below reads only that — so the
  //    two paths cannot drift apart in what they report, only in what they
  //    recomputed.
  //
  //    Timed under `summarize` rather than under a phase of its own: §6.2 names
  //    the phases and this is not one of them, so it is folded into the phase
  //    it precedes rather than reported as a phase §6.2 does not have.
  const summarizeStarted = now();
  const patched = update.full ? replaceStore(update) : patchStore(previous, plan, update);

  // The same refusal the cold path makes, in the same place and for the same
  // reason: "nothing analyzable was found" must not read as "checked, no
  // violations" (§3.4). Counted over the whole store, not over what this
  // generation re-extracted: a closure with no function in it is ordinary.
  let functionsFound = 0;
  for (const file of patched.extracted) functionsFound += file.functions.length;
  if (functionsFound === 0) {
    throw new Error(`no analyzable functions found under ${rootDir}`);
  }

  // 5. summarize. Every file when the config's value moved — a contract in it
  //    can change any summary and cannot change any resolution, which is
  //    §6.2's "re-summarize every file; extraction untouched". Otherwise only
  //    the files this generation re-extracted, with `matchedConfigKeys` per
  //    file standing in for `ResolvedConfig`'s accumulated state.
  const resummarizeAll = update.full || plan.kind === "full" || plan.resummarizeAll;
  const files = summarizeInto(patched.entries, patched.extracted, resummarizeAll, config);
  const summaries = [...files.values()].flatMap((entry) => entry.summaries);
  const summarizeMs = now() - summarizeStarted;

  // 6. impact. The changed-summary comparison and the reverse-call closure,
  //    including building the new generation's reverse-call graph — that graph
  //    is one of the two the closure is taken over, so its cost belongs here
  //    and not in the store construction below.
  const impactStarted = now();
  const reverseCalls = buildReverseCalls(summaries);
  const scope = previous === undefined ? undefined : scopeOf(previous, summaries, reverseCalls);
  const impactMs = now() - impactStarted;

  // 7. propagate. Scoped to `I` whenever there is a committed generation to
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

  // 8. report. Whole-tree by design (ADR-0014): diagnostics, authority records
  //    and coverage are pure functions of the state with no compiler in them,
  //    and scoping them would buy a fraction of a phase for a second equality
  //    proof.
  //
  //    Every input is read off the patched store rather than off this
  //    generation's `ExtractedUpdate`, because on a partial update the update
  //    holds a closure and the report needs the tree.
  const reportStarted = now();
  const entries = [...files.values()];
  const unmatchedExactKeys = config ? unmatchedFrom(config, files) : [];
  const analysis = buildReport({
    state,
    summaries,
    uncarriedContracts: entries.flatMap((entry) => [...entry.module.uncarriedContracts]),
    runtimeWrappers: entries.flatMap((entry) => [...(entry.extracted?.runtimeWrappers ?? [])]),
    unmatchedExactKeys,
    // `ExtractedFile`s, not modules: `coverage.filesAnalyzed` counts the files
    // that contributed something, which is exactly what an entry's `extracted`
    // being present means.
    filesAnalyzed: entries.filter((entry) => entry.extracted !== undefined).length,
    // Re-summed from the per-file slices rather than taken from a project
    // aggregate: on a partial update there is no project aggregate to take.
    skippedFunctions: sumSkipped(entries.map((entry) => entry.module)),
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
    configValueHash,
    files,
    state,
    // Both graphs are rebuilt from the patched store rather than edited in
    // place. That is the whole of "a re-extracted file's old edges are removed
    // before its new ones are added": there is no edge older than this map.
    // The cost is one walk over data already in memory, and what it buys is
    // that the stale-edge failure — which reads as extra work rather than as a
    // wrong answer, and so survives review — cannot occur at all.
    reverseImports: buildReverseImports(entries.map((entry) => entry.module)),
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
    reextracted: update.modules.map((module) => module.filePath).toSorted(),
  };
}

// ---- deciding what this generation may reuse -------------------------------

/** What {@link planUpdate} decided, and why a partial update is or is not on. */
type UpdatePlan =
  | { readonly kind: "full"; readonly reason: string }
  | {
      readonly kind: "partial";
      /** The reverse-import closure to re-extract, root-relative and sorted. */
      readonly reextract: readonly string[];
      /** Files the caller reported deleted, root-relative. */
      readonly removed: readonly string[];
      /** True when the config's value moved, so every file is re-summarized. */
      readonly resummarizeAll: boolean;
    };

/**
 * The disk-side half of the reuse gate, and the closure a partial update would
 * cover. The backend decides the rest — see {@link TsProjectSession.update}.
 *
 * Every `full` below is a §6.2 invalidation-table row. None of them is an
 * optimization left undone: each is a case where no closure over the edges the
 * store holds can reach the files a change affects, and returning `partial`
 * anyway would leave a stale answer committed (§3.4).
 */
function planUpdate(input: {
  readonly previous: ResidentStore | undefined;
  readonly fingerprint: ProjectFingerprint;
  readonly configValueHash: string | undefined;
  readonly changes: readonly FileChange[] | undefined;
  readonly recoveringFromFailure: boolean;
  /** `ambit.config.ts` relative to the root, when it lies under it. */
  readonly configPath: string | undefined;
}): UpdatePlan {
  const { previous, changes } = input;
  if (previous === undefined) return { kind: "full", reason: "the first generation" };
  if (input.recoveringFromFailure) {
    return { kind: "full", reason: "the previous update failed and left no usable baseline" };
  }
  if (changes === undefined) {
    return { kind: "full", reason: "the caller did not report a change set" };
  }
  if (!fingerprintPermitsExtractionReuse(previous.fingerprint, input.fingerprint)) {
    return { kind: "full", reason: "the project fingerprint does not permit extraction reuse" };
  }

  const changed: string[] = [];
  const removed: string[] = [];
  for (const change of changes) {
    // A file *addition* — and a rename, which is a delete and an add — is the
    // one row §6.2 forces rather than merely prefers. The edges the store holds
    // are resolved import targets, so a specifier that resolved to nothing held
    // no edge at all, and a new file can take a specifier away from an existing
    // candidate that *is* still resolving. Neither importer is reachable from
    // the old graph.
    if (change.kind === "added") {
      return { kind: "full", reason: `${change.path} was added` };
    }
    // A path the store has no entry for is a path no closure can start from: a
    // `.d.ts`, a file outside the root, or a caller reporting something this
    // session never saw.
    if (!previous.files.has(change.path)) {
      return { kind: "full", reason: `${change.path} is not a file this session extracted` };
    }
    if (change.kind === "deleted") removed.push(change.path);
    else changed.push(change.path);
  }

  // The closure is transitive **importers**, taken over the old graph: a change
  // to what a module exports changes how its importers' calls resolve. A
  // deletion is the asymmetric case and is safe over the old graph for the same
  // reason an addition is not — every file whose resolution a deletion can
  // change had a specifier resolving *to* the deleted file, which is exactly an
  // edge the old graph holds.
  const resummarizeAll =
    input.configValueHash === undefined ||
    previous.configValueHash === undefined ||
    input.configValueHash !== previous.configValueHash;
  const seedConfig =
    resummarizeAll && input.configPath !== undefined && previous.files.has(input.configPath)
      ? [input.configPath]
      : [];
  const closure = importerClosure([...changed, ...removed, ...seedConfig], previous.reverseImports);
  const deleted = new Set(removed);
  return {
    kind: "partial",
    reextract: [...closure].filter((file) => !deleted.has(file)).toSorted(),
    removed,
    resummarizeAll,
  };
}

/** `seeds` closed under importers, over the reverse-import graph. A BFS, so a cycle costs nothing. */
function importerClosure(
  seeds: readonly string[],
  reverseImports: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<string> {
  const reached = new Set<string>(seeds);
  const queue = [...seeds];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (current === undefined) continue;
    for (const importer of reverseImports.get(current) ?? []) {
      if (reached.has(importer)) continue;
      reached.add(importer);
      queue.push(importer);
    }
  }
  return reached;
}

// ---- building the generation's file map ------------------------------------

/**
 * The per-file records this generation will report from, before summarization.
 *
 * `entries` is in the backend's file order and `extracted` is the same order
 * restricted to the files that contributed something — the two orders a cold
 * run produces, which is what §6.2's byte equivalence is over.
 */
interface PatchedFiles {
  readonly entries: ReadonlyMap<string, PatchedEntry>;
  readonly extracted: readonly ExtractedFile[];
}

/**
 * One file's extraction for this generation, before it is summarized.
 *
 * {@link committed} is the previous generation's entry, present only where this
 * file survived a partial update untouched — which is exactly the condition for
 * reusing its summaries. Carried as its own field rather than inferred from the
 * shape: "does this object already have summaries" is a question a structural
 * test answers by accident, and the answer decides whether a contract is
 * re-derived.
 */
interface PatchedEntry {
  readonly module: ExtractedModule;
  readonly extracted?: ExtractedFile;
  readonly committed?: FileEntry;
}

/** A whole project: the store is replaced, not patched. */
function replaceStore(update: ExtractedUpdate): PatchedFiles {
  const extractedByPath = new Map(update.files.map((file) => [file.filePath, file] as const));
  const entries = new Map<string, PatchedEntry>();
  for (const module of update.modules) {
    const extracted = extractedByPath.get(module.filePath);
    entries.set(module.filePath, { module, ...(extracted ? { extracted } : {}) });
  }
  return { entries, extracted: update.files };
}

/**
 * A partial update applied to the committed generation's file map.
 *
 * Two things make this safe, and both are checks rather than conventions:
 *
 * - **The backend's answer is cross-checked against what was asked.** A backend
 *   that re-extracted fewer files than the closure named would leave entries
 *   the caller believed were refreshed, and every one of them would be a stale
 *   answer served as a fresh one (§3.4). A mismatch throws, and a throw commits
 *   nothing.
 * - **Entries are replaced in place, never removed and re-added.** `Map.set` on
 *   an existing key keeps its position, so the file order a partial update
 *   leaves behind is the order a whole one would.
 */
function patchStore(
  previous: ResidentStore | undefined,
  plan: UpdatePlan,
  update: ExtractedUpdate,
): PatchedFiles {
  if (previous === undefined || plan.kind !== "partial") {
    throw new Error(
      "the backend reported a partial update for a generation that asked for a whole project",
    );
  }
  const asked = new Set(plan.reextract);
  const got = new Set(update.modules.map((module) => module.filePath));
  if (asked.size !== got.size || [...asked].some((file) => !got.has(file))) {
    throw new Error(
      `the backend re-extracted a different set of files than the closure named: asked for ${[...asked].toSorted().join(", ") || "(none)"}, got ${[...got].toSorted().join(", ") || "(none)"}`,
    );
  }
  const removed = new Set(update.removed);
  const expectedRemoved = new Set(plan.removed);
  if (removed.size !== expectedRemoved.size || [...expectedRemoved].some((f) => !removed.has(f))) {
    throw new Error(
      `the backend removed a different set of files than the caller deleted: expected ${[...expectedRemoved].toSorted().join(", ") || "(none)"}, got ${[...removed].toSorted().join(", ") || "(none)"}`,
    );
  }

  const extractedByPath = new Map(update.files.map((file) => [file.filePath, file] as const));
  const entries = new Map<string, PatchedEntry>();
  for (const [filePath, entry] of previous.files) {
    if (removed.has(filePath)) continue;
    if (!asked.has(filePath)) {
      entries.set(filePath, { ...entry, committed: entry });
      continue;
    }
    // Re-extracted. The new `ExtractedFile` may be absent — a file whose last
    // function was just deleted still has a module record and still has import
    // edges — so the old one is dropped rather than kept.
    const module = update.modules.find((candidate) => candidate.filePath === filePath);
    if (module === undefined) throw new Error(`no module record for re-extracted ${filePath}`);
    const extracted = extractedByPath.get(filePath);
    entries.set(filePath, { module, ...(extracted ? { extracted } : {}) });
  }
  return {
    entries,
    extracted: [...entries.values()]
      .map((entry) => entry.extracted)
      .filter((file): file is ExtractedFile => file !== undefined),
  };
}

/**
 * Attach each file's summaries and matched config keys.
 *
 * `all` re-summarizes every file in the store from the extraction it already
 * holds — §6.2's config row, where extraction is untouched and every contract
 * is re-derived. Otherwise only the files this generation re-extracted move,
 * and the rest keep the summaries they committed.
 *
 * This is the first thing that makes `FileEntry.matchedConfigKeys`
 * load-bearing: a generation that summarizes a subset cannot ask
 * `ResolvedConfig.unmatchedExactKeys()`, whose answer is only correct after a
 * whole project has been looked up through that one object.
 */
function summarizeInto(
  entries: ReadonlyMap<string, PatchedEntry>,
  extracted: readonly ExtractedFile[],
  all: boolean,
  config: ResolvedConfig | undefined,
): ReadonlyMap<string, FileEntry> {
  const resummarized = all
    ? extracted
    : extracted.filter((file) => entries.get(file.filePath)?.committed === undefined);
  const { summaries, matchedConfigKeys } = summarizeFiles(resummarized, config);
  const summariesByPath = new Map<string, readonly FunctionSummary[]>();
  for (const summary of summaries) {
    const file = summary.id.slice(0, summary.id.indexOf("#"));
    // Replaced rather than pushed into: a `push` onto a value that came back
    // from `Map.get` is a mutation Ambit cannot follow to a local allocation,
    // so it reads as an escaping `state_write` this function does not declare.
    summariesByPath.set(file, [...(summariesByPath.get(file) ?? []), summary]);
  }

  const files = new Map<string, FileEntry>();
  for (const [filePath, entry] of entries) {
    if (!all && entry.committed !== undefined) {
      files.set(filePath, entry.committed);
      continue;
    }
    files.set(filePath, {
      module: entry.module,
      ...(entry.extracted ? { extracted: entry.extracted } : {}),
      summaries: summariesByPath.get(filePath) ?? [],
      matchedConfigKeys: matchedConfigKeys.get(filePath) ?? [],
    });
  }
  return files;
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
  files: ReadonlyMap<string, FileEntry>,
): readonly string[] {
  const matched = new Set<string>();
  for (const entry of files.values()) {
    for (const key of entry.matchedConfigKeys) matched.add(key);
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
