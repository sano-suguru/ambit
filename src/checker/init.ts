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

    // A class with no constructor written has no declaration site, so there is
    // no patch to offer — a comment above the `class` is inert (AMB-E003).
    // Still reported: the effects are real and the user needs to know they can
    // be declared, by writing the constructor out (P4 — do not hide it).
    if (summary.implicitConstructor) {
      proposals.push(
        proposal(
          propagated,
          effects,
          `${displayName(summary.id)} runs [${effects.join(", ") || "no effects"}] but has no constructor to declare them on; write an explicit constructor to carry ${tag}`,
          [],
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

function displayName(id: SymbolId): string {
  const afterHash = id.split("#")[1] ?? id;
  const parts = afterHash.split(".");
  const last = parts[parts.length - 1];
  if (last === undefined) return id;
  if (last === "constructor" && parts.length >= 2) return `${parts[parts.length - 2]}.${last}`;
  return last;
}
