# ADR-0016: One approval ledger per repository, naming symbols from the root

- Status: Accepted (2026-09-14) — extends 0008
- Decides: `docs/DESIGN.md` §6.3, where the ledger is and what its symbol id is
  relative to
- Evidence: none measured; the behaviour below is reproduced by
  `test/e2e.approvals.test.ts`

## Context

ADR-0008 decided what an approval is and left where it lives to the search
`ambit.config.ts` uses: walk up from the checked directory, take the nearest
`ambit.approvals.md`, stop at a `package.json` or `.git`. A clean-room audit
showed that search makes the approving file a function of things a pull request
controls:

- A pull request adding `src/ambit.approvals.md` approved its own increase under
  `diff <ref> src`, while the root ledger — the one a repository's review rules
  name — sat unread. The same tree failed under `diff <ref> .`.
- A `package.json` between the checked directory and the root meant the root
  ledger was never read at all.
- Symbol ids are relative to the checked directory, so wherever two directories
  share a ledger, `src/client.ts#fetch` in `packages/a` and in `packages/b` is
  one key: a line written for one package approved the other, including in a
  change that touched only the other.

## Decision

The ledger is `ambit.approvals.md` at the git repository root, on both sides of
the comparison, and nowhere else. A ledger line names its symbol from that root:
the checked directory's path, then the §5.3 id. A file of that name between the
checked directory and the root is reported as not read.

## Why

- **What can grant an approval must be fixed before the pull request exists.**
  Review rules such as `CODEOWNERS` protect a path; a search lets the pull
  request pick the path.
- **The directory argument is not a trust input.** It narrows what is analyzed.
  A security record whose meaning changes with how the command was invoked is
  one nobody can review.
- **A ledger's scope and its keys' scope have to be the same.** One file for the
  repository needs names unique across the repository; `diff <ref> .` already
  prints ids of exactly that shape.
- **Config and ledger are different properties.** A change to a config shows up
  in the comparison; a change to the ledger decides what passes and shows up as
  nothing.

## Alternatives rejected

- **A ledger path in `ambit.config.ts`.** The config is found by the same search,
  so a nested config would redirect the ledger. Fixing the config's location
  instead is this decision with a key added.
- **Nested ledgers scoped to their subtree.** Reads N paths by construction, and
  its safety reduces to protecting a glob. Package-level ownership is a real
  need, but no adopter has shown it yet.
- **Re-rooting the §5.3 symbol id everywhere.** `ambit check` runs without a git
  repository, and the NDJSON `symbol` field is guaranteed surface. Only the
  ledger has a repository, so only the ledger's names are re-rooted.

## Consequences

- Breaking for a ledger below the root, and for a line written relative to a
  subdirectory. Lines already merged need no rewriting: a line in the base grants
  nothing whatever it names. New lines use the root-relative form, so an existing
  ledger holds both.
- A ledger line is no longer the same text as the `symbol` of a `check`
  diagnostic when `check` was run on a subdirectory. `diff` prints the line to
  copy, and that is the workflow the ledger is filled by.
- Per-package approvers cannot be expressed by the file alone.

## Revisit when

- An adopter needs approvers per package. The shape that keeps this decision's
  first reason is an allow-list of ledger paths declared at the root, never a
  search.
