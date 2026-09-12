# An optional callback slot let an opaque callback past the guard

- Date: 2026-09-12
- Engines: `typescript-legacy@6.0.3` (adopted) and `typescript-native@7.0.2` (shadow)
- Follows: `docs/measurements/2026-09-12-any-typed-divergence.md`
- Reproduce:

  ```sh
  node scripts/m05-native-install.ts
  node scripts/shadow-corpus.ts drizzle-orm --with-deps
  ```

The previous note cleared the corpus artifact out of `drizzle-orm --with-deps`
and left 31 divergences: 21 `unresolved-classification/shadow-more-unknown`
and 6 `direct-effect/shadow-less-authority`. This note takes the 6 to their
first branch.

**All six are one Ambit bug, in the adopted backend, in the direction §3.4
forbids.** Neither compiler disagrees with the other about anything here: given
the same source they return the same type. What differed is which of Ambit's
own two callability predicates each backend used.

## Result

| `drizzle-orm --with-deps` | before | after |
|---|---|---|
| divergences | 31 | **19** |
| high-risk | 6 | **0** |
| `direct-effect/shadow-less-authority` | 6 | **0** |
| `unresolved-classification/shadow-more-unknown` | 21 | **15** |
| direct-effect parity | 99.9% | **100.0%** |

The six `unresolved-classification` rows that went with them are the *same six
sites*, dumped before and after and compared by location: `query-promise.ts:31`
and the five `count.ts` sites, and no others. Each pair read

```
ts6=reason=builtin-method
ts7=reason=builtin-method callbackByReference
```

— the same missing field, showing in the classification dimension as well as in
the verdict. The 15 that survive are a different set and remain unexplained.

## The six sites

Every one is the same expression shape, and the six rendered rows are identical
apart from the location, so they are listed once rather than six times:

```
category=direct-effect direction=shadow-less-authority risk=high
ts6=kind=known-pure  effects=[] capabilities=[] reason=-              operation=Promise.then
ts7=kind=unresolved  effects=[] capabilities=[] reason=builtin-method operation=Promise.then
```

| Symbol | Location | Expression |
|---|---|---|
| `query-promise.ts#QueryPromise.then` | `query-promise.ts:31:10-31:54` | `this.execute().then(onFulfilled, onRejected)` |
| `pg-core/…/count.ts#PgCountBuilder.then` | `pg-core/query-builders/count.ts:61:10-65:5` | `Promise.resolve(…).then(onfulfilled, onrejected)` |
| `mysql-core/…/count.ts#MySqlCountBuilder.then` | `mysql-core/query-builders/count.ts:54:10-58:5` | same |
| `sqlite-core/…/count.ts#SQLiteCountBuilder.then` | `sqlite-core/query-builders/count.ts:52:10-55:4` | same |
| `singlestore-core/…/count.ts#SingleStoreCountBuilder.then` | `singlestore-core/query-builders/count.ts:54:10-58:5` | same |
| `gel-core/…/count.ts#GelCountBuilder.then` | `gel-core/query-builders/count.ts:53:10-57:5` | same |

Read the direction carefully. The comparator's `shadow-less-authority / high`
label is correct as stated — `known-pure` is a positive claim the shadow side
did not make — but **the adopted side is the wrong one**. `known-pure` on a
`.then` whose two callbacks are opaque parameters says "this call has no
effects", and the callbacks' effects vanish with it. The shadow backend's
`unresolved` is the right answer. This is the one shape so far where the safe
verdict and the `shadow-less-authority` direction point opposite ways.

## The first branch point

Dumping both backends' `CallSite` at `query-promise.ts:31`:

```
typescript-legacy@6.0.3
  {"location":…31:10-31:54, "pureBuiltinName":"Promise.then", "unresolvedReason":"builtin-method"}
typescript-native@7.0.2
  {"location":…31:10-31:54, "pureBuiltinName":"Promise.then", "unresolvedReason":"builtin-method",
   "callbackByReference":true}
```

One field: `callbackByReference`. `src/checker/summarize.ts` refuses a pure
verdict for an allowlisted builtin that both takes a callback and was handed an
opaque one, so with the flag the site summarizes `unresolved` and without it
`known-pure`.

The flag comes from `callableArgumentsOf`, and the branch is its callability
test on the *argument's own* type. Probing 6.0.3's checker at that call:

```
call: this.execute().then(onFulfilled, onRejected)
  resolvedSignature decl: in lib.es5.d.ts
  arg0 "onFulfilled"
     type=((value: T) => TResult1 | PromiseLike<TResult1>) | null | undefined
     isUnion=true callSignatures=0 anyOrUnknown=false
     constituents: undefined[sigs=0] | null[sigs=0] | (value: T) => …[sigs=1]
     declaredParamType=((value: T) => TResult1 | PromiseLike<TResult1>) | null | undefined
                       isUnion=true sigs=0
```

`getCallSignatures()` on a union returns `[]` however callable its constituents
are. `src/checker/backend/legacy-ts.ts` had two predicates for the same
question and used the wrong one here:

| Asked about | Predicate | Union aware |
|---|---|---|
| the *declared parameter* type, in `acceptsCallableArgument` | `isCallableParameterType` | yes |
| the *argument's own* type, inline in `callableArgumentsOf` | `type.getCallSignatures().length > 0` | **no** |

So the position passed the first gate (the declared parameter type is the same
union, and the union-aware predicate said "callback slot") and failed the
second (the argument is that union, and the inline check said "not callable").
`opaque` stayed false. The shadow port had already merged both onto one
union-aware `isCallableArgumentType`, which is why only it reported the flag —
not because 7.0.2 types anything differently.

The shape is not exotic. `cb?: (v: T) => R` is how `Promise.then`,
`Promise.catch` and most callback APIs declare their slots, and forwarding such a parameter onward is the ordinary way to
implement a thenable. `drizzle-orm` does it six times.

## Classification

**Ambit bug, adopted backend, unsafe direction.** Not a compiler semantic
difference — both engines return the identical union type, verified by probing
6.0.3's checker directly (above) and by the shadow backend reaching the correct
answer from the same `getTypeAtLocation`. Not a corpus artifact — the
`drizzle-orm` entry was already corrected in the previous note, and the sites
reproduce with and without dependencies installed.

## Fix

`src/checker/backend/legacy-ts.ts`: one predicate for both questions.
`isCallableParameterType` is renamed `isCallableType` — it is now asked of a
declared parameter type and of an argument type, and the two answers have to
agree, because at an optional slot they are the same type — and
`callableArgumentsOf` calls it instead of its inline check.

Regression coverage is `test/fixtures/backend-conformance/optional-callbacks.ts`
plus four assertions in `test/backend.conformance.test.ts`. It is in the
conformance suite deliberately: the assertions are against the `TsBackend`
interface, so any backend is judged by them, and `generics.ts` next door already
covers the non-optional callback-by-reference case. Two of the four fail on the
adopted backend before the fix and pass after.

The fixture also pins the blast radius, which is the half of this that could go
wrong. Widening the callability test could make `promise.then(null, undefined)`
read as two opaque callbacks; it does not, because `null` and `undefined` are
not unions and have no call signatures. And `promise.then(double)`, where
`double` is a function this project extracted, stays a `callbackTargets` entry
rather than opacity — the reference is followed, so the effects come from
`double`'s own summary.

## What moved

Measured before and after on the same checkout.

`node src/cli/main.ts check src --coverage` — exit 0 both times, `unknown`
rate unchanged at 38.9% (135/347). One call site moved:

```
before  resolved=678  unresolved=440  external-module=404
after   resolved=679  unresolved=439  external-module=403
```

**That is the patch analyzing itself, not the fix changing Ambit's reading of
`src`.** Every `CallSite` in `src` was dumped on both sides and diffed with
locations stripped and the rename normalized away; the entire difference is one
function:

```
- callableArgumentsOf | {"calleeQualifiedName":"typescript.Type.getCallSignatures",
                         "unresolvedReason":"external-module"}
+ callableArgumentsOf | {"resolvedCallee":"…legacy-ts.ts#isCallableType"}
```

The inline `type.getCallSignatures()` was an unresolved call into `typescript`;
the extracted predicate that replaced it resolves. Call-site total is 1,930 on
both sides.

No `callbackByReference` or `callbackTargets` field changed anywhere in `src`,
which is the answer to the self-hosting question AGENTS.md asks of a call-
resolution change: **the shape does not occur in Ambit's own source**, so there
is nothing for the self-hosting block in `test/backend.legacy-ts.test.ts` to
assert that the fixture does not already assert better. The check was made; it
came back empty.

`node scripts/bench-corpus.ts` — the median does not move; two targets do.

| target | before | after |
|---|---:|---:|
| hono | 52.9% | 52.9% |
| trpc-server | 59.7% | **61.2%** |
| elysia | 51.8% | **52.1%** |
| got | 54.6% | 54.6% |
| drizzle-orm | 39.0% | 39.0% |
| **median** | **52.9%** | **52.9%** |

Corpus-wide `builtin-method` goes 550 → 561 and known functions 2,333 → 2,329.
Four functions moved from known to `unknown`. That is the fix working: those
four were reported as having no effects on the strength of a `.then` or `.map`
whose callback Ambit never saw. `drizzle-orm`'s own function-level count does not
move (1,035 either way), so all six `.then` methods were already `unknown` for
some other reason; the correction shows there only in `builtin-method` 23 → 29
and in `Promise.then=6` appearing in `top-unresolved-names`.

`node scripts/shadow-check.ts` — exit 0, no regression. The recorded baseline
for `test/fixtures/backend-conformance` was re-recorded: divergences (7),
high-risk (4) and unclassified (0) are unchanged, and only the three *ratios*
moved, because the new fixture took the root from 48 functions to 52 and the
one diverging function is now 1/52 rather than 1/48. `authorityParity`
0.9792 → 0.9808, `calleeResolutionParity` 0.9737 → 0.9756, `unknownRateDelta`
0.0208 → 0.0192. No other root changed.

## Remaining uncertainty

- **The 15 surviving `unresolved-classification` rows on this target are
  untouched and still unexplained,** as are the corpus-wide 204 the hardening
  note counted. This note explains the six that went and nothing more.
- **The fix is measured on this corpus, not bounded analytically.** Every
  argument whose type is a union with one callable constituent is now scanned
  where it previously was not. On the five corpus targets that is four
  functions and eleven call sites; on a codebase with a different mix it will
  be more. The direction is the conservative one, so the risk is `unknown`
  rate, not a missed effect.
- **The comparator still labels this shape `shadow-less-authority / high`,**
  which is right about the direction and misleading about which side to trust.
  Nothing was changed there: the direction model is what makes the *other*
  categories readable, and one shape where the safe answer is the one with less
  authority is not a reason to rewrite it. It is a reason to read the label as
  "these two disagree, go look", which is what it is for.
