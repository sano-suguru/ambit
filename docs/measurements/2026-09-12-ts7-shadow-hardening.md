# TypeScript 7 shadow backend — hardening the instrument

- Date: 2026-09-12 (same day as
  `docs/measurements/2026-09-12-ts7-shadow-analysis.md`, which this continues)
- Engines: `typescript-legacy@6.0.3` (adopted, DESIGN.md §3.5 / ADR-0001) and
  `typescript-native@7.0.2` (shadow only, installed into `.m05-native/`)
- Host: Node 24.20.0, darwin/arm64

**This does not reopen the §3.5 backend decision, and nothing here argues for
TypeScript 7.** The adopted backend remains the sole authority for diagnostics,
exit codes, CI decisions and review outcomes; nothing under `src/` loads the
shadow backend, `ambit check` has no flag that would, and no default changed.
The work is on the *measuring instrument*: what it can see, whether it says so
honestly, and whether anything stops it from silently rotting.

The previous note's own reading was that "there is now a measuring instrument,
and its first reading found three semantic bugs". This note closes the gaps that
reading named, and the summary is the same in shape: the instrument now sees
more, and what it saw was five more defects in the shadow port and one in the
adopted backend.

## Reproduction

```sh
node scripts/m05-native-install.ts                  # typescript@7.0.2 into .m05-native/
node scripts/shadow-analysis.ts src --self-check    # must report zero divergences
node scripts/shadow-analysis.ts src                 # one root, read the report
node scripts/shadow-check.ts                        # the gate, 14 roots vs the baseline
node scripts/shadow-corpus.ts                       # five third-party repositories (network)
node scripts/shadow/profile-requests.ts src         # where the native extraction's time goes
npx vitest run test/shadow.compare.test.ts          # the comparator, without the native engine
```

`scripts/shadow-check.ts --update` re-records `test/shadow/baseline.json`.
`.github/workflows/shadow.yml` runs the gate on demand and weekly; it is not
part of `ci.yml` and installs the native compiler itself, because
`typescript@7` declares `bin: { tsc }` and must never enter this package's
dependency tree.

## Baseline and result

Baseline is `393c648` (the previous note's tree). Divergences / high-risk:

| Root | before | after |
|---|---|---|
| `src` | 137 / 1 | **7 / 4** |
| `test/fixtures/realistic-api` | 138 / 13 | **0 / 0** |
| `test/fixtures/wrappers` | 28 / 12 | **0 / 0** |
| `test/fixtures/backend-smoke` | 27 / 3 | 27 / 13 |
| `test/fixtures/factory-receiver` | 22 / 0 | **0 / 0** |
| `test/fixtures/held-receiver` | 16 / 0 | **0 / 0** |
| `test/fixtures/cross-module` | 12 / 2 | **0 / 0** |
| `test/fixtures/http-clients` | 8 / 2 | **0 / 0** |
| `test/fixtures/backend-conformance` | 7 / 1 | 7 / 4 |
| `test/fixtures/construction` | 3 / 0 | **0 / 0** |
| `test/fixtures/next-app` | 2 / 0 | **0 / 0** |
| `test/fixtures/propagation` | 1 / 0 | **0 / 0** |
| `test/fixtures/contracts` | 2 / 0 | **0 / 0** |
| `--self-check` (adopted vs itself) | 0 | 0 |

**The high-risk counts rose on two roots and that is not a regression.** Risk
detection got stronger — see "Direction is now read off the values" — so shapes
that were already there are now reported at the risk they always carried. On
`src` the four high-risk entries are one call site
(`cli/analyze.ts:91`, `options.backend.extractProject(dir)`) seen from four
dimensions, and all four are classified `not-yet-ported` from a code the
backend itself emitted.

Unchanged, and checked rather than assumed: `src` authority parity **100%**,
authority diff **0 increases, 0 decreases, 0 `unknown` gained, 0 `unknown`
lost**, CI decision agrees, `unknown` rate delta **+0.0 pt** (TS6 38.9%, TS7
38.9%). `node src/cli/main.ts check src --coverage` still exits 0 with
`unknown-rate=38.9% (135/347)`, 1930 call sites, 440 unresolved — no `src/`
file changed, so `scripts/bench-corpus.ts` was not re-run.

### `src` — the seven that remain

| Dimension | Parity | Counts |
|---|---|---|
| functions | **100%** | 347/347 |
| callee resolution | 99.8% | 1897/1901 (differ 4) |
| call-graph edges | 99.8% | 543/544 (ts6-only 1) |
| unresolved classification | 99.9% | 1900/1901 (differ 1) |
| direct effects | 99.9% | 1929/1930 (differ 1) |
| propagated effects / capabilities / authority / diagnostics | **100%** | — |

- **4 high-risk, one site.** `options.backend.extractProject(dir)` is a
  receiver certainly holding one object literal. `resolution:literal-receiver`
  is `NOT_PORTED`, the shadow backend says so at that site, and the divergence
  is classified from that code rather than from its rendered text.
- **3 normal, `shadow-more-unknown`.** `Object.defineProperty` with an opaque
  callback (`runtime/child-process.ts`, `runtime/fs.ts`, `runtime/pg.ts`): the
  shadow side sets `unknownCallback`, the adopted side does not. The shadow
  side is *more* conservative. Root cause still not established, and they are
  deliberately left `unclassified` — a rule invented to tidy them away is
  exactly what the classifier rewrite was meant to stop.

## What was ported, and what each was worth

Ordered as the previous note ordered them, by what each resolves rather than by
count. The first four are the chain `receiver origin → qualified name → stub
lookup → effect → authority`, which is Ambit's product: a backend that cannot
name a receiver cannot match a stub, and a stub it cannot match is an effect it
does not report.

1. **`installedTypeQualifiedNameOf` / `packageTypeNameOf`** — name a receiver by
   the package type it is declared with (`checker: ts.TypeChecker` →
   `typescript.TypeChecker.getTypeAtLocation`). 63 of the previous 137 on `src`;
   `held-receiver` 16 → 0.
2. **`constructedClassQualifiedNameOf` and `factoryResultQualifiedNameOf`** —
   the class a `const` was constructed from, and the type an imported factory
   returned. `factory-receiver` 22 → 0; it also recovers
   `node:async_hooks.AsyncLocalStorage.getStore`, which the installed-type rule
   correctly refuses because `installedPackageNameOf` refuses `@types/node`.
3. **`reExportHopsOf` / `deepestPackageHop`** — follow a named import through
   re-exports. `cross-module` 12 → 0.
4. **The default-import name.** `import ky from "ky"` is `ky.default`, not
   `ky`. This one is worth its own line because it is the whole chain failing in
   one step: `http-clients` had `kind=stub effects=[network]` on the adopted
   side and `kind=unresolved` on the shadow side, and the capability
   `http:post:api.example.test` simply disappeared. It was the only
   `shadow-less-authority` in the fixture corpus that was a *naming* bug rather
   than an unported shape.

**Receiver-origin resolution is security-relevant, and it was verified as such
rather than assumed.** `held-receiver` and `factory-receiver` exist precisely to
put an installed package's client behind a parameter, a class field, an injected
value and a fluent chain; both are at zero, and `http-clients` demonstrates end
to end that an installed-package instance call now recovers the semantic name,
matches the stub, and produces the capability. "Self-hosting authority output is
unchanged" was never the test — on `src` the authority output was *already*
unchanged at 137 divergences.

`NOT_PORTED` is now three shapes: `resolution:literal-receiver`,
`resolution:instance-member`, `project:no-tsconfig-fallback`.

## Defects found and fixed

Each was found by the shadow comparison. Four are in the shadow port; the last
is in the adopted backend and is *not* fixed here.

1. **Runtime wrapper budgets were never read.** The port's keys were
   `calls`/`ms`; DESIGN.md §4.5's are `timeMs`/`costUsd`/`llmCalls`. Every
   budget read as absent, so every wrapper/`@budget` drift went unreported:
   **four AMB-E011 errors missing** on `test/fixtures/wrappers`. That is
   authority enforcement disappearing on the shadow side, and it had been
   invisible.
2. **Diagnostics and wrappers were keyed on their whole rendered line.** A
   difference therefore surfaced as one entry missing and one extra, both
   valued `present`, with no symbol and no location — 16 such pairs on
   `wrappers` said nothing at all. Identity is now the key and content is the
   value. Defect 1 was found the moment this landed, and could not have been
   found before it.
3. **JSDoc block attachment.** The previous note recorded this as "a genuine
   API difference, not a port gap". It was a port gap.
   `ts.getJSDocCommentsAndTags` runs `filterOwnedJSDocTags`, which keeps **only
   the last** block as a `JSDoc` node and reduces every earlier one to its
   `@overload` tags — read in `node_modules/typescript/lib/typescript.js`,
   6.0.3. Taking the last block is the same rule, and it is also the block whose
   tags `getJSDocTags` returns, which is why the two sides already agreed about
   the *tags* while disagreeing about where they were written. Fixed the three
   on `src`, two on `realistic-api`, one on `http-clients`.
4. **`Response.json` came out as `json`.** The lib declares `Response` as a
   `var` of an anonymous object type, so a static member's `getParent()` reaches
   a `__`-named type symbol and the reconstructed name stops one segment short
   where `ts.getFullyQualifiedName` prints both. The pure-builtin and mutating
   tables are keyed on the two-part name, so a call proven effect-free on one
   backend was `unknown` on the other: two high-risk on
   `test/fixtures/next-app`, now 0. The missing segment is taken from the
   receiver's own *symbol*, and only when that symbol is declared in the
   compiler's own lib.
5. **`ts6-suspect`: the adopted backend drops `https:` from a JSDoc `@see`
   URL.** On `hono`, `@see https://developers.cloudflare.com/...` is extracted
   as `see=://developers.cloudflare.com/...` by the adopted backend and
   correctly by the shadow one. It reaches no contract tag and no diagnostic, so
   it changes no verdict today; it is recorded here and in
   `docs/open-questions.md` rather than fixed, because it is in the product
   backend and outside the change this note describes.

## Direction is now read off the values, independently of classification

Previously only the authority-diff dimension could produce
`shadow-less-authority` / `shadow-less-unknown`. Every other dimension — direct
effects, propagated effects, capabilities, callee resolution, runtime wrappers,
diagnostics — rendered both sides to a string and reported any difference as
`value-mismatch` at normal risk. A shadow backend that dropped an effect, or a
wrapper budget, looked exactly like one that spelled a name differently.

Each dimension now carries two sets computed from the facts:

- **authority** — every token whose presence means authority was *reported*: an
  effect, a capability, a stub match, a wrapper budget, an error diagnostic's
  severity. Losing one is DESIGN.md §3.4's forbidden direction.
- **unknown** — every token whose presence means the analysis *admitted it did
  not know*: an `unknown` flag, an unresolved reason, an opaque callback.
  Losing one is the same failure in different clothes.

Order matters: authority loss is checked before `unknown` loss, and both before
either gain, so a pair that loses one and gains another reports the unsafe half.
A pair with no signals stays `value-mismatch` — a real difference whose
direction cannot be decided, which is not the same as a safe one and is not
reported as one.

**Risk is computed before classification and from different inputs.** A rule
written to explain a known gap cannot downgrade a genuine regression that
happens to resemble it. `test/shadow.compare.test.ts` asserts both halves; the
`shadow-less-authority` case now asserts two high-risk entries where it asserted
one, because the same loss is visible as a propagated effect *and* as authority,
and the old rendered-string comparison called the first of those a normal-risk
`value-mismatch`.

One honest limit: the signal is structural, so it flags "the adopted backend
asserted something the shadow one did not" as high-risk even where the shadow
side's answer is conservative. Eight of the corpus high-risk entries are that
shape (`mutation=local|Set.add|` against `builtin=Set.add`, below). Over-flagging
is noise; under-flagging is a missed regression, and §3.4 decides which way to
err.

## Classification reads structured codes, not rendered text

`KNOWN_DIVERGENCES` matched substrings of the rendered pair, so a rule written
for an unported shape could swallow a genuine regression in a shape that *is*
ported. The shadow backend now records, at the point it declines, the
`NOT_PORTED` code for the shape it declined — keyed by location, and indexed by
owning symbol as well so the propagated dimensions (authority, capabilities,
propagated effects), which have a symbol and no location, resolve to the call
site that caused them. `compareFacts` looks the code up first; the substring
rules remain only as a fallback.

Unclassified divergences: `backend-conformance` 3 → 0, `backend-smoke` 15 → 6,
`src` 3 → 3. The `src` three are the `Object.defineProperty` shapes above and
are correctly unclassified: nobody has root-caused them.

**Two ways a structured classifier can repeat the substring one's failure, both
found in review and both fixed.** They are worth recording because the fix for
the first version of this rewrite was itself wrong:

- **The symbol index must not reach a site that has a location of its own.** It
  exists for the propagated dimensions, which carry a symbol and no location. A
  `classify` that consults it for a *call-site* divergence hands
  `not-yet-ported` to every call in a function that happens to contain one
  declined site.
- **A decline must be recorded only where the unported rule would have acted.**
  `resolution:instance-member` walks the constructed class's own members, so a
  receiver holding `new Set()` is not a shape it would have resolved either.
  Recording one there claimed eight genuine `shadow-less-authority`
  disagreements on the corpus as accounted for. The premise is now "a class this
  project declares", and those eight read `unclassified`, which is what they
  are.

`KNOWN_DIVERGENCES` is down to one rule, for the `call-edge` dimension, which
carries a symbol and no location and so cannot reach a structured code. The
three rules that justified themselves with "receiver-origin naming is
`NOT_PORTED`" are deleted: that is no longer true, and one of them was what
classified the real `ky.default` bug as a known gap.

## Performance — the hypothesis, measured

The previous note recorded that the native engine is ~1.8x faster here where
ADR-0001 measured 3–4x, that Ambit's pure-JavaScript downstream is not the cause,
and that "per-query transport cost dominates as query count rises" was **a
hypothesis with no number attached**. `scripts/shadow/profile-requests.ts`
collects the number. The experiment is within-engine on purpose: both sides are
the *native* compiler over `src`, and the only variable is how much is asked.

| | ADR-0001's probe | shadow backend (before these ports) | shadow backend (after) |
|---|---|---|---|
| requests | 2,212 | 11,449 | 14,847 |
| requests per call site | 1.2 | 6.0 | **7.8** |
| server time | 123 ms | 171 ms | 216 ms |
| transport time | 35 ms | 132 ms | **192 ms** |
| transport share of round trip | 22.3% | 43.6% | **47.1%** |
| bytes sent | 304 KB | 1.40 MB | 1.85 MB |

From the probe's walk to this backend's, **requests rose 6.5x, the compiler's own
time rose 1.7x, and time outside the compiler rose 5.5x.** Nearly half of the
native engine's round trip is now spent not computing. That is the hypothesis
confirmed, and it points somewhere specific: a call site currently costs a symbol
lookup, a type, a signature, a declaration resolution and a parent walk, each a
separate crossing, and the shadow backend's own call profile on `src` is
6,486 `getSymbolAtLocation`, 2,350 `getTypeAtLocation`, 1,923 `typeToString`,
1,797 `getSignaturesOfType`, 1,186 `getResolvedSignature`.

The evidence for batching is therefore direct rather than inferred: a coarser
request — one `analyzeCallSite` returning symbol, declaration, signature,
receiver type and origin together — would remove crossings that are 47% of the
cost, and would be worth more than any engine change. **That is an API Ambit
does not have**, and the note stops there: no such API exists on
`typescript@7.0.2`'s `unstable/sync` surface (see "Blocked on the API" below).

Note also what the ports cost: 6.0 → 7.8 requests per call site. Naming a
receiver by its declared package type means a type, a symbol, a declaration
handle and a resolution per chain hop. The parity was worth it and the cost is
recorded rather than hidden.

**These are profiled numbers and are not parity-report numbers.** Unprofiled,
`scripts/shadow-analysis.ts` on `src` reports TS6 717 ms / TS7 396 ms = 0.55x.

## Ecosystem parity — five third-party repositories

The previous note's own verdict was that `src` is "self-hosting parity, not
ecosystem parity, and only the second one says anything about adoption".
`scripts/shadow-corpus.ts` runs the comparison over the fixed corpus in
`test/corpus/corpus.json` — pinned by commit SHA *and* by the git tree object of
each measured subtree, dependencies deliberately not installed. It fetches from
the network and is therefore in no CI job.

| Target | subtree | authority parity | callee resolution | authority diff | `unknown` delta | decision | divergences (high-risk) | ts7/ts6 |
|---|---|---|---|---|---|---|---|---|
| hono | `src` | 99.5% | 99.9% | 0/0, +3 unknown | +0.5 pt | agree | 48 (4) | 0.95x |
| trpc-server | `packages/server/src` | 98.5% | 99.8% | 0/0, +3 unknown | +1.5 pt | agree | 52 (9) | 0.60x |
| elysia | `src` | 99.4% | 99.8% | 0/0, +2 unknown | +0.6 pt | agree | 112 (13) | 1.00x |
| got | `source` | 99.4% | 99.6% | 0/0, +2 unknown | +0.6 pt | agree | 55 (3) | 1.16x |
| drizzle-orm | `drizzle-orm/src` | 100% | 100% | 0/0, +1 unknown | +0.0 pt | agree | 43 (6) | 0.73x |

**Not one corpus divergence lands on a shape the shadow backend declared.** The
`NOT_PORTED` list is now three shapes, and none of the 310 divergences across
these five repositories is on one of them — every single one is unexplained.
That is the most useful thing the corpus said, and it only became visible once
the classifier stopped over-claiming (above): "accounted for" has to mean the
backend said so at that site, or the list of findings is shorter than the
findings.

Three things this says that `src` could not.

- **The direction holds on code nobody here wrote.** Across all five:
  **0 authority increases, 0 decreases, 0 `unknown` lost.** Every difference is
  the shadow side being *more* conservative, and the CI decision agrees
  everywhere. This is the invariant that matters more than any rate.
- **TypeScript 7 is not reliably faster on third-party code.** 0.60x to 1.16x,
  against 0.55x on `src`. The one claim that survives is that it is *sometimes*
  faster; the performance argument for migration is weaker than `src` alone
  suggested, and weaker again than ADR-0001's 3–4x.
- **New divergence classes appear, and they are recorded separately** — see
  below. `scripts/shadow-corpus.ts` prints shapes the backend accounted for and
  shapes nothing accounted for as two lists, because collapsing them is how a
  parity number stops meaning anything.

### Dependencies removed is a different question, and the A/B says so loudly

The corpus installs nothing, and `corpus.json` justifies that with "moves the
measurement in the conservative direction only". For the benchmark it describes
— one backend's `unknown` rate — that is true. **It does not transfer to a
parity measurement**, and the sentence above was quoted into
`scripts/shadow-corpus.ts` where it does not hold. The absent types are exactly
the receiver and type origins the two backends could disagree about, so removing
them hides divergences as readily as it creates them.

`--with-deps` installs what the measured subtree imports, at the ranges the
pinned commit's own manifest declares, into `.corpus/<target>/.deps/` reached
through an untracked symlink. Nothing is written into the pinned tree and no
version is invented; the resolved versions are printed with the result, because
a range like `>=8` is not reproducible the way a tree object is. A `--with-deps`
run is an experiment, never a baseline.

Run on `drizzle-orm` — the corpus target with by far the most external imports,
and the ORM/driver shape where receiver-origin naming decides whether a call is
a `db_read`:

```sh
node scripts/shadow-corpus.ts drizzle-orm            #  43 divergences,   6 high-risk
node scripts/shadow-corpus.ts drizzle-orm --with-deps  # 167 divergences, 138 high-risk
```

| | no deps | with deps |
|---|---|---|
| divergences | 43 | **167** |
| high-risk | 6 | **138** |
| authority parity | 99.96% | 99.89% |
| callee-resolution parity | 99.99% | 99.42% |
| authority diff, increases | 0 | **2** |
| `shadow-less-unknown` | 0 | **105** |

The answer is the opposite of the comfortable one. Stripping dependencies did
not merely inflate a safe-direction count — **it hid an entire unsafe-direction
class.** 105 `shadow-less-unknown` divergences and 2 authority *increases*
appear only with the types present, and every one of them is invisible in the
numbers the table above this section reports.

What they are, read off the values rather than guessed at: the adopted backend
reports `reason=any-typed` where the shadow backend resolves the real package
type.

| ×35 | `reason=any-typed` → `reason=external-module` |
| ---: | --- |
| ×4 | `unresolvedReason=any-typed` → `kind=stub effects=[db_read,db_write] operation=mysql2.Connection.query` |
| ×3 | `unresolvedReason=any-typed` → `name=expo-sqlite.SQLiteStatement.executeSync` |
| ×2 | `unresolvedReason=any-typed` → `name=mysql2.Query.stream` |

`expo-sqlite/session.ts#ExpoSQLitePreparedQuery.all` calls
`stmt.executeSync(…)` on a `stmt: SQLiteStatement` imported from `expo-sqlite`.
TypeScript 7 types that receiver and names the call; TypeScript 6.0.3 types it
`any`. On four `mysql2` sites the consequence is not a name but an effect: the
shadow side matches a stub and reports **`db_read, db_write`** where the adopted
side reports nothing at all.

Three things follow, and the third is the uncomfortable one.

1. **The no-deps corpus understates the divergence by roughly 4x on a
   dependency-heavy target**, and understates high-risk by more than 20x. The
   five-repository table above is a floor, not a measurement of these projects.
2. **`shadow-less-unknown` is correctly flagged high-risk by the rule and is
   not the unsafe case here.** The rule says "the shadow side admitted less",
   which is the right default; the values say the shadow side *knew* more.
   Direction detection erring toward high-risk is what let this surface at all,
   and the fix is to explain these 105, not to soften the rule.
3. **This looks like a `ts6-suspect` on Ambit's own value chain**, and the
   reading was left open here because asserting one of the three candidates —
   a checker difference, module resolution under the corpus tsconfig, or an
   artifact of installing only what the subtree imports — would have been a
   guess.

   **It was the second, and the tsconfig was ours.**
   `docs/measurements/2026-09-12-any-typed-divergence.md` traces one call site
   to its first branch: `corpus.json` gave `drizzle-orm` a `baseUrl` pointing at
   the measured subtree, and `drizzle-orm/src` contains a directory named after
   nearly every driver it supports, so `import … from 'mysql2'` resolved to
   drizzle's own `src/mysql2/` and the receiver read `any`. With `baseUrl`
   removed, `--with-deps` reports **31 divergences and 6 high-risk** — below the
   hermetic arm's 43 rather than four times above it — with
   `shadow-less-unknown` **0** and authority increases **0**. All 105 and both
   increases were manufactured by one line of corpus configuration.

   The numbers in this section are therefore a record of the artifact, not of
   the backends. What survives it is narrower and still worth having: TypeScript
   6.0.3 applies the deprecated `baseUrl` fallback to a bare specifier where
   7.0.2 does not, which is a real difference for any project that sets
   `baseUrl` — and a parity measurement needs its dependencies, which is how
   this was found at all.

### New classes, seen only on third-party code

1. **A locally-owned mutating builtin classifies differently** (8 high-risk
   across hono, trpc-server, elysia). `this.children.add(...)` is
   `kind=mutation operation=Set.add` with `escaping=false` on the adopted side
   and `pureBuiltinName=Set.add` with `reason=builtin-method callbackByReference`
   on the shadow side. Neither produces an effect — a local mutation carries
   none — and the shadow side additionally marks the site `unknown`, so the
   *verdict* is unchanged and conservative. The branch order in the shadow port's
   `builtin-method` handling differs from the adopted backend's; not fixed here.
2. **16 `function/value-mismatch` on hono and trpc-server** are defect 5 above,
   the adopted backend's `@see` URL truncation. The shadow side is right.
3. **7 `call-edge/shadow-extra`** on trpc-server and elysia: the shadow backend
   records a callback-handoff edge the adopted one does not. Direction is
   `shadow-extra`, so it overstates rather than hides. Not root-caused.
4. **204 `unresolved-classification/shadow-more-unknown`** across the corpus,
   the largest class by far and entirely in the safe direction. Not root-caused,
   and the count alone is a reason to: an instrument whose largest signal is
   unexplained is not finished. The full unaccounted tally —
   204 `unresolved-classification/shadow-more-unknown`,
   19 `direct-effect/shadow-less-authority`, 16 `function/value-mismatch`,
   14 `callee-resolution/shadow-more-unknown`, 11 each of
   `authority`/`capability`/`propagated-effect` `shadow-more-unknown`,
   8 `callee-resolution/shadow-less-authority`,
   8 `unresolved-classification/shadow-less-authority`,
   7 `call-edge/shadow-extra`, 1 `direct-effect/shadow-extra`.

## Protection

`scripts/shadow-check.ts` compares 14 roots against `test/shadow/baseline.json`
and fails on any increase in high-risk divergences, unclassified divergences, or
divergences overall; on the two backends ceasing to agree about the CI decision;
and on the shadow side's `unknown` rate falling relative to the adopted one. It
runs the self-check first and refuses to proceed if the adopted backend diverges
from itself. Improvements never fail it — a gate that punished progress would be
an argument for leaving the numbers alone — and `--update` records them.

It cannot live in `pnpm test`, because the native compiler cannot be a
dependency. `.github/workflows/shadow.yml` is `workflow_dispatch` plus weekly,
installs the compiler into `.m05-native/`, runs the self-check and the gate, and
uploads the JSON reports. It is opt-in and it changes no product outcome: a red
run there is never a reason to doubt `ambit check`.

## Blocked on the API

**A coarse per-call-site query does not exist.** `typescript@7.0.2`'s
`unstable/sync` `Checker` exposes only per-question methods
(`getSymbolAtLocation`, `getTypeAtLocation`, `getResolvedSignature`,
`getSignaturesOfType`, …), and a `NodeHandle` must be `resolve()`d before its
source file can be read. There is no batched or compound request, so the 47%
transport share above cannot be reduced from the consumer side. Minimal
reproduction: `node scripts/shadow/profile-requests.ts src` — the probe's 1.2
requests per call site against this backend's 7.8, on one engine and one tree.
Smallest next step: ask upstream for a compound call-site query, or measure
whether `API`'s snapshot can answer several questions per crossing; nothing here
should fake it by caching an answer the compiler did not give.

**A per-method request profile is not available from the API.**
`getTimingInfo()` returns running totals plus a ring buffer of the five most
recent requests (`RECENT_REQUEST_CAPACITY = 5` in its `dist/api/timing.js`), so
a run making thousands cannot be broken down by method from the API's own log.
Worked around by counting locally with a proxy on the `Checker` and `Program`;
the totals still come from the API.

**The adopted backend's checker cannot be profiled from outside.**
`typescript@6.0.3` exports `createProgram` as a **non-configurable getter**, on
the CommonJS exports object and through Node's ESM bridge alike, so its checker
cannot be wrapped. Counting its calls would take a profiling seam inside
`src/checker/backend/legacy-ts.ts`, and the backend is the product. The legacy
side is timed here and not counted, which is why the performance experiment was
made within-engine instead.

## Remaining blockers, in order

1. ~~**Settle the `any-typed` disagreement first**~~ — done, and it was the
   corpus. See `docs/measurements/2026-09-12-any-typed-divergence.md`.
2. **Re-measure the corpus with `--with-deps` before trusting any of its
   counts**, including the 204 below. On `drizzle-orm` the dependency-resolved
   arm is now *below* the hermetic one (31 against 43), which is the direction
   it should move in; the other four have not been measured with their
   dependencies present, and each one's generated tsconfig is part of the
   measurement.
3. **Root-cause the 204 `unresolved-classification/shadow-more-unknown`** across
   the corpus. Safe direction, largest class, unexplained — and until it is
   explained, "the shadow side is more conservative" is a description rather
   than a finding.
4. **The locally-owned mutating builtin branch order** (class 1 above). Eight
   high-risk entries that are not actually unsafe; fixing the port would remove
   them and make the remaining high-risk count mean what it says.
5. **Port `resolution:literal-receiver` and `resolution:instance-member`.** The
   last two `NOT_PORTED` shapes and all four of `src`'s high-risk entries.
6. **`ts6-suspect`: the `@see` URL truncation** in the adopted backend. It
   changes no verdict today, which is exactly why it will keep not being fixed
   unless it is written down. It is, in `docs/open-questions.md`.
7. **The call-site key is still `(symbol, location, ordinal)`.** Two calls at one
   position in a different source order between backends would pair incorrectly;
   the self-check cannot catch it, and nothing has shown it.

Only after 1–3 is there anything further to say about TypeScript 7, and the thing
to say would still be about ecosystem parity rather than about `src`.

What the A/B changes about the shape of this work is worth stating plainly. The
remaining question is no longer "how much of the adopted backend is still
unported". `NOT_PORTED` is three shapes and none of them appears anywhere in the
corpus. The question is **how much of the difference between two TypeScript
implementations can be explained semantically** — and one of the answers so far
points at the adopted backend, not at the shadow one.
