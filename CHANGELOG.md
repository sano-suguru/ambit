# Changelog

Notable changes to `ambit-ts`. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the versioning is
[semantic versioning](https://semver.org/spec/v2.0.0.html), with 0.x read as
semver defines it — while the major version is 0, a **minor** release may make a
breaking change (`docs/DESIGN.md` §9.3).

What a release must announce here is `docs/DESIGN.md` §9.2's **guaranteed
surface**. Changes outside that list — added stubs, added runtime hooks,
`unknown`-rate movement, caching — are deliberately absent. What is implemented
and what is not is [`docs/status.md`](docs/status.md); this file is not a status
report.

## [Unreleased]

### Added

- **`ambit diff --strict`** — fails the comparison when the analysis reached
  less of the tree than it did on the base side: a symbol that stopped being
  resolved, or a symbol whose own body gained an operation that could not be
  resolved. Both are reported at exit 0 without the flag, as before, so a
  default run's exit codes are unchanged. `diff` previously exited 2 on
  `--strict` as an option it did not act on. Neither shape is an authority
  increase, neither is written into `ambit.approvals.md`, and no diagnostic id
  is minted for either (`docs/DESIGN.md` §6.4,
  [ADR-0012](docs/adr/0012-reporting-an-unresolvable-gain.md)).
- **`unresolved` on the `kind: "authority"` NDJSON record** — the operations in
  a function's own body the analysis could not resolve, as a multiset of
  `{reason, operation?, count}` sorted for byte-stable output. Body-local, never
  propagated, and empty for a `@boundary` function. It is what makes the second
  shape above comparable; `effects.unknown` is unchanged and is not derived from
  it (§5.1).
- Two rows in §6's exit-code table, and the amendment of one: `unknown`
  increased is now "without `--strict`", and both shapes exit 1 with it.

- **`AMB-I002`** — `ambit init` now says *why* it cannot propose a contract.
  For an undeclared function that reached `unknown` and holds the unresolvable
  call in its own body, it reports those calls — name, position, reason — and
  what each reason implies. It carries no `fixes` and proposes no `@boundary`
  ([ADR-0011](docs/adr/0011-reporting-why-a-contract-cannot-be-proposed.md)),
  and it does not change what `AMB-I001` proposes or when.

## [0.1.0] — unreleased

The first release, so this records the surface it establishes rather than a
difference from an earlier one. The date is stamped at publish.

Two rules changed while nothing could yet depend on them. Governance takes
effect at 1.0 or the first external adopter, **not** at the first npm publish
(§9.1, [ADR-0010](docs/adr/0010-when-governance-takes-effect.md)). And §5.2's
"an `id` is never deleted or reused" now says from which version it holds: 1.0.

### Added

- **Contract declarations as JSDoc tags on ordinary TypeScript**: `@effects`,
  `@capabilities`, `@budget`, `@entrypoint`, and `@boundary reason="…"`. Nine
  standard effects, plus user-defined effects composed from them. An undeclared
  function is `unknown`, never `pure`.
- **`ambit check`** — static checking, with `--coverage`, `--strict`,
  `--format json` and `--format github`. Exit 0 when clean, 1 on a violation,
  2 when analysis itself failed.
- **`ambit init`** — proposes `@effects` for the functions that have none;
  `--config` proposes the same declarations as `ambit.config.ts` entries.
- **`ambit diff <ref> [dir]`** — compares the working tree's authority against a
  base ref and exits 1 on an increase no approval covers. `--format github`
  annotates each increase at its declaration. The full exit-code table is
  `docs/DESIGN.md` §6.
- **`ambit.approvals.md`** — the ledger `ambit diff` reads on both sides of a
  comparison. One `- ` line approves one authority gained by one symbol, and
  counts only in the comparison that adds it.
- **NDJSON diagnostics** (`--format json`) — one record per diagnostic, plus one
  `kind: "authority"` record per function, each carrying the analysis `engine`.
- **18 diagnostic ids**, each with its meaning, severity and category in
  [`docs/diagnostics/`](docs/diagnostics/README.md).
- **Out-of-code contracts** — `ambit-ts/config`'s `defineConfig`, for code that
  cannot carry a comment: all five tags, per-directory `strict`, and
  user-defined effects. Where a symbol has both, the JSDoc contract is the one
  in force.
- **Runtime enforcement** — `ambit-ts/runtime`'s `withAmbit`, with capability
  hooks over `fetch`, `node:fs`, `node:fs/promises`, `node:child_process` and
  `pg`, `timeMs` budget enforcement, and a per-context audit trail.
- **Framework adapters** — `ambit-ts/runtime/hono`'s `ambitHandler` and
  `ambit-ts/runtime/next`'s `ambitRoute`. A literal `spec` passed to either, or
  to `withAmbit`, is read as the handler's own `@capabilities` / `@budget`
  declaration.

`@budget` takes three limits and enforces one. `timeMs` is enforced; `costUsd`
and `llmCalls` are parsed, carried and compared, and nothing increments them.
The rest of what Ambit does not do is
[`docs/limitations.md`](docs/limitations.md).
