# Porting the constructed-instance receiver into the TypeScript 7 shadow backend

- Date: 2026-09-12 (continues
  `docs/measurements/2026-09-12-literal-receiver-port.md`, which closed the
  other half of the same gap)
- Engines: `typescript-legacy@6.0.3` (adopted, DESIGN.md §3.5 / ADR-0001) and
  `typescript-native@7.0.2` (shadow only, `.m05-native/`)
- Host: Node 24.20.0, darwin/arm64

**Nothing here reopens the §3.5 backend decision.** The adopted backend remains
the sole authority; no default changed, `ambit check` gained no flag, and
nothing under `src/` loads the shadow backend.

## Reproduction

```sh
node scripts/m05-native-install.ts
node scripts/shadow-analysis.ts src --self-check   # must stay at zero
node scripts/shadow-analysis.ts test/fixtures/backend-smoke
node scripts/shadow-check.ts
```

## The seven divergences, before

Every remaining `NOT_PORTED` divergence in the gate sat on one root, and on one
site within it: `call-resolution.ts#callsInstanceTypedByInterface`, at
`call-resolution.ts:172:10-172:27`.

```ts
const typedEngine: Runner = new Engine();
export function callsInstanceTypedByInterface(): number {
  return typedEngine.run();          // <- line 172
}
```

Four of the seven are the same expansion the literal-receiver gap had — three
call-site dimensions plus the propagated call-graph edge. The other three are
`authority`, `capability` and `propagated-effect` on the enclosing function,
which the literal case did not produce because the target there was
effect-free.

## The first branch point

Identical in shape to the previous note, one rule over: `legacy-ts.ts` has
`constructedInstanceMemberTarget` and the shadow backend had no counterpart.
`classifyCall` asked the checker for the callee's symbol, got `Runner`'s
**method signature** rather than `Engine`'s method, found no project
declaration behind it, and recorded `resolution:instance-member`.

That it is a missing port and not an API difference rests on the same evidence
as before, and the same caveat applies to reusing that argument:
`recordDeclinedShape` fired, and it fired only after TS7's
`getSymbolAtLocation` → `getAliasedSymbol` → `declarations[0]` → `const`
`VariableDeclaration` → `NewExpression` → a project class declaration had all
succeeded. Reaching the decline *was* the walk. The one step not covered by
that argument — walking `members` and the `extends` chain — is what the new
conformance assertions and the re-run exercise directly.

## The port

`Extractor.constructedInstanceMemberTarget` and `Extractor.classDeclarationOf`
in `scripts/shadow/native-ts7-backend.ts`, ported line-for-line from
`legacy-ts.ts`, reached from the same position in `classifyCall`:

```ts
this.objectLiteralReceiverTarget(callee) ?? this.constructedInstanceMemberTarget(callee)
```

One guard is deliberately *not* carried over from the shadow backend's own
`projectClassOf`, which the decline used: its `!isDeclarationFile` filter.
That filter was a decline-honesty guard — recording a gap for `new Set()` would
have claimed one that does not exist — and it is not the adopted backend's
semantics. `legacy-ts.ts` walks into an ambient class and finds nothing,
because what excludes a builtin member is `declaredNodeToId` having no id for
it, not the file it was declared in. The port does the same; the fixture
asserts it.

## The decline channel, and one defect found in it

`recordDeclinedShape` is deleted. With both resolution shapes ported it had
nothing left to record, and a decline code for a rule that exists is the
misclassification the previous note removed.

The `declined` map, `DeclinedReasons`, and the comparator's `shadowDeclined`
lookups **stay**. `NOT_PORTED` is the claim that a gap gets *declared* rather
than left looking like a disagreement, and the next unported shape needs
somewhere to say so. Nothing writes the map today; its JSDoc says so.

`KNOWN_DIVERGENCES` is now empty, and that is a finding rather than a
consequence. Its one rule matched any `call-edge` whose authoritative value
read `present` — every `shadow-missing` edge, with no condition on the shadow
side at all. `classify` consults `declinedBySymbol` first, so a missing edge
with a declined site behind it never reached the rule; the only divergence it
could still catch was **a missing edge with nothing behind it**, which is a
genuine one, and it labelled that `not-yet-ported`. It was written when the
call-edge dimension had no structured code to consult, and it outlived that.
Deleted.

## Regression coverage

`test/fixtures/backend-conformance/instance-receiver.ts` and a new `describe`
in `test/backend.conformance.test.ts` — asserted against the `TsBackend`
interface, inherited by the shadow side through the gate.

Every receiver in the fixture carries a type annotation, and that is what makes
these tests of the rule rather than of the checker. The first draft did not:
an unannotated `let mutable = new Engine()` **resolves** on the adopted
backend, because the checker answers with `Engine.run` directly and the
receiver is never consulted. Probed before asserting; the `let` case is
annotated as a result, and it is the annotation that hands the question to the
rule for the `const` guard to answer.

Resolves: the annotated receiver (the shape the gap was found on); an override
in a derived class (`Tuned.run`, not `Engine.run` — a walk that took the base
first would name a body that never runs and hand the call that body's declared
authority); an inherited member only the base declares.

Must not resolve: an annotated `let` receiver; a member on an ambient class
(`new Set()` — `Set.add` stays a mutation of an escaping receiver); a class
expression bound to a `const`, whose members are not extracted at all. The
last is recorded because a reader would expect the rule to cover it and it does
not — not because it is desirable.

## After

`node scripts/shadow-analysis.ts test/fixtures/backend-smoke`:

| | before | after |
| --- | --- | --- |
| divergences | 7 (4 high-risk) | **0 (0 high-risk)** |
| callee resolution | 44/45 | 45/45 |
| authority | 59/60 | 60/60 |
| authority increases / decreases | 0 / 0 | 0 / 0 |
| `unknown` gained / lost | 0 / 0 | 0 / 0 |
| `unknown` rate (ts6 / ts7) | 25.0% / 26.7% | 25.0% / 25.0% |
| CI decision | agree (both fail) | agree (both fail) |

`node scripts/shadow-check.ts` — **all 14 roots now read 0 divergences, 0
high-risk, 0 unclassified.** The only rows the baseline moved are
`backend-smoke` (7 → 0, high-risk 4 → 0) and `notPorted` losing
`resolution:instance-member`; no other root changed. The gate reports
`backend-smoke`'s `unknown`-rate delta falling 0.0167 → 0 under "regressed",
which is the two sides agreeing and the gate refusing to guess about direction.
`src` stays at 0 and `--self-check` stays at 0.

## What is still not ported

`project:no-tsconfig-fallback`, alone: the adopted backend scans for `.ts`
files when there is no `tsconfig.json`, and the native API opens a project by
config path, so the shadow backend throws. It is a project-loading difference,
not a resolution one — **every call-resolution shape `legacy-ts.ts` implements
is now ported.**

That is not feature parity, and the gate's fourteen zeroes are not a claim of
it. They say the two engines no longer disagree anywhere the instrument looks
in a way that reaches authority and that nothing accounts for. The instrument
looks at 14 fixture roots and `src`; the five-repository corpus
(`scripts/shadow-corpus.ts`) needs the network and was **not** re-run, so the
16 divergences quoted for it in `docs/status.md` predate this change and no new
number is claimed for it here.

## Verification

```
pnpm test                              638 passed (35 files)     exit 0
pnpm exec tsc --noEmit                 clean                     exit 0
./node_modules/.bin/biome ci .         clean                     exit 0
node scripts/shadow-check.ts           gate passed               exit 0
node scripts/shadow-analysis.ts src    0 divergences             exit 0
```
