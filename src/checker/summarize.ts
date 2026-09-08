import type {
  Call,
  CallSite,
  DeclaredEffects,
  EffectSet,
  ExtractedFile,
  FunctionSummary,
  KnownEffect,
  RawJsDoc,
} from "../core/index.ts";
import { effectSetOf, emptyEffectSet, isKnownEffect } from "../core/index.ts";
import { lookupStubEffect } from "../stubs/node-builtins.ts";
import { isKnownPureBuiltin } from "../stubs/pure-builtins.ts";

/**
 * Turn a backend's raw extraction into Ambit's own analysis representation
 * (DESIGN.md §3.4 layer 2), independent of which backend produced it.
 */
export function summarizeExtractedFiles(
  files: readonly ExtractedFile[],
): readonly FunctionSummary[] {
  const summaries: FunctionSummary[] = [];
  for (const file of files) {
    for (const fn of file.functions) {
      summaries.push({
        id: fn.id,
        location: fn.location,
        declared: parseDeclaredEffects(fn.jsDoc),
        calls: fn.calls.map(toCall),
      });
    }
  }
  return summaries;
}

function parseDeclaredEffects(jsDoc: RawJsDoc | undefined): DeclaredEffects {
  const tagText = jsDoc?.tags.get("effects");
  if (tagText === undefined) return { kind: "none" };
  return { kind: "declared", effects: parseEffectsTag(tagText) };
}

/**
 * `pure` is the literal spelling for the empty set (DESIGN.md §4.2 rule 2).
 * Unrecognized tokens are silently dropped in this slice — validating
 * `@effects` tag text against typos is a coverage/lint concern, not part of
 * propagation, and is out of scope here.
 */
export function parseEffectsTag(text: string): EffectSet {
  const trimmed = text.trim();
  if (trimmed === "pure") return emptyEffectSet();

  const effects: KnownEffect[] = trimmed
    .split(",")
    .map((token) => token.trim())
    .filter((token): token is KnownEffect => isKnownEffect(token));
  return effectSetOf(...effects);
}

function toCall(site: CallSite): Call {
  if (site.resolvedCallee) {
    return { kind: "resolved", location: site.location, callee: site.resolvedCallee };
  }
  if (site.calleeQualifiedName) {
    const effect = lookupStubEffect(site.calleeQualifiedName);
    if (effect) {
      return {
        kind: "stub",
        location: site.location,
        effect,
        qualifiedName: site.calleeQualifiedName,
      };
    }
    // A named call that didn't resolve to a project function and doesn't
    // match a known stub (e.g. a third-party library call): unresolved, not
    // "no effect" (DESIGN.md §3.4 — never turn an unanalyzed call into
    // "violation-free"). The connector layer may already know a more
    // specific reason than the residual "unresolved-symbol" (see
    // `CallSite.unresolvedReason`'s doc comment).
    return {
      kind: "unresolved",
      location: site.location,
      reason: site.unresolvedReason ?? "unresolved-symbol",
      qualifiedName: site.calleeQualifiedName,
    };
  }
  if (site.pureBuiltinName) {
    // A callback passed by reference is never walked, so it can't be
    // trusted as pure even when the method name itself is allowlisted
    // (CallSite.callbackByReference's doc comment).
    if (isKnownPureBuiltin(site.pureBuiltinName) && !site.callbackByReference) {
      return { kind: "known-pure", location: site.location, qualifiedName: site.pureBuiltinName };
    }
    return {
      kind: "unresolved",
      location: site.location,
      reason: site.unresolvedReason ?? "unresolved-symbol",
      qualifiedName: site.pureBuiltinName,
    };
  }
  return {
    kind: "unresolved",
    location: site.location,
    reason: site.unresolvedReason ?? "unresolved-symbol",
  };
}
