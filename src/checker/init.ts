import path from "node:path";
import type {
  Diagnostic,
  DiagnosticEngine,
  DiagnosticFix,
  FixEdit,
  KnownEffect,
  SymbolId,
} from "../core/index.ts";
import { KNOWN_EFFECTS } from "../core/index.ts";
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
  readonly path: string;
  readonly source: string;
  readonly rootDir: string;
}

/**
 * `ambit init`'s analysis half (DESIGN.md §4.1: 「既存コードのエフェクトを
 * 4.2 の根拠から推論し、JSDoc の追加を診断の修正候補（5 章
 * `fixes[].edits`）として出力する」).
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
    if (propagated.observed.unknown) continue;

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
  const index = lines.findIndex((line) => /(^|[^A-Za-z0-9_$])contracts\s*:\s*\{/.test(line));
  const line = lines[index];
  if (index < 0 || line === undefined) return undefined;

  const indent = " ".repeat(line.length - line.trimStart().length + 2);
  const key = configKeyFor(target, id);
  const value = `{ effects: [${effects.map((effect) => `"${effect}"`).join(", ")}] }`;
  return {
    file: target.path,
    range: [
      [index, line.length],
      [index, line.length],
    ],
    replacement: `\n${indent}"${key}": ${value},`,
  };
}

/** A symbol id rebased onto the config file's directory (DESIGN.md §4.1 (c)). */
function configKeyFor(target: ConfigTarget, id: SymbolId): string {
  const hash = id.indexOf("#");
  if (hash < 0) return id;
  const absolute = path.resolve(target.rootDir, id.slice(0, hash));
  const relative = path.relative(path.dirname(target.path), absolute).split(path.sep).join("/");
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
