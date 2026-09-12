# One unresolved handle made the shadow backend distrust every call

- Date: 2026-09-12
- Engines: `typescript-legacy@6.0.3` (adopted) and `typescript-native@7.0.2` (shadow)
- Follows: `docs/measurements/2026-09-12-optional-callback-opacity.md`
- Reproduce:

  ```sh
  node scripts/m05-native-install.ts
  node scripts/shadow-corpus.ts drizzle-orm --with-deps
  node scripts/shadow-corpus.ts                        # all five targets, hermetic
  ```

The previous note took `drizzle-orm --with-deps` from 31 divergences to 19 and
left **15 `unresolved-classification/shadow-more-unknown` unexplained**. This
note takes those 15 to their first branch.

**All fifteen are one defect, in the shadow backend, in `scripts/`.** Neither
compiler disagrees with the other about anything here: at every one of the
fifteen sites both engines return the identical type for the identical
expression, verified by probing both checkers at the same call. What differed
is that one side could read the callee's declared parameter list and the other
could not.

Nothing under `src/` changed. TypeScript 6.0.3 remains the sole authority for
diagnostics, exit codes and CI decisions; this is a repair to the measuring
instrument, and the §3.5 backend decision is untouched.

## Result

| | before | after |
|---|---|---|
| `drizzle-orm --with-deps`, divergences / high-risk | 19 / 0 | **0 / 0** |
| the corpus, hermetic, divergences / high-risk | 260 / 24 | **16 / 0** |
| `src` (gated) | 7 / 4 | **4 / 4** |
| `test/fixtures/backend-smoke` (gated) | 27 / 13 | **21 / 12** |

Per target, hermetic (`node scripts/shadow-corpus.ts`, no dependencies
installed — the arm the gate watches):

| target | before | after |
|---|---:|---:|
| hono | 32 / 3 | **6 / 0** |
| trpc-server | 37 / 6 | **10 / 0** |
| elysia | 106 / 12 | **0 / 0** |
| got | 54 / 3 | **0 / 0** |
| drizzle-orm | 31 / 0 | **0 / 0** |
| **total** | **260 / 24** | **16 / 0** |

The "before" column is this tree at `178c245`, i.e. *after* PR #39. It is not
the hardening note's 204, which predates that fix and is not comparable.

`drizzle-orm`'s hermetic 31 is *higher* than its 19 with dependencies
installed, and that ordering is this note's own thesis showing up in the
measurement: strip a project's types and its arguments read `any`, and `any` is
the argument shape this defect inflates. The first attempt at this row recorded
19 — the probes earlier in the investigation had left the `--with-deps`
symlink in place, so the "hermetic" run was not hermetic. Re-run with the link
removed and the pre-fix backend restored, it is 31 / 0, of which 27 are
`unresolved-classification/shadow-more-unknown`.

## The fifteen, clustered

Clustered by the expression shape at the site, which is also how they
partition by *why* the argument looked callable:

| # | shape | why the argument looks callable | sites |
|---:|---|---|---|
| 8 | `new Proxy(target, handler as any)` | the argument is `any` | `pg-core/view.ts:60,213`, `gel-core/view.ts:60,213`, `mysql-core/view.ts:73`, `singlestore-core/view.ts:82`, `sqlite-core/view.ts:54`, `neon-http/driver.ts:67` |
| 3 | `Object.keys(x)` | `x` is `any` | `d1/session.ts:158`, `libsql/session.ts:305`, `utils.ts:335` |
| 2 | `Boolean(fields \|\| customResultMapper)` | a union with one function constituent | `mysql2/session.ts:154`, `singlestore/session.ts:153` |
| 1 | `customResultMapper(result.rows)` | the argument is `any` | `node-postgres/session.ts:167` |
| 1 | `trace.getTracer('drizzle-orm', npmVersion)` | `npmVersion` is `any` | `tracing.ts:31` |

Every one of the fifteen rendered identically apart from the location:

```
category=unresolved-classification direction=shadow-more-unknown risk=normal
ts6=reason=<r>
ts7=reason=<r> callbackByReference
```

One field, `callbackByReference`, on the conservative side — which is why none
of them is high-risk and why none of them changed a verdict that mattered:
authority parity was already 100% and the authority diff already 0/0/0/0.

## The first branch point

Both backends were instrumented inside `callableArgumentsOf` and run over the
same checkout with the same dependencies installed. At
`pg-core/view.ts:60`, `new Proxy(new PgView({…}), selectionProxy as any)`:

```
[ts6] sig=yes decl=ConstructSignature declFile=lib/lib.es2015.proxy.d.ts nparams=2
[ts6]   arg1 "selectionProxy as any" argType=any argCallable=true
                param="handler: ProxyHandler<T>" paramType=ProxyHandler<T> accepts=false
[ts7] sig=yes decl=181                declFile=-                          nparams=0
[ts7]   arg1 "selectionProxy as any" argType=any argCallable=true
                param="-"            paramType=-                          accepts=true
```

The two agree on the argument (`any`, callable-for-this-purpose). They
disagree on whether the *slot* is a callback slot at all, and the shadow side
does not disagree so much as fail to look: `nparams=0`, and no source file for
the declaration it holds.

`signature.declaration` on this API is not a node. Dumping it:

```
declKeys  = canonicalProject,index,kind,path
protoKeys = constructor,resolve
decl.resolve(project) -> kind=181 parameters=2 file=lib/lib.es2015.proxy.d.ts
                         text="new <T extends object>(target: T, handler: ProxyHandler<T>): T;"
```

It is a **lazy handle**, and `resolve` is what produces the node whose
`parameters` can be read. `acceptsCallableArgument` read `.parameters` off the
handle, got `undefined`, found no parameter at the index, and took its
fail-open branch — the one written so that a slot it *cannot* classify is still
scanned. That branch was correct and was firing on every argument of every call
in the project.

The same probe at the other four shapes, same picture, every type string
identical between the engines:

| site | TS6 `paramType` | TS6 `accepts` | TS7 before | TS7 after |
|---|---|---|---|---|
| `d1/session.ts:158` `Object.keys(row)` | `{}` | false | true | **false** |
| `d1/session.ts:158` `.map(k => …)` | `(value: T, index: number, array: T[]) => U` | true | true | **true** |
| `mysql2/session.ts:154` `Boolean(…)` | `T \| undefined` | false | true | **false** |
| `tracing.ts:31` `getTracer(…, npmVersion)` | `string \| undefined` | false | true | **false** |
| `pg-core/view.ts:60` `new Proxy(…, h as any)` | `ProxyHandler<T>` | false | true | **false** |

The `.map` row is the control: a position that really is a callback slot still
accepts, so the repair narrows nothing it should not.

## Classification

**Shadow backend defect (`scripts/shadow/native-ts7-backend.ts`), conservative
direction.**

- Not a compiler semantic difference. Both engines returned byte-identical
  `typeToString` output for every argument and every parameter at all fifteen
  sites, and once the handle is resolved TS7's answer equals TS6's at each one.
- Not a corpus artifact. The `drizzle-orm` entry was corrected two notes ago;
  these sites reproduce with and without dependencies installed, and the same
  defect accounts for divergences on four other repositories that share no
  configuration with it.
- Not an adopted-backend bug. `src/` is unchanged and `git diff src/` is empty.
- Not intentional. The fail-open branch exists for slots that *cannot* be
  classified; here the slot could be, and the port simply did not ask.

The port already knew declarations are handles — `declarationsOf` has called
`handle.resolve(this.project)` since it was written. `acceptsCallableArgument`
was the one place that read one raw. Reading a field off an unresolved handle
returns `undefined` silently instead of throwing, which is why the miss read as
"this declaration has no parameters" rather than as an error.

## Fix

`scripts/shadow/native-ts7-backend.ts`, two changes:

- `resolveHandle` — the resolve step, extracted from `declarationsOf` and
  called by `acceptsCallableArgument` before it reads `.parameters`.
- `literalArgumentsOf` — a second, unrelated port-fidelity gap found while
  reading the same dumps: the adopted backend collapses "no argument was a
  literal" to `undefined`, the port returned `[undefined]`. No compared
  dimension reads the field, so it never showed as a divergence and its removal
  moves no number; it is corrected so that it is not one more thing to rule out
  next time.

Regression coverage is three functions in
`test/fixtures/backend-conformance/optional-callbacks.ts`
(`passesAnyToNonCallbackSlot`, `passesAnyToNonCallbackConstructorSlot`,
`passesCallableUnionToNonCallbackSlot`) with three assertions in
`test/backend.conformance.test.ts`. They sit beside the previous note's cases
deliberately: those assert that a callback slot handed an opaque reference
*must* be opaque, these that a non-callback slot handed a callable-looking
argument must not be — the two halves of one predicate, and a backend that
loses either fails the same fixture.

The fixture has teeth against the shadow backend through
`scripts/shadow-check.ts`, not through `pnpm test`, which runs the adopted
backend only. On `test/fixtures/backend-conformance`:

```
without the fix  10 divergences (7 not-yet-ported, 3 unclassified — one per new function)
with the fix      7 divergences (7 not-yet-ported, 0 unclassified)
```

## What moved on the gated roots

`test/shadow/baseline.json` was re-recorded. Two roots moved and both are the
same defect:

- **`src` 7 / 4 → 4 / 4.** The three that went are exactly the three
  `Object.defineProperty` rows that
  `docs/measurements/2026-09-12-ts7-shadow-hardening.md` left as
  "root cause still not established" (`runtime/child-process.ts`,
  `runtime/fs.ts`, `runtime/pg.ts`). `defineProperty`'s third parameter is
  `PropertyDescriptor & ThisType<any>` — not a callback slot — and the port
  could not see that. **That open item is now closed.** The four that remain
  are one site, `cli/analyze.ts:91`, seen from four dimensions and classified
  `not-yet-ported` from a `resolution:literal-receiver` code the shadow backend
  emitted itself.
- **`test/fixtures/backend-smoke` 27 / 13 → 21 / 12.** All six are one site,
  `sample.ts#foldToThunk` at `sample.ts:108`, an `Array.reduce` whose
  `initialValue` is function-typed. That is precisely the case
  `acceptsCallableArgument` was written for, so the fixture had been failing
  the very narrowing it documents. One of the six is worth naming separately:
  the unfixed port emitted an `AMB-W001` diagnostic there that the adopted
  backend does not — a spurious warning on a correct `@effects pure`
  declaration, and the only user-visible consequence this defect would have
  had if TS7 were ever authoritative.

The gate's `regressed:` section reported the shadow side's `unknown` rate
*falling* on both roots (`backend-conformance` 0.0192 → 0.0182 pt,
`backend-smoke` 0.0667 → 0.05 pt) and it is right to call that out by default —
losing `unknown` is normally the unsafe direction. Here it is the correct one,
because the `unknown` being lost was never earned: the shadow side was claiming
not to know things it did know. That judgement is the reason the baseline is
updated by hand rather than automatically.

## The wider corpus: the same class, and the size of it

Hermetic, all five targets, before and after the fix on the same checkout:
**248 → 16 divergences, 24 → 0 high-risk.** The class found on `drizzle-orm`
accounts for **232 of the 248**, across five repositories that share no
tsconfig, no dependency set and no coding style. `elysia` and `got` go to zero;
so do all 24 high-risk rows, including eight `direct-effect/shadow-less-authority`.

**No new authority-bearing root-cause class appears.** The 16 that survive are
one class, and it is not this one — every one of them is
`function/value-mismatch`, and in every one the *only* difference is JSDoc
comment text on a tag Ambit does not read:

- **15 of 16 — a `@see` tag's URL scheme.** TS6 records
  `see=://trpc.io/docs/v11/server/context`, TS7 records
  `see=https://trpc.io/docs/v11/server/context`. Diffing the two rendered
  values character by character, the entire difference is the inserted
  `https`.
- **1 of 16 — `middleware/etag/index.ts#etag` on `hono`,** where TS7 keeps a
  `@param` type-and-name run (`{(Uint8Array): ArrayBuffer | …} [options.generateDigest]`)
  that TS6 drops.

Where that difference is produced is **not established**: neither compiler's
JSDoc parser was probed, and the port's own tag reader is as plausible a source
as the parser is. What is established is that it is **inert for Ambit**: the
contract tags are
`@effects`, `@capabilities`, `@budget`, `@entrypoint` and `@boundary` (§4.1),
and `@see`, `@param` and `@deprecated` are none of them. Consistent with that,
every target reports functions 100%, authority 100%, and an authority diff of
0 increases / 0 decreases / 0 `unknown` gained / 0 `unknown` lost. It is left
`unclassified` rather than given a rule of its own: a classifier entry invented
to tidy away sixteen rows that cost nothing is the move the classifier rewrite
was meant to stop.

## What is left

**What this measures is not feature parity, and the two must not be read as one
number.** What went to zero is the *unexplained, authority-bearing* divergence
on real third-party code: no shape now differs between the engines that changes
what Ambit reports and that nothing accounts for. What has not gone anywhere is
the shadow backend's own declared gap — `NOT_PORTED` is still three shapes
(`resolution:literal-receiver`, `resolution:instance-member`,
`project:no-tsconfig-fallback`), the first of them is what the four remaining
`src` rows are, and a shape the port declines is not a shape the port handles.
"The shadow backend and the adopted one no longer disagree about anything we
cannot explain" is what the numbers support; "the shadow backend does what the
adopted one does" is not, and nothing here should be quoted as though it were.

- **The 16 above**, established only as JSDoc text on non-contract tags with no
  authority consequence — parser or port not distinguished, and deliberately
  not suppressed.
- **The four `not-yet-ported` rows on `src`**, which are a gap in the port, say
  so from a code the port emits, and are what `NOT_PORTED` is for.
- **`test/fixtures/backend-smoke`'s remaining 21 / 12**, untouched by this note
  and not investigated here.
- **The `--with-deps` arm is an experiment, not a baseline.** `drizzle-orm`
  reaching 0 / 0 with its dependencies installed was measured against
  25 packages resolved at today's published versions from the pinned manifest's
  ranges, and a different day can resolve differently.

## Verification

Run on this tree, exit status quoted, not predicted:

```
pnpm exec tsc --noEmit                                  0
./node_modules/.bin/biome ci .                          0   (259 files)
pnpm test                                               0   (35 files, 626 tests)
node scripts/shadow-check.ts                            0   no regression against the recorded baseline
node scripts/shadow-corpus.ts                           0   16 divergences, 0 high-risk
node scripts/shadow-corpus.ts drizzle-orm --with-deps   0   0 divergences, 0 high-risk
```

`scripts/bench-corpus.ts` and `node src/cli/main.ts check src --coverage` were
not re-run and no number in `docs/status.md` moves: `src/` is byte-identical,
so neither can have changed.
