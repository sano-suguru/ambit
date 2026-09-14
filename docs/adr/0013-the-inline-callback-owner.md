# ADR-0013: A file's inline callbacks are one entry, compared as a multiset over its bodies

- Status: Accepted (2026-09-11)
- Decides: `docs/DESIGN.md` §4.1 (a) "The inline-callback owner", §6.3 "What
  'grew' means", §6.4's third shape
- Evidence:
  [`measurements/2026-09-11-inline-callback-owner.md`](../measurements/2026-09-11-inline-callback-owner.md),
  [`measurements/2026-09-11-third-third-party-validation-outline.md`](../measurements/2026-09-11-third-third-party-validation-outline.md)
- Extends: ADR-0008 (what an approval is written against)

## Context

`router.post("documents.create", auth(), async (ctx) => { … })` — the idiomatic
registration in Koa, Express, Fastify and Hono — puts the handler body in a
function with no name and, at module scope, no extracted ancestor. Nothing
walked it: authority added inside one was reported by neither `ambit diff` mode.
Any fix has to supply an identity stable enough that an `ambit.approvals.md`
line written today still matches tomorrow (§6.3), and an anonymous function has
no name.

## Decision

Every unowned inline callback in a file is analyzed under **one** entry,
`file.ts#<inline callbacks>`, declarable by nobody. `ambit diff` compares
authority as a **multiset over the bodies a symbol owns**, which for the one body
every other symbol owns is the set comparison it already was. Where what the
bodies hold moves between them without any count changing, the comparison
reports that it cannot match them — §6.4's third shape, failing only `--strict`.

## Why

- **The entry holds no position and no ordinal**, so it survives re-indenting,
  moving a registration, and inserting or deleting a neighbour.
- **The multiset pays for the shared identity**: two handlers holding `network`
  are two holders, so a third is an increase.
- **A move is indistinguishable from a reorder.** One handler losing authority
  while another gains it is the same pair of sequences a reorder produces, and
  one reading is a public route that can now reach the network. Picking the safe
  reading would be the guess §3.4 forbids; reporting the uncertainty costs no
  approval line.

## Alternatives rejected

- **A name per callback.** No stable candidate exists: a position contradicts
  §6.4's "the key holds no position"; an ordinal renames every sibling below an
  inserted one, which `ambit diff` reads as new symbols; the registration's
  literal argument misses some registrations and is silently wrong on one shape
  (ADR-0007).
- **One entry per file, compared as a *set*.** Measured: it merges a large
  number of `(body, authority)` pairs into silence, many of them outside test
  files. Every handler whose neighbour already reaches the network would gain
  network invisibly.
- **Counting authority per call site**: it would report a second `fetch` in a
  handler that already fetches, which a named function does not.
- **Letting `ambit.config.ts` declare the owner.** One sentence would stand for
  every handler in the file (P4).
- **Reporting a move as an increase.** It would tax a reorder with an approval
  line — §6.3's third criterion.
- **Matching whole bodies** to decide whether something moved.
  `[{network}, {db_write}]` → `[{network, db_write}, {}]` leaves no body
  unchanged while `db_write` changes hands, so the comparison is per fact — with
  a capability's presence read by §4.4's containment.

## Consequences

- The analysis sees strictly more code. `--coverage` and `ambit diff --strict`
  move on the third-party subjects; default `ambit diff` still reports zero
  increases on unmodified trees.
- **Per-handler identity is not available.** An increase names the file, and on
  a count increase the witness path names a body holding the authority, which
  need not be the one that changed. Whether that is reviewable enough is
  [`open-questions.md`](../open-questions.md).

## Revisit when

- An adopter reports the file-level increase as unreviewable.
- `--strict` is measured as unusable on a repository that wants it.
