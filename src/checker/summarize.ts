import type {
  Budget,
  Call,
  CallSite,
  CapabilitySet,
  ConfigContract,
  ContractDivergence,
  DeclaredBoundary,
  DeclaredBudget,
  DeclaredCapabilities,
  DeclaredEffects,
  EffectSet,
  ExtractedFile,
  FunctionSummary,
  KnownEffect,
  LiteralArgument,
  RawJsDoc,
} from "../core/index.ts";
import {
  capabilitySetsEqual,
  DEFAULT_ON_EXCEED,
  effectSetOf,
  effectSetsEqual,
  emptyEffectSet,
  formatBudget,
  formatCapability,
  isKnownEffect,
  KNOWN_EFFECTS,
  parseBudgetTag,
  parseCapabilitiesTag,
  parseCapability,
} from "../core/index.ts";
import {
  isConstructorKey,
  isKnownPureConstructor,
  lookupConstructorEffect,
} from "../stubs/constructors.ts";
import { lookupClientEffects } from "../stubs/data-clients.ts";
import { lookupHttpCapability } from "../stubs/http-capabilities.ts";
import { lookupStubEffect } from "../stubs/node-builtins.ts";
import { isKnownPureBuiltin } from "../stubs/pure-builtins.ts";
import type { ResolvedConfig } from "./config.ts";

/**
 * Turn a backend's raw extraction into Ambit's own analysis representation
 * (DESIGN.md §3.4 layer 2), independent of which backend produced it.
 */
export function summarizeExtractedFiles(
  files: readonly ExtractedFile[],
  config?: ResolvedConfig,
): readonly FunctionSummary[] {
  const summaries: FunctionSummary[] = [];
  for (const file of files) {
    for (const fn of file.functions) {
      const jsDoc = {
        declared: parseDeclaredEffects(fn.jsDoc),
        capabilities: parseDeclaredCapabilities(fn.jsDoc),
        budget: parseDeclaredBudget(fn.jsDoc),
        boundary: parseDeclaredBoundary(fn.jsDoc),
        entrypoint: fn.jsDoc?.tags.has("entrypoint") ?? false,
      };
      const declaredContract = config?.contractFor(fn.id);
      const merged = mergeContract(jsDoc, declaredContract);
      summaries.push({
        id: fn.id,
        location: fn.location,
        tagLocations: fn.jsDoc?.tagLocations ?? new Map(),
        declarationStart: fn.declarationStart,
        ...(fn.jsDocRange ? { jsDocRange: fn.jsDocRange } : {}),
        ...(fn.implicitConstructor ? { implicitConstructor: true as const } : {}),
        ...(fn.configOnly ? { configOnly: true as const } : {}),
        ...merged,
        calls: fn.calls.map(toCall),
      });
    }
  }
  return summaries;
}

/** The five contract tags as JSDoc alone declares them. */
interface JsDocContract {
  readonly declared: DeclaredEffects;
  readonly capabilities: DeclaredCapabilities;
  readonly budget: DeclaredBudget;
  readonly boundary: DeclaredBoundary;
  readonly entrypoint: boolean;
}

/**
 * Combine a JSDoc contract with the one `ambit.config.ts` declares for the
 * same symbol (DESIGN.md §4.1).
 *
 * Two rules, both from §4.1. JSDoc wins per tag — a tag JSDoc declares is the
 * one that propagates, and config fills only the tags JSDoc left out, so
 * `@effects` in the code plus `capabilities` in the config is one complete
 * contract rather than a conflict. Where both declare the *same* tag and the
 * two parse to different values, the difference is recorded as a
 * {@link ContractDivergence} and reported (`AMB-W005`) rather than resolved
 * silently.
 *
 * A JSDoc tag that failed to parse still counts as "JSDoc declared this":
 * config must not quietly stand in for a tag the author wrote and misspelled,
 * or `AMB-E002` would be reported against a contract that is not the one in
 * force.
 */
function mergeContract(
  jsDoc: JsDocContract,
  config: ConfigContract | undefined,
): Pick<
  FunctionSummary,
  "declared" | "capabilities" | "budget" | "boundary" | "entrypoint" | "declaredBy" | "divergences"
> {
  if (config === undefined) {
    return {
      ...jsDoc,
      ...(jsDoc.declared.kind === "declared" ? { declaredBy: "jsdoc" as const } : {}),
    };
  }

  const divergences: ContractDivergence[] = [];
  const configEffects = config.effects ? expandConfigEffects(config.effects) : undefined;
  const configCapabilities = config.capabilities
    ? configCapabilitySet(config.capabilities)
    : undefined;
  const configBudget: Budget | undefined = config.budget
    ? { ...config.budget, onExceed: config.budget.onExceed ?? DEFAULT_ON_EXCEED }
    : undefined;

  let declared = jsDoc.declared;
  let declaredBy: "jsdoc" | "config" | undefined =
    jsDoc.declared.kind === "declared" ? "jsdoc" : undefined;
  if (configEffects) {
    if (jsDoc.declared.kind === "none") {
      declared = { kind: "declared", effects: configEffects };
      declaredBy = "config";
    } else if (
      jsDoc.declared.kind === "declared" &&
      !effectSetsEqual(jsDoc.declared.effects, configEffects)
    ) {
      divergences.push({
        tag: "effects",
        jsDoc: formatEffects(jsDoc.declared.effects.effects),
        config: formatEffects(configEffects.effects),
      });
    }
  }

  let capabilities = jsDoc.capabilities;
  if (configCapabilities) {
    if (jsDoc.capabilities.kind === "none") {
      capabilities = { kind: "declared", capabilities: configCapabilities };
    } else if (
      jsDoc.capabilities.kind === "declared" &&
      !capabilitySetsEqual(jsDoc.capabilities.capabilities, configCapabilities)
    ) {
      divergences.push({
        tag: "capabilities",
        jsDoc: formatCapabilities(jsDoc.capabilities.capabilities),
        config: formatCapabilities(configCapabilities),
      });
    }
  }

  let budget = jsDoc.budget;
  if (configBudget) {
    if (jsDoc.budget.kind === "none") {
      budget = { kind: "declared", budget: configBudget };
    } else if (
      jsDoc.budget.kind === "declared" &&
      formatBudget(jsDoc.budget.budget) !== formatBudget(configBudget)
    ) {
      divergences.push({
        tag: "budget",
        jsDoc: formatBudget(jsDoc.budget.budget),
        config: formatBudget(configBudget),
      });
    }
  }

  let boundary = jsDoc.boundary;
  if (config.boundary !== undefined) {
    if (jsDoc.boundary.kind === "none") {
      boundary = { kind: "declared", reason: config.boundary };
    } else if (jsDoc.boundary.kind === "declared" && jsDoc.boundary.reason !== config.boundary) {
      divergences.push({
        tag: "boundary",
        jsDoc: jsDoc.boundary.reason,
        config: config.boundary,
      });
    }
  }

  // No `@entrypoint` is not a declaration that the function is *not* one, so
  // only an explicit `entrypoint: false` beside the tag is a disagreement.
  let entrypoint = jsDoc.entrypoint;
  if (config.entrypoint !== undefined) {
    if (!jsDoc.entrypoint && config.entrypoint) entrypoint = true;
    else if (jsDoc.entrypoint && !config.entrypoint) {
      divergences.push({ tag: "entrypoint", jsDoc: "true", config: "false" });
    }
  }

  return {
    declared,
    capabilities,
    budget,
    boundary,
    entrypoint,
    ...(declaredBy ? { declaredBy } : {}),
    ...(divergences.length > 0 ? { divergences } : {}),
  };
}

/**
 * A config `effects` list turned into an {@link EffectSet}. Every name is a
 * standard effect, which `validateConfig` already guaranteed.
 */
function expandConfigEffects(names: readonly string[]): EffectSet {
  return effectSetOf(...names.filter(isKnownEffect));
}

function configCapabilitySet(tokens: readonly string[]): CapabilitySet {
  const capabilities = tokens
    .map(parseCapability)
    .filter((capability): capability is NonNullable<typeof capability> => capability !== undefined);
  return { capabilities, unknown: false };
}

function formatEffects(effects: ReadonlySet<KnownEffect>): string {
  const ordered = KNOWN_EFFECTS.filter((effect) => effects.has(effect));
  return ordered.length === 0 ? "pure" : ordered.join(", ");
}

function formatCapabilities(set: CapabilitySet): string {
  return set.capabilities.map(formatCapability).join(", ");
}

function parseDeclaredEffects(jsDoc: RawJsDoc | undefined): DeclaredEffects {
  const tagText = jsDoc?.tags.get("effects");
  if (tagText === undefined) return { kind: "none" };
  const effects = parseEffectsTag(tagText);
  if (effects === undefined) return { kind: "invalid", raw: tagText };
  return { kind: "declared", effects };
}

function parseDeclaredCapabilities(jsDoc: RawJsDoc | undefined): DeclaredCapabilities {
  const tagText = jsDoc?.tags.get("capabilities");
  if (tagText === undefined) return { kind: "none" };
  const capabilities = parseCapabilitiesTag(tagText);
  if (capabilities === undefined) return { kind: "invalid", raw: tagText };
  return { kind: "declared", capabilities };
}

function parseDeclaredBudget(jsDoc: RawJsDoc | undefined): DeclaredBudget {
  const tagText = jsDoc?.tags.get("budget");
  if (tagText === undefined) return { kind: "none" };
  const budget = parseBudgetTag(tagText);
  if (budget === undefined) return { kind: "invalid", raw: tagText };
  return { kind: "declared", budget };
}

/**
 * `@boundary reason="..."`. DESIGN.md §4.6 makes `reason` mandatory, so a tag
 * without one does not declare a boundary — it declares an unexplained hole,
 * which is exactly what the tag exists to prevent. Both quoted and bare
 * `reason=` forms are accepted; anything else is `"invalid"`.
 */
export function parseBoundaryTag(text: string): string | undefined {
  const match = /^reason\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/.exec(text.trim());
  const reason = match?.[1] ?? match?.[2] ?? match?.[3];
  return reason !== undefined && reason.trim().length > 0 ? reason.trim() : undefined;
}

function parseDeclaredBoundary(jsDoc: RawJsDoc | undefined): DeclaredBoundary {
  const tagText = jsDoc?.tags.get("boundary");
  if (tagText === undefined) return { kind: "none" };
  const reason = parseBoundaryTag(tagText);
  if (reason === undefined) return { kind: "invalid", raw: tagText };
  return { kind: "declared", reason };
}

/**
 * `pure` is the literal spelling for the empty set (DESIGN.md §4.2 rule 2).
 * Returns `undefined` when a token is neither `pure` nor a known effect (a
 * typo, e.g. `@effects netwrok`) — such a declaration must not silently
 * collapse to an empty (`pure`) contract. The caller reports this as
 * `AMB-E002` (`diagnose.ts`) instead of the tag's real, but broken, contract.
 */
export function parseEffectsTag(text: string): EffectSet | undefined {
  const trimmed = text.trim();
  if (trimmed === "pure") return emptyEffectSet();

  const tokens = trimmed.split(",").map((token) => token.trim());
  const effects: KnownEffect[] = [];
  for (const token of tokens) {
    if (!isKnownEffect(token)) return undefined;
    effects.push(token);
  }
  return effectSetOf(...effects);
}

function toCall(site: CallSite): Call {
  if (site.mutation) {
    return {
      kind: "mutation",
      location: site.location,
      escaping: site.mutation.escaping,
      ...(site.mutation.qualifiedName ? { qualifiedName: site.mutation.qualifiedName } : {}),
      ...(site.mutation.unknownCallback ? { unknownCallback: true as const } : {}),
    };
  }
  if (site.resolvedCallee) {
    return { kind: "resolved", location: site.location, callee: site.resolvedCallee };
  }
  if (site.calleeQualifiedName) {
    // A construction is keyed in its own namespace (`src/stubs/
    // constructors.ts`) — `new URL(...)` and `URL(...)` are different
    // operations and must never share a table entry.
    if (isConstructorKey(site.calleeQualifiedName)) {
      return toConstructorCall(site, site.calleeQualifiedName);
    }
    const effects = stubEffectsFor(site.calleeQualifiedName, site.literalArguments);
    if (effects) {
      const required = lookupHttpCapability(site.calleeQualifiedName, site.literalArguments);
      return {
        kind: "stub",
        location: site.location,
        effects,
        qualifiedName: site.calleeQualifiedName,
        ...(required?.capability ? { requiredCapability: required.capability } : {}),
        ...(required?.targetUnknown ? { capabilityTargetUnknown: true as const } : {}),
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

/**
 * The bundled effect tables, in one lookup: the fixed table for globals and
 * Node.js builtins (`src/stubs/node-builtins.ts`), then the database/LLM
 * client table (`src/stubs/data-clients.ts`), whose answer can depend on the
 * call's own literal arguments. The two key spaces do not overlap — a builtin
 * key never has a client class in it — so the order only decides which lookup
 * runs first, not which answer wins.
 */
function stubEffectsFor(
  qualifiedName: string,
  literalArguments: readonly (LiteralArgument | undefined)[] | undefined,
): readonly KnownEffect[] | undefined {
  const builtin = lookupStubEffect(qualifiedName);
  if (builtin) return [builtin];
  return lookupClientEffects(qualifiedName, literalArguments);
}

function toConstructorCall(site: CallSite, qualifiedName: string): Call {
  const withoutArguments = site.constructedWithoutArguments === true;
  const effect = lookupConstructorEffect(qualifiedName, withoutArguments);
  if (effect) {
    return { kind: "stub", location: site.location, effects: [effect], qualifiedName };
  }
  // A callback passed by reference is never walked, so an allowlisted
  // constructor that runs one (`new Promise(namedExecutor)`) cannot be
  // trusted as effect-free (DESIGN.md §4.2 rule 4).
  if (isKnownPureConstructor(qualifiedName, withoutArguments) && !site.callbackByReference) {
    return { kind: "known-pure", location: site.location, qualifiedName };
  }
  return {
    kind: "unresolved",
    location: site.location,
    reason: site.unresolvedReason ?? "unresolved-symbol",
    qualifiedName,
  };
}
