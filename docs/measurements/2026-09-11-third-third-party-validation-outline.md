# A third third-party backend: `outline/outline`, `server/`

Run on 2026-09-11, Node.js v24.20.0, macOS (darwin arm64), Apple M1, 8 cores,
16 GiB, from this repository. Ambit pinned at `58d9a0b` for every "before"
column.

This is the **last** self-directed repository validation. Its question is not
whether outline passes. It is whether the findings of the first two
third-party runs — [Unleash](2026-09-11-third-party-diff-validation.md) and
[immich](2026-09-11-second-third-party-validation-immich.md) — are properties
of Ambit or properties of the two repositories that produced them, and which
remaining blocker, if any, has to be fixed before a real external adopter is
worth asking for.

## The subject

`outline/outline@35dd15b9718bcb8e547b86c1428d55170b49250b` (`35dd15b9`,
2026-09-10, "Optimize documentCollaborativeUpdater by moving computations
outside transaction (#13720)"), BSL 1.1, a self-hosted team knowledge base.
The checked directory is `server/` — 759 `.ts` files on disk, 195 of them
`*.test.ts`, plus `.tsx` email templates.

```sh
git clone --depth 50 --filter=blob:none https://github.com/outline/outline.git outline
cd outline && git rev-parse HEAD    # 35dd15b9718bcb8e547b86c1428d55170b49250b
node yarn.cjs install --immutable   # yarn 4.11.0, nodeLinker: node-modules
```

`HEAD` of the default branch at clone time. Not hand-picked, and nothing about
its contents was read before the revision was fixed.

### Why it is independent of Ambit

`grep -ril ambit` over the checkout matches exactly one file:
`shared/i18n/locales/it_IT/translation.json`, an Italian string that contains
the letters. No source, configuration, dependency, or document in outline
refers to Ambit. It has no `ambit.config.ts`, no `ambit.approvals.md`, and no
contract JSDoc tags. It is not in `test/corpus/corpus.json`, so no measurement
in this repository has ever been taken against it, and no rule here was
written with it in view. It was not a subject of either prior run; it appears
in the immich record only as the runner-up that was **not** chosen.

### Why it complements Unleash and immich

Required: differ from **both** prior subjects on the axes that decide what the
analysis has to resolve. It differs from both on all six.

| axis | Unleash `044461b` | immich `2a626220` | outline `35dd15b9` |
|---|---|---|---|
| framework | Express 4 | NestJS 12, decorator DI | **Koa 3 + `koa-router` 7** |
| handler shape | controller **class methods** | controller **class methods** | **inline `async` arrow functions** passed to `router.post(...)` |
| persistence | `knex` query builder | `kysely` + `postgres`, DI-injected | **Sequelize 6 + `sequelize-typescript`** — decorated model **classes**, static and instance methods |
| queue / cache | none | `bullmq` on `ioredis` | **`bull` 4** on `ioredis`, `@bull-board/koa` |
| external SDK profile | `ky` | `sharp`, `fluent-ffmpeg`, `exiftool-vendored`, `nodemailer`, `openid-client` | **`@aws-sdk/client-s3`** (+ `lib-storage`, `s3-request-presigner`, `cloudfront-signer`), `nodemailer`, `passport`, `@sentry/node` |
| package manager / layout | npm, single package, checked at `src/lib` | **pnpm workspace**, checked package is a subdirectory with its own `node_modules` | **yarn 4 Berry** (`nodeLinker: node-modules`), single package, **`node_modules` at the git root**, checked directory `server/` is a subdirectory with **no tsconfig of its own** |

Four of those are chosen against what Ambit already answers, not for it:

- **Sequelize is covered by no bundled table.** `src/stubs/data-clients.ts` has
  rows for `pg`, `mysql2`, `knex` and `@prisma/client`. It has none for
  `sequelize`. `pg@8.20.0` *is* installed here (Sequelize's transport) but the
  call shape is `ApiKey.findAll(...)`, not `pool.query(...)`.
- **`bull` is not `bullmq`.** Different package, different name, no rows either.
- **`@aws-sdk/client-s3` is object storage, an authority neither prior subject
  had at all.** Both prior runs' cloud-side authority was `fetch`.
- **The handler shape is the one neither prior subject had.** Unleash and
  immich both route through class methods, which `docs/DESIGN.md` §4.1 attaches
  contracts to. outline's routes are arrow functions in argument position,
  which §4 skips as `callback-argument`. Whether a call path can reach a route
  at all here is therefore an open measurement, not an assumption.

Two further properties made it the pick:

- **Its authority is native, varied, and security-relevant.** Object storage,
  signed URLs, OAuth/OIDC providers, SMTP, a Redis-backed queue, and a
  `server/policies/` authorization layer — a knowledge base is an access-control
  product, so an authority change there is the kind a reviewer actually cares
  about.
- **Comparable scale.** 759 files against immich's 548 and Unleash's 596. Large
  enough to be real, small enough that the experiment stays about signal.

### Toolchain notes taken before running

- outline pins `typescript ^6.0.3` — resolved to **6.0.3**, exactly the version
  `src/checker/backend/legacy-ts.ts` is pinned to. Same JS-implementation line,
  not TypeScript 7.
- The **only** `tsconfig.json` is at the repository root. `server/` has none, so
  `ambit check server` must walk up to find it. That tsconfig's `include` is
  absent and its `exclude` is `["node_modules", "build", "server/migrations"]`,
  so the program is the whole repository — `app/` (844 `.tsx`/`.ts` React
  files), `shared/`, `plugins/` — not just `server/`.
- `"types"` is **absent** from that tsconfig, as it was on immich. `AGENTS.md`
  records that TypeScript 6 stopped auto-including `node_modules/@types/*`.
  `@types/node@20.19.43` *is* installed as a transitive dependency. Whether
  Node builtin specifiers resolve under this configuration is measured below,
  not assumed.
- `"moduleResolution": "bundler"` with `"resolvePackageJsonExports": false`, and
  `"module": "esnext"` with no `"type"` field in `package.json`. Neither prior
  subject used bundler resolution; both used a node resolution mode.
- `experimentalDecorators` / `emitDecoratorMetadata` on (sequelize-typescript).
  `paths` maps `@server/*`, `@shared/*`, `~/*`, `plugins/*`.
- `strict` is **false**; `noImplicitAny` and `strictNullChecks` are true.
  Neither prior subject ran with `strict: false`.
- `node_modules` is at the git root, so the immich blocker's precondition — the
  checked package's dependencies living below the git root — does **not** hold
  here. This run therefore tests the fix for a regression rather than
  re-testing the bug.

## Onboarding friction

`yarn install --immutable` took **37.2 s**, exit 0, 1,921 packages, 980 MiB.
Nothing had to be configured, annotated, or excluded for `ambit check` to run:
it walked up from `server/` and found the root `tsconfig.json` on its own.

Five things an adopter would notice. Only the last is Ambit's.

- **The package manager is not on the machine by default.** `yarn` resolves
  through Volta here and Volta has none pinned; `corepack` is absent; npm has no
  `yarn@4.11.0` to run. The 4.11.0 bundle had to be fetched from
  `repo.yarnpkg.com` by hand. Not Ambit's problem — but it is the first thing
  between an adopter and a baseline, and neither prior subject had it.
- **No contracts means `check` says nothing.** `check server` exits 0 with zero
  diagnostics: the repository declares no `@effects` anywhere. `diff` is again
  the only command with anything to say about an unannotated codebase. Third
  subject, third time.
- **The checked directory is not the project.** The only `tsconfig.json` is at
  the repository root and covers `app/` (the React client), `shared/`,
  `plugins/` and `server/` alike. `check .` is therefore a different product
  question than `check server`, and the run below measures both.
- **Tests are analyzed with everything else.** 195 `*.test.ts` files live under
  `server/`, with no `include`/`exclude` in `ambit.config.ts` to narrow that.
  Their bodies sit inside `describe(…)` / `it(…)` callback arguments, counted as
  `callback-argument`. Third subject, same exposure.
- **`node_modules` is at the git root**, so `diff`'s base worktree gets the same
  environment the head side has. The immich blocker's precondition does not hold
  here, which is what makes this run a regression check on that fix rather than
  a repeat of it.

## Baseline, Ambit `58d9a0b`, no repository-specific anything

### `check server --coverage` — exit 0, 11.5 s

| | |
|---|---:|
| diagnostics | none — the repository declares no contracts |
| files / functions | 474 / 1,951 (474 files carrying a record, out of 759 `.ts` on disk) |
| `unknown` rate | **69.0% (1,347/1,951)** |
| `boundary` rate | 0.0% |
| entrypoints | 0 |
| skipped | **6,112** — callback-argument **5,741**, nested-function 203, object-literal-method 102, bodyless-declaration 63, other 3 |
| call sites | 9,618 — resolved 3,119, stub 134, pure 1,716, inlined 159, mutation 792, **unresolved 3,698** |
| unresolved by reason | `external-module` 2,838, `unresolved-symbol` 455, `builtin-method` 212, `callback-parameter` 90, `overload-without-body` 53, `dynamic-import` 26, `any-typed` 21, `ambient-declaration` 3 |

Two reasons appear here that neither prior run reported at all:
`overload-without-body` (53 — Sequelize models overload `findByPk` and friends)
and `ambient-declaration` (3 — the project's own `server/typings/*.d.ts`).

**1,951 functions for 759 files** against immich's 3,061 for 548 and Unleash's
3,523 for 596. The denominator is small because 5,741 function bodies were never
extracted, and 226 of those are this repository's HTTP routes.

### `check .` — the whole repository, for comparison

exit 0, 17.1 s. 1,572 files / 5,453 functions, `unknown` **67.7%**, skipped
13,963 (callback-argument 10,874). Top unresolved names: `t` 1,629,
`react.useCallback` 495, `react.useState` 331, `react-i18next.useTranslation`
323. The React client swamps the histogram, so `check server` is the right
scope for a backend question — at the cost recorded under "first-party code
outside the checked directory" below.

### High-fan-out unresolved operations

```text
@server/policies.authorize                        59
sequelize-typescript.Sequelize.transaction        59
@shared/utils/error.toError                       52
socket.io.BroadcastOperator.emit                  51
socket.io.Server.to                               50
Console.log                                       49
http-errors.default                               30
prosemirror-model.Node.toJSON                     30
prosemirror-model.Node.fromJSON                   29
@shared/helpers/AuthenticationHelper.canAccess    27
```

Two shapes, and both are new relative to the prior two subjects.

- **Four of the ten are first-party names.** `@server/policies.authorize`,
  `@shared/utils/error.toError`, `@shared/helpers/AuthenticationHelper.canAccess`
  are functions with bodies, in this repository. Two of them are *outside* the
  checked directory: `extractProject` indexes only files under the checked root
  (`isUnderRoot`), so a call into `shared/` resolves to a declaration the
  analysis never extracted and lands in `unresolved-symbol`.
  `@server/policies.authorize` is inside the root and is unresolved for a
  different reason: `export const authorize: typeof cancan.authorize =
  cancan.authorize`, a `const` whose *annotation* §4.2 rule 7 forbids letting
  decide. Neither shape was reachable on Unleash (`src/lib` was self-contained)
  or immich (`server/src` was).
- **`sequelize-typescript.Sequelize.transaction` is the receiver rule holding on
  a third repository** — `this.sequelize` is typed by the package, so it is
  named. What that same rule does *not* reach is the subject of E2 below.

### `diff` on the untouched tree

```sh
node <ambit>/src/cli/main.ts diff HEAD server            # exit 0, 20.4 s
node <ambit>/src/cli/main.ts diff HEAD server --strict   # exit 0, 22.2 s
```

```text
base HEAD (35dd15b) vs the working tree, over server

No authority increased.

1950 symbols unchanged, out of 1950 symbols compared.
```

**Zero standing noise, 5 lines, exit 0 in both modes.** Re-run after the whole
experiment matrix, on a `git status`-clean tree: identical. The immich fix
holds on a layout it was not written for — `node_modules` at the git root,
checked directory one level below — and adds nothing.

### The subject's own history

| | `diff HEAD~20 server` (15 files changed) | `diff HEAD~49 server` (46 files changed) |
|---|---|---|
| authority increased | 0 | 0 |
| symbols that became unresolved (§6.4 shape 1) | 1 | 3 |
| symbols with an unresolvable gain (§6.4 shape 2) | 0 | 8 |
| renames tracked | 0 | 1 (`utils/opensearch.ts` → `routes/discovery/opensearch.ts`) |
| exit, `diff` | **0** | **0** |
| exit, `diff --strict` | 1 | 1 |

Proportional to the change, not to the tree, on both ranges. The rename was
compared against its old path and reported as a move, not as a new symbol.

Two of the `HEAD~49` entries are the finding that E2 isolates below:

```text
  middlewares/authentication.ts#auth (middlewares/authentication.ts:52)
    ? <unnamed> (callback-parameter)
    ? <unnamed> (unresolved-symbol)
```

## The experiment matrix

Eleven edits, each applied **alone** to a clean tree and reverted before the
next. Eight are edits an AI coding agent might plausibly make; E2b, E6b and E7
are controls that isolate a cause. The target is the
`documents.create` request path:

```
router.post("documents.create", …, async (ctx) => { … })   ← inline arrow, server/routes/api/documents/documents.ts:1780
  └─ documentCreator(ctx, …)                               ← server/commands/documentCreator.ts:149
       └─ (leaf: the injected operation)
```

Two more callers reach `documentCreator` without passing through HTTP:
`queues/tasks/DocumentImportTask.perform` (a Bull job) and
`tools/documents.ts#documentTools` → `routes/mcp/index.ts#createMcpServer`.

| | edit | `diff` | `--strict` | entries | reviewer can name the affected request path |
|---|---|---|---|---:|---|
| E1 | `fetch(…)` in a new module, called from `documentCreator` | **exit 1** | exit 1 | 16 | **no** — job and MCP callers named, HTTP route absent |
| E2 | `Template.destroy({force:true})` added inside the existing **read** `Template.findByPk` | exit 0, 1 symbol under §6.4 | **exit 1** | 1 | **no** — and the operation is `<unnamed>` |
| E2b | the same as an instance call, `template.destroy({force:true})` | exit 0, 1 symbol under §6.4 | **exit 1** | 1 | **no** — `<unnamed>` again |
| E2c | raw SQL, `sequelize.query("DELETE FROM documents …")` | exit 0, 1 symbol under §6.4 | **exit 1** | 1 | operation named `sequelize-typescript.Sequelize.query`; no path |
| E3 | `node:fs.rmSync` + `node:child_process.execSync` in `documentCreator` | **exit 1** | exit 1 | 16 | **no** — same three tops as E1 |
| E3b | the same two calls imported `from "fs"` / `"child_process"` | **exit 1** | exit 1 | 16 | **no** — same, operations named in the source's own spelling |
| E4 | `bull` `new Queue(…).add(…)` in `documentCreator` | exit 0, 1 symbol under §6.4 | **exit 1** | 1 | operation named `bull.default.add`; no path |
| E5 | `@aws-sdk/client-s3` `DeleteObjectCommand` in `documentCreator` | exit 0, 1 symbol under §6.4 | **exit 1** | 1 | operation named in full; no path |
| E6 | the **same `fetch` as E1**, written directly inside the inline route handler | **exit 0** | **exit 0** | **0** | **nothing is reported at all** |
| E6b | control: `fetch` in a named function in the same route file, called from the handler | exit 1 | exit 1 | 2 | no caller path — the handler is not a symbol |
| E7 | control: the handler extracted to a named `const`, then the `fetch` added | exit 1 | exit 1 | 3 | **yes** — the handler itself is the named symbol |

### E1 — known network authority

An earlier E1 landed one function higher by an anchor mistake — in
`authorizeDocumentCreate`, which the same route handler also calls — and is
recorded rather than dropped: 6 entries, exit 1, and the same two non-HTTP tops
(`tools/documents.ts#documentTools` → `routes/mcp/index.ts#createMcpServer`).
The row below is the intended injection point.

16 entries, 8 symbols × 2 authorities, exit 1, with the whole path:

```text
  queues/tasks/DuplicateCollectionDocumentsTask.ts#DuplicateCollectionDocumentsTask.perform (queues/tasks/DuplicateCollectionDocumentsTask.ts:21)
    + network
      -> documentsDuplicator (commands/documentDuplicator.ts:89)
      -> duplicateRoots (commands/documentDuplicator.ts:101)
      -> documentCreator (commands/documentCreator.ts:149)
      -> reportDocumentCount (utils/documentTelemetry.ts:1)
      operation: fetch (utils/documentTelemetry.ts:2)
```

`+ capability http:post:telemetry.example.com` is read off the literal URL, and
the new module is marked `[new symbol]`. Four-hop paths resolve through a
default-exported function, a local helper, and a class method.

**The reported tops are two Bull job classes and the MCP server factory. The
HTTP route that calls `documentCreator` at `documents.ts:1852` is not among
them** — its handler is an argument-position arrow, which §4 skips. A reviewer
reading this output learns that document import and duplication *jobs* gained
outbound network, and does not learn that `POST /api/documents.create` did.

**Approval cost is 16 lines for one edit**, against 3 on Unleash's E1 and 6 on
immich's. The cost is (symbols on the path) × (authorities), and this repository's
command layer has more callers per command.

### E3 / E3b — filesystem and process authority

16 entries each, exit 1, naming `operation: node:fs.rmSync` /
`node:child_process.execSync` for E3 and `fs.rmSync` / `child_process.execSync`
for E3b. The un-prefixed spelling is reported in the source's own spelling and
classified identically — the Unleash rule holding on a third repository, and on
a `tsconfig.json` with **no `"types"` field at all**, exactly as on immich:
`@types/node@20.19.43` is reachable only transitively, through
`/// <reference types="node" />` in installed `.d.ts` files.

### E2 / E2b — the operation with no name

```text
  models/Template.ts#Template.findByPk (models/Template.ts:241)
    ? <unnamed> (external-module)
```

That is the entire report for a hard `DELETE` — `force: true`, bypassing
Sequelize's soft-delete — added inside a method named `findByPk`. `--strict`
exits 1 on it; `diff` exits 0.

E2c isolates the cause. The *same kind* of destructive operation written on a
receiver the package itself types is named in full:

```text
    ? sequelize-typescript.Sequelize.query (external-module)
```

So the rule is: a receiver whose declared type comes from a package is named;
a receiver whose declared type is a **project-local class that inherits the
method from a package base class** is not. `Template extends ParanoidModel
extends Model` (sequelize-typescript → sequelize), so `Template` and `template`
are locally-declared types, while `destroy` is declared in
`node_modules/sequelize/types/model.d.ts` — which is where the
`external-module` reason comes from. The reason knows the package; the name
does not use it.

This is the shape Unleash's knex and immich's kysely could not produce: both
hand out builder objects the package types, so both were named. ActiveRecord
ORMs — Sequelize, TypeORM's `BaseEntity`, Mongoose — are the opposite shape by
construction.

### E4 / E5 — authority through a dependency no table covers

```text
  commands/documentCreator.ts#documentCreator (commands/documentCreator.ts:149)
    ? bull.default.add (external-module)
    ? new bull.default (unresolved-symbol)
```

```text
  commands/documentCreator.ts#documentCreator (commands/documentCreator.ts:149)
    ? @aws-sdk/client-s3.S3Client.send (external-module)
    ? new @aws-sdk/client-s3.DeleteObjectCommand (external-module)
    ? new @aws-sdk/client-s3.S3Client (external-module)
```

E5 is the best §6.4 output of the run: a reviewer can read "this deletes an S3
object" off the entry without opening the diff. E4's `bull.default` is the
package's `export = Queue` form read through its default export — identifiable,
but it names the export shape rather than the class (`Queue`). Both exit 0 under
`diff` and 1 under `--strict`.

Neither carries a call path. Third subject, same shape.

### E6 — the miss

The same `fetch` as E1, written where an agent editing a route would most
naturally write it:

```ts
router.post(
  "documents.create",
  auth(), …,
  async (ctx: APIContext<T.DocumentsCreateReq>) => {
    await fetch("https://telemetry.example.com/documents", { … });   // ← added
    const document = await documentCreator(ctx, { … });
```

```text
base HEAD (35dd15b) vs the working tree, over server

No authority increased.

1950 symbols unchanged, out of 1950 symbols compared.
```

**Exit 0 under `diff`, exit 0 under `--strict`, no line anywhere.** Not a
§6.4 report, not an unresolved gain, not a warning — silence.

Isolated: `check server --coverage` with E6 applied is **byte-identical** to
the baseline, `call-sites: total=9618` on both. The added call site is not
counted as resolved, unresolved, or skipped; the handler's body is never walked,
so no call inside it exists for the analysis. `classifySkipped` reaches
`isCallbackArgument` and the function-like node is tallied under `skipped`, but
a skipped function has no record, and `ambit diff` compares records.

E6b and E7 isolate the trigger to **argument position, not the file and not the
route**. E6b — a named `function` declaration added to the same route file —
is reported (2 entries), though with no caller, because its only caller is the
handler. E7 — the handler itself extracted to `const createApiKeyHandler =
async (ctx) => {…}` — is reported with the handler as the named symbol, because
`isIndexedInitializer` indexes a `const`-bound arrow.

This repository registers **226** routes that way (195 under
`server/routes/api`). The workaround is one line per route, in the adopter's
repository.

`docs/DESIGN.md` §6.4 states the rule this breaks, in its own words: *"What it
must not be is silence — reporting an unanalyzed path as 'nothing increased
here' is exactly what §3.4 forbids."* §4.1 attaches `@effects` to "any function
or method", and an argument-position arrow is one. Code and specification
disagree, and the specification is the one that is right.

### Latency

Every run timed. `check server --coverage` 11.5 s; `check .` 17.1 s; `diff HEAD
server` 19–22 s across fourteen runs (base, matrix, controls, re-check).
`--strict` costs nothing measurable over `diff`. The machine was not quiescent
and no run is separable within that band.

## Comparison across all three subjects

| | Unleash `044461b` | immich `2a626220` | outline `35dd15b9` |
|---|---:|---:|---:|
| analyzed files / functions | 596 / 3,523 | 460 / 3,061 | **474 / 1,951** |
| `unknown` rate | 71.0% | 79.5% | **69.0%** |
| skipped, callback-argument | — | 4,141 | **5,741** |
| standing noise, `diff` on an unmodified tree | 0 | 0 (package-rooted / after the fix) | **0** |
| standing noise, `diff --strict` on an unmodified tree | 0 | 0 | **0** |
| approval lines for one `fetch` edit | 3 (E1) | 6 (E1) | **16** (E1) |
| known authority reported with the full call path | yes | yes | **yes, but stopping below HTTP** |
| §6.4 entry carries a call path | no | no | **no** |
| §6.4 operation is named | yes | yes | **no, for the repository's own ORM** |
| authority added inside the handler itself | not reachable — class methods | not reachable — class methods | **missed entirely** |

### Repeated — held on all three

1. **Zero standing noise on an unmodified tree, in both modes.** Third subject,
   third time, and here on a third layout (git root `node_modules`, checked
   directory one level down). This is the property the gate rests on and it has
   now survived npm/single-package, pnpm-workspace, and yarn-4/single-package.
2. **Known operations are reported with the whole call path.** E1 and E3 here
   are Unleash's and immich's E1 and E3, through a third framework, with the
   same shape of output — up to where the path ends (see *New*, 1).
3. **The un-prefixed builtin specifier is read as the same module** (E3b), and
   again on a `tsconfig.json` that declares no `"types"`.
4. **A client a class is handed is named from its declared type.**
   `sequelize-typescript.Sequelize.transaction` is the top-two name here, and
   E2c shows it working on a destructive operation. The rule holds — the
   *limit* of the rule is what is new.
5. **A new `unknown` rate is not progress and not a verdict.** 69.0% here is
   the *lowest* of the three and this is the subject with the worst miss. The
   rate and the usefulness of the gate continue to move independently — now on
   three subjects, in both directions.
6. **§6.4 entries carry no call path.** Third subject, every uncovered
   dependency: this repository's ORM, its queue, and its object storage.
7. **`check` alone says nothing on an unannotated codebase.** Third subject.
   Not a defect.
8. **The proportionality property.** `diff` over the subject's own history
   reports in proportion to the change (1 symbol over 15 files, 11 over 46),
   never to the size of the tree.

### Contradicted

- **Nothing from either prior run was contradicted.** Every positive finding
  reproduced. Two were *narrowed* rather than reversed:
  - "A client a class is handed is named from its declared type" is true of a
    receiver the package types, and false of a project class that inherits the
    method from a package base class (E2 / E2b vs E2c). The rule was written
    against knex and confirmed against kysely; both are builder-handing
    libraries, and neither could produce the ActiveRecord shape.
  - "Known authority is reported with the whole call path **to the
    controller**" is true where the controller is a class method. Where it is
    an argument-position arrow, the path stops one hop below it (E1), or the
    change is not reported at all (E6).

### New

1. **Authority added inside an argument-position handler is not reported at
   all.** E6: exit 0 in both modes, zero lines, `--coverage` byte-identical.
   This is the first *silent* miss in three subjects, and `docs/DESIGN.md` §6.4
   names it as the thing that must not happen. Not reachable on Unleash or
   immich, whose handlers are class methods; reachable on any Koa, Express,
   Fastify or Hono codebase that registers handlers inline, which is the
   idiomatic style for three of those four.
2. **A §6.4 entry can name no operation at all.** `? <unnamed>
   (external-module)` is the whole report for a hard `DELETE`. Triggered by a
   project-local subclass of a package base class — the ActiveRecord shape
   (Sequelize, TypeORM `BaseEntity`, Mongoose). Strictly worse than the
   missing-call-path finding: the reviewer gets neither the path nor the
   operation, so there is nothing to act on and nothing to close.
3. **First-party code outside the checked directory is unresolved.**
   `extractProject` indexes only files under the checked root, so
   `@shared/utils/error.toError` (52 sites) and
   `@shared/helpers/AuthenticationHelper.canAccess` (27) — ordinary functions
   with bodies in this repository — are `unresolved-symbol`. Two of the top ten
   names. Neither prior subject's checked directory imported sibling
   first-party code. Symmetric across base and head, so it is not `diff` noise;
   it raises `unknown` and truncates paths.
4. **Approval cost scales with the caller fan-out of the edited layer**, not
   with the edit. 16 lines here against 6 and 6, for the same one-line `fetch`.
5. **Two new unresolved reasons appeared in the wild**:
   `overload-without-body` (53 — Sequelize's overloaded model statics) and
   `ambient-declaration` (3 — the project's own `.d.ts`).
6. **A package written `export =` is named through its default export**
   (`bull.default.add`). Identifiable but wrong in the part that matters least;
   recorded, not acted on.
7. **`diff` tracked a rename across directories** on the subject's own history
   (`utils/opensearch.ts` → `routes/discovery/opensearch.ts`), reporting a move
   rather than a new symbol. First time a real third-party history exercised it.

## Is §6.4's explanation the recurring reviewer problem?

Partly, and this run changes the answer.

It **is** recurring: on all three subjects, every operation through a
dependency no table covers is reported body-locally, with no route from a
changed caller to the leaf. Here that is the ORM, the queue and the object
store — the repository's whole authority surface.

But on this subject it is **not the top problem**, and the evidence says so
twice.

- E6 is a *miss*, not a reporting shape. No enrichment of a report that is
  never emitted can help.
- E2 shows the explanation failing one level below the call path: the entry
  exists, `--strict` fails on it, and it says `<unnamed>`. A witness path
  attached to that entry would tell a reviewer which endpoint reaches an
  operation nobody can identify.

### What information the reviewer was missing

Ranked by what a reviewer reading each report actually could not do.

| report | what is missing | consequence |
|---|---|---|
| E6 | everything | the change is invisible; no review happens |
| E2 / E2b | the operation's identity **and** the path | `--strict` fails with `? <unnamed>`; nothing to close |
| E4 / E5 / E2c | one route from a changed caller to the leaf | the reviewer has the operation and must find the endpoint by hand |
| E1 / E3 / E3b | the HTTP entry point above the deepest named symbol | the reviewer sees jobs and MCP, and may conclude no request path changed |

### Can caller/reachability enrichment address it without changing `unresolved` semantics?

For rows 3 and 4, yes — a witness path attached to the body-local entry, as
`docs/open-questions.md` already frames it, and `diff` already computes exactly
this shape for authority (E1's `->` chains).

For rows 1 and 2, no.

- Row 2 is not a path problem. `installedTypeNameOf` names a receiver from its
  declared type and stops; nothing about a caller path supplies the name of an
  operation. This needs the callee's **declaring** type, which the analysis
  already located — `external-module` is derived from that same declaration
  file.
- Row 1 is not a reporting problem at all. Until the handler body is analyzed
  there is no record, no entry, and nothing to attach a path to.

## Blockers, ranked

Ranked by `<decision>`'s order: credible CI use first, then cross-repository
frequency, then reviewability and security, then implementation scope.

1. **Authority inside an argument-position function is invisible to `diff`.**
   *CI:* total, and worse than a false positive — the gate passes a change that
   added an outbound POST to a request handler, in both modes, with no line to
   read. A green `ambit diff` is the assurance the product sells.
   *Frequency:* new as a miss, but its cause is measured on all three subjects
   (4,141 callback-argument skips on immich, 5,741 here) and the exposed
   population is every codebase whose handlers are registered inline: Koa,
   Express, Fastify, Hono.
   *Security:* the highest — this is the position an AI agent edits.
   *Scope:* **large, and it turns on an unsettled design question.** An
   anonymous argument-position function has no `docs/DESIGN.md` §5.3
   declaration path. A positional key contradicts §6.4's "the key holds no
   position"; a key derived from the registration's literal argument was
   measured at 86% static determinability, with one silently *wrong* answer, in
   [`http-route-key-spike.md`](http-route-key-spike.md) /
   [ADR-0007](../adr/0007-http-route-keys.md). Picking one is a specification
   change, not a patch.
2. **A §6.4 entry can name no operation.** *CI:* `--strict` is the only mode
   that catches E2, and what it prints cannot be acted on. On an ActiveRecord
   codebase that is every database operation, so `--strict` degenerates into an
   unclosable failure — `docs/open-questions.md`'s "`unknown` fatigue" trigger
   ("an adopter turning `--strict` off rather than fixing what it reports") in
   its purest form. *Frequency:* new here, but the shape is structural:
   Sequelize, TypeORM `BaseEntity`, Mongoose, and any framework base class.
   *Security:* a hard `DELETE` inside `findByPk` reported as `<unnamed>`.
   *Scope:* small and additive — the declaration whose file already produced
   the `external-module` reason also carries the type that declares the method.
3. **§6.4 entries carry no call path.** Third subject, unchanged from immich's
   ranking. Real, and it is a reporting shape rather than a miss: the operation
   is named (except under blocker 2) and `--strict` fails on it.
4. **First-party code outside the checked directory is unresolved.** Raises
   `unknown` and truncates paths, symmetric across base and head so it adds no
   `diff` noise. New, and the honest scope question behind it — "which
   directory is the project" — is `docs/open-questions.md`'s Monorepos entry,
   not a defect.
5. **No table covers `sequelize`, `bull` or `@aws-sdk/client-s3`.** The
   *designed* answer (§4.3): an uncovered operation is `unknown` and `--strict`
   fails on it. Rows are admitted on measurement, not on one repository's
   dependency list.

## E8 — `ambit check` does not terminate

Found while probing a discrepancy the matrix above left open: `check server
--coverage` reports **1,951** functions and `diff` compares **1,950** symbols.
`check server --format json` emits **1,950** `kind: "authority"` records, all
ids unique. `buildAuthorityRecords` reads a `Map<SymbolId, …>`, so one
extracted function has no record of its own: **two declarations in `server/`
share a SymbolId.**

They are in `server/models/base/Model.ts`:

```ts
class Model … {
  public destroyWithCtx(ctx: APIContext, eventOpts?: EventOverrideOptions) { … }   // line 107
  public static destroyWithCtx<M extends Model>(…) { … }                           // line 201
}
```

`collectFunctionLikeDeclarations` indexes a class method as
`[...classPath, member.name.text]` with no marker for `static`, so the
instance method and the static method are both
`models/base/Model.ts#Model.destroyWithCtx`.

### What it does

| edit (each applied alone to the clean tree) | `check server --coverage` |
|---|---|
| none — the baseline | exit 0, **11.5 s** |
| E8a: `fetch(…)` added to the **instance** `destroyWithCtx` | **did not terminate** (killed at 180 s; 88% CPU throughout) |
| E8b: `fetch(…)` added to the **static** `destroyWithCtx` | **did not terminate** (killed at 180 s) |

`ambit diff HEAD server` on E8a was killed at 10 minutes, its child process at
88% CPU the whole time. `check` alone reproduces it, so it is in the analysis,
not in `diff`'s worktree handling.

### Minimal reproduction, independent of outline

No dependencies, no `node_modules`, 11 lines:

```ts
// src/a.ts
export class Thing {
  public run(): void {
    void fetch("https://example.com/one");
  }

  public static run(): void {}
}

export function caller(t: Thing): void {
  t.run();
}
```

```sh
node <ambit>/src/cli/main.ts check src --coverage   # does not terminate
```

Two controls, same file, same command:

| variant | result |
|---|---|
| the static renamed to `runStatic` | exit 0, **1.4 s** |
| both members kept, **neither** having an effect | exit 0, **0.7 s** |

So the trigger is precise: **two function declarations that share a SymbolId
and whose summaries differ.** `propagate`'s fixed point then has two answers
for one key and oscillates between them forever.

This is the invariant `test/backend.conformance.test.ts` records as
load-bearing, and the one `collectFunctionLikeDeclarations` cites twice in its
own comments — for overload signatures ("`ExtractedFile.functions` requires ids
to be unique, because `propagate`'s fixed point does not terminate without
it") and for constructors. Static and instance members of the same class were
not covered by it. `docs/DESIGN.md` §4.1 (a) already has the device that is
missing: an accessor is indexed as `get x` / `set x` precisely "because `get`
and `set` share a name and a plain `x` could not tell them apart".

A same-named static and instance member is an ordinary TypeScript idiom —
`static create` beside `create`, `static from` beside `from` — and needs no
framework, dependency, or configuration to hit.

## Blockers, re-ranked after E8

E8 changes the order. The list below replaces the one above; nothing in the
earlier list was withdrawn.

| # | blocker | CI | frequency | reviewability / security | scope |
|---|---|---|---|---|---|
| **B0** | **`check` / `diff` never terminate** when two declarations share a SymbolId and differ | **total — no answer at all** | one repository, but the cause needs only a class with a same-named static and instance member; 11-line repro with no dependencies | loud rather than dangerous, but nothing can be reviewed | **small** — the accessor device (§4.1 (a)) applied to `static` |
| B1 | authority inside an argument-position handler is invisible to `diff` | total, and silent | new; the exposed population is every inline-handler codebase (Koa, Express, Fastify, Hono) | **highest** — a green gate over a real increase | **large, and unsettled**: no §5.3 path exists for an anonymous argument-position function, and all three candidate notations have a measured or structural failure mode |
| B2 | a §6.4 entry can name no operation (`? <unnamed>`) | `--strict` becomes unclosable on an ActiveRecord ORM | new; structural for Sequelize / TypeORM `BaseEntity` / Mongoose | a hard `DELETE` reported as `<unnamed>` | small and additive |
| B3 | §6.4 entries carry no call path | reviewability only | **all three subjects** | the reviewer must find the endpoint by hand | medium |
| B4 | first-party code outside the checked directory is unresolved | none — symmetric across base and head | new | raises `unknown`, truncates paths | a scope question, not a defect |
| B5 | no table covers `sequelize` / `bull` / `@aws-sdk/client-s3` | none — this is §4.3's designed answer | — | — | — |

### Why B1 is not this run's fix, although it ranks highest on security

`<decision>`'s conditions ask for a proposed fix that generalizes and weakens
nothing. Three notations for an anonymous argument-position function were
considered and each has a failure mode that is measured or structural:

- **positional** (`documents.ts#router.post@1852`) contradicts §6.4's "the key
  holds no position, so re-indenting or moving a line reports nothing" — it
  would turn every line shift into a rename and put standing noise on an
  almost-unchanged tree, the one invariant three subjects have established;
- **keyed on the registration's literal argument** (`router.post("documents.create")`)
  was measured for a neighbouring question in
  [`http-route-key-spike.md`](http-route-key-spike.md) /
  [ADR-0007](../adr/0007-http-route-keys.md): 12 of 14 registrations yield a
  literal statically (86%), and one of the misses is *silently wrong* —
  `sub.get("/items")` under `app.route("/api", sub)` keys `/items` for a route
  served at `/api/items`;
- **a per-file pseudo-symbol** holding the union of unindexed top-level
  callback bodies needs no per-handler key and no position, but cannot tell a
  second `fetch` in a file that already has one from the first, so it reports
  nothing for the second — silence again, in a narrower place.

None is clearly right. That is a design question, not a patch, and per
`AGENTS.md` it is recorded and left rather than guessed at. It is recorded in
`docs/open-questions.md`, and the current behaviour with its one-line
workaround (E7) in `docs/limitations.md`. **It is the reason this validation's
recommendation is not "go to an external adopter now".**

### Why B2 is not this run's fix either

It meets `<decision>`'s five conditions and is the runner-up. `<decision>`
allows one, and B0 outranks it on every criterion except that both are small.
Not implemented.

## The decision

`<decision>`'s five conditions, against **B0**:

1. **It blocks credible CI use.** The command does not return. A CI job hangs
   until the runner's own timeout kills it, which reads as infrastructure
   failure rather than as a finding. There is no flag that avoids it and no
   output to read.
2. **Clear general applicability.** The trigger is a class with a same-named
   static and instance member — plain TypeScript, no framework, no dependency,
   no configuration. The 11-line reproduction above has no `node_modules`.
   It was found on the third subject, but nothing about it is third-subject
   shaped.
3. **Behavioural, not cosmetic.** A non-terminating analysis, and — where it
   does terminate, as on the unedited tree — one function's record silently
   standing in for two.
4. **The fix generalizes.** `docs/DESIGN.md` §4.1 (a) already distinguishes
   `get x` from `set x` in the declaration-path segment for exactly this
   reason. Applying the same device to `static` is the same rule, not a new
   one, and touches no repository-specific shape.
5. **It weakens nothing.** The previously-masked declaration gains a record of
   its own, so the analysis sees strictly more, never less. No `unknown`
   becomes known, no detection is removed, and an unmodified tree has nothing
   new to report — measured below.

## The change

Two edits to `collectFunctionLikeDeclarations`, one guard, and the notation
they imply.

- **A `static` class member's declaration-path segment carries the marker** —
  `Cache.static run`, and `Cache.static get total` for a static accessor. This
  is the device `docs/DESIGN.md` §4.1 (a) already uses for `get x` / `set x`,
  applied to the other pair that shares a name. The marker is unconditional:
  applying it only where a collision exists would rename a static method's
  symbol the moment somebody added an instance method beside it.
- **A namespace member hangs off the namespace's name** — `sql.param`.
  `visitTop` descended into a `ModuleDeclaration` with the container path
  unchanged, so a namespaced function and a top-level function of the same name
  shared an id. Found by the guard below, on `drizzle-orm`'s `src/sql/sql.ts`,
  which declares both: it is the same defect, in the second container the
  declaration path was not naming.
- **A residual collision stops the run.** Where ids are minted, a second
  declaration under an id already used throws, naming the id and the line.
  §3.4 forbids turning an analysis failure into "no violations", and the
  failure this replaces is worse than either: no answer at all.
- `docs/DESIGN.md` §4.1 (a), `CHANGELOG.md` (this changes the `symbol`
  notation, so an `ambit.config.ts` key or an `ambit.approvals.md` line naming
  a static or namespaced declaration must be rewritten),
  `docs/analysis-limitations.md`, and two conformance fixtures.

The fixture is in `test/fixtures/backend-conformance/static-and-instance.ts`,
where the two members' effects deliberately **differ**: two summaries under one
id only fail to converge when they disagree, so a fixture with both `pure`
would have passed while the defect was present. With the source change reverted,
`vitest run test/backend.conformance.test.ts` produces no result and is killed
at 90 s; with it, the file's 31 tests pass in 0.6 s.

## After, measured

Same checkouts, same machine, same commands. "Before" is Ambit `58d9a0b`.

### The defect itself

| | before | after |
|---|---|---|
| minimal 11-line repro, `check src --coverage` | **did not terminate** | exit 0, **0.5 s** |
| outline E8a (`fetch` in the instance `destroyWithCtx`), `check server` | **did not terminate** (killed at 180 s) | exit 0, **9.9 s** |
| outline E8b (`fetch` in the static `destroyWithCtx`), `check server` | **did not terminate** (killed at 180 s) | exit 0, **9.7 s** |
| outline E8a, `diff HEAD server` | killed at 10 min, child at 88% CPU | exit 1, **33 authority increases** with paths to `commands/accountProvisioner.ts#accountProvisioner` |
| outline E8b, `diff HEAD server` | not reachable | exit 1, 2 entries on `models/base/Model.ts#Model.static destroyWithCtx` |

### The untouched tree — the invariant

| `diff HEAD server`, unmodified | before | after |
|---|---:|---:|
| authority increases | 0 | **0** |
| §6.4 entries | 0 | **0** |
| symbols compared | 1,950 | **1,951** |
| exit, `diff` / `--strict` | 0 / 0 | **0 / 0** |
| report length | 5 lines | **5 lines** |

The one extra symbol is the previously-masked declaration getting a record of
its own — the analysis sees strictly more, and has nothing new to report about
an unchanged tree. `check server --coverage` is otherwise identical to the
baseline: `unknown` 69.0% (1,347/1,951), 9,618 call sites, 3,698 unresolved,
the same reason histogram and the same top ten. 11.0 s against 11.5 s.

### The matrix, re-run

| | before | after |
|---|---|---|
| E1 `fetch` | exit 1, 16 entries | **exit 1, 16 entries** — unchanged |
| E2 Sequelize hard `DELETE` | exit 0 / `--strict` 1, `? <unnamed>` | **exit 0 / `--strict` 1, `? <unnamed>`** — the symbol now reads `Template.static findByPk`, the operation is still unnamed |
| E6 `fetch` in the inline handler | exit 0, silent | **exit 0, silent** — unchanged |

E2 and E6 are B2 and B1, and neither was this run's fix. They are recorded in
`docs/open-questions.md` and `docs/limitations.md`, not closed. **The
`<unnamed>` entries in the `HEAD~49` range are a different shape again** —
`callback-parameter` and `unresolved-symbol`, not `external-module` — so even
the B2 fix, when it is made, would not name those.

### Regression checks

- **Unleash, the first subject, re-cloned at `044461b` and re-installed**:
  `check src/lib --coverage` reproduces the recorded figures **exactly** —
  16,491 call sites, stub **953**, unresolved **6,426**, `external-module`
  **3,390**, top name `knex.QueryBuilder.where` **448**. `diff HEAD src/lib`
  exit **0**, `--strict` exit **0**, "3523 symbols unchanged, out of 3523".
  Symbol count unchanged, so that repository has no collision.
- **immich, the second subject, re-cloned at `2a62622` and re-installed**:
  `check server/src --coverage` reproduces its recorded figures exactly —
  15,041 call sites, stub **116**, unresolved **8,482**, `external-module`
  **7,738**, top name `kysely.RawBuilder.execute` **1902**. `diff HEAD
  server/src` exit **0**, `--strict` exit **0**, "3061 symbols unchanged, out
  of 3061". The workspace fix from that run is unaffected.
- `pnpm test` **552 passing, 33 files**, against **549, 33** at `58d9a0b`. The
  three new ones are the conformance assertions above.
- `pnpm exec tsc --noEmit` pass. `./node_modules/.bin/biome ci .` pass.
- `check src --coverage` exit 0, `unknown` **37.9% (129/340)** against 37.8%
  (128/339) — the one new function is `memberSegment`, `unknown` because
  `typescript`'s own API has no rows. `AMB-W001` count **10**, unchanged.
- `diff HEAD src` on Ambit itself: **no authority increase, exit 0.**
  `memberSegment` appears as one §6.4 entry, as a new function calling into the
  compiler API does.
- `node scripts/bench-corpus.ts` median **52.6%**, per target hono 52.6%,
  trpc-server 59.7%, elysia 51.7%, got 54.6%, drizzle-orm 39.0% — every number
  unchanged. This run is where the namespace collision surfaced: before the
  namespace fix the guard stopped `drizzle-orm` with
  `two declarations share the symbol id sql/sql.ts#param`, which is the
  previously-silent merge becoming visible. After it, the corpus completes and
  reads the same as it did.

## Answers to the questions this run was set

1. **Standing diff noise on an unmodified tree: zero.** Both modes, 5 lines,
   exit 0, before and after the fix, re-checked on a `git status`-clean tree
   after the whole matrix.
2. **Known authority expansions are detected with useful witness paths — up to
   a point.** E1 and E3/E3b each exit 1 with the full chain, through four hops.
   The paths reach Bull job classes and the MCP server factory and **stop below
   the HTTP route**, because the route handler is an argument-position arrow.
3. **`ambit diff --strict` stays usable: exit 0 on the unmodified tree**, and
   exit 1 only where the analysis genuinely reached less — 8 symbols over 46
   changed commits, and each of E2/E4/E5. No unrelated persistent error.
4. **No, a body-local §6.4 report was not sufficient for review here**, and it
   failed in two different ways: without a call path for E4/E5, and without an
   operation name at all for E2.
5. **What the reviewer was missing**, in order: for E6, everything; for E2, the
   operation's identity and the path; for E4/E5/E2c, one route from a changed
   caller to the leaf; for E1/E3, the HTTP entry point above the deepest named
   symbol.
6. **Caller/reachability enrichment would close rows 3 and 4 and neither of the
   first two.** A witness path supplies no name for an operation, and there is
   nothing to attach a path to when no record exists.
7. **No new base/head environment skew.** `node_modules` is at the git root
   here, so the immich fix links what was already linked; `diff` on the
   unmodified tree is silent in both modes. The layout difference that *did*
   cost something is a different one: the checked directory is not the project,
   so first-party code in `shared/` is unresolved — symmetrically on both
   sides, so no noise.
8. **Repeated / contradicted / new** — the three-repository table above. Eight
   findings repeated, none contradicted (two narrowed), seven new.

## Recommendation

**Fix B1 before asking an external adopter, and do not start a fourth
repository.**

Three subjects is enough. The sampling has stopped producing new questions
about the *gate* — zero standing noise, path-carrying authority reports,
proportional history diffs, and the `unknown` rate's independence from all of
it have now held three times, on three frameworks, three ORMs, three package
managers and three repository layouts. What the third subject produced that the
first two could not is a class of miss, and it is not a sampling question: it
is that `ambit diff` says "No authority increased" about a tree that gained an
outbound POST inside a request handler, which is the one sentence the product
cannot afford to be wrong about. Every subsequent repository written in that
style would report it again, and none of them would tell us anything more about
what to do.

This run's fix was the non-terminating analysis, because a command that never
returns outranks everything and its cause was settled. B1's cause is not
settled — three candidate notations, each with a measured or structural failure
mode — so it needs a design decision, which is where it now sits
(`docs/open-questions.md`). It is small enough to decide and implement
deliberately, and large enough that guessing at it inside a validation run
would have been the wrong way to spend the one change this run allowed.

B2 is the runner-up and is recorded, not implemented.
