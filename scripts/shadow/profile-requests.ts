/**
 * Where the native backend's extraction time goes, and how much of it is the
 * compiler rather than the boundary in front of it.
 *
 *     node scripts/shadow/profile-requests.ts <dir> [--runs <n>] [--json <path>]
 *
 *     node scripts/shadow/profile-requests.ts src
 *
 * `docs/measurements/2026-09-12-ts7-shadow-analysis.md` recorded that the
 * native engine is ~1.8x faster here where ADR-0001's probe measured 3–4x,
 * that Ambit's pure-JavaScript downstream is *not* the cause (extraction alone
 * shows the same factor), and that the remaining reading — per-query transport
 * cost rising with query count — was **a hypothesis with no number attached**.
 * AGENTS.md forbids naming a cause without one, so this collects the number.
 *
 * The experiment is a within-engine one, and deliberately so. Both sides run
 * the *native* compiler over the same tree:
 *
 * - **ADR-0001's probe** (`scripts/m05-probe/native.ts`) walks each file once
 *   and resolves each callee — four queries per call site at most.
 * - **the shadow backend** asks for types, signatures, symbol parents,
 *   declaration handles and their resolutions, many times per call site.
 *
 * If the hypothesis holds, the second makes far more requests per call site
 * and spends a far larger share of its time outside the compiler. One engine,
 * one tree, one variable: how much is asked.
 *
 * A cross-engine version of the same profile is not available and the reason
 * is recorded rather than worked around: `typescript@6.0.3` exports
 * `createProgram` as a **non-configurable getter**, on the CommonJS exports
 * object and through Node's ESM bridge alike, so the adopted backend's checker
 * cannot be wrapped from outside. Counting its calls would take a profiling
 * seam inside `src/checker/backend/legacy-ts.ts`, and the backend is the
 * product — a measurement does not get to live in it. The legacy side is
 * therefore timed here and not counted.
 *
 * A profiled run is slower than an unprofiled one. Wall-clock numbers for a
 * parity report come from `scripts/shadow-analysis.ts`, which profiles
 * nothing.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { legacyTsBackend } from "../../src/checker/index.ts";
import type { ExtractedProject } from "../../src/core/index.ts";
import { loadAst, loadAstIs, loadSyncApi } from "../m05-probe/native-compiler.ts";
import { CONTRACT_TAGS, emptyCounts } from "../m05-probe/shared.ts";
import { extractProjectTimed, type NativeTimingTotals } from "./native-ts7-backend.ts";

interface Subject {
  readonly functions: number;
  readonly callSites: number;
}

function subjectOf(project: ExtractedProject): Subject {
  let functions = 0;
  let callSites = 0;
  for (const file of project.files) {
    functions += file.functions.length;
    for (const fn of file.functions) callSites += fn.calls.length;
  }
  return { functions, callSites };
}

interface NativeRun {
  readonly label: string;
  readonly ms: number;
  readonly subject: Subject;
  readonly totals: NativeTimingTotals;
  /** Checker/program calls the walk made, `undefined` where they were not counted. */
  readonly callsByMethod: ReadonlyMap<string, number> | undefined;
}

async function runShadowBackend(root: string): Promise<NativeRun> {
  const started = performance.now();
  const { project, profile } = await extractProjectTimed(root, true);
  const ms = performance.now() - started;
  if (!profile) throw new Error("the native backend returned no profile");
  return {
    label: "shadow backend",
    ms,
    subject: subjectOf(project),
    totals: profile.totals,
    callsByMethod: profile.callsByMethod,
  };
}

/**
 * ADR-0001's own walk, re-run here rather than quoted: its recorded numbers
 * come from a different machine and a different day, and a comparison between
 * a measured side and a remembered one is not a comparison.
 *
 * The body mirrors `scripts/m05-probe/native.ts` — one pass per file, one
 * symbol lookup, one alias hop, one handle resolution, one file
 * classification per call site — and nothing else.
 */
async function runAdr0001Probe(root: string): Promise<NativeRun> {
  const { API, SymbolFlags } = await loadSyncApi();
  const { getJSDocTags } = await loadAst();
  const is = await loadAstIs();
  const absoluteRoot = path.resolve(root);
  const configPath = findConfigFile(absoluteRoot);

  const started = performance.now();
  const api = new API({ cwd: path.dirname(configPath), collectTiming: true });
  try {
    const project = api.updateSnapshot({ openProjects: [configPath] }).getProjects()[0];
    if (!project) throw new Error(`no project opened for ${absoluteRoot}`);
    const { program, checker } = project;
    const counts = emptyCounts();

    // biome-ignore lint/suspicious/noExplicitAny: the compiler's own types are not available here
    type Node = any;
    const isFunctionLike = (node: Node): boolean =>
      is.isFunctionDeclaration(node) ||
      is.isMethodDeclaration(node) ||
      is.isArrowFunction(node) ||
      is.isFunctionExpression(node) ||
      is.isConstructorDeclaration(node) ||
      is.isGetAccessorDeclaration(node) ||
      is.isSetAccessorDeclaration(node);

    for (const fileName of program.getSourceFileNames()) {
      if (!fileName.startsWith(absoluteRoot)) continue;
      const sourceFile = program.getSourceFile(fileName);
      if (!sourceFile || sourceFile.isDeclarationFile) continue;
      const visit = (node: Node): void => {
        if (isFunctionLike(node)) {
          counts.functions++;
          for (const tag of getJSDocTags(node)) {
            if (tag.tagName && CONTRACT_TAGS.has(tag.tagName.text)) counts.contractTags++;
          }
        }
        if (is.isCallExpression(node)) {
          counts.calls++;
          const symbol = checker.getSymbolAtLocation(node.expression);
          const isAlias = symbol !== undefined && (symbol.flags & SymbolFlags.Alias) !== 0;
          const resolved = isAlias && symbol ? checker.getAliasedSymbol(symbol) : symbol;
          const declaration = resolved?.declarations?.[0]?.resolve(project);
          if (declaration) {
            const file = declaration.getSourceFile();
            if (program.isSourceFileDefaultLibrary(file)) counts.defaultLib++;
            else if (program.isSourceFileFromExternalLibrary(file)) counts.external++;
            else counts.local++;
          }
        }
        node.forEachChild(visit);
      };
      sourceFile.forEachChild(visit);
    }

    const info = api.getTimingInfo();
    if (!info?.enabled) throw new Error("the probe API reports timing disabled");
    const t = info.totals;
    return {
      label: "ADR-0001 probe",
      ms: performance.now() - started,
      subject: { functions: counts.functions, callSites: counts.calls },
      totals: {
        requestCount: t.requestCount,
        roundTripMs: t.roundTripMs,
        serverTimeMs: t.serverTimeMs,
        transportOverheadMs: t.transportOverheadMs,
        bytesSent: t.bytesSent,
        bytesReceived: t.bytesReceived,
        nodesMaterialized: t.nodesMaterialized ?? 0,
        sourceFilesFetched: t.sourceFilesFetched ?? 0,
        nodesFetched: t.nodesFetched ?? 0,
      },
      callsByMethod: undefined,
    };
  } finally {
    api.close();
  }
}

/** The same upward search both backends do; duplicated here so the probe opens the same project. */
function findConfigFile(from: string): string {
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no tsconfig.json found from ${from}`);
    dir = parent;
  }
}

function renderRun(run: NativeRun): string[] {
  const t = run.totals;
  const perCall = run.subject.callSites === 0 ? 0 : t.requestCount / run.subject.callSites;
  const transportShare = t.roundTripMs === 0 ? 0 : (100 * t.transportOverheadMs) / t.roundTripMs;
  const lines = [
    `  ${run.label}`,
    `    subject                ${run.subject.functions} functions, ${run.subject.callSites} call sites`,
    `    wall clock (profiled)  ${Math.round(run.ms)} ms`,
    `    requests               ${t.requestCount.toLocaleString("en-US")}  (${perCall.toFixed(1)} per call site)`,
    `    round trip             ${t.roundTripMs.toFixed(0)} ms = server ${t.serverTimeMs.toFixed(0)} ms + transport ${t.transportOverheadMs.toFixed(0)} ms`,
    `    transport share        ${transportShare.toFixed(1)}%`,
    `    bytes                  sent ${t.bytesSent.toLocaleString("en-US")}, received ${t.bytesReceived.toLocaleString("en-US")}`,
    `    nodes materialized     ${t.nodesMaterialized.toLocaleString("en-US")} of ${t.nodesFetched.toLocaleString("en-US")} fetched (${t.sourceFilesFetched} source files)`,
  ];
  if (run.callsByMethod) {
    const total = [...run.callsByMethod.values()].reduce((a, b) => a + b, 0);
    lines.push(`    checker/program calls  ${total.toLocaleString("en-US")}`);
    for (const [method, count] of [...run.callsByMethod].toSorted((a, b) => b[1] - a[1])) {
      lines.push(`      ${String(count).padStart(8)}  ${method}`);
    }
  }
  return lines;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const root = argv.find((arg) => !arg.startsWith("--"));
  if (!root) {
    process.stderr.write(
      "usage: node scripts/shadow/profile-requests.ts <dir> [--runs <n>] [--json <path>]\n",
    );
    return 2;
  }
  const runsFlag = argv.indexOf("--runs");
  const runs = Math.max(1, runsFlag === -1 ? 3 : Number(argv[runsFlag + 1] ?? 3));
  const jsonFlag = argv.indexOf("--json");
  const jsonPath = jsonFlag === -1 ? undefined : argv[jsonFlag + 1];

  const legacyMs: number[] = [];
  const shadowRuns: NativeRun[] = [];
  const probeRuns: NativeRun[] = [];
  for (let run = 0; run < runs; run++) {
    const started = performance.now();
    await legacyTsBackend.extractProject(root);
    legacyMs.push(performance.now() - started);
    shadowRuns.push(await runShadowBackend(root));
    probeRuns.push(await runAdr0001Probe(root));
  }
  const shadow = shadowRuns[shadowRuns.length - 1];
  const probe = probeRuns[probeRuns.length - 1];
  if (!shadow || !probe) throw new Error("no run completed");

  const out: string[] = [];
  out.push(`# native extraction request profile — ${root}`);
  out.push(`  runs: ${runs}; the native side is profiled, so these times are not parity times`);
  out.push("");
  out.push("## wall clock");
  out.push(`  ts6 (adopted, unprofiled)  ${legacyMs.map((ms) => Math.round(ms)).join("/")} ms`);
  out.push(`  ts7 shadow backend         ${shadowRuns.map((r) => Math.round(r.ms)).join("/")} ms`);
  out.push(`  ts7 ADR-0001 probe         ${probeRuns.map((r) => Math.round(r.ms)).join("/")} ms`);
  out.push("");
  out.push("## one engine, one tree, one variable: how much is asked");
  out.push(...renderRun(probe));
  out.push("");
  out.push(...renderRun(shadow));
  out.push("");
  const perCallProbe =
    probe.subject.callSites === 0 ? 0 : probe.totals.requestCount / probe.subject.callSites;
  const perCallShadow =
    shadow.subject.callSites === 0 ? 0 : shadow.totals.requestCount / shadow.subject.callSites;
  out.push("## the comparison");
  out.push(
    `  requests per call site   probe ${perCallProbe.toFixed(1)}  →  backend ${perCallShadow.toFixed(1)}  (${perCallProbe === 0 ? "n/a" : `${(perCallShadow / perCallProbe).toFixed(1)}x`})`,
  );
  out.push(
    `  server time              probe ${probe.totals.serverTimeMs.toFixed(0)} ms  →  backend ${shadow.totals.serverTimeMs.toFixed(0)} ms`,
  );
  out.push(
    `  transport time           probe ${probe.totals.transportOverheadMs.toFixed(0)} ms  →  backend ${shadow.totals.transportOverheadMs.toFixed(0)} ms`,
  );
  process.stdout.write(`${out.join("\n")}\n`);

  if (jsonPath) {
    const resolved = path.resolve(jsonPath);
    mkdirSync(path.dirname(resolved), { recursive: true });
    const serialize = (run: NativeRun): unknown => ({
      ...run,
      callsByMethod: run.callsByMethod ? Object.fromEntries(run.callsByMethod) : null,
    });
    writeFileSync(
      resolved,
      `${JSON.stringify(
        {
          schema: "ambit-native-request-profile/1",
          root,
          runs,
          legacyMs,
          shadow: shadowRuns.map(serialize),
          probe: probeRuns.map(serialize),
        },
        null,
        2,
      )}\n`,
    );
  }
  return 0;
}

process.exitCode = await main();
