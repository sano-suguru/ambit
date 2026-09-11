# ADR-0013: A file's inline callbacks are one entry, compared as a multiset over its bodies

- Status: Accepted (2026-09-11)
- Decides: `docs/DESIGN.md` §4.1 (a) "The inline-callback owner", §6.3 "What
  'grew' means", §6.4's third shape
- Evidence:
  [`measurements/2026-09-11-inline-callback-owner.md`](../measurements/2026-09-11-inline-callback-owner.md)
- Extends: ADR-0008 (what an approval is written against)

## Context

`router.post("documents.create", auth(), async (ctx) => { … })` — the idiomatic
registration in Koa, Express, Fastify and Hono — puts the handler body in a
function with no name and, at module scope, no extracted ancestor. Nothing
walked it: a `fetch(…)` added inside one was reported by neither `ambit diff`
mode, on 226 routes of one repository. Any fix has to supply an identity stable
enough that an `ambit.approvals.md` line written today still matches tomorrow
(§6.3), and an anonymous function has no name. That is the whole difficulty.

## Decision

Every unowned inline callback in a file is analyzed under **one** entry,
`file.ts#<inline callbacks>`, declarable by nobody; and `ambit diff` compares
authority as a **multiset over the bodies a symbol owns**, which for the one
body every other symbol owns is the set comparison it already was.

The two halves are one decision. The entry supplies an identity that holds no
position and no ordinal — it survives re-indenting, moving the registration,
and inserting or deleting a neighbour, because it does not mention them. The
multiset supplies what the shared identity would otherwise cost: two handlers
holding `network` are two holders, so a third is an increase.

**The third piece, which review forced**: what a body holds *moving* to another
leaves every count where it was — `network`, and equally an operation the
analysis could not read. One handler losing it while another gains it is the
same pair of sequences a reorder produces, and one reading is a public route
that can now reach the network. Nothing separates them, so the comparison
reports that it cannot — §6.4's third shape: not an increase, failing only
`--strict`. Picking the safe reading would have been the guess §3.4 forbids.

## Alternatives rejected

- **A name per callback.** A position contradicts §6.4's "the key holds no
  position". An ordinal renames every sibling below an inserted one, and a
  renamed symbol holding authority reads as a new one, so adding a route to a
  16-handler group would report the fifteen below it. Keying on the
  registration's string-literal argument reaches 86% of registrations, is
  silently wrong on one shape (ADR-0007), and needs an ordinal for the rest.
  None is a name the source actually has.
- **One entry per file, compared as a *set*.** This is the decision without
  its second half, and it was measured rather than argued about: on outline
  `server/` it merges 495 `(body, authority)` pairs into silence, 187 of them
  outside test files. Every handler in a file whose neighbour already reaches
  the network would gain network invisibly.
- **Counting authority per call site**: it would report a second `fetch` in a
  handler that already fetches, which a named function does not.
- **Letting `ambit.config.ts` declare the owner.** Its id is writable, so the
  refusal is deliberate: one sentence would stand for every handler in the file
  (P4).
- **Reporting the swap as an increase.** Indistinguishable from a reorder, so
  it would tax moving code with an approval line — §6.3's third criterion.
  Reporting the *uncertainty* costs no line and hides nothing.
- **Matching whole bodies across the two sides** to decide whether something
  moved. `[{network}, {db_write}]` → `[{network, db_write}, {}]` leaves both
  counts at one and no body unchanged, so it sees nothing while `db_write`
  changes hands. The comparison is per fact for that reason — and a
  capability's presence is §4.4's containment there too, or a grant that
  narrows on its way to another handler reads as two unrelated tokens.

## Consequences

The analysis sees strictly more code, and most of it reaches calls no stub
table covers. `--coverage`'s function count, call sites and `unknown` rate move
on all three third-party subjects, and `ambit diff --strict` fails on edits it
used to pass (one added line in a test file, on each of the three). Default
`ambit diff` does not: zero increases and exit 0 on all three unmodified trees,
every previously-emitted record byte-identical.

**The coverage hole is closed; per-handler identity is not available.** A
file's inline handlers become comparable, not individually accountable: an
increase names the file, and on a count increase the witness path names a body
holding the authority, which need not be the one that changed. Whether that is
reviewable enough is [`open-questions.md`](../open-questions.md).

## Revisit when

- An adopter reports the file-level increase as unreviewable.
- `--strict` is measured as unusable on a repository that wants it.
