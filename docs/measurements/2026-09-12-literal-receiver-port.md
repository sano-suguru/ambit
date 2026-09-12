# Porting the object-literal receiver into the TypeScript 7 shadow backend

- Date: 2026-09-12 (continues
  `docs/measurements/2026-09-12-ts7-shadow-hardening.md` and
  `docs/measurements/2026-09-12-callable-slot-handle.md`)
- Engines: `typescript-legacy@6.0.3` (adopted, DESIGN.md §3.5 / ADR-0001) and
  `typescript-native@7.0.2` (shadow only, `.m05-native/`)
- Host: Node 24.20.0, darwin/arm64

**Nothing here reopens the §3.5 backend decision.** The adopted backend remains
the sole authority; no default changed, `ambit check` gained no flag, and
nothing under `src/` loads the shadow backend. The change is to the shadow port
and to the fixtures and assertions around one semantic shape.

## Reproduction

```sh
node scripts/m05-native-install.ts
node scripts/shadow-analysis.ts src --self-check   # must stay at zero
node scripts/shadow-analysis.ts src
node scripts/shadow-check.ts
```

## The four divergences, before

`node scripts/shadow-analysis.ts src` reported 4 divergences, all high-risk,
all `not-yet-ported` on `resolution:literal-receiver`:

```
[call-edge/shadow-missing]                cli/analyze.ts#analyze
[callee-resolution/shadow-less-authority] cli/analyze.ts:91:13-91:48
[direct-effect/shadow-less-authority]     cli/analyze.ts:91:13-91:48
[unresolved-classification/…]             cli/analyze.ts:91:13-91:48
```

**One semantic site, seen four times.** Three rows carry the same location —
the three dimensions that read a call site — and the fourth is the call-graph
edge propagated out of it, which is why it names the function and not a
location. There is no second site: `cli/analyze.ts:91` is the only one on
`src`, and `recordDeclinedShape` emitted the code exactly once.

The site is the fallback half of the backend indirection in `analyze`:

```ts
const project = options.backend
  ? await options.backend.extractProject(dir)
  : await legacyTsBackend.extractProject(dir);   // <- line 91
```

with `export const legacyTsBackend: TsBackend = { extractProject, … }` in
`src/checker/backend/legacy-ts.ts`.

## The first branch point

The chain, followed on both sides:

| step | TS6 (adopted) | TS7 (shadow), before |
| --- | --- | --- |
| `legacyTsBackend` → symbol | import alias → de-aliased | same |
| symbol → `declarations[0]` | `VariableDeclaration` | same |
| declaration → initializer | `ObjectLiteralExpression`, `const`, no spread | same |
| literal → member `extractProject` | `ShorthandPropertyAssignment` | **not reached** |
| member → value symbol → id | `legacy-ts.ts#extractProject` | — |
| `CallSite` | `resolvedCallee` | `unresolvedReason: "unresolved-symbol"` |

The branch is at `native-ts7-backend.ts:1308` (before this change):
`classifyCall` asked the checker for the callee's symbol, which returns
`TsBackend`'s **member signature** rather than the literal's member — the
annotation shadows the value, which is precisely what
`objectLiteralReceiverTarget` exists to get past in `legacy-ts.ts` — found no
project declaration behind it, and then called `recordDeclinedShape`, which
recorded `resolution:literal-receiver` and left the site unresolved.

**Root cause: a missing port, not a compiler difference.** The evidence that it
is not an API difference is in the decline itself: `recordDeclinedShape` fires
only after TS7's `getSymbolAtLocation` → `getAliasedSymbol` →
`declarations[0]` → `const` `VariableDeclaration` → `ObjectLiteralExpression`
all succeeded on this receiver, so every link up to the member hop was already
demonstrated to agree with TS6 by the old report. The one untested link — the
member hop, `getShorthandAssignmentValueSymbol` on `extractProject` — is what
the re-run below exercises directly, and it agrees. No standalone probe was
needed and none was written.

TS6 is also *correct* here, not merely authoritative: `legacyTsBackend` binds
the exported `extractProject`, that function is what runs, and
`test/backend.legacy-ts.test.ts` asserts against this very call. Parity was the
right target.

## The port

`Extractor.objectLiteralReceiverTarget` in
`scripts/shadow/native-ts7-backend.ts`, a line-for-line port of
`legacy-ts.ts`'s function of the same name, calling helpers the shadow backend
already had (`declarationsOf`, `indexableObjectLiteral`,
`objectLiteralMemberTarget`). It is called from the same position in
`classifyCall` as in `legacy-ts.ts` — after the declaration-based lookups, before
the unresolved-reason fallbacks. No new heuristic: every guard is the adopted
backend's guard.

`resolution:literal-receiver` is gone from `NOT_PORTED` and from
`recordDeclinedShape`. That removal is load-bearing, not tidying: a declined
code standing for a rule that now exists would classify a *genuine* future
disagreement on this shape as "not yet ported", which is the failure the
hardening note was written to prevent.

## Regression coverage

`test/fixtures/backend-conformance/literal-receiver.ts` and a new
`describe` in `test/backend.conformance.test.ts` — asserted against the
`TsBackend` interface, so any backend is judged by them, and inherited by the
shadow side through `scripts/shadow-check.ts` (this fixture is one of its 14
roots).

Resolves: the annotated receiver (the `src` shape), and `as const`.
Must not resolve — the boundary where a broader rule would claim authority it
did not follow: a member holding a re-binding (`const rebound = target`, one
hop and no more), a member whose value is a call result, and a member read out
of another object. `let`, spread and parameter receivers were already covered
in `test/fixtures/backend-smoke/call-resolution.ts`.

One assertion is about the adopted backend rather than the port:
`any-typed.ts#callsAnyTypedMember` (`const anyReceiver: any = { run: pureTarget }`)
resolves. The fixture existed with nothing asserting it. The behaviour is
right — §4.2 rule 7 reads the value, and `any` here is on the annotation — but
it sat one edit away from silently changing, and it is the case that separates
a receiver annotation from §4.7's `as any` on the callee.

## After

`node scripts/shadow-analysis.ts src`:

| | before | after |
| --- | --- | --- |
| divergences | 4 (4 high-risk) | **0 (0 high-risk)** |
| callee resolution | 1900/1901 | 1901/1901 |
| call-graph edges | 544/545 | 545/545 |
| direct effects | 1929/1930 | 1930/1930 |
| unresolved classification | 1900/1901 | 1901/1901 |
| authority increases / decreases | 0 / 0 | 0 / 0 |
| `unknown` gained / lost | 0 / 0 | 0 / 0 |
| `unknown` rate (ts6 / ts7) | 38.9% / 38.9% | 38.9% / 38.9% |
| CI decision | agree (both pass) | agree (both pass) |

Propagated effects, capabilities, authority and diagnostics were already at
100% and stayed there. `--self-check` stays at zero divergences. No new
divergence appeared anywhere.

`node scripts/shadow-check.ts` over its 14 roots — every root that moved, and
nothing else did:

| root | divergences | high-risk |
| --- | --- | --- |
| `src` | 4 → **0** | 4 → **0** |
| `test/fixtures/backend-conformance` | 7 → **0** | 4 → **0** |
| `test/fixtures/backend-smoke` | 21 → **7** | 12 → **4** |

The gate also reports the `backend-conformance` and `backend-smoke`
`unknown`-rate deltas falling (0.0182 → 0 and 0.05 → 0.0167 pt) under the
heading "regressed". That heading is the gate refusing to guess: it flags any
movement in the shadow side's `unknown` rate relative to the adopted one, in
either direction. Both are the two sides agreeing more, and both are recorded
in the new baseline.

The five-repository corpus (`scripts/shadow-corpus.ts`) was **not** re-run —
it needs the network. The 16 divergences quoted for it in `docs/status.md`
predate this change and can only fall, since a site that now resolves cannot
produce more disagreement; no number has been claimed for it here.

## One defect fixed on the way

`scripts/shadow-check.ts --update` writes the baseline with
`JSON.stringify(…, 2)`, which always expands an array over lines; Biome's JSON
formatter collapses a short one back onto a single line. The two disagree only
when the array is short enough to fit, and shortening `notPorted` from three
entries to two is what made them disagree — a `--update` would have failed
`biome ci` from here on. `biome.json` now turns the formatter off for
`test/shadow/baseline.json`, which is machine-written, rather than having the
writer guess at the formatter's rules.

## What is still not ported

- `resolution:instance-member` — `constructedInstanceMemberTarget`, a receiver
  bound by `const` to one `new` of a class this project declares. The 7
  divergences left on `backend-smoke` are all this, all at
  `call-resolution.ts#callsInstanceTypedByInterface`, and it is the same shape
  of gap this note just closed for the literal.
- `project:no-tsconfig-fallback` — the adopted backend scans for `.ts` files
  when there is no `tsconfig.json`; the native API opens a project by config
  path, so the shadow backend throws.

## Verification

```
pnpm test                              632 passed (35 files)     exit 0
pnpm exec tsc --noEmit                 clean                     exit 0
./node_modules/.bin/biome ci .         clean                     exit 0
node scripts/shadow-check.ts           gate passed               exit 0
node scripts/shadow-analysis.ts src    0 divergences             exit 0
```
