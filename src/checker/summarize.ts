import type {
  Budget,
  Call,
  CallSite,
  CapabilitySet,
  ConfigContract,
  ContractDivergence,
  ContractOrigins,
  DeclarationOrigin,
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
  RuntimeWrapper,
  SymbolId,
} from "../core/index.ts";
import {
  budgetFrom,
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
import { lookupBuiltinEffect } from "../stubs/builtin-effects.ts";
import {
  isConstructorKey,
  isHigherOrderConstructor,
  isKnownPureConstructor,
  lookupConstructorEffect,
} from "../stubs/constructors.ts";
import { lookupClientEffects } from "../stubs/data-clients.ts";
import { lookupHttpCapability } from "../stubs/http-capabilities.ts";
import { lookupStubEffect } from "../stubs/node-builtins.ts";
import {
  isHigherOrderBuiltin,
  isKnownPureBuiltin,
  isKnownPureGlobalCall,
} from "../stubs/pure-builtins.ts";
import type { ResolvedConfig } from "./config.ts";

/**
 * Turn a backend's raw extraction into Ambit's own analysis representation
 * (DESIGN.md §3.4 layer 2), independent of which backend produced it.
 */
export function summarizeExtractedFiles(
  files: readonly ExtractedFile[],
  config?: ResolvedConfig,
): readonly FunctionSummary[] {
  const aliases = config?.effectAliases;
  const summaries: FunctionSummary[] = [];
  for (const file of files) {
    const specs = specContracts(file.runtimeWrappers);
    for (const fn of file.functions) {
      const jsDoc = {
        declared: parseDeclaredEffects(fn.jsDoc, aliases),
        capabilities: parseDeclaredCapabilities(fn.jsDoc),
        budget: parseDeclaredBudget(fn.jsDoc),
        boundary: parseDeclaredBoundary(fn.jsDoc),
        entrypoint: fn.jsDoc?.tags.has("entrypoint") ?? false,
      };
      const declaredContract = config?.contractFor(fn.id);
      const merged = mergeContract(jsDoc, declaredContract, specs.get(fn.id), aliases);
      summaries.push({
        id: fn.id,
        location: fn.location,
        tagLocations: fn.jsDoc?.tagLocations ?? new Map(),
        declarationStart: fn.declarationStart,
        ...(fn.jsDocRange ? { jsDocRange: fn.jsDocRange } : {}),
        ...(fn.implicitConstructor ? { implicitConstructor: true as const } : {}),
        ...(fn.configOnly ? { configOnly: true as const } : {}),
        ...merged,
        calls: fn.calls.flatMap(toCalls),
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
 * The `capabilities` and `budget` a `withAmbit` / `ambitHandler` spec fixes as
 * literals, in the same shape a JSDoc tag parses to. A half the source builds
 * at runtime is absent: nothing was declared there that can be read.
 */
interface SpecContract {
  readonly capabilities?: CapabilitySet;
  readonly budget?: Budget;
}

/**
 * The declarations the registrations in one file make about the handlers they
 * name (DESIGN.md §4.4).
 *
 * Only a registration whose `handler` is a declaration in this same file says
 * anything here — one naming a handler from elsewhere has no summary to attach
 * to, and stays `AMB-W004`'s business. A half the source does not fix as a
 * literal is left out, so it is `AMB-W004` too rather than a declaration
 * invented from a value nobody can read.
 *
 * The first registration naming a handler is the one that declares for it.
 * A second one is not merged: whatever it says is compared against this one's
 * declaration like any other spec, so a pair that disagrees is `AMB-E010` /
 * `AMB-E011` rather than a silent last-write-wins.
 */
function specContracts(wrappers: readonly RuntimeWrapper[]): ReadonlyMap<SymbolId, SpecContract> {
  const contracts = new Map<SymbolId, SpecContract>();
  for (const wrapper of wrappers) {
    const handler = wrapper.handler;
    if (handler === undefined || contracts.has(handler)) continue;
    const capabilities = wrapper.capabilities ? capabilitySetOf(wrapper.capabilities) : undefined;
    const budget = wrapper.budget?.kind === "literal" ? budgetFrom(wrapper.budget) : undefined;
    contracts.set(handler, {
      ...(capabilities ? { capabilities } : {}),
      ...(budget ? { budget } : {}),
    });
  }
  return contracts;
}

/**
 * Combine a JSDoc contract with the one `ambit.config.ts` declares for the
 * same symbol and the one the registration beside it fixes (DESIGN.md §4.1,
 * §4.4).
 *
 * JSDoc wins per tag — a tag JSDoc declares is the one that propagates, and the
 * other sides fill only the tags JSDoc left out, so `@effects` in the code plus
 * `capabilities` in the spec is one complete contract rather than a conflict.
 * Where JSDoc and config declare the *same* tag and the two parse to different
 * values, the difference is recorded as a {@link ContractDivergence} and
 * reported (`AMB-W005`) rather than resolved silently.
 *
 * A spec is the last side consulted, and needs no divergence record of its own:
 * `diagnoseRuntimeWrappers` compares every literal spec against whatever this
 * merge settled on, so a spec disagreeing with a JSDoc *or* a config
 * declaration is still `AMB-E010` / `AMB-E011` — an error, not a warning. Only
 * the case where no other side declared anything is silent, and there the two
 * being compared are the same declaration.
 *
 * A JSDoc tag that failed to parse still counts as "JSDoc declared this":
 * neither config nor a spec must quietly stand in for a tag the author wrote
 * and misspelled, or `AMB-E002` would be reported against a contract that is
 * not the one in force.
 */
function mergeContract(
  jsDoc: JsDocContract,
  config: ConfigContract | undefined,
  spec: SpecContract | undefined,
  aliases: EffectAliases,
): Pick<
  FunctionSummary,
  "declared" | "capabilities" | "budget" | "boundary" | "entrypoint" | "declaredBy" | "divergences"
> {
  const divergences: ContractDivergence[] = [];
  const configEffects = config?.effects ? expandConfigEffects(config.effects, aliases) : undefined;
  const configCapabilities = config?.capabilities
    ? capabilitySetOf(config.capabilities)
    : undefined;
  const configBudget: Budget | undefined = config?.budget
    ? { ...config.budget, onExceed: config.budget.onExceed ?? DEFAULT_ON_EXCEED }
    : undefined;

  let declared = jsDoc.declared;
  let effectsBy: DeclarationOrigin | undefined =
    jsDoc.declared.kind === "declared" ? "jsdoc" : undefined;
  if (configEffects) {
    if (jsDoc.declared.kind === "none") {
      declared = { kind: "declared", effects: configEffects };
      effectsBy = "config";
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
  let capabilitiesBy: DeclarationOrigin | undefined =
    jsDoc.capabilities.kind === "declared" ? "jsdoc" : undefined;
  if (configCapabilities) {
    if (jsDoc.capabilities.kind === "none") {
      capabilities = { kind: "declared", capabilities: configCapabilities };
      capabilitiesBy = "config";
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
  if (spec?.capabilities && capabilities.kind === "none") {
    capabilities = { kind: "declared", capabilities: spec.capabilities };
    capabilitiesBy = "spec";
  }

  let budget = jsDoc.budget;
  let budgetBy: DeclarationOrigin | undefined =
    jsDoc.budget.kind === "declared" ? "jsdoc" : undefined;
  if (configBudget) {
    if (jsDoc.budget.kind === "none") {
      budget = { kind: "declared", budget: configBudget };
      budgetBy = "config";
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
  if (spec?.budget && budget.kind === "none") {
    budget = { kind: "declared", budget: spec.budget };
    budgetBy = "spec";
  }

  const declaredBy: ContractOrigins = {
    ...(effectsBy ? { effects: effectsBy } : {}),
    ...(capabilitiesBy ? { capabilities: capabilitiesBy } : {}),
    ...(budgetBy ? { budget: budgetBy } : {}),
  };

  let boundary = jsDoc.boundary;
  if (config?.boundary !== undefined) {
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
  if (config?.entrypoint !== undefined) {
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
    ...(Object.keys(declaredBy).length > 0 ? { declaredBy } : {}),
    ...(divergences.length > 0 ? { divergences } : {}),
  };
}

/**
 * A config `effects` list turned into an {@link EffectSet}. Every name is
 * either a standard effect or a user-defined one, which `validateConfig`
 * already guaranteed — a user-defined name expands to the standard effects it
 * stands for, and nothing but standard effects ever leaves this function
 * (DESIGN.md §4.1 (d)).
 */
function expandConfigEffects(names: readonly string[], aliases: EffectAliases): EffectSet {
  const effects: KnownEffect[] = [];
  for (const name of names) {
    if (isKnownEffect(name)) effects.push(name);
    else effects.push(...(aliases?.get(name) ?? []));
  }
  return effectSetOf(...effects);
}

/**
 * A list of capability strings — a config `capabilities` list, or a spec's
 * literal array — turned into a {@link CapabilitySet}.
 *
 * A token that does not parse is dropped rather than guessed at. It is not
 * lost: `validateConfig` rejects a malformed config token, and a malformed
 * spec token leaves the set narrower than the text the spec wrote, which
 * `diagnoseRuntimeWrappers` then reports as `AMB-E010` against that text.
 */
function capabilitySetOf(tokens: readonly string[]): CapabilitySet {
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

function parseDeclaredEffects(
  jsDoc: RawJsDoc | undefined,
  aliases: EffectAliases,
): DeclaredEffects {
  const tagText = jsDoc?.tags.get("effects");
  if (tagText === undefined) return { kind: "none" };
  const effects = parseEffectsTag(tagText, aliases);
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
export function parseEffectsTag(text: string, aliases?: EffectAliases): EffectSet | undefined {
  const trimmed = text.trim();
  if (trimmed === "pure") return emptyEffectSet();

  const tokens = trimmed.split(",").map((token) => token.trim());
  const effects: KnownEffect[] = [];
  for (const token of tokens) {
    if (isKnownEffect(token)) {
      effects.push(token);
      continue;
    }
    // A user-defined name is usable from `@effects` too, not only from
    // config (DESIGN.md §4.2: "User-defined effects can be declared in
    // `ambit.config.ts` as combinations of standard effects"). It expands here, so
    // nothing downstream ever sees a name that is not a standard effect
    // (§4.1 (d)).
    const expansion = aliases?.get(token);
    if (expansion === undefined) return undefined;
    effects.push(...expansion);
  }
  return effectSetOf(...effects);
}

/**
 * User-defined effect names and the standard effects they stand for. Absent
 * when no config was loaded, in which case every name has to be standard.
 */
export type EffectAliases = ReadonlyMap<string, readonly KnownEffect[]> | undefined;

/**
 * One call site as the analysis representation sees it — usually one
 * {@link Call}, and more than one where the site also hands a function
 * reference to a callee that runs it (`arr.map(toCall)`).
 *
 * The extra entries are ordinary resolved calls: DESIGN.md §4.2 rule 4 says a
 * higher-order call's callback effects are "inferred from the actual argument
 * at the call site", and when that argument names a function this project
 * extracted, the argument *is* the answer. Only a callee already known to
 * invoke what it is handed produces them — a higher-order allowlisted builtin
 * or constructor, or a mutating builtin, whose verdict covers the receiver and
 * not the comparator it was given. A call that merely inspects a function
 * value gains no edge (`src/stubs/pure-builtins.ts`, `HIGHER_ORDER_BUILTINS`).
 */
function toCalls(site: CallSite): readonly Call[] {
  const call = toCall(site);
  if (!site.callbackTargets || !invokesItsCallableArguments(call)) return [call];

  return [
    call,
    ...site.callbackTargets.map(
      (callee): Call => ({ kind: "resolved", location: site.location, callee }),
    ),
  ];
}

/**
 * Whether the callee this site resolved to is one that runs a function it is
 * handed. Answered from the verdict rather than from the raw site, because
 * only a call the tables *answered* has a name whose semantics are known: an
 * unresolved call is already `unknown`, and attributing a callback's effects
 * to the caller there would add effects without removing the uncertainty.
 */
function invokesItsCallableArguments(call: Call): boolean {
  // A mutating builtin that was handed a comparator runs it — `arr.sort(cmp)`
  // is the case DESIGN.md §4.2 names. The mutation verdict answers what
  // happens to the receiver and says nothing about the comparator, so without
  // the edge the comparator's effects would simply vanish.
  if (call.kind === "mutation") return true;
  if (call.kind !== "known-pure" || call.qualifiedName === undefined) return false;
  return isConstructorKey(call.qualifiedName)
    ? isHigherOrderConstructor(call.qualifiedName)
    : isHigherOrderBuiltin(call.qualifiedName);
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
  if (site.inlinedCallee) {
    return { kind: "inlined", location: site.location };
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
    // A global called as a bare identifier (`Number(x)`) has a textual name in
    // this namespace rather than a checker-derived one, so the pure allowlist
    // for those is consulted here. Only when the connector layer already
    // resolved the callee into TypeScript's default lib: the name alone is not
    // evidence that this `Number` is the builtin one
    // (`src/stubs/pure-builtins.ts`, `PURE_GLOBAL_CALLS`).
    // Nothing in that table calls what it is handed (`Function` is refused
    // there for exactly that reason), so an opaque callable argument does not
    // bear on the verdict the way it does for `Array.map`.
    if (
      site.unresolvedReason === "builtin-method" &&
      isKnownPureGlobalCall(site.calleeQualifiedName)
    ) {
      return {
        kind: "known-pure",
        location: site.location,
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
    // A builtin whose effect is known exactly is a stub call, not an absence
    // of effect and not `unknown` (`src/stubs/builtin-effects.ts`).
    const builtinEffect = lookupBuiltinEffect(site.pureBuiltinName);
    if (builtinEffect) {
      return {
        kind: "stub",
        location: site.location,
        effects: [builtinEffect],
        qualifiedName: site.pureBuiltinName,
      };
    }
    // A callback passed by reference is never walked, so it can't be
    // trusted as pure even when the method name itself is allowlisted
    // (CallSite.callbackByReference's doc comment) — but only where the
    // method can actually call it. `Array.isArray(handler)` inspects its
    // argument; refusing it would report a call that cannot happen.
    if (
      isKnownPureBuiltin(site.pureBuiltinName) &&
      !(site.callbackByReference && isHigherOrderBuiltin(site.pureBuiltinName))
    ) {
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
  if (
    isKnownPureConstructor(qualifiedName, withoutArguments) &&
    !(site.callbackByReference && isHigherOrderConstructor(qualifiedName))
  ) {
    return { kind: "known-pure", location: site.location, qualifiedName };
  }
  return {
    kind: "unresolved",
    location: site.location,
    reason: site.unresolvedReason ?? "unresolved-symbol",
    qualifiedName,
  };
}
