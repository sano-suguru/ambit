# Changelog

Notable changes to `ambit-ts`. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the versioning is
[semantic versioning](https://semver.org/spec/v2.0.0.html), with 0.x read as
semver defines it — while the major version is 0, a **minor** release may make a
breaking change (`docs/DESIGN.md` §9.3).

What a release is obliged to announce here is the **guaranteed surface** of
`docs/DESIGN.md` §9.2: the meaning of the JSDoc tags and of the standard
effects, diagnostic ids and their meanings, the NDJSON diagnostic field shape,
the format of `ambit.approvals.md`, the CLI's commands, flags and exit codes,
and the package's subpath exports. A change to any of those appears here at the
release that makes it, whether or not it also required an RFC.

Changes outside that list are deliberately absent. §9.2's second list says which
those are — added stubs, added runtime hooks, movement in the `unknown` rate,
the resolution of the analysis, and caching. What is implemented and what is not
is [`docs/status.md`](docs/status.md); this file is not a status report.

## [Unreleased]

## [0.1.0] — unreleased

The first published release, so what it records is the guaranteed surface it
establishes rather than a difference from an earlier one. The version's date is
stamped when it is actually published.

One thing here *is* a change rather than an establishment, because it changed
before anyone could depend on it: **governance takes effect at 1.0 or the first
external adopter, not at the first npm publish** (`docs/DESIGN.md` §9.1,
[ADR-0010](docs/adr/0010-when-governance-takes-effect.md)). Until that trigger,
a design decision is an edit to `docs/DESIGN.md` plus a record in `docs/adr/`;
`rfcs/` and `conformance/` arrive with the trigger. Which changes require an RFC
is unchanged. What replaces the procedure in the meantime is §9.2's guaranteed
surface, announced in this file — and §5.2's "an `id` is never deleted or
reused" now says from which version it holds, namely 1.0.

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

One limit worth stating next to the tag list, because a reader could otherwise
assume otherwise from `@budget`'s syntax: of its three limits only `timeMs` is
enforced. `costUsd` and `llmCalls` are parsed, carried and compared, and nothing
increments them. The rest of what Ambit does not do is
[`docs/limitations.md`](docs/limitations.md).
