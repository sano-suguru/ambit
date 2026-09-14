# Open questions

What Ambit has **not** decided. This file is separate from
[`docs/DESIGN.md`](DESIGN.md) so that the specification carries only what is
guaranteed: a reader must not have to tell a rule from a question by reading
carefully.

A question that has been answered leaves this list. The answer goes in the
`docs/DESIGN.md` section that now specifies it, and the reasoning in
[`docs/adr/`](adr/README.md).

Nothing here is a known defect. A defect that can be fixed is fixed, not
recorded (`AGENTS.md`, Defects). Nor is anything here work whose design is
already settled and which is waiting only to be built: that is an issue, not a
question.

**Every entry carries a trigger** — the observation that would make it worth
deciding. An entry with no trigger is a wish, and a list of wishes is where work
goes to be forgotten; delete it, or file it as an issue. The trigger is also the
exit: when it fires, the evidence is read. If it decides the question, the
answer goes in the `docs/DESIGN.md` section that now specifies it and the entry
leaves this file; if it does not, the entry says what was missing and names the
observation that would supply it.

Each entry is the question and its trigger, plus the current state and the
evidence where there is more to say than the question itself. A long history belongs in the measurement or ADR it links to, not
here.

## Analysis

- **What `kind: "authority"` records are called, now that they carry more than
  authority.** §5.1's record gained `unresolved` (§6.4,
  [ADR-0012](adr/0012-reporting-an-unresolvable-gain.md)), which is explicitly
  *not* authority — it is what the analysis failed to read. The field belongs on
  the record, because `ambit diff` compares base and head records and the
  comparable state has to travel with them; what no longer holds is the reading
  that an authority record contains only authority. Renaming is not free —
  `kind` and the field names are §9.2's NDJSON surface — and one field does not
  pay for the churn.
  *Trigger:* a second non-authority field being added to the record. The rename
  is then decided together with whatever that field is.
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
- **Nested function declarations and the locality rule.** Whether a function
  declared inside another function's body should get a symbol id, a contract,
  and a summary of its own.
  *Current state:* it has none. A contract tag on it is `AMB-E003`, and
  `--coverage` counts it as skipped `nested-function`. Its calls are not lost: a
  call from inside the enclosing function's body is walked into that function's
  summary and tallied as inlined, not `unresolved-symbol`.
  What blocks giving it an id is a reading, not evidence. §4.2's locality rule
  reads the mutation target's root relative to *the function being summarized*:
  a `const` array allocated in `outer` and pushed to from `inner` is a local
  mutation seen from `outer`, and a "binding of an enclosing function", hence
  `state_write`, seen from `inner`. Indexing `inner` would propagate a
  `state_write` back into `outer` that the same rule says `outer` does not have.
  Which reading is the contract has to be settled before ids are minted.
  *Trigger:* an adopter who needs to declare a contract on a nested function and
  gets `AMB-E003`. The earlier trigger — roughly 500 corpus call sites reported
  `unresolved-symbol` — was measured before those calls were inlined and no
  longer describes the cost.
  *Evidence:* [coverage and latency](measurements/2026-09-11-coverage-and-latency.md)
  (inlining); `nested-function` skipped counts on
  [immich](measurements/2026-09-11-second-third-party-validation-immich.md) and
  [outline](measurements/2026-09-11-third-third-party-validation-outline.md).
- **JSDoc limits and symbol identification.** (1) Notation for object-literal
  members with no identifier name (computed, string, or numeric keys), and for
  names that can collide with the declaration path's joiner `"."`. These cannot
  be named even in config and remain in AMB-E003 and in `--coverage`'s skipped.
  (2) Whether to resolve the asymmetry `docs/DESIGN.md` §4.1 (a) left — JSDoc
  can syntactically be written on getters and anonymous default exports with a
  declaration path, yet is not adopted. Resolving it requires first deciding how
  to fix JSDoc's attribution uniquely.
  *Trigger:* an `AMB-E003` on a shape a config key also cannot name.
- **Whether an inline argument-position function should be named one at a
  time.**
  *Current state:* every such function in a file is analyzed under one entry,
  `file.ts#<inline callbacks>`, compared as a multiset over the bodies it owns
  (`docs/DESIGN.md` §4.1 (a), §6.3). No per-body name survived: a position, an
  ordinal, a registration's literal argument, and a per-file set were each
  rejected ([ADR-0013](adr/0013-the-inline-callback-owner.md)).
  What a name would still buy is **attribution**. Authority moving from one body
  to another leaves every count where it was, so it is not an increase and
  cannot be made one without taxing a plain reorder (§6.3's third criterion).
  §6.4's third shape reports that the bodies cannot be matched — "something
  moved", not "this handler gained it". A name would turn that one report into
  one increase and one decrease.
  *Trigger:* an adopter for whom the file-level report is not reviewable, or a
  measured case where the git diff does not identify the handler.
  *Evidence:* [inline-callback owner](measurements/2026-09-11-inline-callback-owner.md),
  [HTTP route key spike](measurements/http-route-key-spike.md).
- **Indirect calls in frameworks.** The call paths of Express, NestJS's DI,
  Next.js, and Hono. How far dedicated stubs and entry-point declarations can
  absorb them. NestJS's decorator DI and class inheritance were measured and
  cost nothing (immich); what is left is the registration shape above.
  *Trigger:* an adopter's framework whose handlers do not resolve.
- **What environment `ambit diff` reconstructs.** Both sides are analyzed
  against the *working tree's* `node_modules` (§6), so a change that upgrades a
  dependency analyzes the base commit's source against the new package's types.
  That is deliberate — it is what keeps a difference in environment out of a
  report about contracts — but it means `diff` answers "what did this source
  change let the code do", not "what can the code do now that it could not
  before". Authority a dependency *upgrade* introduces has no answer here, and
  §8's supply-chain work assumes one.
  *Trigger:* `ambit sbom` or "a dependency update widens effects" (`ROADMAP.md`,
  M4) being implemented, or an adopter reporting an upgrade whose authority
  change `diff` did not name.
- **`unknown` fatigue.** Beyond per-directory `strict`, the total volume of
  warnings and the measurement denominator in practice.
  *Trigger:* an adopter turning `--strict` off rather than fixing what it
  reports.
- **Monorepos.** Multiple tsconfigs, project references, config discovery,
  `unknown` at project boundaries, and update propagation, when the checked
  directory is a workspace **root**: which tsconfig is found there, which
  `node_modules` below it the base side needs, and how project boundaries are
  reported.
  *Current state:* a package *inside* a workspace is decided and specified —
  `ambit diff <ref> <subdir>` links `node_modules` from the repository root down
  to the checked directory (§6).
  *Trigger:* an adopter running `ambit diff` at a workspace root.
  *Evidence:* [immich](measurements/2026-09-11-second-third-party-validation-immich.md)
  (the subdirectory case).
- **What would reopen architecture C for the resident path (ADR-0014).**
  *Current state:* No-Go. The cost side is established — contract-only narrowing
  (ADR-0015) leaves `project-update` dominant on a contract edit, and
  `createProgram` + `getTypeChecker` dominate a small update on the two
  dependency-heavy subjects — but the frequency side is not: nothing measured
  says leaf and contract-only updates are the common case on a 500+-file
  project, and whole rebuilds, which C does not touch, dominated this
  repository's own sessions. The first of the earlier reopen conditions fired
  on 2026-09-13 and was read on 2026-09-14 as insufficient for exactly that
  reason. Why TypeScript reports no structure reuse on a leaf edit there is also
  unexplained.
  *Trigger:* a measured editor or agent session on a 500+-file adopter project
  where leaf or contract-only updates are the common case; or an explanation of
  the missing structure reuse showing compiler-side reuse can be made to pay
  without a caching host. Another repository chosen here does not fire it.
  *Evidence:* [resident benchmark](measurements/2026-09-13-resident-benchmark.md),
  [JSDoc narrowing](measurements/2026-09-13-resident-jsdoc-narrowing.md),
  [this repository's workload](measurements/2026-09-13-resident-workload.md),
  [large-project workload](measurements/2026-09-14-resident-large-workload.md).
- **Whether a project file outside the checked root must rebuild everything.**
  Under what conditions an edit to such a file provably leaves every in-root
  extraction and checker answer unchanged, and whether checking those
  conditions is cheaper than the rebuild.
  *Current state:* §6.2 requires the rebuild. A candidate sufficient condition
  survived 36 adversarial probes and then failed its falsification pass: a
  reference directive in the outside file can reclassify a file already in the
  program (`isSourceFileFromExternalLibrary`, `isSourceFileDefaultLibrary`)
  without moving any text, and Ambit reads both. Whether a revised candidate
  that also compares those per-file attributes and redirect status is complete
  is open.
  *Trigger:* a goal that runs the attacks the pass did not (redirects, `.tsx`
  implicit imports, symlinks, NodeNext/CJS, checker-internal ordering) against
  the revised candidate first.
  *Evidence:* [outside-root invalidation design](measurements/2026-09-13-outside-root-invalidation-design.md);
  the cost on this repository, in
  [this repository's workload](measurements/2026-09-13-resident-workload.md).

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

- **TypeScript version compatibility.** (1) How far 6.0.3 can read a TS 7-side
  tsconfig: it rejects with TS5023 a tsconfig containing `deduplicatePackages`,
  which only 7.0.2 accepts, so under that configuration `ambit check` does not
  start; whether to turn this into a diagnostic is undecided. (2) Whether to
  carry a second backend as a product — meaningful only once §3.5's conditions
  are met.
  *Trigger:* an adopter whose tsconfig `ambit check` refuses to start on.
- **`baseUrl` and a bare specifier: whose resolution should an effect analysis
  follow?** `typescript@6.0.3` applies the deprecated `baseUrl` fallback to a
  bare specifier under `moduleResolution: Bundler`; `typescript@7.0.2` does not.
  With `baseUrl` set to drizzle-orm's source root, 6.0.3 resolves
  `import { Connection } from 'mysql2'` inside `src/mysql2/session.ts` to
  drizzle's own `src/mysql2/` directory and the receiver reads `any`, while
  7.0.2 reaches the installed package. Both answers are defensible: the
  project's own `tsc` resolves the way 6.0.3 does, and a bundler at runtime the
  way 7.0.2 does. Ambit reports what a call site *does*, which argues for the
  runtime answer; Ambit also has to agree with the type check the project
  already runs, which argues for the other.
  *Current state:* undecided. What is not undecided is that a project setting
  `baseUrl` with a source directory named after a dependency — the ordinary
  shape of an adapter layer — is analyzed differently by the two backends.
  *Trigger:* any of §3.5's conditions for revisiting the backend decision, since
  TypeScript 7 cannot be more than a shadow until this is settled; or an adopter
  whose `baseUrl` shadows a dependency.
  *Evidence:* [any-typed divergence](measurements/2026-09-12-any-typed-divergence.md).
- **Whether a non-contract JSDoc tag's text is carried faithfully.** On `hono`,
  `@see https://developers.cloudflare.com/...` is extracted as
  `see://developers.cloudflare.com/...` by `typescript-legacy@6.0.3` and
  correctly by the TypeScript 7 shadow backend — 16 `function` divergences
  across `hono` and `trpc-server`. It reaches no contract tag and no diagnostic,
  so no verdict changes today. Undecided is whether the raw text of a
  non-contract tag is something Ambit promises to carry at all, or only the
  five tags §9.2 names — which decides whether this is a bug in the adopted
  backend or a property of a field nobody reads.
  *Trigger:* anything in the product — a diagnostic, a fix candidate, or a
  consumer of the exported types — reading a non-contract tag's text.
  *Evidence:* [TS7 shadow hardening](measurements/2026-09-12-ts7-shadow-hardening.md),
  defect 5.
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
- **Fix candidates and the diagnostic schema.** The representation for when a
  concrete patch cannot be generated safely, when a type diagnostic carries no
  contract information, and for analysis failures.
  *Trigger:* a consumer reading `fixes` programmatically — `ambit agent`, or an
  adopter's own tooling.
