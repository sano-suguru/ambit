# Open questions

What Ambit has **not** decided. This file is separate from
[`docs/DESIGN.md`](DESIGN.md) so that the specification carries only what is
guaranteed: a reader must not have to tell a rule from a question by reading
carefully.

A question that has been answered leaves this list. The answer goes in the
`docs/DESIGN.md` section that now specifies it, and the reasoning in
[`docs/adr/`](adr/README.md).

Nothing here is a known defect. A defect that can be fixed is fixed, not
recorded (`AGENTS.md`, Defects).

**Every entry carries a trigger** — the observation that would make it worth
deciding. An entry with no trigger is a wish, and a list of wishes is where work
goes to be forgotten; delete it, or file it as an issue. The trigger is also the
exit: when it fires, the question is decided, the answer goes in the
`docs/DESIGN.md` section that now specifies it, and the entry leaves this file.

## Analysis

- **Type assertions and non-null assertions.** `as any` and `!` are not treated
  identically. The rule for when the type survives but the contract-level callee
  is not determined is unsettled.
  *Trigger:* a corpus target where `as any` and `!` produce measurably
  different unresolved counts.
- **`pure` and accessors.** How far a property reference `o.x` — which can
  trigger a getter and run arbitrary code — should be treated as a call.
  Obtaining type API information is not a proof of purity.
  *Trigger:* a getter with a real side effect appearing in the corpus, or an
  `AMB-E001` traced to one.
- **Nested function declarations and the locality rule.** `docs/DESIGN.md` §4.1
  says `@effects` attaches to "any function or method", and §5.3's `"."`-joined
  declaration path has a spelling for a nested one (`outer.inner`). The backend
  does not index them, so a call to a nested function is `unresolved-symbol` —
  measured at roughly 500 call sites over `test/corpus/corpus.json`. Indexing
  them is not mechanical, because §4.2's locality rule reads the mutation
  target's root relative to *the function being summarized*: a `const` array
  allocated in `outer` and pushed to from `inner` is a local mutation seen from
  `outer`, and a "binding of an enclosing function", hence `state_write`, seen
  from `inner`. Indexing `inner` would propagate a `state_write` back into
  `outer` that the same rule says `outer` does not have. Which reading is the
  contract has to be settled before the ids are minted.
  *Trigger:* already fired — roughly 500 corpus call sites. Blocked on the
  reading above, not on evidence.
- **JSDoc limits and symbol identification.** (1) Notation for object-literal
  members with no identifier name (computed, string, or numeric keys), and for
  names that can collide with the declaration path's joiner `"."`. These cannot
  be named even in config and remain in AMB-E003 and in `--coverage`'s skipped.
  (2) Whether to resolve the asymmetry `docs/DESIGN.md` §4.1 (a) left — JSDoc
  can syntactically be written on getters and anonymous default exports with a
  declaration path, yet is not adopted. Resolving it requires first deciding how
  to fix JSDoc's attribution uniquely.
  *Trigger:* an `AMB-E003` on a shape a config key also cannot name.
- **Indirect calls in frameworks.** The call paths of Express, NestJS's DI,
  Next.js, and Hono. How far dedicated stubs and entry-point declarations can
  absorb them.
  *Trigger:* an adopter's framework whose handlers do not resolve.
- **`unknown` fatigue.** Beyond per-directory `strict`, the total volume of
  warnings and the measurement denominator in practice.
  *Trigger:* an adopter turning `--strict` off rather than fixing what it
  reports.
- **Monorepos.** Multiple tsconfigs, project references, config discovery,
  `unknown` at project boundaries, and update propagation.
  *Trigger:* an adopter with a monorepo.

## Runtime

- **Coverage and fragility of runtime hooks.** (1) By what approach to add the
  unhooked `mysql2`, `@prisma/client`, `drizzle-orm`, `mongodb`, and LLM SDKs —
  for Prisma, because `$extends` cannot express a restore, the approach itself
  is undecided. (2) Tracking library updates: there is no mechanism for
  detecting that a replacement point (`Pool.prototype.query` and the like)
  changed upstream, and supported versions are merely written in
  [`docs/limitations.md`](limitations.md). (3) The installation procedure for
  each `worker_threads` worker and for child processes.
  *Trigger:* an adopter whose enforced path uses one of these clients or
  workers.
- **Mapping contracts to handlers.** (1) The registration procedure for
  execution paths with no adapter (BullMQ, `worker_threads`, CLI entry points).
  (2) How the agreement check should handle a registration whose `spec` and
  handler are in different files — currently excluded from comparison via
  `AMB-W004`.
  *Trigger:* `AMB-W004` firing on an adopter's registrations.
- **Edge runtimes.** Phase 1 guarantees Node.js only. For anything else, state
  explicitly whether runtime enforcement exists.
  *Trigger:* an adopter deploying an enforced route to Edge.
- **Precision of budget blocking.** The guaranteed range for price-table
  updates, reserving limits, parallel calls, reconciling actuals, work that does
  not support cancellation, and calls with no obtainable upper bound.
  *Trigger:* `costUsd` being implemented at all — today nothing prices a call.
- **Gaps in entry-point granularity.** Per-function capabilities within a single
  request are statically checked only, by default. Confirm the trade-off with an
  adopter.
  *Trigger:* an adopter asking for a capability check inside a request.

## Toolchain and platform

- **Conditions for revisiting the backend decision.** Two of `docs/DESIGN.md`
  §3.5's three conditions are things to watch rather than to decide: all 12
  subpaths of the native API's entry points are still published under
  `unstable/*`, and daily dev builds go out on `next` behind `latest`. The third
  is Ambit's own work — re-run gates 3 and 4 once §6.2's resident path exists.
  *Trigger:* any of §3.5's three named conditions.
- **TypeScript version compatibility.** (1) How far 6.0.3 can read a TS 7-side
  tsconfig: it rejects with TS5023 a tsconfig containing `deduplicatePackages`,
  which only 7.0.2 accepts, so under that configuration `ambit check` does not
  start; whether to turn this into a diagnostic is undecided. (2) Whether to
  carry a second backend as a product — meaningful only once §3.5's conditions
  are met.
  *Trigger:* an adopter whose tsconfig `ambit check` refuses to start on.
- **The rule for tracking the analysis engine's version.** The version is "the
  latest stable release of the JS-implementation line that leaves the counts of
  `pnpm test` / `tsc --noEmit` / `biome ci` / `check src` and `check
  realistic-api` unchanged". When to re-evaluate that rule is undecided.
  *Trigger:* a JS-line release the rule would reject.
- **Separating the build compiler from the analysis engine.** `docs/DESIGN.md`
  §3.1 states that the target language's compatibility, the build compiler, and
  the analysis engine's version are managed separately, but in `package.json` a
  single `typescript` serves both `tsc --noEmit` and `legacy-ts.ts`. Because
  `legacy-ts.ts` passes `ts.version` straight into a diagnostic's
  `engine.version`, updating only the build tsc can silently change the engine
  string. Separation by a second npm alias was **rejected on measurement**:
  `typescript@7` also declares `bin: { tsc }`, so installing it under an alias
  still takes `node_modules/.bin/tsc` ([`docs/measurements/m0.5-backend-comparison.md`](measurements/m0.5-backend-comparison.md),
  gate 5). If separation becomes necessary, take a different route.
  *Trigger:* a diagnostic's `engine.version` observed changing without the
  analysis engine changing.
- **The deadline for tracking the baseline runtime's LTS.** `docs/DESIGN.md`
  §3.1's baseline runtime is a single Active LTS (Node.js 24 as of 2026-09).
  Node.js 24 moves to Maintenance LTS on 2026-10-20 and Node.js 26 becomes
  Active LTS on 2026-10-28 ([Node.js Release
  Schedule](https://github.com/nodejs/Release)). By that date, either complete
  verification on Node.js 26 together with the move of `engines` /
  `@types/node` / CI, or explicitly decide anew to keep 24 as the baseline while
  it is in Maintenance LTS. Left alone, the policy that "the baseline runtime is
  the Active LTS" simply stops holding.
  *Trigger:* **2026-10-20**, a date, not an observation.
- **Editor integration.** Which of a Language Service Plugin, an LSP connection,
  or a thin editor extension to take.
  *Trigger:* someone asking for diagnostics in an editor. Until then this is M4
  work with no design question in it, and is a candidate for deletion from this
  file.
- **Fix candidates and the diagnostic schema.** The representation for when a
  concrete patch cannot be generated safely, when a type diagnostic carries no
  contract information, and for analysis failures.
  *Trigger:* a consumer reading `fixes` programmatically — `ambit agent`, or an
  adopter's own tooling.
