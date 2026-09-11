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

E4 is the one that matters. The edit adds a destructive database write to a
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

- **Node builtins imported without the `node:` prefix (E3b).** The stub table
  is keyed `node:fs.writeFileSync`, and the name a call gets is the specifier
  the source wrote — so the same edit that fails the build as `node:fs` passes
  as `fs`. This repository writes the un-prefixed form throughout (`fs`,
  `crypto`, `events`, `path` all appear in its unresolved histogram), which
  makes it the spelling an agent copying the file's neighbours would use. A
  handful of alias rows would close it.
- **`ky` (E2).** Named `ky.post` and covered by no table, so outbound HTTP
  through this repository's own client is invisible. The same holds for `axios`
  and `got`. A row would fix `ky`; the general problem is that HTTP clients are
  as unbounded as DB clients.
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
- **A symbol already `unknown` can gain anything.** `diff` reports a *gained*
  `unknown` and never fails on it, and a symbol that was already `unknown` does
  not even gain one. In a tree at 71%, that is most of the surface. This is the
  finding that outlived the fix, and `docs/status.md`'s bottleneck section
  carries it, and it is filed as the next decision in
  [`docs/open-questions.md`](../open-questions.md).
