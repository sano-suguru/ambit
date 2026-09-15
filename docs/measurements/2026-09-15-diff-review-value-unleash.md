# Does `ambit diff` change a review decision? Nine real Unleash commits

Run on 2026-09-15, Node.js v24.19.0, macOS (darwin arm64), Ambit at `bab0c4d`.

The question was not the `unknown` rate. It was whether `ambit diff`, run on
real commits a third party actually merged, tells a human reviewer something
that changes what they check or approve. Nothing in Ambit or in the subject was
changed for this run; analysis defects found during it are recorded, not fixed.

## Subject and selection

`Unleash/unleash` main at `41af48e5` (2026-09-15), checked directory `src/lib`.
Unleash was also the subject of the
[2026-09-11 run](2026-09-11-third-party-diff-validation.md), which used
synthetic edits; this run uses only commits the project merged.

The rule, the commit list, and a git-diff-only review judgement for every
commit were written down **before any Ambit command ran**:

- A — the six newest non-merge commits touching non-test `src/lib/**/*.ts`, in
  order, none skipped: `4908e11b0`, `53dd4eede`, `b719d7eb8`, `92a63da2b`,
  `20f9095bb`, `d14ff3b22`.
- B — three older commits chosen by category, deliberately including ones where
  Ambit was expected to say nothing: `93b932133` (an IDOR fix), `8cec1a30f`
  (outbound email, renames methods), `1bebbafec` (a transactional refactor).

"Authority" was judged in two senses, kept apart: **effect authority** (what
Ambit models — database, network, filesystem, state, env) and **application
authorization** (who may do what in Unleash). Ambit claims only the first; the
second is recorded because a reviewer reads a diff for both.

## Procedure

No commit changes `package.json` or `pnpm-lock.yaml` relative to its parent,
so base and head resolve the same packages. The nine commits span five distinct
lockfiles. For each commit `C`: `git checkout C`, `pnpm install
--frozen-lockfile --ignore-scripts` whenever its lockfile differed from the
installed one (five installs, exit 0), then

```sh
node <ambit>/src/cli/main.ts diff HEAD src/lib      # control, untouched tree
node <ambit>/src/cli/main.ts diff C~1 src/lib       # the case
node <ambit>/src/cli/main.ts diff C~1 src/lib --strict
```

Every report was then checked against `ambit check src/lib --format json` at
`C~1` and at `C`, comparing the reported symbol's `effects.observed`. A report
is labelled:

- **useful** — the reviewer should confirm or approve it, and would not have
  otherwise;
- **noise** — true, but not worth a reviewer's attention;
- **wrong** — the stated increase did not happen.

## Controls

All nine `diff HEAD src/lib` runs on untouched trees: exit 0, no increase
(3,841–3,850 symbols compared, 15–31 s). The gate has no standing noise here,
as on 2026-09-11.

## Cases

### C1 `4908e11b0` — fix: reject duplicate strategy parameter names

- Git-diff review: one `joi` `.unique('name')` in `strategy-schema.ts`, two new
  tests. Focus: validation tightening. No effect or authorization change.
- `ambit diff`: exit 1, five increases, all on
  `routes/admin-api/strategy.test.ts#<inline callbacks>`: `network`, `db_read`,
  `fs_read`, `state_write`, `env`. Also "several anonymous bodies … cannot be
  matched".
- Check: `check` gives that symbol the same observed set on both sides —
  `network, db_read, fs_read, state_write, env`. The base file already called
  `getSetup()` 18 times. The report is still true by the specification: the
  file's inline callbacks are compared as a multiset over the bodies they own,
  and the two new `test(…)` bodies each call `getSetup()`, so they are new
  holders of all five effects.
- Labels: 5 × **noise** (true per the multiset rule; the new holders are test
  bodies calling an existing helper).
- Missed: none.
- Review decision changed: **no**. Adopted as a CI gate, this validation fix
  would have been blocked until five approval lines for test code were
  committed.

### C2 `53dd4eede` — feat(addon): addon service layer for the project route

- Git-diff review: `createAddon` / `updateAddon` / `removeAddon` take an
  optional `project`; update and remove throw `NotFoundError` unless
  `addon.projects` is exactly `[project]`; create and update overwrite
  `projects`. Focus: authorization correctness (an absent `project` skips the
  check). No new effect.
- `ambit diff`: exit 1, two increases —
  `addon-service.test.ts#<inline callbacks>` `+state_write`, and
  `AddonService.validateAddonBelongsToProject` `[new symbol]` `+state_write`
  through `NotFoundError` → `UnleashError.constructor`.
- Check: the test symbol is `state_write` on both sides; the commit adds test
  bodies, which the multiset rule counts as new holders. `UnleashError extends
  Error` and assigns `this.id`, which the specification makes `state_write`
  (the constructor `this` of a class with `extends` is not local).
- Labels: test symbol **noise**; `validateAddonBelongsToProject` **noise** (true
  by the rules; the "authority" is constructing an error to throw).
- Missed: the project-scoped authorization rule (application authorization,
  outside the effect model).
- Review decision changed: **no**.

### C3 `b719d7eb8` — chore: clean up `topLabelInputs` flag

- Git-diff review: removes a flag and its env var read; the rest is frontend. No
  increase.
- `ambit diff`: exit 0, no increase.
- Labels: none. Missed: none. Review decision changed: **no**.

### C4 `92a63da2b` — chore: remove unused `newProfileDropdown`

- Git-diff review: same shape as C3. No increase.
- `ambit diff`: exit 0, no increase.
- Labels: none. Missed: none. Review decision changed: **no**.

### C5 `20f9095bb` — feat(permissions): add `UPDATE_PROJECT_ADDON`

- Git-diff review: a permission constant, plus a **JavaScript** migration that
  inserts the permission and grants it to the `Owner` project role. Focus: the
  grant. This is an authorization increase.
- `ambit diff`: exit 0, no increase.
- Labels: none.
- Missed: the role grant. It is application authorization in a `.js` migration
  executed as SQL — outside the effect model and outside the TypeScript sources.
- Review decision changed: **no**.

### C6 `d14ff3b22` — feat: rate limiting for the Admin API

- Git-diff review: a new rule for `/api/admin`, applied before authentication,
  default 6,000/min, read from `ADMIN_API_RATE_LIMIT_PER_MINUTE`. Focus: whether
  the default throttles legitimate automation. Pre-registered expectation: an
  env-read increase.
- `ambit diff`: exit 0, no increase.
- Check: `loadRateLimitingConfig` and `createRateLimitRules` have an empty
  observed set on both sides. The specification's effect table defines `env` as
  including environment variables, and `loadRateLimitingConfig` already read
  seven `process.env` variables at base, so by the specification this is `env`
  → `env`: no increase. What the run does show is a code/specification
  disagreement: the seven `process.env` reads in this function are not observed
  as `env`. If that holds elsewhere, a function reading its first environment
  variable would not be reported; this run did not test that case.
- Labels: none. Missed: no increase in this commit (the added read is in a
  function that already read env; the behaviour change is a restriction).
  Review decision changed: **no**.

### C7 `93b932133` — fix: cross-project IDOR on feature-dependency routes

- Git-diff review: dependency queries narrowed by project; `store.delete` now
  reads `features` in a subquery; import uses `dto.project` instead of the
  feature's own project. Focus: authorization correctness and that import
  change. No new kind of I/O.
- `ambit diff`: exit 1, four increases —
  `DependentFeaturesReadModel.getDependencies` `+db_read`;
  `DependentFeaturesStore.delete` `+db_read`;
  `dependent.features.e2e.test.ts#<inline callbacks>` `+db_write`;
  `FeaturesReadModel.featuresInProject` `[new symbol]` `+db_read` (replacing
  `featuresInTheSameProject`).
- Check: `getDependencies` observed nothing at base although its base body is
  `await this.db('dependent_features').whereIn(…)`; the head adds `.select` in a
  subquery, which is observed. `featuresInTheSameProject` likewise observed
  nothing at base (`countDistinct` / `whereIn`). `delete` goes from `db_write` to
  `db_read, db_write`. The e2e test gains `db_write` at head.
- Labels: `getDependencies` **wrong** (the function read the database before
  and after; what increased is what the analysis observed — `select` is
  observed, `whereIn` is not); `delete` **noise** (a real new read, already
  visible and already noted in the git-diff review); e2e test **noise**;
  `featuresInProject` **noise** (a new symbol doing the read its predecessor
  did).
- Missed: nothing in the effect sense; the authorization change is a narrowing
  and outside the model.
- Review decision changed: **no**.

### C8 `8cec1a30f` — feat: batch same-user expiry tokens in one email

- Git-diff review: two methods renamed to plural forms, context type tightened,
  templates changed. No effect change.
- `ambit diff`: exit 1, four increases — `fs_read` and `state_write` on each of
  `sendPersonalApiTokensExpiryEmail` and `sendServiceAccountTokensExpiryEmail`,
  both `[new symbol]`; the singular originals listed as no longer present.
- Check: the originals had `fs_read, state_write` at base; the renamed ones have
  the same at head.
- Labels: 4 × **noise** (true per symbol; a rename, not new authority).
- Missed: none. The reported set omits the SMTP send; the output does flag both
  symbols as incompletely resolved.
- Review decision changed: **no**.

### C9 `1bebbafec` — fix: client registration writes resilient to deadlocks

- Git-diff review: two upserts wrapped in a transaction, rows sorted,
  `seenClients` restored on error. Focus: transaction semantics. No new effect.
- `ambit diff`: exit 1, two increases —
  `client-applications-store.test.ts#<inline callbacks>` `+db_read`;
  `instance-service.test.ts#<inline callbacks>` `+state_write`.
- Check: the first gains `db_read` at head; the second is `state_write, env` on
  both sides, with new test bodies added (multiset rule, as in C1).
  `bulkUpsert` is `db_write, state_write, env` on both sides.
- Labels: both **noise** (test code).
- Missed: none. Review decision changed: **no**.

## Totals

- Increase lines reported: 17 — useful 0, noise 16, wrong 1.
- 9 of the 17 are on test files (Unleash's `tsconfig.json` includes them); 7 of
  those are new test bodies counted as new holders by the multiset rule (C1 × 5,
  C2, C9). The 1 wrong is a base-side read the analysis did not observe (C7
  `getDependencies`).
- Increases in production files alone: 8 — noise 7, wrong 1; C2, C7 and C8
  would still exit 1.
- Commits `diff` failed: 5 of 9 (C1, C2, C7, C8, C9). `--strict` changed no exit
  code.
- Effect-authority increases a reviewer found that `diff` did not: 0. The sample
  contained no real effect-authority increase at all, so detection was not
  exercised.
- Application-authorization changes `diff` did not report: C2 (project-scoped
  rule), C5 (permission granted to `Owner`), C7 (narrowed). None is in Ambit's
  model.
- Review decisions changed by `diff`: **0 of 9**.

## Verdict for this sample

Nine commits from one repository. No report was useful, sixteen were noise and
one was wrong, and a gate would have failed five ordinary commits; no review
decision changed. This run gives no evidence of review value. It also cannot
show the absence of value in detection: none of the nine commits granted new
effect authority.

Recorded, not fixed: `process.env` reads are not observed as `env`, although the
specification's effect table includes environment variables in `env` (C6).

## Raw output

The case outputs below are verbatim; the control outputs all end in
`N symbols unchanged, out of N symbols compared.` with exit 0.

<details><summary><code>4908e11b0</code></summary>

```text
$ ambit diff 4908e11b0~1 src/lib   (working tree = 4908e11b0)
base 4908e11b0~1 (53dd4ee) vs the working tree, over src/lib

5 authorities increased without approval:

  routes/admin-api/strategy.test.ts#<inline callbacks> (routes/admin-api/strategy.test.ts:1)
    + network
      -> getSetup (routes/admin-api/strategy.test.ts:9)
      -> getApp (app.ts:51)
      -> loadIndexHTML (util/load-index-html.ts:7)
      operation: ky.get (util/load-index-html.ts:17)
    - `src/lib/routes/admin-api/strategy.test.ts#<inline callbacks>` `effect:network` — <why this increase is correct>

  routes/admin-api/strategy.test.ts#<inline callbacks> (routes/admin-api/strategy.test.ts:1)
    + db_read
      -> getSetup (routes/admin-api/strategy.test.ts:9)
      -> createServices (services/index.ts:198)
      -> createInstanceStatsService (features/instance-stats/createInstanceStatsService.ts:62)
      -> createGetActiveUsers (features/instance-stats/getActiveUsers.ts:10)
      operation: knex.QueryBuilder.from (features/instance-stats/getActiveUsers.ts:13)
    - `src/lib/routes/admin-api/strategy.test.ts#<inline callbacks>` `effect:db_read` — <why this increase is correct>

  routes/admin-api/strategy.test.ts#<inline callbacks> (routes/admin-api/strategy.test.ts:1)
    + fs_read
      -> getSetup (routes/admin-api/strategy.test.ts:9)
      -> getApp (app.ts:51)
      -> loadIndexHTML (util/load-index-html.ts:7)
      operation: fs.readFileSync (util/load-index-html.ts:20)
    - `src/lib/routes/admin-api/strategy.test.ts#<inline callbacks>` `effect:fs_read` — <why this increase is correct>

  routes/admin-api/strategy.test.ts#<inline callbacks> (routes/admin-api/strategy.test.ts:1)
    + state_write
    - `src/lib/routes/admin-api/strategy.test.ts#<inline callbacks>` `effect:state_write` — <why this increase is correct>

  routes/admin-api/strategy.test.ts#<inline callbacks> (routes/admin-api/strategy.test.ts:1)
    + env
      -> getSetup (routes/admin-api/strategy.test.ts:9)
      operation: Math.random (routes/admin-api/strategy.test.ts:10)
    - `src/lib/routes/admin-api/strategy.test.ts#<inline callbacks>` `effect:env` — <why this increase is correct>

Add each line above to ambit.approvals.md at the repository root,
with the reason, and commit it in the same change. An approval already in the base
grants nothing.

Analysis reached something it could not resolve in 1 symbol where it previously did not.
This is not authority and is not counted as an increase; those symbols' effects may be incomplete:
  routes/admin-api/strategy.test.ts#<inline callbacks>

1 symbol gained an operation the analysis could not resolve:

  routes/admin-api/strategy.test.ts#<inline callbacks> (routes/admin-api/strategy.test.ts:1)
    ? <unnamed> x4 (external-module)
    ? @vitest/expect.Assertion.toBe x3 (external-module)
    ? @vitest/expect.Assertion.toContain x2 (external-module)
    ? @vitest/expect.Assertion.toEqual (external-module)
    ? expect x6 (external-module)
    ? supertest.TestAgent.post (external-module)
    ? supertest.TestAgent.put (external-module)
    ? <unnamed> x3 (unresolved-symbol)

This is not authority, so no approval covers it and none is asked for. What
closes it is a stub, a verifiable declaration, or explicit isolation behind
@boundary.

1 symbol holds several anonymous bodies, and what each of them holds moved:

  routes/admin-api/strategy.test.ts#<inline callbacks> (routes/admin-api/strategy.test.ts:1)
    ? which body holds what changed, and the bodies cannot be matched

Nothing grew, so this is not an increase and no approval covers it. What it
means is that an authority, or an operation the analysis could not read, may
now sit in a different handler — read the file's diff. Binding a handler to a
name gives it a symbol of its own, which is compared against itself.

3849 symbols unchanged, out of 3850 symbols compared.
exit=1 18s
```

</details>

<details><summary><code>53dd4eede</code></summary>

```text
$ ambit diff 53dd4eede~1 src/lib   (working tree = 53dd4eede)
base 53dd4eede~1 (6630b97) vs the working tree, over src/lib

2 authorities increased without approval:

  services/addon-service.test.ts#<inline callbacks> (services/addon-service.test.ts:1)
    + state_write
    - `src/lib/services/addon-service.test.ts#<inline callbacks>` `effect:state_write` — <why this increase is correct>

  services/addon-service.ts#AddonService.validateAddonBelongsToProject (services/addon-service.ts:210)  [new symbol]
    + state_write
      -> NotFoundError.constructor (error/notfound-error.ts:6)
      -> UnleashError.constructor (error/unleash-error.ts:51)
    - `src/lib/services/addon-service.ts#AddonService.validateAddonBelongsToProject` `effect:state_write` — <why this increase is correct>

Add each line above to ambit.approvals.md at the repository root,
with the reason, and commit it in the same change. An approval already in the base
grants nothing.

Analysis reached something it could not resolve in 2 symbols where it previously did not.
This is not authority and is not counted as an increase; those symbols' effects may be incomplete:
  services/addon-service.test.ts#<inline callbacks>
  services/addon-service.ts#AddonService.validateAddonBelongsToProject

1 symbol gained an operation the analysis could not resolve:

  services/addon-service.test.ts#<inline callbacks> (services/addon-service.test.ts:1)
    ? @vitest/expect.Assertion.rejects.toThrow x4 (external-module)
    ? @vitest/expect.Assertion.toBe x2 (external-module)
    ? @vitest/expect.Assertion.toStrictEqual x3 (external-module)
    ? expect x9 (external-module)

This is not authority, so no approval covers it and none is asked for. What
closes it is a stub, a verifiable declaration, or explicit isolation behind
@boundary.

3848 symbols unchanged, out of 3850 symbols compared.
exit=1 17s
```

</details>

<details><summary><code>b719d7eb8</code></summary>

```text
$ ambit diff b719d7eb8~1 src/lib   (working tree = b719d7eb8)
base b719d7eb8~1 (74998e9) vs the working tree, over src/lib

No authority increased.

3849 symbols unchanged, out of 3849 symbols compared.
exit=0 18s
```

</details>

<details><summary><code>92a63da2b</code></summary>

```text
$ ambit diff 92a63da2b~1 src/lib   (working tree = 92a63da2b)
base 92a63da2b~1 (20f9095) vs the working tree, over src/lib

No authority increased.

3849 symbols unchanged, out of 3849 symbols compared.
exit=0 16s
```

</details>

<details><summary><code>20f9095bb</code></summary>

```text
$ ambit diff 20f9095bb~1 src/lib   (working tree = 20f9095bb)
base 20f9095bb~1 (2d4e725) vs the working tree, over src/lib

No authority increased.

3849 symbols unchanged, out of 3849 symbols compared.
exit=0 19s
```

</details>

<details><summary><code>d14ff3b22</code></summary>

```text
$ ambit diff d14ff3b22~1 src/lib   (working tree = d14ff3b22)
base d14ff3b22~1 (ffc7a69) vs the working tree, over src/lib

No authority increased.

3849 symbols unchanged, out of 3849 symbols compared.
exit=0 17s
```

</details>

<details><summary><code>93b932133</code></summary>

```text
$ ambit diff 93b932133~1 src/lib   (working tree = 93b932133)
base 93b932133~1 (89feebb) vs the working tree, over src/lib

4 authorities increased without approval:

  features/dependent-features/dependent-features-read-model.ts#DependentFeaturesReadModel.getDependencies (features/dependent-features/dependent-features-read-model.ts:50)
    + db_read
      operation: knex.QueryBuilder.select (features/dependent-features/dependent-features-read-model.ts:58)
    - `src/lib/features/dependent-features/dependent-features-read-model.ts#DependentFeaturesReadModel.getDependencies` `effect:db_read` — <why this increase is correct>

  features/dependent-features/dependent-features-store.ts#DependentFeaturesStore.delete (features/dependent-features/dependent-features-store.ts:40)
    + db_read
      operation: knex.QueryBuilder.select (features/dependent-features/dependent-features-store.ts:49)
    - `src/lib/features/dependent-features/dependent-features-store.ts#DependentFeaturesStore.delete` `effect:db_read` — <why this increase is correct>

  features/dependent-features/dependent.features.e2e.test.ts#<inline callbacks> (features/dependent-features/dependent.features.e2e.test.ts:1)
    + db_write
      operation: knex.QueryBuilder.insert (features/dependent-features/dependent.features.e2e.test.ts:401)
    - `src/lib/features/dependent-features/dependent.features.e2e.test.ts#<inline callbacks>` `effect:db_write` — <why this increase is correct>

  features/feature-toggle/features-read-model.ts#FeaturesReadModel.featuresInProject (features/feature-toggle/features-read-model.ts:33)  [new symbol]
    + db_read
      operation: knex.QueryBuilder.select (features/feature-toggle/features-read-model.ts:38)
    - `src/lib/features/feature-toggle/features-read-model.ts#FeaturesReadModel.featuresInProject` `effect:db_read` — <why this increase is correct>

Add each line above to ambit.approvals.md at the repository root,
with the reason, and commit it in the same change. An approval already in the base
grants nothing.

Analysis reached something it could not resolve in 2 symbols where it previously did not.
This is not authority and is not counted as an increase; those symbols' effects may be incomplete:
  features/dependent-features/dependent.features.e2e.test.ts#<inline callbacks>
  features/feature-toggle/features-read-model.ts#FeaturesReadModel.featuresInProject

4 symbols gained an operation the analysis could not resolve:

  features/dependent-features/dependent-features-read-model.ts#DependentFeaturesReadModel.getDependencies (features/dependent-features/dependent-features-read-model.ts:50)
    ? knex.QueryBuilder.andWhere (external-module)
    ? knex.QueryBuilder.whereIn x2 (external-module)
    ? <unnamed> (unresolved-symbol)
  features/dependent-features/dependent-features-store.ts#DependentFeaturesStore.delete (features/dependent-features/dependent-features-store.ts:40)
    ? knex.QueryBuilder.where (external-module)
    ? knex.QueryBuilder.whereIn (external-module)
    ? <unnamed> (unresolved-symbol)
  features/dependent-features/dependent.features.e2e.test.ts#<inline callbacks> (features/dependent-features/dependent.features.e2e.test.ts:1)
    ? @vitest/expect.Assertion.toEqual x3 (external-module)
    ? @vitest/expect.Assertion.toHaveLength x3 (external-module)
    ? expect x6 (external-module)
    ? knex.QueryBuilder.where (external-module)
    ? supertest.Test.expect x3 (external-module)
    ? supertest.Test.send (external-module)
    ? supertest.TestAgent.delete x2 (external-module)
    ? supertest.TestAgent.post (external-module)
    ? test x3 (external-module)
    ? <unnamed> x4 (unresolved-symbol)
  features/feature-toggle/tests/features-read-model.e2e.test.ts#<inline callbacks> (features/feature-toggle/tests/features-read-model.e2e.test.ts:1)
    ? @vitest/expect.Assertion.toBe x2 (external-module)
    ? expect x2 (external-module)

This is not authority, so no approval covers it and none is asked for. What
closes it is a stub, a verifiable declaration, or explicit isolation behind
@boundary.

2 symbols no longer present:
  features/feature-toggle/fakes/fake-features-read-model.ts#FakeFeaturesReadModel.featuresInTheSameProject
  features/feature-toggle/features-read-model.ts#FeaturesReadModel.featuresInTheSameProject

3835 symbols unchanged, out of 3843 symbols compared.
exit=1 24s
```

</details>

<details><summary><code>8cec1a30f</code></summary>

```text
$ ambit diff 8cec1a30f~1 src/lib   (working tree = 8cec1a30f)
base 8cec1a30f~1 (8ea0eb3) vs the working tree, over src/lib

4 authorities increased without approval:

  services/email-service.ts#EmailService.sendPersonalApiTokensExpiryEmail (services/email-service.ts:567)  [new symbol]
    + fs_read
      -> sendTokenExpiryEmail (services/email-service.ts:612)
      -> compileTemplate (services/email-service.ts:751)
      -> resolveTemplate (services/email-service.ts:765)
      operation: fs.existsSync (services/email-service.ts:775)
    - `src/lib/services/email-service.ts#EmailService.sendPersonalApiTokensExpiryEmail` `effect:fs_read` — <why this increase is correct>

  services/email-service.ts#EmailService.sendPersonalApiTokensExpiryEmail (services/email-service.ts:567)  [new symbol]
    + state_write
      -> sendTokenExpiryEmail (services/email-service.ts:612)
      -> compileTemplate (services/email-service.ts:751)
      -> resolveTemplate (services/email-service.ts:765)
      -> NotFoundError.constructor (error/notfound-error.ts:6)
      -> UnleashError.constructor (error/unleash-error.ts:51)
    - `src/lib/services/email-service.ts#EmailService.sendPersonalApiTokensExpiryEmail` `effect:state_write` — <why this increase is correct>

  services/email-service.ts#EmailService.sendServiceAccountTokensExpiryEmail (services/email-service.ts:589)  [new symbol]
    + fs_read
      -> sendTokenExpiryEmail (services/email-service.ts:612)
      -> compileTemplate (services/email-service.ts:751)
      -> resolveTemplate (services/email-service.ts:765)
      operation: fs.existsSync (services/email-service.ts:775)
    - `src/lib/services/email-service.ts#EmailService.sendServiceAccountTokensExpiryEmail` `effect:fs_read` — <why this increase is correct>

  services/email-service.ts#EmailService.sendServiceAccountTokensExpiryEmail (services/email-service.ts:589)  [new symbol]
    + state_write
      -> sendTokenExpiryEmail (services/email-service.ts:612)
      -> compileTemplate (services/email-service.ts:751)
      -> resolveTemplate (services/email-service.ts:765)
      -> NotFoundError.constructor (error/notfound-error.ts:6)
      -> UnleashError.constructor (error/unleash-error.ts:51)
    - `src/lib/services/email-service.ts#EmailService.sendServiceAccountTokensExpiryEmail` `effect:state_write` — <why this increase is correct>

Add each line above to ambit.approvals.md at the repository root,
with the reason, and commit it in the same change. An approval already in the base
grants nothing.

Analysis reached something it could not resolve in 2 symbols where it previously did not.
This is not authority and is not counted as an increase; those symbols' effects may be incomplete:
  services/email-service.ts#EmailService.sendPersonalApiTokensExpiryEmail
  services/email-service.ts#EmailService.sendServiceAccountTokensExpiryEmail

2 symbols no longer present:
  services/email-service.ts#EmailService.sendPersonalApiTokenExpiryEmail
  services/email-service.ts#EmailService.sendServiceAccountTokenExpiryEmail

3843 symbols unchanged, out of 3848 symbols compared.
exit=1 33s
```

</details>

<details><summary><code>1bebbafec</code></summary>

```text
$ ambit diff 1bebbafec~1 src/lib   (working tree = 1bebbafec)
base 1bebbafec~1 (ac2cada) vs the working tree, over src/lib

2 authorities increased without approval:

  db/client-applications-store.test.ts#<inline callbacks> (db/client-applications-store.test.ts:1)
    + db_read
      operation: knex.QueryBuilder.first (db/client-applications-store.test.ts:39)
    - `src/lib/db/client-applications-store.test.ts#<inline callbacks>` `effect:db_read` — <why this increase is correct>

  features/metrics/instance/instance-service.test.ts#<inline callbacks> (features/metrics/instance/instance-service.test.ts:1)
    + state_write
    - `src/lib/features/metrics/instance/instance-service.test.ts#<inline callbacks>` `effect:state_write` — <why this increase is correct>

Add each line above to ambit.approvals.md at the repository root,
with the reason, and commit it in the same change. An approval already in the base
grants nothing.

Analysis reached something it could not resolve in 1 symbol where it previously did not.
This is not authority and is not counted as an increase; those symbols' effects may be incomplete:
  features/metrics/instance/instance-service.test.ts#<inline callbacks>

4 symbols gained an operation the analysis could not resolve:

  db/client-applications-store.test.ts#<inline callbacks> (db/client-applications-store.test.ts:1)
    ? @vitest/expect.Assertion.toBe (external-module)
    ? @vitest/expect.Assertion.toEqual (external-module)
    ? @vitest/runner.test (external-module)
    ? knex.QueryBuilder.where (external-module)
    ? vitest.expect x2 (external-module)
    ? <unnamed> x2 (unresolved-symbol)
  db/client-applications-store.ts#ClientApplicationsStore.bulkUpsert (db/client-applications-store.ts:209)
    ? <unnamed> x2 (callback-parameter)
    ? knex.Transaction.raw x2 (external-module)
  features/metrics/instance/instance-service.test.ts#<inline callbacks> (features/metrics/instance/instance-service.test.ts:1)
    ? @vitest/expect.Assertion.toMatchObject (external-module)
    ? expect (external-module)
    ? vitest.VitestUtils.fn x2 (external-module)
    ? new ../../../../test/fixtures/fake-event-store.js.default (unresolved-symbol)
    ? new ../../../../test/fixtures/fake-strategies-store.js.default (unresolved-symbol)
  features/metrics/instance/metrics.test.ts#<inline callbacks> (features/metrics/instance/metrics.test.ts:1)
    ? @vitest/expect.ExpectStatic.arrayContaining (external-module)

This is not authority, so no approval covers it and none is asked for. What
closes it is a stub, a verifiable declaration, or explicit isolation behind
@boundary.

3840 symbols unchanged, out of 3845 symbols compared.
exit=1 27s
```

</details>

### `check` comparison behind the labels

```text
== 53dd4eede~1
    services/addon-service.test.ts#<inline callbacks> => state_write (unknown)
    services/addon-service.ts#AddonService.updateAddon => state_write (unknown)
    services/addon-service.ts#AddonService.removeAddon => state_write (unknown)
== 53dd4eede
    services/addon-service.test.ts#<inline callbacks> => state_write (unknown)
    services/addon-service.ts#AddonService.updateAddon => state_write (unknown)
    services/addon-service.ts#AddonService.removeAddon => state_write (unknown)
== 93b932133~1
    features/dependent-features/dependent-features-read-model.ts#DependentFeaturesReadModel.getDependencies =>  (unknown)
    features/dependent-features/dependent-features-store.ts#DependentFeaturesStore.delete => db_write (unknown)
    features/dependent-features/dependent.features.e2e.test.ts#<inline callbacks> => state_write (unknown)
    features/feature-toggle/features-read-model.ts#FeaturesReadModel.featuresInTheSameProject =>  (unknown)
    features/feature-toggle/features-read-model.ts#FeaturesReadModel.featuresInProject => (absent)
== 93b932133
    features/dependent-features/dependent-features-read-model.ts#DependentFeaturesReadModel.getDependencies => db_read (unknown)
    features/dependent-features/dependent-features-store.ts#DependentFeaturesStore.delete => db_read,db_write (unknown)
    features/dependent-features/dependent.features.e2e.test.ts#<inline callbacks> => db_write,state_write (unknown)
    features/feature-toggle/features-read-model.ts#FeaturesReadModel.featuresInTheSameProject => (absent)
    features/feature-toggle/features-read-model.ts#FeaturesReadModel.featuresInProject => db_read (unknown)
== 8cec1a30f~1
    services/email-service.ts#EmailService.sendPersonalApiTokenExpiryEmail => fs_read,state_write (unknown)
    services/email-service.ts#EmailService.sendPersonalApiTokensExpiryEmail => (absent)
    services/email-service.ts#EmailService.sendTokenExpiryEmail => fs_read,state_write (unknown)
== 8cec1a30f
    services/email-service.ts#EmailService.sendPersonalApiTokenExpiryEmail => (absent)
    services/email-service.ts#EmailService.sendPersonalApiTokensExpiryEmail => fs_read,state_write (unknown)
    services/email-service.ts#EmailService.sendTokenExpiryEmail => fs_read,state_write (unknown)
== 1bebbafec~1
    db/client-applications-store.test.ts#<inline callbacks> => state_write,env (unknown)
    features/metrics/instance/instance-service.test.ts#<inline callbacks> => state_write,env (unknown)
    db/client-applications-store.ts#ClientApplicationsStore.bulkUpsert => db_write,state_write,env (unknown)
== 1bebbafec
    db/client-applications-store.test.ts#<inline callbacks> => db_read,state_write,env (unknown)
    features/metrics/instance/instance-service.test.ts#<inline callbacks> => state_write,env (unknown)
    db/client-applications-store.ts#ClientApplicationsStore.bulkUpsert => db_write,state_write,env (unknown)
== d14ff3b22~1
    create-config.ts#loadRateLimitingConfig =>  (unknown)
    middleware/rate-limit-middleware.ts#createRateLimitRules =>  (unknown)
== d14ff3b22
    create-config.ts#loadRateLimitingConfig =>  (unknown)
    middleware/rate-limit-middleware.ts#createRateLimitRules =>  (unknown)
```

### Pre-registration, verbatim

Written before the first Ambit command against Unleash. Its C6 expectation and
its "Expect Ambit" lines are predictions, kept as written.

```text
# Pre-registration — written before any Ambit command ran against Unleash

Subject: Unleash/unleash main @ 41af48e5 (2026-09-15). Checked dir: src/lib.

Selection rule (fixed before running Ambit):
- A: the six newest non-merge commits on main touching non-test `src/lib/**/*.ts`,
  in order, no skipping by content: 4908e11b0, 53dd4eede, b719d7eb8, 92a63da2b, 20f9095bb, d14ff3b22.
- B: three older commits picked by category, deliberately including ones where Ambit is
  expected to report nothing: 93b932133 (authorization/IDOR fix), 8cec1a30f (outbound
  email feature, renames methods), 1bebbafec (transactional/deadlock refactor).
No commit changes package.json / pnpm-lock.yaml.

"Authority" is judged in two senses and recorded separately:
- effect authority (Ambit's model): which I/O / process / env / network a function can reach
- application authorization: who may do what in Unleash (permissions, project scoping)

## Git-diff-only review judgement (item 1), recorded before Ambit output

C1 4908e11b0 strategy-schema: joi `.unique('name')` on parameters.
  Review focus: validation tightening; could reject payloads previously accepted.
  Effect authority: none. App authorization: none. Expect Ambit: nothing.

C2 53dd4eede addon-service: optional `project` arg; update/remove throw NotFound unless
  addon.projects is exactly [project]; create/update overwrite projects=[project].
  Review focus: authorization correctness (project undefined skips the check; exact-1
  match rule). Effect authority: none new (same store/event calls).
  App authorization: yes (new project-scoped access rule). Expect Ambit: nothing.

C3 b719d7eb8 flag cleanup: removes one env var read (+frontend). Effect: decrease only.
  Review focus: frontend. Expect Ambit: no increase.

C4 92a63da2b flag cleanup: removes one env var read. Effect: decrease only. Expect: no increase.

C5 20f9095bb new permission constant + JS migration inserting a permission row.
  Review focus: the migration (who gets the permission). Effect authority in TS: none.
  App authorization: yes (new permission). Migration is .js, outside a TS checker.
  Expect Ambit: nothing.

C6 d14ff3b22 admin API rate limit: new env read ADMIN_API_RATE_LIMIT_PER_MINUTE in
  loadRateLimitingConfig; new rule on /api/admin applied before authentication, 6000/min.
  Review focus: default could throttle legitimate admin automation; pre-auth keying.
  Effect authority: +1 env read in create-config (an increase in Ambit's sense).
  Expect Ambit: possibly an env read increase, if process.env reads are modeled.

C7 93b932133 IDOR fix: queries narrowed by project; store.delete now also reads `features`
  via subquery; import uses dto.project instead of feature.project.
  Review focus: authorization correctness, the import projectId change.
  Effect authority: same DB tables, no new I/O kind. App authorization: narrowed.
  Expect Ambit: nothing.

C8 8cec1a30f email batching: renames sendPersonalApiTokenExpiryEmail ->
  sendPersonalApiTokensExpiryEmail and the service-account equivalent.
  Review focus: template changes, callers (not in OSS src/lib). Effect authority: none
  (same SMTP path). Expect Ambit: possible report because renamed functions are new symbols.

C9 1bebbafec deadlock resilience: wraps two upserts in a transaction, sorts rows,
  restores seenClients on error. Review focus: transaction semantics, error restore.
  Effect authority: none new. Expect Ambit: nothing.
```
