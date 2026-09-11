# The inline-callback owner — measurements

2026-09-11. Ambit `b79a5d5` ("before") against the change recorded in
[ADR-0013](../adr/0013-the-inline-callback-owner.md) ("after"). Same machine,
same checkouts, same commands.

The subjects are the three from the validation runs, at the same pinned
revisions: `Unleash/unleash@044461b` (`src/lib`),
`immich-app/immich@2a62622` (`server/src`),
`outline/outline@35dd15b9` (`server`). The defect being closed is that run's
**B1** / **E6**.

## 1. The defect

`ambit diff HEAD server` on outline with `fetch("https://telemetry.example.com/documents",
{ method: "POST" })` added as the first line of the `documents.create` inline
handler — the recorded **E6** edit, byte for byte.

| | before | after |
|---|---|---|
| E6, `diff` | exit **0**, no line anywhere | exit **1**, `+ capability http:post:telemetry.example.com` |
| E6, `diff --strict` | exit 0 | exit **1** |
| authority moved between two handlers | exit 0/0, no line | exit 0 with a §6.4 report, `--strict` exit **1** |

The effect half of E6 is *not* reported, before or after, and this is correct:
the handler already reaches the network through `documentCreator`. The control
proves it is not a property of the owner — extracting that same handler to
`const documentsCreateHandler = async (ctx) => { … }` on the base tree gives a
named symbol whose own record already reads
`observed: ["network", "state_write"], unknown: true`, so a named function
reports nothing for it either. Authority is a set per body, and §6.4 ¶1 says so.

**E6c**, the same edit with a URL the source does not fix
(`fetch(String(ctx.request.href))`): silent before, silent after, and silent
under a named handler. Not this defect.

**E6d**, the case the multiset exists for — the same dynamic `fetch` added to
the *first* handler in that file, which holds no network of its own, while two
of the file's 29 do:

```text
  routes/api/documents/documents.ts#<inline callbacks> (routes/api/documents/documents.ts:1)
    + network
      operation: fetch (routes/api/documents/documents.ts:209)
```

exit **1**. Compared as a *set* this reports nothing, because the file's union
already held `network`. That is what the next section measures.

## 2. Why one entry per file is not compared as a set

Each unowned inline callback was given a throwaway ordinal id, `check server
--format json` dumped, and per file:
`Σ_bodies |authority(body)| − |⋃_bodies authority(body)|` — the number of
`(body, authority)` pairs a per-file *set* cannot tell from a sibling's.

| outline `server/` | |
|---|---:|
| owner entries (files with ≥1 unowned inline callback) | 294 |
| owned bodies | 867 |
| bodies per owner, max | 29 |
| files where per-body would distinguish something a set merges | 82 |
| **masked `(body, authority)` pairs** | **495** |
| of those, outside `*.test.ts` | 187 |

Top files: `routes/api/documents/documents.test.ts` 55, `documents.ts` 34,
`collections.test.ts` 22, `collections.ts` 19.

## 3. What the multiset still cannot see, and what is reported instead

Authority *moving* between two owned bodies leaves every count where it was.
The minimal case, on the repro tree:

```ts
router.post("/admin",  async () => { await fetch("https://internal.example"); });
router.post("/public", async () => {});
```

with the `fetch` moved to `/public`. `network` holders: **1 before, 1 after**.

| | before this fix | after the multiset alone | with §6.4's third shape |
|---|---|---|---|
| `diff` | exit 0, no line | exit 0, **"No authority increased."** and nothing else | exit 0, and the report names the symbol |
| `diff --strict` | exit 0 | exit 0 | **exit 1** |

The middle column is what the first review round caught. `[network, pure]`
becoming `[pure, network]` is the same pair of sequences a plain reorder
produces, so no comparison over those two sequences can tell them apart — the
fix is not a better comparison but a report that says so.

**The second round caught the same hole in `unknown` and `unresolved`.** Three
cases, each measured on the repro tree before the criterion was widened, each
**silent in both modes**:

| moved between two handlers, count unchanged | before | after |
|---|---|---|
| an authority, body for body | exit 0 / 0, no line | report, `--strict` **exit 1** |
| an authority, merged into a handler that kept its own | exit 0 / 0, no line | report, `--strict` **exit 1** |
| a capability that narrowed on the way | `removed` only | `removed` **and** the report, `--strict` **exit 1** |
| the `unknown` a body inherited from a callee | exit 0 / 0, no line | report, `--strict` **exit 1** |
| the same opaque operation (`opaque-client.del`) | exit 0 / 0, no line | report, `--strict` **exit 1** |
| two *different* opaque operations, both bodies `unknown` | exit 0 / 0, no line | report, `--strict` **exit 1** |

The third needed `AuthorityBody` to carry each body's own `unresolved`: with
only the `unknown` boolean, two unresolved bodies are indistinguishable
records. One limit remains and is a property of the analysis rather than of the
comparison — where a call has **no qualified name** (an ambient `declare const`
receiver, `unresolved-symbol` with no operation), two such bodies really are
the same record, and swapping them is unreportable. In the same fixture with
the operations named through a package, it fires.

**The third round found the criterion itself wrong.** Matching *whole bodies*
across the two windows misses authority changing hands without any body staying
the same:

```text
base: [{network}, {db_write}]      head: [{network, db_write}, {}]
```

Both holder counts stay at one, no body is unchanged, and `db_write` moved from
the second handler to the first. Measured on the repro tree: exit 0 / 0, no
line. The comparison is therefore **per fact, not per body** — each effect,
capability, `unknown`, and unresolvable operation at one count is read as a
presence sequence over the bodies in the window. Held by as many bodies as
before but arranged differently: it moved. Held by a different number: it was
added or removed, and the other sections report it.

A fourth round found the same fact-vs-semantics gap in capabilities. Read as
raw tokens, `admin: http:get:*` → `public: http:get:api.example.com` is one
token disappearing and another appearing — two different holder counts, so no
relocation — while §4.4's containment says one body held
`http:get:api.example.com` on each side and it was a different one. Measured:
`removed: http:get:*` and **nothing else**, with the public route's new reach
reported nowhere. A capability's presence is now `holdersOf`'s containment, the
same rule `added` and `removed` use.

Three criteria were built and discarded on measurement or on a counterexample
before this one. Firing on any `unknown` body in the window fired on E6 and on
a one-line test edit — effectively every edit to an inline-callback file on
outline. Firing on a body common to both windows missed the merge above.
Reading capabilities as raw tokens missed the narrowing above. The current one
fires on all nine relocation cases and on none of the noise cases:

| edit | third shape fires | exit / `--strict` |
|---|---|---|
| unchanged tree (all three subjects) | no | 0 / 0 |
| re-flowing a registration across lines | no | 0 / 0 |
| a sibling registration inserted above, or deleted between two | no | 0 / 0 |
| outline E6 (`fetch` added to one handler) | no | 1 / 1 |
| a route inserted at the top of `documents.ts` | no | 1 / 1 |
| one `expect(…)` added to a test file | no | 0 / 1 |
| `/admin` → `/public` swap, of any of the four kinds above | **yes** | 0 / 1 |
| `[{network}, {db_write}]` → `[{network, db_write}, {}]` | **yes** | 0 / 1 |
| the same shape in capabilities | **yes** | 0 / 1 |
| `admin: http:get:*` → `public: http:get:api.example.com` (narrowing, and changing hands) | **yes** | 0 / 1 |
| the same grant narrowing *without* changing hands | no | 0 / 0 |

## 4. The untouched tree — the invariant

`diff HEAD <dir>` on a `git status`-clean checkout, both modes.

| | Unleash | immich | outline |
|---|---:|---:|---:|
| authority increases | 0 | 0 | 0 |
| §6.4 entries | 0 | 0 | 0 |
| exit, `diff` / `--strict` | 0 / 0 | 0 / 0 | 0 / 0 |
| symbols compared, before | 3,523 | 3,061 | 1,951 |
| symbols compared, after | **3,849** | **3,191** | **2,245** |

The added symbols are exactly the owner entries; nothing else appears.

## 5. Existing symbols do not churn

`check <dir> --format json` on each subject, both sides, `kind: "authority"`
lines only, owner records removed from the "after" side:

```sh
diff <subject>-before.ndjson <subject>-after-without-owners.ndjson
```

| | records | result |
|---|---:|---|
| Unleash | 3,523 | identical |
| immich | 3,061 | identical |
| outline | 1,951 | identical |

Every previously-emitted record is byte-identical on all three. This is the
acceptance criterion "existing named-function identities do not churn", and it
is why §4's increase counts are 0 rather than merely small.

## 6. `--coverage`, which does move

Bodies that were never walked are now analyzed, and most of what they reach is
uncovered by any stub table.

| | Unleash | | immich | | outline | |
|---|---:|---:|---:|---:|---:|---:|
| | before | after | before | after | before | after |
| files | 596 | 833 | 460 | 547 | 474 | 723 |
| functions | 3,523 | 3,849 | 3,061 | 3,191 | 1,951 | 2,245 |
| `unknown` rate | 71.0% | **73.3%** | 79.5% | **79.9%** | 69.3% | **72.8%** |
| call sites | 16,491 | **36,301** | 15,041 | **35,248** | 9,618 | **43,924** |
| unresolved | 6,426 | 20,241 | 8,482 | 25,842 | 4,118 | 26,394 |
| `skipped` | 5,275 | 5,275 | 4,387 | 4,387 | 6,112 | 6,112 |

`skipped` is unchanged on purpose: it counts function-like nodes with no id of
their own, which an owned callback still is. The new top unresolved names are
test-framework calls — outline `expect=6788, it=2903, describe=235`.

## 7. `ambit diff --strict` fails on edits it used to pass

One `expect(1).toBe(1);` line added to the first `it(…)` body of one test file,
in each subject's checked directory:

| | `diff` | `diff --strict`, before | `diff --strict`, after |
|---|---:|---:|---:|
| Unleash `src/lib/addons/addon.test.ts` | 0 | — | **1** |
| immich `server/src/controllers/activity.controller.spec.ts` | 0 | **0** | **1** |
| outline `server/routes/api/documents/documents.test.ts` | 0 | — | **1** |

Reported as §6.4's second shape (`? expect (unresolved-symbol)`), which is the
designed answer for a body that gained an operation the analysis cannot
resolve — the difference is that the body is now analyzed at all. Default
`ambit diff` is exit 0 in every row.

## 8. Ambit itself, and the corpus

`check src --coverage`: exit 0. Functions 340 → **347** (five files gain an
owner, and this change adds two functions of its own), `unknown` 37.9% →
**38.9% (135/347)**, `AMB-W001` count **10**,
unchanged. `pnpm test` **604 passing, 34 files** against 552, 33.
`pnpm exec tsc --noEmit` pass. `biome ci .` pass.

`node scripts/bench-corpus.ts`, median `unknown` **52.9%** against 52.6%:

| target | before | after |
|---|---:|---:|
| hono | 52.6% | 52.9% |
| trpc-server | 59.7% | 59.7% |
| elysia | 51.7% | 51.8% |
| got | 54.6% | 54.6% |
| drizzle-orm | 39.0% | 39.0% |

## 9. The approval round trip

The owner's id is the first to contain characters no declaration path had —
angle brackets and a space. Copying the line `diff` prints into
`ambit.approvals.md` and re-running takes the repro from exit 1 to exit **0**,
with both increases shown as approved in this change. `--format github` emits
the id intact in the annotation title line. Asserted in
`test/inline-callbacks.test.ts`, both the round trip and the rule that one line
covers the increase however many bodies gained it.

## 10. Identity stability

Asserted in `test/inline-callbacks.test.ts` against the real backend, two trees
at a time. Preserved: re-flowing a registration across lines, editing a
declaration above the callbacks, inserting a sibling registration above one,
deleting a sibling from between two. Reported: a callback gaining an authority
no sibling held, a callback gaining one a sibling already held (the multiset),
a callback losing one (as a decrease, never a failure). Unaffected: a callback
inside a named function, which still belongs to that function and produces no
owner at all.
