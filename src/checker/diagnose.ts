import type {
  Budget,
  Capability,
  ContractViaEntry,
  Diagnostic,
  DiagnosticEngine,
  DiagnosticFix,
  FixEdit,
  FunctionSummary,
  KnownEffect,
  RuntimeWrapper,
  SkippedFunctionKind,
  SourceLocation,
  StubCall,
  SymbolId,
  UncarriedContract,
  WrapperBudget,
} from "../core/index.ts";
import {
  callLeavesUnknown,
  DEFAULT_ON_EXCEED,
  displayName,
  excessCapabilities,
  excessEffects,
  formatBudget,
  formatCapability,
  KNOWN_EFFECTS,
} from "../core/index.ts";
import type { PropagatedFunction } from "./propagate.ts";
import {
  capabilityUnknownWitnessChain,
  capabilityWitnessChain,
  unknownWitnessChain,
  witnessChain,
} from "./propagate.ts";

/**
 * Compare declared vs. observed effects for every declared function and
 * produce diagnostics (DESIGN.md §5.1). Undeclared functions
 * (`declared.kind === "none"`) are not diagnosed here — see the plan's note
 * on §4.2/§4.3: undeclared is a coverage concern, not a propagation input.
 *
 * `engine` identifies the backend that produced `state` (DESIGN.md §3.4) and
 * is attached to every diagnostic emitted.
 */
export function diagnose(
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
  engine: DiagnosticEngine,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const propagated of state.values()) {
    diagnostics.push(...diagnoseEffects(propagated, state, engine));
    diagnostics.push(...diagnoseCapabilities(propagated, state, engine));
    diagnostics.push(...diagnoseBoundary(propagated, engine));
    diagnostics.push(...diagnoseBudget(propagated, engine));
    diagnostics.push(...diagnoseEntrypoint(propagated, engine));
  }

  return diagnostics;
}

/**
 * The one fix candidate AMB-E001 can generate: widen the `@effects` tag to
 * cover what was observed.
 *
 * There is deliberately no second, contract-preserving candidate. Restoring a
 * declaration means restructuring the code — moving the effectful call to a
 * caller that is allowed to make it — and Ambit cannot generate that patch
 * safely. DESIGN.md §5.3 forbids inventing one for the sake of ranking:
 * 「生成できない候補を順位のために捏造しない」. So this fix is always
 * `consistentWithContract: false`, and `impact` says what widening costs.
 */
function buildWidenFix(
  propagated: PropagatedFunction,
  declared: ReadonlySet<KnownEffect>,
  excess: ReadonlySet<KnownEffect>,
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
): readonly DiagnosticFix[] {
  const { summary } = propagated;
  const tagLocation = summary.tagLocations.get("effects");
  // No recorded tag position means no applicable patch. §5.3: never emit a
  // summary-only candidate as if it were one.
  if (!tagLocation) return [];

  const widened = KNOWN_EFFECTS.filter((effect) => declared.has(effect) || excess.has(effect));
  if (widened.length === 0) return [];

  const edit: FixEdit = {
    file: tagLocation.file,
    range: toEditRange(tagLocation),
    replacement: `@effects ${widened.join(", ")}`,
  };

  const callers = callersOf(summary.id, state);
  const pureCallersBroken = callers.filter((caller) => {
    const callerDeclared = caller.summary.declared;
    if (callerDeclared.kind !== "declared") return false;
    return [...excess].some((effect) => !callerDeclared.effects.effects.has(effect));
  }).length;

  return [
    {
      rank: 1,
      kind: "widen",
      summary: `Allow ${[...excess].join(", ")} in ${displayName(summary.id)}`,
      // Not a probability. The patch is mechanical and always applies; what
      // is uncertain is whether widening is what the author wants, which is
      // exactly what `consistentWithContract: false` is for.
      confidence: 1,
      consistentWithContract: false,
      edits: [edit],
      impact: {
        callersAffected: callers.map((caller) => caller.summary.id),
        pureCallersBroken,
      },
    },
  ];
}

/**
 * DESIGN.md §5.3: `location` is 1-based, an edit range 0-based and
 * end-exclusive. `SourceLocation.endLine`/`endCol` are already exclusive, so
 * only the origin shifts.
 */
function toEditRange(location: SourceLocation): FixEdit["range"] {
  return [
    [location.line - 1, location.col - 1],
    [location.endLine - 1, location.endCol - 1],
  ];
}

/** Every analyzed function with a resolved call to `id` — who a widened contract newly affects. */
function callersOf(
  id: SymbolId,
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
): readonly PropagatedFunction[] {
  return [...state.values()].filter((candidate) =>
    candidate.summary.calls.some((call) => call.kind === "resolved" && call.callee === id),
  );
}

function diagnoseEffects(
  propagated: PropagatedFunction,
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
  engine: DiagnosticEngine,
): readonly Diagnostic[] {
  const { summary } = propagated;
  if (summary.declared.kind === "invalid") {
    return [buildInvalidEffectsDiagnostic(propagated, summary.declared.raw, engine)];
  }
  if (summary.declared.kind !== "declared") return [];

  const diagnostics: Diagnostic[] = [];
  const declaredEffects = summary.declared.effects;
  const excess = excessEffects(declaredEffects, propagated.observed);

  if (excess.size > 0) {
    diagnostics.push(
      buildExcessDiagnostic(propagated, declaredEffects.effects, excess, state, engine),
    );
  }
  if (propagated.observed.unknown) {
    diagnostics.push(buildUnknownDiagnostic(propagated, declaredEffects.effects, state, engine));
  }
  return diagnostics;
}

/**
 * DESIGN.md §4.4's 縮小則: a callee may not require a capability its caller
 * does not grant. A function's own declaration is the grant; what its body
 * reaches is the requirement.
 */
function diagnoseCapabilities(
  propagated: PropagatedFunction,
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
  engine: DiagnosticEngine,
): readonly Diagnostic[] {
  const { summary } = propagated;
  if (summary.capabilities.kind === "invalid") {
    return [
      {
        id: "AMB-E004",
        severity: "error",
        category: "capabilities",
        message: `${displayName(summary.id)} declares @capabilities "${summary.capabilities.raw}", which is not a comma-separated list of <resource>:<action>:<target>`,
        location: summary.location,
        fixes: [],
        docs: "docs/diagnostics/README.md#amb-e004",
        engine,
      },
    ];
  }
  if (summary.capabilities.kind !== "declared") return [];

  const granted = summary.capabilities.capabilities.capabilities;
  const excess = excessCapabilities(granted, propagated.required.capabilities);
  const diagnostics: Diagnostic[] = [];

  // DESIGN.md §4.4's static half: a target this function's own body fixes in
  // the source — a literal URL's host — is checked against the grant here, at
  // the call site, rather than folded into the declaration-to-declaration
  // escalation below. The two are different findings: one names a line to
  // change, the other names a callee whose contract is too wide.
  const literalViolations = summary.calls.filter(
    (call) =>
      call.kind === "stub" &&
      call.requiredCapability !== undefined &&
      excessCapabilities(granted, [call.requiredCapability]).length > 0,
  );
  for (const call of literalViolations) {
    if (call.kind !== "stub" || !call.requiredCapability) continue;
    diagnostics.push(buildLiteralTargetViolation(propagated, granted, call, engine));
  }

  const reportedLiterally = new Set(
    literalViolations.map((call) =>
      call.kind === "stub" && call.requiredCapability
        ? formatCapability(call.requiredCapability)
        : "",
    ),
  );
  // A capability reported at a literal call site is dropped from the
  // escalation *only* when nothing else requires it: otherwise the same
  // function's own `fetch("https://elsewhere.example/…")` would hide a callee
  // that declares the very same capability, and fixing the URL would reveal
  // an escalation that was there all along. `capabilityWitness` names that
  // callee, and is empty when the requirement is this body's alone.
  const inheritedExcess = excess.filter((capability) => {
    const text = formatCapability(capability);
    if (!reportedLiterally.has(text)) return true;
    return capabilityWitnessChain(summary.id, text, state).length > 0;
  });

  if (inheritedExcess.length > 0) {
    diagnostics.push(
      buildCapabilityEscalation(propagated, granted, inheritedExcess, state, engine),
    );
  }
  if (propagated.required.unknown) {
    const chain = capabilityUnknownWitnessChain(summary.id, state);
    const witness = chain[chain.length - 1];
    const witnessSummary = witness ? state.get(witness)?.summary : undefined;
    // Three different causes reach the same unknown, and saying the wrong one
    // sends a reader hunting for a call that resolved perfectly well.
    const cause = capabilityUnknownCause(propagated, witnessSummary);
    diagnostics.push({
      id: "AMB-W003",
      severity: "warning",
      category: "capabilities",
      message: `${displayName(summary.id)} declares @capabilities but ${cause}, so its capability requirement is not fully known`,
      location: summary.location,
      contract: {
        declared: granted.map(formatCapability),
        required: propagated.required.capabilities.map(formatCapability),
        excess: [],
        via: chainToVia(chain, state),
      },
      fixes: [],
      docs: "docs/diagnostics/README.md#amb-w003",
      engine,
    });
  }
  return diagnostics;
}

/**
 * Why a declared capability set is not fully known. A `@boundary` callee that
 * declared nothing, an operation whose target the source does not fix, and a
 * call that could not be resolved are three different situations with three
 * different fixes; naming the wrong one wastes the reader's time.
 *
 * A direct unresolved call wins over a dynamic target: it is the wider hole
 * (an unresolved callee could require anything), and the witness chain is
 * empty for both, so nothing else would say it.
 */
function capabilityUnknownCause(
  propagated: PropagatedFunction,
  witnessSummary: FunctionSummary | undefined,
): string {
  if (witnessSummary?.boundary.kind === "declared") {
    return `calls ${displayName(witnessSummary.id)}, a @boundary that declares no @capabilities`;
  }
  const { calls } = propagated.summary;
  if (!calls.some(callLeavesUnknown)) {
    const dynamic = calls.find((call) => call.kind === "stub" && call.capabilityTargetUnknown);
    if (dynamic?.kind === "stub") {
      return `calls ${dynamic.qualifiedName} with a target that is not a literal in the source, which only the runtime can match (DESIGN.md §4.4)`;
    }
  }
  return "reaches a call that could not be resolved";
}

/**
 * DESIGN.md §4.4's static half: an operation whose target the source fixes —
 * a literal URL — reaching outside what the function was granted.
 *
 * Reported at the call site rather than at the declaration, because that is
 * the line to change, and separately from `AMB-E005`, because the finding is
 * different: nothing declared this requirement, the code performs it directly.
 *
 * No fix candidate. The two possible patches are widening the grant and
 * changing the URL, and Ambit cannot tell which the author meant; §5.3 forbids
 * inventing one for the sake of ranking, and widening a capability silently is
 * exactly the expansion of authority the tag exists to catch.
 */
function buildLiteralTargetViolation(
  propagated: PropagatedFunction,
  granted: readonly Capability[],
  call: StubCall,
  engine: DiagnosticEngine,
): Diagnostic {
  const { summary } = propagated;
  const required = call.requiredCapability;
  const requiredText = required ? formatCapability(required) : "";
  const grantedList = granted.map(formatCapability);

  return {
    id: "AMB-E009",
    severity: "error",
    category: "capabilities",
    message: `${displayName(summary.id)} grants [${grantedList.join(", ")}] but ${call.qualifiedName} here targets ${requiredText}`,
    location: call.location,
    contract: {
      declared: grantedList,
      required: propagated.required.capabilities.map(formatCapability),
      excess: [requiredText],
      via: [],
    },
    fixes: [],
    docs: "docs/diagnostics/README.md#amb-e009",
    engine,
  };
}

function buildCapabilityEscalation(
  propagated: PropagatedFunction,
  granted: readonly Capability[],
  excess: readonly Capability[],
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
  engine: DiagnosticEngine,
): Diagnostic {
  const { summary } = propagated;
  // Deterministic choice of which excess capability's path to show, so the
  // same code always produces the same diagnostic.
  const primary = [...excess].sort((a, b) =>
    formatCapability(a).localeCompare(formatCapability(b)),
  )[0];
  const chain = primary ? capabilityWitnessChain(summary.id, formatCapability(primary), state) : [];
  const via = chainToVia(chain, state);
  const grantedList = granted.map(formatCapability);
  const excessList = excess.map(formatCapability);

  const message =
    via.length > 0
      ? `${displayName(summary.id)} grants [${grantedList.join(", ")}] but calls ${displayName(via[via.length - 1]?.symbol ?? summary.id)} which requires [${excessList.join(", ")}]`
      : `${displayName(summary.id)} grants [${grantedList.join(", ")}] but requires [${excessList.join(", ")}]`;

  return {
    id: "AMB-E005",
    severity: "error",
    category: "capabilities",
    message,
    location: summary.location,
    contract: {
      declared: grantedList,
      required: propagated.required.capabilities.map(formatCapability),
      excess: excessList,
      via,
    },
    fixes: [],
    docs: "docs/diagnostics/README.md#amb-e005",
    engine,
  };
}

/**
 * `@boundary` is an explicit trust declaration (DESIGN.md §4.6). Two ways to
 * write one that does nothing, both reported rather than accepted:
 * a missing `reason`, and no contract to trust in its place.
 */
function diagnoseBoundary(
  propagated: PropagatedFunction,
  engine: DiagnosticEngine,
): readonly Diagnostic[] {
  const { summary } = propagated;
  if (summary.boundary.kind === "invalid") {
    return [
      {
        id: "AMB-E006",
        severity: "error",
        category: "boundary",
        message: `${displayName(summary.id)} declares @boundary "${summary.boundary.raw}", which does not give the required reason= (DESIGN.md §4.6)`,
        location: summary.location,
        fixes: [],
        docs: "docs/diagnostics/README.md#amb-e006",
        engine,
      },
    ];
  }
  if (summary.boundary.kind !== "declared") return [];
  // An `@effects` that failed to parse is already AMB-E002's business; saying
  // "no @effects" on top of it would name the wrong problem.
  if (summary.declared.kind !== "none") return [];

  return [
    {
      id: "AMB-E007",
      severity: "error",
      category: "boundary",
      message: `${displayName(summary.id)} declares @boundary but no @effects, so its body is not checked and nothing was declared in its place`,
      location: summary.location,
      fixes: [],
      docs: "docs/diagnostics/README.md#amb-e007",
      engine,
    },
  ];
}

function diagnoseBudget(
  propagated: PropagatedFunction,
  engine: DiagnosticEngine,
): readonly Diagnostic[] {
  const { summary } = propagated;
  if (summary.budget.kind !== "invalid") return [];
  return [
    {
      id: "AMB-E008",
      severity: "error",
      category: "budget",
      message: `${displayName(summary.id)} declares @budget "${summary.budget.raw}", which is not a space-separated list of timeMs/costUsd/llmCalls limits with an optional onExceed=throw|warn|abort`,
      location: summary.location,
      fixes: [],
      docs: "docs/diagnostics/README.md#amb-e008",
      engine,
    },
  ];
}

/**
 * DESIGN.md §4.4: 「エントリポイントは `@entrypoint` と `@capabilities` を…
 * 明示する。未指定は unknown 相当として警告」. An entrypoint is where the
 * runtime establishes a capability context; one with no capability set
 * establishes nothing to check against.
 */
function diagnoseEntrypoint(
  propagated: PropagatedFunction,
  engine: DiagnosticEngine,
): readonly Diagnostic[] {
  const { summary } = propagated;
  if (!summary.entrypoint) return [];
  if (summary.capabilities.kind !== "none") return [];
  return [
    {
      id: "AMB-W002",
      severity: "warning",
      category: "capabilities",
      message: `${displayName(summary.id)} is an @entrypoint with no @capabilities, so the runtime has no capability set to establish for it`,
      location: summary.location,
      fixes: [],
      docs: "docs/diagnostics/README.md#amb-w002",
      engine,
    },
  ];
}

function buildExcessDiagnostic(
  propagated: PropagatedFunction,
  declared: ReadonlySet<KnownEffect>,
  excess: ReadonlySet<KnownEffect>,
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
  engine: DiagnosticEngine,
): Diagnostic {
  const { summary } = propagated;

  // Deterministic choice of which excess effect's path to show in `via`:
  // KNOWN_EFFECTS declaration order, not Set iteration/insertion order.
  const primaryEffect = KNOWN_EFFECTS.find((effect) => excess.has(effect));
  const chain = primaryEffect ? witnessChain(summary.id, primaryEffect, state) : [];
  const via = chainToVia(chain, state);

  const fnName = displayName(summary.id);
  const excessList = [...excess].filter((e) => KNOWN_EFFECTS.includes(e));
  const declaredList = declaredContractList(declared).join(", ");

  const message =
    via.length > 0
      ? `${fnName} declares ${declaredList} but calls ${displayName(via[via.length - 1]?.symbol ?? summary.id)} which has effects [${excessList.join(", ")}]`
      : `${fnName} declares ${declaredList} but performs [${excessList.join(", ")}] directly`;

  return {
    id: "AMB-E001",
    severity: "error",
    category: "effects",
    message,
    location: summary.location,
    contract: {
      declared: declaredContractList(declared),
      observed: [...propagated.observed.effects],
      via,
    },
    fixes: buildWidenFix(propagated, declared, excess, state),
    docs: "docs/diagnostics/README.md#amb-e001",
    engine,
  };
}

function buildUnknownDiagnostic(
  propagated: PropagatedFunction,
  declared: ReadonlySet<KnownEffect>,
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
  engine: DiagnosticEngine,
): Diagnostic {
  const { summary } = propagated;
  const chain = unknownWitnessChain(summary.id, state);
  const via = chainToVia(chain, state);
  const fnName = displayName(summary.id);
  const declaredList = declaredContractList(declared).join(", ");

  const message =
    via.length > 0
      ? `${fnName} declares ${declaredList} but calls ${displayName(via[via.length - 1]?.symbol ?? summary.id)} which could not be resolved`
      : `${fnName} declares ${declaredList} but calls something that could not be resolved`;

  return {
    id: "AMB-W001",
    severity: "warning",
    category: "effects",
    message,
    location: summary.location,
    contract: {
      declared: declaredContractList(declared),
      observed: [...propagated.observed.effects],
      via,
    },
    fixes: [],
    docs: "docs/diagnostics/README.md#amb-w001",
    engine,
  };
}

/**
 * A `@effects` tag that failed to parse (`summarize.ts`'s `parseEffectsTag`
 * returned `undefined` — a token that is neither `pure` nor a known effect).
 * Reported instead of the excess/unknown diagnostics above, never alongside
 * them: `summarizeExtractedFiles` already treats this function as
 * undeclared for propagation, so it cannot also carry an observed-vs-declared
 * mismatch.
 */
function buildInvalidEffectsDiagnostic(
  propagated: PropagatedFunction,
  raw: string,
  engine: DiagnosticEngine,
): Diagnostic {
  const { summary } = propagated;
  const fnName = displayName(summary.id);

  return {
    id: "AMB-E002",
    severity: "error",
    category: "effects",
    message: `${fnName} declares @effects "${raw}", which is not "pure" or a known effect name`,
    location: summary.location,
    fixes: [],
    docs: "docs/diagnostics/README.md#amb-e002",
    engine,
  };
}

/** Why the node in question cannot carry a contract, for AMB-E003's message. */
const UNCARRIED_REASON: Record<SkippedFunctionKind, string> = {
  "class-declaration": "a class declaration — the contract belongs on its constructor",
  "getter-setter": "a getter/setter",
  "object-literal-method": "an object-literal member with no stable declaration path",
  "anonymous-default-export": "an anonymous default export",
  "callback-argument": "a callback passed inline as an argument",
  "nested-function": "a function declared inside another function",
  "bodyless-declaration":
    "a declaration with no body (an overload signature, an abstract member, or an ambient declare) — the contract belongs on the implementation that runs",
  other: "a node the analysis does not extract",
};

/**
 * A contract tag written on a function-like node the backend does not extract
 * (DESIGN.md §4.1 permits `@effects` on 任意の関数・メソッド, but only an
 * extracted node has a `SymbolId` to hang one on). Reported rather than
 * dropped, on the same principle as AMB-E002: a declaration that silently does
 * nothing looks like a guarantee and is not one.
 */
export function diagnoseUncarriedContracts(
  uncarried: readonly UncarriedContract[],
  engine: DiagnosticEngine,
): readonly Diagnostic[] {
  return uncarried.map((contract) => ({
    id: "AMB-E003",
    severity: "error",
    category: "effects",
    message: `@${contract.tag} is declared on ${UNCARRIED_REASON[contract.kind]}, which cannot carry a contract — the declaration has no effect${
      contract.configKey
        ? `; declare it in ambit.config.ts under "${contract.configKey}" instead`
        : ""
    }`,
    location: contract.location,
    fixes: [],
    docs: "docs/diagnostics/README.md#amb-e003",
    engine,
  }));
}

/**
 * JSDoc and `ambit.config.ts` declare the same tag for one symbol and the two
 * do not agree (DESIGN.md §4.1: 「同一シンボルに JSDoc と config の両方が
 * あれば JSDoc を優先し、差異を警告する」).
 *
 * A warning, not an error: JSDoc winning is the specified behaviour, so the
 * run is doing the right thing — but a config entry that is being ignored is
 * a declaration the author believes is in force and is not, which is the same
 * failure AMB-E003 exists to prevent. `--strict` does not promote it: the
 * disagreement is between two declarations, not an unverified path.
 *
 * No fix is offered. Which side is wrong is the author's decision — deleting
 * the config entry and rewriting the JSDoc are opposite intentions, and §5.3
 * forbids inventing a candidate to fill the slot.
 */
export function diagnoseContractDivergence(
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
  configPath: string,
  engine: DiagnosticEngine,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const { summary } of state.values()) {
    for (const divergence of summary.divergences ?? []) {
      diagnostics.push({
        id: "AMB-W005",
        severity: "warning",
        category: "effects",
        message: `${displayName(summary.id)} declares @${divergence.tag} as [${divergence.jsDoc}] in JSDoc and [${divergence.config}] in ${configPath}; the JSDoc declaration is the one in force`,
        location: summary.location,
        fixes: [],
        docs: "docs/diagnostics/README.md#amb-w005",
        engine,
      });
    }
  }
  return diagnostics;
}

/**
 * An exact `contracts` key that named no extracted symbol (DESIGN.md §4.1).
 *
 * Same principle as AMB-E003: a declaration that silently applies to nothing
 * reads as a guarantee and is not one. Only *exact* keys are reported — a
 * glob covering a directory this run did not check matches nothing for a
 * reason that is not a mistake, and reporting it would make `ambit check
 * src/domain` noisy in proportion to how much of the project it skipped.
 *
 * A warning rather than an error, and not promoted by `--strict`: the key may
 * name a file outside the directory being checked, which is a normal thing
 * for one config to do.
 */
export function diagnoseUnmatchedConfigKeys(
  keys: readonly string[],
  configPath: string,
  configSource: string,
  engine: DiagnosticEngine,
): readonly Diagnostic[] {
  return keys.map((key) => ({
    id: "AMB-W006",
    severity: "warning" as const,
    category: "effects" as const,
    message: `contracts key "${key}" matches no analyzed declaration; the contract it declares is not in force`,
    location: configKeyLocation(configPath, configSource, key),
    fixes: [],
    docs: "docs/diagnostics/README.md#amb-w006",
    engine,
  }));
}

/**
 * Where a `contracts` key is written in the config file's own text.
 *
 * Found textually rather than by parsing: the config was imported as a
 * module, not parsed into an AST, and a key's line is all a reader needs to
 * find it. Falls back to the file's first character when the key cannot be
 * located (an object built by an expression rather than written literally),
 * which is honest — the key is real, its line is not knowable here.
 */
function configKeyLocation(configPath: string, configSource: string, key: string): SourceLocation {
  const lines = configSource.split("\n");
  for (const [index, line] of lines.entries()) {
    const col = line.indexOf(key);
    if (col < 0) continue;
    return {
      file: configPath,
      line: index + 1,
      col: col + 1,
      endLine: index + 1,
      endCol: col + 1 + key.length,
    };
  }
  return { file: configPath, line: 1, col: 1, endLine: 1, endCol: 1 };
}

/** How a wrapper whose handler could not be reached at all is described. */
const HANDLER_NOT_IN_THIS_FILE =
  "its handler is not a declaration in this file, so there is no JSDoc contract beside it to compare";

/**
 * DESIGN.md §4.4: the contract is written twice — once as `@capabilities` and
 * `@budget` on the handler, once in the `withAmbit(spec, handler)` or
 * `ambitHandler(spec, handler, decode)` beside it. Explicit registration is
 * what §4.4 chose, so the duplication stays; nothing checked that the two
 * agree, and an agent adding `db:write:users` to one of them — or widening
 * `timeMs` in one of them — expanded authority silently.
 *
 * This compares the two **as source**, half by half: the capability set
 * (`AMB-E010`) and the budget (`AMB-E011`) are fixed by the source
 * independently, so one may be comparable when the other is not. §12's
 * 「契約とハンドラの対応付け」 — matching a contract to a handler after a build
 * strips the comments, or after a bundler moves it — stays open, and a half
 * this comparison cannot reach is reported (`AMB-W004`) rather than passed
 * over.
 */
export function diagnoseRuntimeWrappers(
  wrappers: readonly RuntimeWrapper[],
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
  engine: DiagnosticEngine,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const wrapper of wrappers) {
    const handler = wrapper.handler ? state.get(wrapper.handler)?.summary : undefined;
    if (!handler) {
      diagnostics.push(
        uncomparedWrapper(
          wrapper,
          wrapper.unmatchedReason === "handler-not-in-this-file"
            ? HANDLER_NOT_IN_THIS_FILE
            : "its handler could not be matched to an analyzed declaration",
          engine,
        ),
      );
      continue;
    }
    diagnostics.push(...diagnoseWrapperCapabilities(wrapper, handler, engine));
    diagnostics.push(...diagnoseWrapperBudget(wrapper, handler, engine));
  }

  return diagnostics;
}

/** The capability half of §4.4's agreement check. */
function diagnoseWrapperCapabilities(
  wrapper: RuntimeWrapper,
  handler: FunctionSummary,
  engine: DiagnosticEngine,
): readonly Diagnostic[] {
  // A `@capabilities` that did not parse is AMB-E004's business; comparing
  // against a tag Ambit already rejected would name the wrong problem.
  if (handler.capabilities.kind === "invalid") return [];
  if (wrapper.capabilities === undefined) {
    return [
      uncomparedWrapper(
        wrapper,
        "its capability list is not a literal array of strings in the source",
        engine,
      ),
    ];
  }
  if (!handler.entrypoint && handler.capabilities.kind === "none") {
    return [
      uncomparedWrapper(
        wrapper,
        `${displayName(handler.id)} declares neither @entrypoint nor @capabilities, so there is nothing to compare the spec against`,
        engine,
      ),
    ];
  }

  const declared =
    handler.capabilities.kind === "declared"
      ? handler.capabilities.capabilities.capabilities.map(formatCapability)
      : [];
  const wrapped = [...wrapper.capabilities];
  if (sameCapabilityText(declared, wrapped)) return [];

  return [
    {
      id: "AMB-E010",
      severity: "error",
      category: "capabilities",
      message: `${wrapper.wrapper} grants [${wrapped.join(", ")}] but ${displayName(handler.id)} declares @capabilities [${declared.join(", ")}]`,
      location: wrapper.location,
      contract: {
        declared,
        required: wrapped,
        excess: wrapped.filter((capability) => !declared.includes(capability)),
        via: [],
      },
      fixes: [],
      docs: "docs/diagnostics/README.md#amb-e010",
      engine,
    },
  ];
}

/**
 * The budget half of §4.4's agreement check.
 *
 * Its own id rather than AMB-E010's: that diagnostic's `contract` field is
 * capability text (`declared` / `required` / `excess`), and a budget
 * disagreement has nothing honest to put in it.
 */
function diagnoseWrapperBudget(
  wrapper: RuntimeWrapper,
  handler: FunctionSummary,
  engine: DiagnosticEngine,
): readonly Diagnostic[] {
  // A `@budget` that did not parse is AMB-E008's business, for the reason an
  // invalid `@capabilities` is AMB-E004's.
  if (handler.budget.kind === "invalid") return [];
  if (wrapper.budget === undefined) {
    return [
      uncomparedWrapper(
        wrapper,
        "its budget is not an object literal of literal limits in the source",
        engine,
      ),
    ];
  }

  const declared = handler.budget.kind === "declared" ? handler.budget.budget : undefined;
  const wrapped =
    wrapper.budget.kind === "literal" ? withDefaultOnExceed(wrapper.budget) : undefined;
  if (sameBudget(declared, wrapped)) return [];

  return [
    {
      id: "AMB-E011",
      severity: "error",
      category: "budget",
      message: `${wrapper.wrapper} sets ${describeBudget(wrapped, "budget")} but ${displayName(handler.id)} declares ${describeBudget(declared, "@budget")}`,
      location: wrapper.location,
      fixes: [],
      docs: "docs/diagnostics/README.md#amb-e011",
      engine,
    },
  ];
}

/**
 * The spec's budget with `onExceed` defaulted, so the two sides are comparable.
 *
 * `parseBudgetTag` already writes `throw` into a `@budget` that omits it, so
 * the JSDoc side has no absent state; leaving the spec's key absent would make
 * `@budget timeMs=500` and `{ timeMs: 500 }` disagree over a policy both sides
 * apply identically. The numeric limits are not defaulted: there `timeMs=500`
 * against no `timeMs` is a real disagreement.
 */
function withDefaultOnExceed(budget: Extract<WrapperBudget, { kind: "literal" }>): Budget {
  return {
    ...(budget.timeMs === undefined ? {} : { timeMs: budget.timeMs }),
    ...(budget.costUsd === undefined ? {} : { costUsd: budget.costUsd }),
    ...(budget.llmCalls === undefined ? {} : { llmCalls: budget.llmCalls }),
    onExceed: budget.onExceed ?? DEFAULT_ON_EXCEED,
  };
}

/** Field-by-field equality; a limit present on one side only is a disagreement. */
function sameBudget(a: Budget | undefined, b: Budget | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.timeMs === b.timeMs &&
    a.costUsd === b.costUsd &&
    a.llmCalls === b.llmCalls &&
    a.onExceed === b.onExceed
  );
}

function describeBudget(budget: Budget | undefined, label: string): string {
  return budget === undefined ? `no ${label}` : `${label} ${formatBudget(budget)}`;
}

function uncomparedWrapper(
  wrapper: RuntimeWrapper,
  reason: string,
  engine: DiagnosticEngine,
): Diagnostic {
  return {
    id: "AMB-W004",
    severity: "warning",
    category: "capabilities",
    message: `${wrapper.wrapper} here was not compared with a declared contract: ${reason}. The check is on the source only (DESIGN.md §4.4)`,
    location: wrapper.location,
    fixes: [],
    docs: "docs/diagnostics/README.md#amb-w004",
    engine,
  };
}

/** Set equality over the capability text as written; order is not part of the contract. */
function sameCapabilityText(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function chainToVia(
  chain: readonly SymbolId[],
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
): readonly ContractViaEntry[] {
  return chain.map((id) => {
    const location = state.get(id)?.summary.location;
    return { symbol: id, file: location?.file ?? "", line: location?.line ?? 0 };
  });
}

/** `["pure"]` for the declared empty set, matching DESIGN.md §5.1's example; the known effects otherwise. */
function declaredContractList(
  declared: ReadonlySet<KnownEffect>,
): readonly (KnownEffect | "pure")[] {
  return declared.size === 0 ? ["pure"] : [...declared];
}
