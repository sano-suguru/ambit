/**
 * One root through both backends, compared — the single path
 * `scripts/shadow-analysis.ts` (a report to read) and `scripts/shadow-check.ts`
 * (a gate to fail) both take.
 *
 * Shared rather than duplicated because the two must never drift: a gate that
 * runs the pipeline slightly differently from the report is a gate that passes
 * on a number nobody published.
 */

import {
  legacyTsBackend,
  loadConfig,
  resolveConfig,
  summarizeExtractedFiles,
} from "../../src/checker/index.ts";
import { analyze } from "../../src/cli/analyze.ts";
import type { TsBackend } from "../../src/core/index.ts";
import { compareFacts, type ShadowReport } from "./compare.ts";
import { lastDeclinedReasons, NOT_PORTED, nativeTs7Backend } from "./native-ts7-backend.ts";
import { buildFacts, type ShadowFacts } from "./normalize.ts";

export interface RunError {
  readonly backend: string;
  readonly phase: string;
  readonly message: string;
}

export interface RunOutcome {
  readonly facts?: ShadowFacts;
  readonly error?: RunError;
}

/**
 * One backend through the whole pipeline, timed.
 *
 * The extraction is run twice — once for the raw facts, once inside
 * `analyze()` — because `analyze()` owns the config loading and the diagnostic
 * assembly, and reaching inside it to reuse one extraction would mean the
 * shadow run and a real `ambit check` no longer take the same path.
 *
 * Only the `analyze()` call is timed. The facts extraction is the shadow
 * harness's own cost and is not part of what `ambit check` does, so including
 * it would report a duration no product path pays.
 */
export async function run(label: string, backend: TsBackend, dir: string): Promise<RunOutcome> {
  try {
    const project = await backend.extractProject(dir);
    const loaded = await loadConfig(dir);
    const config = loaded ? resolveConfig(loaded, dir) : undefined;
    const summaries = summarizeExtractedFiles(project.files, config);
    const started = performance.now();
    const analysis = await analyze(dir, { backend });
    const durationMs = performance.now() - started;
    return {
      facts: buildFacts({
        backend: { name: backend.name, version: backend.version },
        durationMs,
        project,
        summaries,
        analysis,
      }),
    };
  } catch (error) {
    return {
      error: {
        backend: label,
        phase: "analyze",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Both backends over one root, compared.
 *
 * `selfCheck` puts the *adopted* backend on both sides. It must report zero
 * divergences; anything else is a bug in the comparison rather than in either
 * compiler, and it is the cheapest way to find one.
 *
 * Returns the errors rather than throwing on them: a side that did not run is
 * not a parity of zero divergences (DESIGN.md §3.4), and the caller decides
 * how loudly to say so.
 */
export async function compareRoot(
  dir: string,
  selfCheck: boolean,
): Promise<{ readonly report?: ShadowReport; readonly errors: readonly RunError[] }> {
  const shadowBackend: TsBackend = selfCheck ? legacyTsBackend : nativeTs7Backend;
  const authorityRun = await run("authority", legacyTsBackend, dir);
  const shadowRun = await run("shadow", shadowBackend, dir);
  // Read immediately after the shadow extraction, and only when the shadow
  // side *is* the native backend — on a self-check both sides are the adopted
  // one and nothing declines.
  const shadowDeclined = selfCheck ? undefined : lastDeclinedReasons();

  const errors = [authorityRun.error, shadowRun.error].filter((e) => e !== undefined);
  if (!authorityRun.facts || !shadowRun.facts) return { errors };

  return {
    report: compareFacts({
      root: dir,
      authority: authorityRun.facts,
      shadow: shadowRun.facts,
      notPorted: selfCheck ? [] : NOT_PORTED,
      ...(shadowDeclined ? { shadowDeclined } : {}),
      errors,
    }),
    errors,
  };
}

export type { ShadowFacts };
