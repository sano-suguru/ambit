# A second third-party backend: `immich-app/immich`, `server/`

Run on 2026-09-11, Node.js v24.20.0, macOS (darwin arm64), Apple M1, 8 cores,
16 GiB, from this repository. Ambit pinned at `ad70a25` for every
"before" column.

The question this run exists to answer is **not** whether immich passes. It is
whether the product lessons from the first third-party validation
([2026-09-11 Unleash](2026-09-11-third-party-diff-validation.md)) generalize to
a backend with a different architecture, or whether they were Unleash-shaped.
The subject was selected, and the rationale below written, **before any Ambit
command was run against it.**

## The subject

`immich-app/immich@2a626220415ea4f22da6846e26d37852664254bf`
(`2a626220`, 2026-09-10, "feat: NestJS 12 and ESM (#31237)"), AGPL, a
self-hosted photo and video backup server. The checked package is `server/`
— its `src/` is 548 TypeScript files.

```sh
git clone --depth 50 --filter=blob:none https://github.com/immich-app/immich.git immich
cd immich && git rev-parse HEAD    # 2a626220415ea4f22da6846e26d37852664254bf
pnpm install --ignore-scripts --filter immich... --config.strict-peer-dependencies=false
```

### Why it is independent of Ambit

`grep -ril ambit` over the checkout matches exactly one line: an integrity
hash inside `pnpm-lock.yaml` that happens to contain the letters. No source,
config, documentation, or dependency in immich refers to Ambit; immich has no
`ambit.config.ts`, no `ambit.approvals.md`, and no contract JSDoc tags. It is
not in `test/corpus/corpus.json`, so no measurement in this repository has ever
been taken against it and no rule here was written with it in view. The
revision predates this run by one day and was not chosen for its contents —
`HEAD` of the default branch at clone time.

### Why it complements Unleash

Required: differ from Unleash on at least two of five axes. It differs on all
five.

| axis | Unleash `044461b` | immich `2a626220` |
|---|---|---|
| framework / runtime | Express 4, hand-wired services, CommonJS | **NestJS 12** with decorator DI, **ESM** (`"type": "module"`, `module: nodenext`) |
| persistence | `knex` query builder over PostgreSQL | **`kysely`** + **`postgres`** (postgres.js) + `pg`, via `nestjs-kysely` DI |
| queue / cache | none | **`bullmq`** job queues on **`ioredis`**, `@socket.io/redis-adapter` |
| external SDK profile | `ky` for outbound HTTP | `sharp`, `fluent-ffmpeg`, `exiftool-vendored`, `nodemailer`, `openid-client`, `socket.io`, `@extism/extism`, OpenTelemetry SDK |
| repository structure | single package, checked at `src/lib` | **pnpm workspace monorepo** (`server`, `web`, `e2e`, `packages/**`, …); the checked package is a *subdirectory* with its own `tsconfig.json` and its own `node_modules` |

Three of those five are deliberately *not* covered by any bundled table.
`src/stubs/data-clients.ts` has rows for `pg`, `mysql2`, `knex` and
`@prisma/client`; it has none for `kysely`, `postgres`, `ioredis` or `bullmq`.
That is the point: the selection rule was to pick a repository whose authority
Ambit would have to earn, not one its tables already answer. The `pg` in
immich's dependency list is a transport under `kysely`, not the call shape its
repositories are written in.

Two further properties made it the pick over the runner-up (`outline/outline`
— Koa, Sequelize, Bull, `@aws-sdk/client-s3`, yarn):

- **It is the shape the first validation was blindest to, at a larger dose.**
  Unleash's lesson was that a client a class is *handed* had no name. NestJS is
  constructor injection as an architecture, not as a convention — so it is a
  direct test of whether that fix generalizes or was knex-shaped.
- **Its authority is genuinely varied.** A media server does filesystem and
  child-process work as its core job (`fluent-ffmpeg`, `exiftool-vendored`,
  `sharp`, upload paths), not incidentally. Unleash's filesystem authority was
  injected by the experiments; immich's is native.

Comparable scale keeps the comparison legible rather than turning it into a
scale test: 548 source files against Unleash's 596.

### Toolchain notes taken before running

- immich pins `typescript: npm:@typescript/typescript6@^6.0.2` — the same
  JS-implementation line Ambit's engine is pinned to (6.0.3), not TypeScript 7.
- `server/tsconfig.json` declares `"types": ["vitest/globals"]` — **not**
  `["node"]`. `AGENTS.md` records that TypeScript 6 stopped auto-including
  `node_modules/@types/*`. Whether Node builtin specifiers resolve under this
  configuration is measured below, not assumed.
- `experimentalDecorators` and `emitDecoratorMetadata` are on; `paths` maps
  `src/*` and `test/*`.
- The monorepo root's `node_modules` contains only `prettier`. Every dependency
  of the checked package is under `server/node_modules`.

## Onboarding friction

`pnpm install --ignore-scripts --filter immich...` took **24.8 s**, exit 0, and
installed only the checked package's dependency closure. Nothing had to be
configured, annotated, or excluded for `ambit check` to run: it walked up from
`server/src` and found `server/tsconfig.json` on its own.

Four things an adopter would notice, none of them requiring a change to immich:

- **No contracts means `check` says nothing.** `check server/src` exits 0 with
  zero diagnostics, because the repository declares no `@effects` anywhere.
  `diff` is again the only command with anything to say about an unannotated
  codebase. Same as Unleash.
- **Tests are analyzed with everything else, but contribute almost nothing.**
  105 `*.spec.ts` files live under `server/src` and there is no
  `include`/`exclude` in `ambit.config.ts` to narrow that, so all of them go
  through the analysis — yet only **20** of them produce a record at all, for
  **30** functions out of 3,061. A vitest spec's bodies sit inside
  `describe(…)` / `it(…)` callback arguments, which §4's skip list counts as
  `callback-argument`; they are most of this repository's 4,141 such skips.
  Unleash's 236 analyzed test-side functions were mocha-shaped and counted the
  same way; the exposure is the same and the volume is not.
- **The only DB client Ambit has a table for is unreachable here.** `pg@8.23.0`
  is installed, but it ships no type declarations and immich does not install
  `@types/pg` — it reaches PostgreSQL through `kysely` and `postgres`. So
  `src/stubs/data-clients.ts`'s `pg.*` rows cannot fire in this repository at
  all, and its four covered clients (`pg`, `mysql2`, `knex`, `@prisma/client`)
  cover **zero** of immich's persistence call sites.
- **`"types": ["vitest/globals"]` does not break Node builtin resolution here,
  but only by accident.** `AGENTS.md` records that TypeScript 6 no longer
  auto-includes `node_modules/@types/*`. Compiled in isolation against immich's
  own `tsconfig.json`, a file containing `import { existsSync } from 'node:fs'`
  fails with *"Cannot find name 'node:fs' … add 'node' to the types field"*,
  and no `@types/node` file is in the program. In the **whole** program it
  resolves, because third-party declarations under `server/node_modules` pull
  `@types/node` in transitively — `ioredis`'s `.d.ts` files each open with
  `/// <reference types="node" />`, and so do others. So immich's Node builtin
  typing is reachable only through its installed dependencies, which is
  precisely what the base worktree does not get; the root cause below rests on
  this.

## Baseline, Ambit `ad70a25`, no repository-specific anything

Two trees were measured, and the difference between them is the headline
finding, so both are stated up front.

- **(M) the monorepo as cloned** — git root is the monorepo root, the checked
  directory is `server/src`. This is what an immich contributor would run.
- **(P) a package-rooted control** — the identical `server/` tree, at the same
  revision, in a git repository whose root *is* `server/`, with the same
  `node_modules`. Built by `git archive HEAD server | tar -x --strip-components=1`
  into a fresh `git init`, with `node_modules` symlinked in and gitignored. It
  exists only to isolate one variable: where `node_modules` sits relative to the
  git root.

### `check server/src --coverage` — identical on both trees

```sh
node <ambit>/src/cli/main.ts check server/src --coverage   # exit 0, 11.2 s
```

| | |
|---|---|
| diagnostics | none — the repository declares no contracts |
| files / functions | 460 / 3,061 — 460 being the files that carry a record, out of 548 `.ts` on disk |
| `unknown` rate | **79.5% (2,432/3,061)** |
| `boundary` rate | 0.0% |
| entrypoints | 0 |
| skipped | 4,387 (callback-argument 4,141, object-literal-method 160, nested-function 83, getter-setter 1, bodyless-declaration 2) |
| call sites | 15,041 — resolved 4,339, **stub 116**, pure 1,608, inlined 36, mutation 460, **unresolved 8,482** |
| unresolved by reason | `external-module` 7,738, `unresolved-symbol` 455, `callback-parameter` 157, `builtin-method` 119, `any-typed` 11, `dynamic-import` 2 |

The `check` output is byte-identical between (M) and (P), which is the control
working: `check` never builds a base worktree, so the two trees differ for it in
nothing at all.

### High-fan-out unresolved operations

```text
kysely.RawBuilder.execute            1902
kysely.SelectQueryBuilder.where       720
kysely.SelectQueryBuilder.select      499
kysely.Kysely.selectFrom              215
kysely.SelectQueryBuilder.$if         206
new @nestjs/common.BadRequestException 136
kysely.SelectQueryBuilder.innerJoin   131
kysely.SelectQueryBuilder.execute     127
kysely.ExpressionBuilder.selectFrom   125
kysely.SelectQueryBuilder.whereRef     96
```

**Every name in the top ten is a receiver the analysis named from its declared
type** — the rule the Unleash run added. None of these receivers has an origin:
`this.db` is `@InjectKysely() private db: Kysely<DB>`, a constructor-injected
client, and the builders after it are the return types of its methods. Before
that rule the histogram here would have read like Unleash's did, with local
identifier names at the top. That is the first generalization result, and it is
a positive one.

The second is finer and matters for what a stub table could ever do:
**kysely's stage types keep the read/write direction in the name.**
`selectFrom` returns `SelectQueryBuilder`, `deleteFrom` returns
`DeleteQueryBuilder`, `insertInto` returns `InsertQueryBuilder`. So
`kysely.DeleteQueryBuilder.execute` and `kysely.SelectQueryBuilder.execute` are
different keys, and a future table could give one `db_write` and the other
`db_read` without guessing — which is exactly what knex's shared
`QueryBuilder.where` could not do, and why `where` / `join` / `orderBy` were
left out of the knex rows. Recorded as an observation; no rows were added (see
the decision at the end).

### `diff` on the **untouched** tree — the finding

```sh
# (P) package-rooted control
node <ambit>/src/cli/main.ts diff HEAD src            # exit 0
node <ambit>/src/cli/main.ts diff HEAD src --strict   # exit 0
```

```text
base HEAD (9e67bf5) vs the working tree, over src

No authority increased.

3061 symbols unchanged, out of 3061 symbols compared.
```

```sh
# (M) the monorepo as cloned
node <ambit>/src/cli/main.ts diff HEAD server/src            # exit 1
node <ambit>/src/cli/main.ts diff HEAD server/src --strict   # exit 1
```

```text
base HEAD (2a62622) vs the working tree, over server/src

257 authorities increased without approval:
…
1182 symbols gained an operation the analysis could not resolve:
…
1737 symbols unchanged, out of 3061 symbols compared.
```

| | (P) package root | (M) monorepo |
|---|---:|---:|
| authority increases, unapproved | **0** | **257** |
| symbols with an unresolvable gain | 0 | **1,182** |
| symbols unchanged | 3,061 / 3,061 | 1,737 / 3,061 |
| exit, `diff` | **0** | **1** |
| exit, `diff --strict` | **0** | **1** |
| report length | 5 lines | **7,927 lines** |

Effects in the 257: `fs_read` 209, `fs_write` 20, `process` 19, `state_write`
6, `env` 3. No `network`, no capability lines.

`diff HEAD~20 server/src` on (M) is the same report to within one line — 257,
1,182, 1,737 again, across a range that touches 443 files including the NestJS
12 / ESM migration. The noise is not proportional to the change; it is the
whole signal.

### Root cause, isolated

`src/cli/worktree.ts`'s `addWorktree` symlinks exactly one directory into the
base checkout:

```ts
const installed = path.join(repoRoot, "node_modules");
if (existsSync(installed)) {
  await symlink(installed, path.join(root, "node_modules"), "dir");
}
```

`repoRoot` is `git rev-parse --show-toplevel`. In immich that is the monorepo
root, whose `node_modules` holds `prettier` and nothing else; every dependency
of the checked package is under `server/node_modules`, which the base worktree
never gets. The base side therefore analyzes the same source against a
different environment.

Measured directly, by reproducing the base worktree by hand
(`git worktree add --detach /tmp/ibase HEAD` + the same root symlink) and
running `check server/src --coverage` inside it:

| | head side (working tree) | base side (worktree) |
|---|---:|---:|
| `unknown` rate | 79.5% | 80.5% |
| stub call sites | 116 | **92** |
| pure | 1,608 | **1,262** |
| mutation | 460 | **422** |
| `external-module` | 7,738 | **0** |
| `any-typed` | 11 | **7,518** |
| `import-binding` | 0 | **535** |
| top unresolved name | `kysely.RawBuilder.execute` 1902 | `new BadRequestException` 136 |

With no `@types/node` reachable, `import { existsSync } from 'node:fs'` gives
an `any`-typed binding on the base side, so `node:fs.existsSync` is not
classified there and *is* on the head side — which is where 209 of the 257
`fs_read` increases come from. Nothing in the source changed; the environment
did.

This is `docs/open-questions.md`'s **Monorepos** entry firing, on its own stated
trigger ("an adopter with a monorepo"). It is not specific to monorepos in
principle — the condition is that the checked package's `node_modules` is not at
the git root — but pnpm workspaces guarantee that condition by design, since
they do not hoist to the workspace root.

## The experiment matrix

Five edits an AI coding agent might plausibly make, each applied **alone** to
the clean tree and reverted before the next. All five target the same
three-hop NestJS path: `TagController.getAllTags` →
`TagService.getAll` → `TagRepository.getAll`, matching the depth used in the
Unleash run.

Every row was run on the package-rooted control (P), where the gate is
readable. E1, E2 and E4 were additionally run on the monorepo (M); that column
is the blocker's effect, not a second measurement of the analysis.

| | edit | (P) `diff` | (P) `diff --strict` | (M) `diff` |
|---|---|---|---|---|
| E1 | `fetch(…)` in a new module, called from `TagService.getAll` | **exit 1**, 6 entries | exit 1 | exit 1, but 263 entries instead of 257 |
| E2 | `this.db.deleteFrom('tag')…execute()` added inside the existing **read** `TagRepository.getAll` | exit 0, **1 symbol named** under §6.4 | **exit 1** | exit 1, **and no count moves at all** |
| E3 | `node:fs.rmSync` + `node:child_process.execSync` in `TagService.getAll` | **exit 1**, 4 entries | exit 1 | — |
| E3b | the same two calls imported `from 'fs'` / `'child_process'` | **exit 1**, 4 entries | exit 1 | — |
| E4 | `ioredis` `redis.set(…)` in `TagService.getAll` | exit 0, **1 symbol named** under §6.4 | **exit 1** | exit 1, 1,183 §6.4 entries instead of 1,182 |
| E5 | `bullmq` `queue.add(…)` in `TagService.getAll` | exit 0, **1 symbol named** under §6.4 | **exit 1** | — |

### E1 — known network authority, through NestJS DI

Six entries (3 symbols × 2 authorities), reaching the controller:

```text
  controllers/tag.controller.ts#TagController.getAllTags (controllers/tag.controller.ts:42)
    + network
      -> getAll (services/tag.service.ts:26)
      -> reportTagCount (utils/tag-telemetry.ts:1)
      operation: fetch (utils/tag-telemetry.ts:2)
```

with `+ capability http:post:telemetry.example.com` read off the literal URL,
and the new module marked `[new symbol]`. **The path crosses two NestJS
indirections** — `TagController`'s `constructor(private service: TagService)`
and `TagService extends BaseService`, where `this.tagRepository` is an
inherited property, not a local one — and both resolve.

### E3 / E3b — filesystem and process authority

Four entries each (2 symbols × 2 effects), up to the controller, naming
`operation: node:fs.rmSync` / `node:child_process.execSync` for E3 and
`operation: fs.rmSync` / `child_process.execSync` for E3b. The un-prefixed
spelling is reported in the source's own spelling and classified identically,
which is the Unleash follow-up's builtin-specifier rule holding on a second
repository.

### E2 / E4 / E5 — authority through a dependency no table covers

Each produces exactly one §6.4 entry, at the leaf, with the operations named:

```text
  repositories/tag.repository.ts#TagRepository.getAll (repositories/tag.repository.ts:47)
    ? kysely.DeleteQueryBuilder.execute (external-module)
    ? kysely.DeleteQueryBuilder.where x2 (external-module)
    ? kysely.Kysely.deleteFrom (external-module)
```

```text
  services/tag.service.ts#TagService.getAll (services/tag.service.ts:28)
    ? ioredis.Redis.set (external-module)
```

```text
  services/tag.service.ts#TagService.getAll (services/tag.service.ts:28)
    ? bullmq.Queue.add (external-module)
```

All three exit 0 under `diff` and **1** under `diff --strict`. E2 is the one
that would matter to a reviewer: a destructive `DELETE` added to a method
called `getAll`, and the default gate passes it. `--strict` is what catches it,
and on tree (P) `--strict` has **zero** standing noise — so on this repository
`--strict` is a usable CI gate and the default one is not, for the three most
common authority-bearing dependencies it has.

The §6.4 entry is **leaf-only**: it names `TagRepository.getAll` and does not
appear on `TagService.getAll` or on the controller, because §6.4 reports the
operations a function's *own body* could not resolve. E1's authority report
carries the call path; E2's does not. A reviewer reading E2's output sees a
repository method, not the endpoint it is behind.

### E2 under the monorepo — the miss the blocker causes

On (M), `TagRepository.getAll` is *already* listed in the baseline's 1,182
§6.4 entries, with its five unchanged `SelectQueryBuilder` reads reported as
gains, because the base side resolved none of them. Adding the delete changes
no count in the report — 257 / 1,182 / 1,737 before and after — and the three
new `DeleteQueryBuilder` lines land inside an entry that was already there,
in a 7,927-line report. The destructive write is not missed in the sense of
being absent; it is unfindable, and no exit code moves because the run was
already failing.

## Comparison with the Unleash validation

Classified against
[`2026-09-11-third-party-diff-validation.md`](2026-09-11-third-party-diff-validation.md).

### Repeated

- **Zero standing noise on an untouched tree** — but only on (P). Unleash was a
  single package, so its git root and its `node_modules` coincided and the
  question never arose. The property holds where the precondition holds.
- **Known operations are reported with the whole call path to the controller.**
  E1 and E3 here are Unleash's E1 and E3, through a different framework, with
  the same result and the same shape of output.
- **The un-prefixed builtin specifier is read as the same module** (E3b),
  closing on immich the way it closed on Unleash.
- **A client a class is handed is named from its declared type.** The rule the
  Unleash run added is what produces immich's entire top-ten histogram. It was
  written against knex, injected by hand; it holds against kysely, injected by
  a NestJS decorator, with no change.
- **Approval cost is one line per (symbol × effect).** E1 costs six lines for
  one edit; E3 costs four. Unleash's E3 cost six. Unchanged.
- **A new `unknown` rate is not progress.** immich's 79.5% is *higher* than
  Unleash's 71.0% and says nothing about whether the gate works on it —
  E1/E3/E3b pass through symbols that are `unknown` on both sides.

### Contradicted

- **Nothing was contradicted.** No finding from the Unleash run failed to hold
  here. The one that came closest to a surprise went the other way: the
  concern that a fluent query builder collapses to a single receiver name is
  **not** true of kysely, whose stage types carry the direction — so the knex
  limitation ("`where` / `join` / `orderBy` appear in read and write chains
  alike") is a knex property, not a query-builder property.

### New

1. **`diff` compares two different environments when the checked package's
   `node_modules` is not at the git root.** 257 false authority increases and
   1,182 false §6.4 entries on an unmodified tree, exit 1 in both modes. Not
   reachable on Unleash's single-package layout. This is the blocker.
2. **§6.4 entries do not carry a call path.** Visible here because E2, E4 and
   E5 are all §6.4-only; on Unleash only E5 was, and it was read as a single
   example rather than as the common case for an uncovered dependency.
3. **The bundled DB tables covered none of this repository's persistence.**
   Four covered clients, zero reachable call sites — `pg` is installed but
   untyped, and the real traffic is kysely. Unleash's knex was covered *after*
   that run added rows for it; immich shows what the pre-rows state looks like
   for a second builder.
4. **`--strict` is what makes an uncovered-dependency authority change fail**,
   and on (P) it is usable as CI with no standing noise at all — a stronger
   statement than Unleash's run could make, since there `--strict` was measured
   mainly on the untouched tree and on history ranges.
5. **NestJS decorator DI and class inheritance did not cost anything.**
   `@InjectKysely()`, `constructor(private service: TagService)`, and
   `this.tagRepository` inherited from `BaseService` all resolve. The
   `docs/open-questions.md` entry "Indirect calls in frameworks" names NestJS's
   DI as an open risk; on this repository it is not one. The `@Controller`
   route decorators are a different question and are untested here — nothing
   declared an `@entrypoint`.

## Blockers, ranked by adopter impact and fan-out

1. **`diff`'s base worktree does not get the checked package's
   `node_modules`.** Impact: total — the gate reports 257 fabricated authority
   increases and exits 1 on an unmodified tree, in both modes, so there is no
   configuration under which an immich-shaped adopter can turn it on. Fan-out:
   every pnpm-workspace repository (pnpm does not hoist to the workspace root
   by design), every yarn `nohoist` package, every nested package whose
   dependencies are installed beside it — and it scales with the whole tree,
   not with the change. Behavioral, not cosmetic: it both fabricates increases
   and, as E2 on (M) shows, buries a real destructive write inside them. Cause
   is in `src/cli/worktree.ts`, with no reference to anything about immich.
2. **§6.4 entries have no call path.** Impact: a reviewer sees
   `TagRepository.getAll` and has to find the endpoint themselves. Fan-out:
   every uncovered dependency, which for this repository is its database, its
   cache and its queue. Real, but it is a reporting shape, not a miss — the
   operation is named and `--strict` fails on it.
3. **No table covers `kysely`, `ioredis` or `bullmq`.** Impact: three of the
   repository's core authorities are `unknown` rather than `db_write` /
   `network`. Fan-out: large by popularity. But this is the *designed* answer —
   §4.3 says an uncovered operation is `unknown`, `--strict` fails on it, and
   the tables admit rows on measurement, not on popularity. Adding rows for a
   package because one repository uses it is what `AGENTS.md` and the
   second-repo rule exist to prevent.
4. **`check` alone says nothing on an unannotated codebase.** Repeated from
   Unleash, unchanged, and not a defect.

## The decision

`<decision>`'s four conditions, against blocker 1:

1. **It blocks credible CI use.** Exit 1 on an unmodified tree, in both modes,
   with a 7,927-line report. There is no flag that turns it off. It also causes
   a miss in the sense that matters: E2's destructive `DELETE`, applied on (M),
   moves no count in the report and no exit code, because the run was already
   failing and the symbol was already listed.
2. **Behavioral, not cosmetic.** 257 records that say a function gained
   `fs_read` when nothing in the source changed.
3. **The root cause is general.** `src/cli/worktree.ts` links
   `<repository root>/node_modules` and nothing else. Nothing about it is
   specific to immich's naming, layout or conventions; the trigger is "the
   checked package's `node_modules` is not at the git root", which pnpm
   workspaces produce by construction.
4. **The fix cannot weaken anything.** It gives the *base* side the packages
   the head side already had. It adds no resolution the head side lacks, so no
   `unknown` becomes known on the head, and nothing already detected can stop
   being detected.

Blockers 2 and 3 were **not** implemented, per `<decision>`'s "do not implement
the runner-up".

## The change

`addWorktree` takes the checked subdirectory and links a `node_modules` for
every directory from the repository root down to it, guarded three ways: the
working tree must have one there, the base checkout must have that directory at
all (a package added since the base ref has nothing to link into), and an
existing link is left alone. `runDiff` passes the `subdir` it already computes.
Nine lines of behavior and a helper that walks the path with `path.dirname`.

What is **not** covered: a `node_modules` *below* the checked directory — that
is `ambit diff` run at a workspace root, where each package installs its own.
That invocation has unmeasured parts beyond this one (immich's workspace root
has no `tsconfig.json` at all), so it stays in `docs/open-questions.md` under
Monorepos rather than being guessed at here.

`ancestry` carries no `@effects` tag, for the same reason
`installedPackageNameOf` carries none: `node:path` has no stub rows, so a
`pure` declaration there is one the analysis cannot check and reports as
`AMB-W001`. Warning count on `check src` is 10 before and after.

## After, measured

Same checkout, same machine, same commands. "Before" is Ambit `ad70a25`.

### The untouched monorepo — the property the gate rests on

| `diff HEAD server/src`, unmodified tree | before | after |
|---|---:|---:|
| authority increases, unapproved | 257 | **0** |
| symbols with an unresolvable gain | 1,182 | **0** |
| symbols unchanged | 1,737 / 3,061 | **3,061 / 3,061** |
| exit, `diff` | 1 | **0** |
| exit, `diff --strict` | 1 | **0** |
| report length | 7,927 lines | **5 lines** |

```text
base HEAD (2a62622) vs the working tree, over server/src

No authority increased.

3061 symbols unchanged, out of 3061 symbols compared.
```

### The experiment matrix, re-run on the monorepo

All six edits, both modes, applied to (M) exactly as before.

| | (M) `diff` before | (M) `diff` after | (M) `--strict` after |
|---|---|---|---|
| E1 `fetch` | exit 1, 263 entries | **exit 1, 6 entries** | exit 1 |
| E2 kysely `deleteFrom…execute` | exit 1, no count moved | **exit 0, 1 symbol named** | **exit 1** |
| E3 `node:fs` + `node:child_process` | not run | **exit 1, 4 entries** | exit 1 |
| E3b un-prefixed `fs` / `child_process` | not run | **exit 1, 4 entries** | exit 1 |
| E4 `ioredis.Redis.set` | exit 1, 1,183 §6.4 entries | **exit 0, 1 symbol named** | **exit 1** |
| E5 `bullmq.Queue.add` | not run | **exit 0, 1 symbol named** | **exit 1** |

All twelve outputs are **byte-identical** to the package-rooted control's,
modulo the base commit in the header line — checked mechanically, not by eye.
The monorepo and the single-package repository now report the same thing about
the same source, which is the whole claim.

### Twenty commits of the subject's own history

`diff HEAD~20 server/src`, a range touching 443 files in `server/src`
including the NestJS 12 / ESM migration:

| | before | after |
|---|---:|---:|
| authority increased, unapproved | 257 | **0** |
| symbols with an unresolvable gain | 1,182 | **35** |
| symbols unchanged | 1,737 | **3,026** |
| exit, `diff` | 1 | **0** |
| exit, `diff --strict` | 1 | 1 |

The §6.4 count is now proportional to the change — 35 symbols over 443 changed
files — rather than to the size of the tree. `--strict` still exits 1 over that
range, which is what it is for: a migration of that size did reach operations
the analysis could not read. On an unmodified tree it exits 0.

### Regression checks

- **Unleash, the first subject, re-measured on the same checkout**
  (`Unleash/unleash@044461b`, cloned again and installed the same way):
  `diff HEAD src/lib` exit **0**, `--strict` exit **0**, "3523 symbols
  unchanged, out of 3523". `check src/lib --coverage` reproduces the recorded
  figures exactly — 16,491 call sites, stub **953**, unresolved **6,426**,
  `external-module` **3,390**, top name `knex.QueryBuilder.where` 448. A
  single-package repository is unaffected: the extra directories in the chain
  do not exist, so nothing is linked that was not linked before.
- `pnpm test` **549 passing, 33 files**, against **547, 33 files** measured at
  `ad70a25` on the same machine. The two new ones are in
  `test/e2e.diff.test.ts`: the workspace layout, and the guard for a directory
  the base ref does not have.
- `pnpm exec tsc --noEmit` pass. `./node_modules/.bin/biome ci .` pass.
- `check src --coverage` exit 0, `unknown` rate 37.8% (128/339) against 37.6%
  (127/338) — the one new function, `ancestry`, is `unknown` because
  `node:path` has no rows. `AMB-W001` count 10, unchanged.
- `diff HEAD src` on Ambit itself: **no authority increase**, exit 0. The new
  loop calls `node:path.join`, which is reported under §6.4 on `addWorktree`,
  and `ancestry` appears as a symbol the analysis does not resolve. `--strict`
  exits 1 on those two, as it is designed to.
- `node scripts/bench-corpus.ts` median **52.6%**, per target hono 52.6%,
  trpc-server 59.7%, elysia 51.7%, got 54.6%, drizzle-orm 39.0% — unchanged.
  The corpus installs no dependencies and `check` builds no worktree, so this
  change cannot reach it; run to confirm rather than assumed.

### Latency

Every `diff` run of the matrix was timed. On (M): **11.6–13.4 s** before (six
runs), **17.2–21.3 s** after (twelve runs). The rise is real and it is not the
symlinks — it is the base side now having 7,738 `external-module` call sites to
resolve where before it had 7,518 `any`-typed ones, which is work the before
column was skipping by analyzing an empty environment. The package-rooted
control (P), which always had the dependencies on both sides, ran
**17.3–19.7 s** across its own twelve runs, before and independent of this
change — so after-(M) lands in the band of a run that was already analyzing a
populated base on both sides. That is what the evidence supports: the cost is
analyzing a populated base, not the links. The machine was not quiescent and no
run is separable within those bands.

## What is still missed, and was not fixed

- **§6.4 entries carry no call path.** E2 names `TagRepository.getAll`; the
  reader has to find `TagController.getAllTags` themselves. Recurs on both
  subjects, for every uncovered dependency. This is the runner-up and is not
  implemented here. On review it was also narrowed: *propagating* the gain to
  callers is the wrong shape, because an unresolved operation is not authority
  and every caller would then be marked as holding something its own body does
  not. A witness path attached to the body-local entry is the form worth
  deciding on. Filed in `docs/open-questions.md`, with the trigger being a
  third subject that was **not** chosen to ask this question.
- **`diff` compares the base commit's source against the working tree's
  dependencies.** This change extends that to a workspace, it does not
  introduce it. It is what keeps environment out of a contract report, and it
  is also why authority introduced by a *dependency upgrade* has no answer
  here. Filed in `docs/open-questions.md`; nothing in this run decides it.
- **No table covers `kysely`, `ioredis` or `bullmq`.** Deliberate: rows are
  admitted on measurement, and one repository using a package is not a
  measurement of the package. What this run *did* establish is that kysely's
  stage types would let such rows separate `db_read` from `db_write` without
  the guess knex forced — recorded for whenever a second subject makes the case.
- **`ambit diff` at a workspace root.** Not measured, not fixed; see
  `docs/open-questions.md`.
- **`pg` installed without types.** The one bundled DB table immich could hit
  is unreachable because the package ships no declarations and immich does not
  install `@types/pg`. Nothing here decides whether that is worth an answer.
