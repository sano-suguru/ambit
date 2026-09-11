# `ambit diff` against a third-party backend, measured

Run on 2026-09-11, Node.js v24.20.0, macOS (darwin arm64), Apple M1, from this
repository. `docs/status.md` carries the conclusions; this file carries the run.

The question was one `docs/status.md` had no evidence for: **could a real
third-party TypeScript backend use `ambit diff` as a CI signal today?** Every
number below was produced by running the commands shown, against a repository
nobody here wrote, chosen before any of it was measured.

## The subject

`Unleash/unleash@044461b` — an AGPL feature-flag server: TypeScript, Node.js,
Express, PostgreSQL through `knex`, outbound HTTP through `ky`, its own CI and
test suite. Cloned shallow, `pnpm install --ignore-scripts` (31.4 s, exit 0),
and **not modified** except by the four experiments below, each reverted before
the next. `src/lib` was the checked directory: 596 files, 3,523 functions.

It was chosen as a credible adopter profile, not as an easy subject — a
class-per-store architecture with every client injected, which is the shape the
analysis turned out to be blindest to.

## Baseline, before any change to Ambit

```sh
node src/cli/main.ts check src/lib --coverage   # exit 0, 5.52 s
node src/cli/main.ts diff HEAD src/lib          # exit 0, 11.59 s
```

| | |
|---|---|
| diagnostics | none — the repository declares no contracts, so nothing can be violated |
| `unknown` rate | 71.0% (2,500/3,523) |
| call sites | 16,491 — resolved 5,177, stub **120**, pure 2,719, mutation 1,166, unresolved **7,259** |
| unresolved by reason | `external-module` 4,223, `unresolved-symbol` 2,546, `any-typed` 231 |
| top unresolved names | `stopTimer` 125, `stop` 46, `getLogger` 44, `then` 35, `express.Express.use` 32 |
| `diff HEAD` on the untouched tree | **no increase**, 3,523/3,523 unchanged |

Two facts to read off this. The untouched tree produces **no** false increase,
so the gate has no standing noise — that is what makes the rest worth measuring.
And 120 stubbed call sites out of 16,491 in a server whose every store talks to
PostgreSQL is not a coverage gap in the tables; it is a naming gap, which the
next section isolates.

### Onboarding friction

Nothing had to be configured, annotated, or excluded. `ambit check <dir>` finds
the project's own `tsconfig.json` by walking up, and `diff` symlinks the working
tree's `node_modules` into the base worktree, so both sides resolve the same
packages. Two things an adopter would notice: the repository's `tsconfig.json`
does not exclude `*.test.ts`, so 236 test-side functions are analyzed with
everything else and there is no `include`/`exclude` in `ambit.config.ts` to
narrow that; and with no contracts written, `check` reports nothing at all —
`diff` is the only command that says anything about an unannotated codebase.

## The four experiments

Each is a separate edit an AI coding agent might plausibly make, applied alone
to the clean tree, measured with `diff HEAD src/lib`, then reverted. E1–E3 add a
new module called from `TagService.getTags`, two hops below the HTTP controller.

| | change | before the fix | after |
|---|---|---|---|
| E1 | `fetch(…)` in a new helper module | **exit 1**, 3 entries, full path to `operation: fetch` | unchanged |
| E2 | the same call through `ky`, the client this repository actually uses | **exit 0 — missed** | **exit 0 — still missed** |
| E3 | `node:fs.writeFileSync` + `node:child_process.execSync` | **exit 1**, 6 entries (3 symbols × 2 effects) | unchanged |
| E3b | the same two calls imported as `from 'fs'` / `'child_process'` | **exit 0 — missed** | **exit 0 — still missed** |
| E4 | `await this.db(TABLE).where({…}).del()` inside an existing *read* method | **exit 0 — missed, silently** | **exit 1**, 1 entry, `operation: knex.QueryBuilder.del` |

E2 and E3b were closed the same day, in a follow-up change; the section at the
end of this file carries that run. E4 is the one that matters. The edit adds a destructive database write to a
method named `getAll`, and the comparison printed *3,523 symbols unchanged, out
of 3,523 symbols compared* — not even the "could not resolve" note, because the
symbol was already `unknown` before the edit and stayed `unknown` after it.

E1 and E3 show what the gate is worth when the operation *is* named: the
increase is reported on the controller as well as on the leaf, with the hop that
introduced it. The cost is one approval line per (symbol × effect) — six lines
for E3's one edit.

## The cause, isolated

Probed apart from Unleash, on a scratch project with a real `pg` installed —
`pg` being a package Ambit already ships rules for — one `query` call written
five ways:

| receiver | before | after |
|---|---|---|
| module-scope `const pool = new Pool()` | `pg.Pool.query` → `db_read` | unchanged |
| function-local `const pool = new Pool()` | `pg.Pool.query` → `db_read` | unchanged |
| class field `private pool = new Pool()` | **`unknown`** | `pg.Pool.query` → `db_read` |
| constructor-injected `constructor(pool: Pool)` | **`unknown`** | `pg.Pool.query` → `db_read` |
| function parameter `(pool: Pool)` | **`unknown`** | `pg.Pool.query` → `db_read` |

So this was never a missing-`knex`-rules problem. A name was built only from a
receiver's *origin* — an import, a `const` holding `new <ImportedClass>`, a
`const` holding an imported factory's result — and a client a class is *handed*
has no such origin. The bundled `pg`, `mysql2` and Prisma rules were unreachable
in the shape most server code is written in.

## The change

One rule, in `src/checker/backend/legacy-ts.ts`: where no origin names the
receiver, name it from its **declared type**, when every declaration of that
type is a class or interface a package declares — inside a `declare module "…"`,
or in a `.d.ts` from `node_modules` whose `package.json` supplies the name. The
chain is walked toward its root and the root-most named receiver wins, so the
key keeps the shape the client table already uses. It is withheld wherever the
callee's own declaration is the compiler's lib, which is what keeps
`arr.map(…)` on the pure-builtin path.

The package half of the name is the directory the declaration resolved through
(`…/node_modules/knex/types/index.d.ts` → `knex`), not the `name` in the
package's own manifest. That is the same answer the existing origin rules give
for a receiver whose origin *is* an import — an aliased install is named by its
alias in both — and it keeps the whole naming path off the filesystem.

Ten `knex.QueryBuilder.*` rows followed, admitted by the table's own rule —
names that measurement surfaced. Only the verbs that fix a direction:
`where` / `join` / `orderBy` appear in read and write chains alike and stay
`unknown` rather than being guessed at.

`from` is the one row that is a table clause rather than a verb, so it was
measured instead of argued: **166** `knex.QueryBuilder.from` sites in `src/lib`,
of which **4** sit anywhere near a write verb. Three of those four are
`select(…).from(…)` subqueries *inside* a delete's `whereNotIn` — reads, and
correctly named as such. The fourth is a `from` belonging to the delete itself,
in a function that reads in the same statement through those subqueries, so the
row contributes no effect that function does not already hold. 165 of 166 are
plain reads.

## After

```sh
node src/cli/main.ts check src/lib --coverage   # exit 0
node src/cli/main.ts diff HEAD src/lib          # exit 0
```

| | before | after |
|---|---:|---:|
| stub call sites | 120 | **940** |
| unresolved call sites | 7,259 | **6,439** |
| `external-module` | 4,223 | **3,403** |
| `unknown` rate | 71.0% | **71.0%** |
| `check src/lib` | 5.11–5.71 s | 5.53–5.72 s |
| `diff HEAD src/lib` | 11.53–11.91 s | 11.72–12.48 s |
| `diff` on the untouched tree | no increase | **no increase** |

Latency is three runs of each, the two builds interleaved on the same machine
so the comparison is not between a quiet minute and a busy one — the machine was
not quiescent, and a single run of either side lands anywhere in a 3 s band. The
rule costs a type query per member chain that no origin named, which shows as a
few percent and is not separable from the noise at this sample size.

Top unresolved names, after: `knex.QueryBuilder.where` 448,
`knex.QueryBuilder.leftJoin` 128, `stopTimer` 125, `express.Response.status`
121, `knex.QueryBuilder.whereIn` 118.

**The `unknown` rate did not move at all**, and that is the honest reading of
what naming buys: a function keeps `unknown` while *one* call in it is
unresolved, so 820 newly-stubbed call sites changed no function's verdict. What
changed is that the authority is now *visible as authority* — which is what
`diff` compares — and that the histogram now names the packages an adopter would
have to cover next instead of reading `stopTimer`.

Regression checks: `pure` call sites on Ambit's own source went 562 → 569 and
`builtin-method` stayed 13, so nothing proven effect-free was taken off that
path. `diff HEAD src` over Ambit itself reports **no** authority increase: the
package name is derived from the resolved path rather than by reading a
`package.json`, so the naming rule adds no `fs_read` to the extraction path and
needs no memo to stay cheap. An earlier draft that read the manifest did both,
and Ambit's own gate priced it at 19 approval lines — which is how the cheaper
rule was found. `node scripts/bench-corpus.ts` median is **52.6%, unchanged** — the corpus
installs no dependencies, so no receiver there has a package type to read.
`pnpm test` 504 passing, `tsc --noEmit` pass, `biome ci .` pass,
`check src --coverage` exit 0.

## What is still missed, and was not fixed

Recorded, deliberately not addressed in the same change:

- **HTTP clients other than `fetch`, `undici` and `ky`.** `axios` and `got`
  are named at the call site and covered by no table, so outbound HTTP through
  either is invisible. The general problem is that HTTP clients are as
  unbounded as DB clients; what decides a row is measurement, not popularity,
  and neither has been measured against a backend that uses it.
- **`knex`'s own root.** `Knex` is an interface merged with a namespace, which
  the naming rule refuses, so `db.select(…)` is unnamed while the `from(…)` that
  follows it is named.
- **Approval-line count.** One edit costs one line per (symbol × effect): E3's
  single edit needs six.
- **`installedPackageNameOf` assumes a `node_modules` layout.** Yarn PnP, and
  any other resolver that does not lay packages out in directories, names
  nothing — the same answer the rule gives for a receiver it cannot place,
  not a wrong one. The path parsing itself is unit-tested against a flat
  install, pnpm's virtual store, a nested `node_modules`, a scope, `@types`,
  and a Windows separator.
- **A gain the analysis cannot resolve has no line.** Stated carefully, because
  the obvious wider claim is false: a *known* effect added inside an `unknown`
  symbol **does** fail. E4 after the fix is the proof — `TagStore.getAll` is
  `unknown` on both sides (its `this.timer(…)` and `this.db.select(…)` calls
  never resolve) and the added `del()` still exits 1. What is compared is the
  effect set, and being `unknown` beside it changes neither side.

  What has no line is the *unresolvable* gain, in two shapes. Base known, head
  `unknown`: printed as `unknownGained`, exit 0 by §6's exit table. Base already
  `unknown`, head `unknown` with more unresolved operations inside it: nothing
  at all, because a symbol carries a boolean rather than the set of operations
  behind it. E2 and E3b were both the second shape when they were measured; the
  follow-up below gave both an operation the tables name, so what is left in
  this shape is an operation no table names at all (`axios`, `got`).

  **The noise of the missing signal was measured**, since that is what decides
  whether it can be a gate. Per-symbol multisets of unresolved call identities
  were compared across three ranges of this repository's own history:

  | range | files changed in `src/lib` | symbols that gained an unresolved operation |
  |---|---:|---:|
  | `957c2e4^..957c2e4` (one PR) | 3 | 1 |
  | `8550a1f^..8550a1f` (one PR) | 8 | 2 |
  | `HEAD~20..HEAD` (20 commits) | 12 | 3 |

  It fires proportionally to the change rather than to the 71% `unknown`
  surface, and on `HEAD~20..HEAD` the three symbols are **disjoint** from the
  three `unknownGained` already names — so it is additional signal, not a
  restatement. Not implemented here: it is a change to §6.3's model and to §6's
  exit table, which is §9.2 surface. Filed with these numbers in
  [`docs/open-questions.md`](../open-questions.md).

## Follow-up, same day: E2 and E3b closed

The two misses above that were operations no bundled table named. Same
checkout (`Unleash/unleash@044461b`, cloned again and installed the same way),
same commands, same machine.

**The change.** Seven `ky` rows in `src/stubs/node-builtins.ts` with the
matching capability rules beside them, and one lookup rule: a builtin's module
specifier is read under both of its spellings, because `from "fs"` and `from
"node:fs"` cannot be different modules — Node resolves a bare builtin specifier
to the builtin before it looks at `node_modules`. The normalization covers the
builtins a bundled table has a row for and nothing else, so a specifier no
table answers (`os`, `path`, `crypto`) keeps the spelling its source wrote in
the coverage histogram, and the *reported* operation is still the source's own
spelling (`operation: fs.writeFileSync`).

The ky rows were read off `ky@1.14.3`'s own types and source, not assumed:
`KyInstance`'s call signature is `(url, options)`, and `ky[method]` merges
`{method}` **last** (`validateAndMerge(defaults, options, {method})`), so
`ky.post(url, {method: "get"})` still POSTs — the request-method rows therefore
ignore the options object, while the bare call reads it as `fetch` does.
`create` and `extend` return an instance and send nothing, so they have no row
and stay `unknown`. `axios` and `got` were left out: no measurement has
surfaced them, which is the same rule every other row in these tables was
admitted under.

**Coverage on the untouched tree.**

| | before this follow-up | after |
|---|---:|---:|
| stub call sites | 940 | **953** |
| unresolved call sites | 6,439 | **6,426** |
| `external-module` | 3,403 | **3,390** |
| `unknown` rate | 71.0% (2,500/3,523) | **71.0% (2,500/3,523)** |
| `diff HEAD src/lib` on the untouched tree | no increase | **no increase** |

Thirteen call sites, and again no movement in the `unknown` rate: a function
stays `unknown` while any one call in it is unresolved, and these thirteen sit
in functions that have other unresolved calls. What changed is that the
authority is visible as authority, which is what `diff` compares.

**The two experiments, re-run.** Each applied alone to the clean tree, measured
with `diff HEAD src/lib`, then reverted.

| | change | before | after |
|---|---|---|---|
| E2 | `ky.post(…)` in a new module called from `TagService.getTags` | exit 0 — missed | **exit 1**, 4 entries |
| E3b | `writeFileSync` + `execSync` imported `from 'fs'` / `'child_process'` | exit 0 — missed | **exit 1**, 6 entries |

E3b now reports exactly what E3 reported for the prefixed spelling: six entries
(3 symbols × 2 effects), up to `TagController.getTags`, naming
`operation: fs.writeFileSync` and `operation: child_process.execSync` — the
source's spelling, at the leaf that introduced it. E2 reports the effect and the capability
on the new symbol and on the caller, with `operation: ky.post` and
`+ capability http:post:telemetry.example.com` read off the literal URL. The
bare call was measured as well, since it is the shape this repository's
`addon.ts` uses: `ky(url, {method: 'POST'})` reports
`operation: ky.default` with the same capability, the method read from the
options object. Both names are pinned in-repo by
`test/fixtures/http-clients`, which declares `ky` locally rather than
installing it — a `declare module` and an installed package produce the same
key.

Regression checks: `pnpm test` 524 passing, `tsc --noEmit` pass, `biome ci .`
pass, `check src --coverage` exit 0 with `pure` 569 → 573 and `stub` unchanged
at 19 (the two new functions in `src/stubs/` account for the rise; nothing
proven effect-free was taken off that path). `node scripts/bench-corpus.ts` was run on
both builds and its output is byte-identical, down to the `unresolved-by-reason`
breakdown: median **52.6%**, and per target hono 52.6%, trpc-server 59.7%,
elysia 51.7%, got 54.6%, drizzle-orm 39.0%. The corpus is not silent on the
spelling — eleven un-prefixed builtin imports occur across three of its targets
(`http` 8, `net` 2, `fs` 1) — but they are type-only imports or reach members
no table has a row for (`createServer`, `EventEmitter`), so not one call site
changed classification. No target there uses `ky`.

## Follow-up, same day: the unresolvable gain, implemented and measured

The miss recorded above under "A gain the analysis cannot resolve has no line"
— §6.4's second shape — implemented as
[ADR-0012](../adr/0012-reporting-an-unresolvable-gain.md) decides it: the
authority record carries the multiset of operations a function's own body could
not resolve, `ambit diff` reports a gain in it, and `--strict` is what makes it
fail.

Same checkout (`Unleash/unleash@044461b`, cloned again and installed the same
way, `pnpm install --ignore-scripts`), same machine. "Before" is
`ambit@671fd51` — the commit this change is built on — run from a `git
worktree` of this repository against the identical tree, so the two columns
differ only in Ambit.

**The untouched tree.** The property the whole gate rests on.

```sh
node <ambit>/src/cli/main.ts diff HEAD src/lib            # exit 0
node <ambit>/src/cli/main.ts diff HEAD src/lib --strict   # exit 0
```

Both print the same four lines and nothing else:

```text
base HEAD (044461b) vs the working tree, over src/lib

No authority increased.

3523 symbols unchanged, out of 3523 symbols compared.
```

Zero standing noise, with the flag and without it. `check src/lib --coverage`
is **byte-identical** between the two builds, down to the
`unresolved-by-reason` breakdown: `unknown` rate 71.0% (2,500/3,523), 6,426
unresolved call sites, 953 stub. The field is additive and the analysis did not
move.

**Twenty commits of the subject's own history.**

```sh
node <ambit>/src/cli/main.ts diff HEAD~20 src/lib   # exit 1 on both builds
```

The two outputs differ by exactly the new section and the tally under it;
the authority half is byte-identical, and the exit code is 1 on both — from the
one unapproved increase, not from anything new.

| | before | after |
|---|---:|---:|
| authority increased, unapproved | 1 | 1 |
| `unknownGained` (shape 1) | 3 | 3 |
| gained an unresolvable operation (shape 2) | — | **3** |
| symbols unchanged | 3,519 | 3,516 |
| exit code | 1 | 1 |

**Three symbols** — the number measured before the design was written, over the
same range, by comparing per-symbol multisets by hand. The identity key the
implementation settled on (`(reason, qualified name)`, no position, counts
kept) reproduces it, and the three are disjoint from the three `unknownGained`
already names, as they were then. What they name:

```text
3 symbols gained an operation the analysis could not resolve:

  …#PersonalDashboardReadModel.getPersonalFeatures (…:112)
    ? <unnamed> (any-typed)
    ? knex.QueryBuilder.modify x2 (external-module)
  …#ProjectReadModel.getProjectsByUser (…:269)
    ? knex.QueryBuilder.modify (external-module)
  …#ProjectReadModel.getProjectsFavoritedByUser (…:299)
    ? knex.QueryBuilder.modify (external-module)
```

The tally moved 3,519 → 3,516 because `unchangedSymbols` counted these three as
unchanged while the section above named them — a footer contradicting the body.
Fixed in the same change.

`--strict` over the same range exits 1 and adds two lines saying which of the
two runs the reader is looking at; nothing else in the output changes.

### E5: an outbound call through a client no table covers

The case §6.4 exists for, and the one the earlier section recorded as invisible.
`superagent` — installed in this repository, covered by no bundled table — added
to `TagStore.getAll`, the method E4 used, `unknown` on both sides before and
after.

```ts
async getAll(): Promise<ITag[]> {
    const stopTimer = this.timer('getAll');
    await superagent.get('https://telemetry.example.com/tags');   // added
    const rows = await this.db.select(COLUMNS).from(TABLE);
    …
```

| | before | after |
|---|---|---|
| `diff HEAD src/lib` | **exit 0, "3523 symbols unchanged, out of 3523"** — silent | exit 0, **1 symbol named**, with the operation |
| `diff HEAD src/lib --strict` | **exit 2** — `ambit: diff does not support --strict (diff takes --format text or github)` | **exit 1** |

After:

```text
1 symbol gained an operation the analysis could not resolve:

  db/tag-store.ts#TagStore.getAll (db/tag-store.ts:43)
    ? superagent.get (unresolved-symbol)

This is not authority (DESIGN.md §4.3), so no approval covers it and none is
asked for. What closes it is a stub, a verifiable declaration, or explicit
isolation behind @boundary (§4.3, §6.4).
```

The reason is `unresolved-symbol` rather than `external-module`: the call goes
through `superagent`'s default export, which follows to no single declaration.
Recorded as measured — the report is keyed on whatever reason the analysis
actually gave, and does not depend on which one it is.

### E2 re-run: the working gate, unchanged

`ky.post` in a new module called from `TagService.getTags` — the edit whose
shape the follow-up above closed. Run on both builds against the same tree:
**byte-identical output, exit 1 on both.** Six entries (3 symbols × 2
authorities: `network` and `capability http:post:telemetry.example.com`), up
through `TagService.getTags` to `TagController.getTags`, naming
`operation: ky.post`. Nothing appears in the §6.4 section, because `ky`
resolves and the gain is authority.

This is the assertion that matters most here. §6.4 had to be added **beside**
the authority comparison and not inside it: a classification that moved any part
of a working gate into a reported-only box would have traded a failing build for
a paragraph. It did not — three separate comparisons (`HEAD`, `HEAD~20`, E2)
produce identical authority halves on the two builds.

### Latency

Three runs of each, interleaved on the same machine, `diff HEAD src/lib`:
before **14.9 / 18.4 / 17.6 s**, after **20.3 / 17.8 / 15.5 s**. The bands
overlap and the machine was not quiescent; nothing separable at this sample
size. The work added is one pass over each function's existing call list.

### Regression checks

`pnpm test` 546 passing (527 before; 19 are new, in
`test/unresolved-gain.test.ts`), `tsc --noEmit` pass, `biome ci .` pass,
`check src --coverage` exit 0 with `unknown` rate 37.6% (127/338) and
`unresolved-by-reason` unchanged, `diff HEAD~1 src` exit 0.
`node scripts/bench-corpus.ts` median **52.6%, unchanged**, per target hono
52.6%, trpc-server 59.7%, elysia 51.7%, got 54.6%, drizzle-orm 39.0%.

### What is still missed, and was not fixed

- **`@boundary` is the only exit under `--strict` for an uncovered package.**
  §4.3's three routes are a declaration, a stub, or `@boundary`, and an adopter
  cannot write the stub: `ambit.config.ts` names symbols in the checked tree,
  not in `node_modules`. E5's `superagent.get` has no answer short of
  `@boundary` on `TagStore.getAll`, which says more than the edit did. This is
  why the flag is opt-in, and it is in
  [`docs/limitations.md`](../limitations.md) rather than left to be discovered.
- **A nameless operation is reported as `<unnamed>`.** `HEAD~20`'s first symbol
  gained one (`any-typed`). It is a true report — an operation the analysis
  could not read was added — but it names nothing a reader can act on, and no
  stub can ever close it. Left as measured rather than filtered: excluding a
  reason would read part of an unresolved surface as safe.
