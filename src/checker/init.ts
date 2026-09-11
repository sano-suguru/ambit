import path from "node:path";
import type {
  Call,
  Diagnostic,
  DiagnosticEngine,
  DiagnosticFix,
  FixEdit,
  KnownEffect,
  MutationCall,
  SymbolId,
  UnresolvedCall,
  UnresolvedReason,
} from "../core/index.ts";
import { callLeavesUnknown, KNOWN_EFFECTS } from "../core/index.ts";
import type { PropagatedFunction } from "./propagate.ts";

/**
 * Where `ambit init --config` writes: the config file `ambit check` would
 * load, its current text, and the analysis root every {@link SymbolId}'s file
 * half is relative to.
 *
 * The root is needed because the two are written against different bases —
 * a symbol id is relative to `check <dir>`, a `contracts` key is relative to
 * the config file (DESIGN.md §4.1 (c)) — and a patch that ignored the
 * difference would propose a key that names nothing.
 */
export interface ConfigTarget {
  /** The config file as the output names it — root-relative when it is under the root. */
  readonly path: string;
  readonly source: string;
  readonly rootDir: string;
}

/**
 * `ambit init`'s analysis half (DESIGN.md §4.1: "`ambit init` infers the
 * effects of existing code from the evidence in 4.2 and emits JSDoc additions
 * as fix candidates in diagnostics (chapter 5, `fixes[].edits`)").
 *
 * For every function that has no `@effects` tag and whose propagated effect
 * set is fully known, emit an `AMB-I001` info diagnostic carrying one
 * applicable patch that adds the tag.
 *
 * The `unknown` guard is the whole point. A function whose effects could not
 * be resolved gets **no** proposal: writing `@effects pure` on it would turn
 * "we could not tell" into a declared guarantee, which is precisely what §4.3
 * says `unknown` exists to prevent. Those functions stay undeclared and keep
 * showing up in `--coverage`, exactly as §4.1 says they should.
 *
 * What they no longer get is silence. Where such a function holds an
 * unresolvable call in its own body, an `AMB-I002` reports those calls and
 * what each reason implies — see {@link unresolvedReport}. It carries no
 * `fixes`: reporting why a contract cannot be written is not proposing one.
 *
 * Nothing here writes to disk. The proposals are diagnostics, so the same
 * NDJSON an agent already consumes carries them, and applying them is the
 * caller's decision.
 */
export function proposeContracts(
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
  engine: DiagnosticEngine,
  configTarget?: ConfigTarget,
): readonly Diagnostic[] {
  const proposals: Diagnostic[] = [];

  for (const propagated of state.values()) {
    const { summary } = propagated;
    if (summary.declared.kind !== "none") continue;
    // A boundary's body was never analyzed, so there is nothing inferred to
    // propose — and proposing the empty set would be the worst possible
    // suggestion for a function that exists to hide something.
    if (summary.boundary.kind === "declared") continue;
    if (propagated.observed.unknown) {
      // No contract, and none can be proposed — but staying silent about
      // *why* leaves the reader with nothing at all. AMB-I002 reports the
      // calls that stopped the inference, for the functions that hold one.
      const blockers = summary.calls.filter(isBlocking);
      if (blockers.length > 0) proposals.push(unresolvedReport(propagated, blockers, engine));
      continue;
    }

    const effects = KNOWN_EFFECTS.filter((effect) => propagated.observed.effects.has(effect));
    const tag = `@effects ${effects.length === 0 ? "pure" : effects.join(", ")}`;

    // Declarations no JSDoc comment can carry: an accessor or an anonymous
    // default export (DESIGN.md §4.1 (a)), and a class that writes no
    // constructor (its construction has a declaration path and no declaration
    // site at all). All three have a stable symbol id, so `ambit.config.ts`
    // can name them — which is what `--config` proposes.
    if (summary.configOnly || summary.implicitConstructor) {
      const edit = configTarget ? configEdit(configTarget, summary.id, effects) : undefined;
      proposals.push(
        proposal(
          propagated,
          effects,
          configProposalMessage(summary, effects, tag, configTarget, edit !== undefined),
          edit
            ? [
                {
                  rank: 1,
                  kind: "narrow",
                  summary: `Declare [${effects.join(", ") || "no effects"}] for ${displayName(summary.id)} in ${configTarget?.path ?? "ambit.config.ts"}`,
                  confidence: 1,
                  consistentWithContract: true,
                  edits: [edit],
                },
              ]
            : [],
        ),
      );
      continue;
    }

    const edit = contractEdit(propagated, tag);
    if (!edit) continue;

    proposals.push(
      proposal(
        propagated,
        effects,
        `${displayName(summary.id)} has no @effects; its observed effects are [${effects.join(", ") || "none"}]`,
        [
          {
            rank: 1,
            kind: "narrow",
            summary: `Declare ${tag} on ${displayName(summary.id)}`,
            confidence: 1,
            // Adding a declaration where there was none cannot contradict a
            // contract that does not exist, and the set proposed is exactly
            // what was observed — so this neither loosens nor tightens.
            consistentWithContract: true,
            edits: [edit],
          },
        ],
      ),
    );
  }

  return proposals;

  function proposal(
    propagated: PropagatedFunction,
    effects: readonly KnownEffect[],
    message: string,
    fixes: readonly DiagnosticFix[],
  ): Diagnostic {
    return {
      id: "AMB-I001",
      severity: "info",
      category: "effects",
      message,
      location: propagated.summary.location,
      contract: { declared: [], observed: effects, via: [] },
      fixes,
      docs: "docs/diagnostics/README.md#amb-i001",
      engine,
    };
  }
}

/**
 * `AMB-I002`: an undeclared function whose own body holds a call that could
 * not be resolved, so `AMB-I001` cannot propose anything for it.
 *
 * The §4.1 prohibition is unchanged — nothing is proposed and `fixes` is
 * empty. What changes is that the reason is no longer silent. A reader gets
 * the call sites that stopped the inference and, for each, the route its
 * reason implies (`docs/diagnostics/README.md#amb-i002`).
 *
 * Only functions that hold a blocking call **themselves** are reported. One
 * that merely inherited `unknown` from a callee is left alone: the callee is
 * where the work is, and it gets its own diagnostic there — reporting both
 * would say the same thing once per caller.
 *
 * There are no `fixes` because there is no patch. Every route here is either
 * a decision only a person can make (isolate this behind a boundary, annotate
 * this value) or work on Ambit itself (a missing stub). DESIGN.md §5.3 defines
 * `fixes[].edits` as concrete applicable patches, and a candidate that only
 * describes what to do is exactly what it forbids
 * ([ADR-0011](../../docs/adr/0011-reporting-why-a-contract-cannot-be-proposed.md)).
 */
function unresolvedReport(
  propagated: PropagatedFunction,
  blockers: readonly BlockingCall[],
  engine: DiagnosticEngine,
): Diagnostic {
  const { summary } = propagated;
  const lines = blockers.map((call) => {
    const reason = reasonOf(call);
    // The name is what the stub tables would key on, and a great many
    // unresolved calls have none — a callback parameter, an `any` receiver,
    // `eval`. Those lead with the location rather than with a placeholder
    // standing in for a name that does not exist (DESIGN.md §5.3).
    const named = call.qualifiedName ? `${call.qualifiedName} ` : "";
    return `${named}(${call.location.file}:${call.location.line}) ${reason}: ${ROUTES[reason]}`;
  });
  const count = `${blockers.length} call${blockers.length === 1 ? "" : "s"}`;
  return {
    id: "AMB-I002",
    severity: "info",
    category: "effects",
    message: [
      `${displayName(summary.id)} has no @effects and none can be proposed: ${count} in its own body could not be resolved`,
      ...lines,
    ].join("\n"),
    location: summary.location,
    // No `contract`. `EffectsContract.observed` has no spelling for
    // `unknown`, so listing the effects resolved so far would read as the
    // complete set — the one thing this diagnostic exists to deny.
    fixes: [],
    docs: "docs/diagnostics/README.md#amb-i002",
    engine,
  };
}

/**
 * What a blocking call is called in the report.
 *
 * A mutator handed a callback by reference (`xs.sort(cmp)`) is not an
 * `UnresolvedCall` and has no {@link UnresolvedReason}, but it makes the
 * caller `unknown` for the same reason `callback-parameter` does — the actual
 * argument is what decides (§4.2 rule 4) — so it is labelled in the same
 * namespace rather than left out of the report.
 */
type BlockingReason = UnresolvedReason | "callback-by-reference";

/**
 * The two call kinds `callLeavesUnknown` accepts, as a type. Written as a
 * predicate over that function rather than as a second condition, so the set
 * this reports on and the set `propagate` derives `unknown` from cannot drift
 * apart.
 */
type BlockingCall = UnresolvedCall | MutationCall;

function isBlocking(call: Call): call is BlockingCall {
  return callLeavesUnknown(call);
}

function reasonOf(call: BlockingCall): BlockingReason {
  return call.kind === "unresolved" ? call.reason : "callback-by-reference";
}

/**
 * The route each reason implies. Written as what the reason *is*, not as a
 * recommendation: three of them are not the reader's work at all, and the one
 * that is a choice — isolating a third-party call behind `@boundary` — is
 * named with the accounting §4.3 gives it, because a boundary is tallied
 * separately from succeeding at analysis and Ambit must not sell it as
 * progress (ADR-0011).
 *
 * Typed as a total record so a new {@link UnresolvedReason} cannot be added
 * without deciding what to say about it.
 */
const ROUTES: Readonly<Record<BlockingReason, string>> = {
  "external-module":
    'declared in a package under node_modules — a stub for that package resolves it, or `@boundary reason="<package>"` isolates it, which --coverage tallies separately from analysis (§4.3)',
  "import-binding":
    'an import binding that follows to no declaration — check the module specifier and the named export first; if the module is third-party, a stub resolves it, or `@boundary reason="<package>"` isolates it, tallied separately (§4.3)',
  "ambient-declaration":
    'declared in a .d.ts belonging to this project — a contract written on that declaration resolves it, or `@boundary reason="<package>"` isolates it, tallied separately (§4.3)',
  "builtin-method":
    "a TypeScript default-lib method Ambit's own bundled tables do not name — a gap in Ambit, not in this codebase; report the name",
  "callback-parameter":
    "a callback parameter: §4.2 rule 4 infers its effects from the actual argument at each call site, so this is decided by the callers, not here",
  "callback-by-reference":
    "a callback passed to a mutator by reference: §4.2 rule 4 infers its effects from the actual argument, so this is decided by the callers, not here",
  "any-typed":
    "the callee's type is `any`, so nothing identifies it (§4.2 rule 6) — a type annotation on that value restores the call",
  "dynamic-import": "dynamic `import()`: not analyzable by design (§4.2 rule 6)",
  eval: "`eval`: not analyzable by design (§4.2 rule 6)",
  "new-function": "`new Function`: not analyzable by design (§4.2 rule 6)",
  "overload-without-body":
    'reaches a declaration with no implementation in the project (§4.1 "Overloads and bodyless declarations") — the body is elsewhere, so there is nothing to propagate from',
  "unresolved-symbol":
    "no single declaration Ambit can follow — a nested function, or a receiver with no one object literal certainly behind it (§4.2 rule 7)",
};

/**
 * The patch that adds `tag`: a new line inside the existing JSDoc block when
 * there is one, or a fresh single-line block above the declaration when there
 * is not. Both are inserts (a zero-width range), so nothing existing is
 * overwritten.
 */
function contractEdit(propagated: PropagatedFunction, tag: string): FixEdit | undefined {
  const { summary } = propagated;
  const indent = " ".repeat(Math.max(0, summary.declarationStart.col - 1));
  const comment = summary.jsDocRange;

  if (comment) {
    // Insert the tag on its own line just before the block's closing `*/`,
    // which is the last two characters of the block.
    const closingCol = comment.endCol - 2;
    if (closingCol < 1) return undefined;
    // A one-line block (`/** text *​/`) has to become multi-line to hold a
    // tag on its own line; a multi-line one is already sitting at the start
    // of a `*`-prefixed line, so it only needs the line itself.
    const singleLine = comment.line === comment.endLine;
    const replacement = singleLine ? `\n${indent} * ${tag}\n${indent} ` : `* ${tag}\n${indent} `;
    return {
      file: comment.file,
      range: [
        [comment.endLine - 1, closingCol - 1],
        [comment.endLine - 1, closingCol - 1],
      ],
      replacement,
    };
  }

  return {
    file: summary.declarationStart.file,
    range: [
      [summary.declarationStart.line - 1, summary.declarationStart.col - 1],
      [summary.declarationStart.line - 1, summary.declarationStart.col - 1],
    ],
    replacement: `/** ${tag} */\n${indent}`,
  };
}

/**
 * What a config-only proposal says, which depends on how far the command can
 * actually get: `--config` with a config file present produces a patch; every
 * other combination produces the reason there is none. Never silence — the
 * effects are real, and P4 forbids hiding what cannot be declared.
 */
function configProposalMessage(
  summary: PropagatedFunction["summary"],
  effects: readonly KnownEffect[],
  tag: string,
  configTarget: ConfigTarget | undefined,
  hasEdit: boolean,
): string {
  const what = `${displayName(summary.id)} runs [${effects.join(", ") || "no effects"}]`;
  if (hasEdit) return `${what} and has no declaration; add it to ${configTarget?.path}`;
  if (summary.implicitConstructor && configTarget === undefined) {
    return `${what} but has no constructor to declare them on; write an explicit constructor to carry ${tag}, or declare "${summary.id}" in ambit.config.ts (ambit init --config)`;
  }
  if (configTarget === undefined) {
    return `${what} and cannot carry a JSDoc contract; declare "${summary.id}" in ambit.config.ts (ambit init --config)`;
  }
  return `${what} and cannot carry a JSDoc contract; ${configTarget.path} has no \`contracts\` block to append "${summary.id}" to`;
}

/**
 * The patch that appends one `contracts` entry to an existing config file.
 *
 * Inserted at the end of the `contracts: {` line, so the edit is a single
 * line's insertion into text this command did not parse — the config was
 * loaded by importing it, not by building an AST, and guessing where the
 * block *ends* would mean matching braces in a file that may contain any
 * expression. `undefined` when there is no such line: §5.3 forbids emitting a
 * candidate that does not apply.
 *
 * The key is rebased from the analysis root to the config file's directory
 * (§4.1 (c)).
 */
function configEdit(
  target: ConfigTarget,
  id: SymbolId,
  effects: readonly KnownEffect[],
): FixEdit | undefined {
  const lines = target.source.split("\n");
  const pattern = /(?:^|[^A-Za-z0-9_$])contracts\s*:\s*\{/;
  const index = lines.findIndex((line) => pattern.test(line));
  const line = lines[index];
  if (index < 0 || line === undefined) return undefined;
  const opening = pattern.exec(line);
  if (!opening) return undefined;

  // Inserted immediately after the `{`, not at the end of the line: a
  // formatter collapses an empty block to `contracts: {},` and appending
  // after that line's text would put the entry outside the object.
  const column = opening.index + opening[0].length;
  const indent = " ".repeat(line.length - line.trimStart().length + 2);
  const key = configKeyFor(target, id);
  const value = `{ effects: [${effects.map((effect) => `"${effect}"`).join(", ")}] }`;
  return {
    file: target.path,
    range: [
      [index, column],
      [index, column],
    ],
    replacement: `\n${indent}"${key}": ${value},`,
  };
}

/** A symbol id rebased onto the config file's directory (DESIGN.md §4.1 (c)). */
function configKeyFor(target: ConfigTarget, id: SymbolId): string {
  const hash = id.indexOf("#");
  if (hash < 0) return id;
  const absolute = path.resolve(target.rootDir, id.slice(0, hash));
  const configDir = path.dirname(path.resolve(target.rootDir, target.path));
  const relative = path.relative(configDir, absolute).split(path.sep).join("/");
  return `${relative}#${id.slice(hash + 1)}`;
}

function displayName(id: SymbolId): string {
  const afterHash = id.split("#")[1] ?? id;
  const parts = afterHash.split(".");
  const last = parts[parts.length - 1];
  if (last === undefined) return id;
  if (last === "constructor" && parts.length >= 2) return `${parts[parts.length - 2]}.${last}`;
  return last;
}
