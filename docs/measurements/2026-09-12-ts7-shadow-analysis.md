# TypeScript 7 shadow analysis — parity, divergences, and what is not ported

- Date: 2026-09-12
- Engines: `typescript-legacy@6.0.3` (adopted, DESIGN.md §3.5 / ADR-0001) and
  `typescript-native@7.0.2` (shadow only, installed into `.m05-native/`)
- Host: Node 24.20.0, darwin/arm64

**This does not reopen the §3.5 backend decision.** The adopted backend remains
the sole authority for diagnostics, exit codes and review outcomes; nothing
under `src/` loads the shadow backend, and `ambit check` has no flag that
would. What this produces is evidence — the gate-1 conformance detail and the
gate-3 update behaviour that §3.5's "conditions for revisiting" would need
measured rather than predicted. Changing the default still takes an RFC (§9).

## Reproduction

```sh
node scripts/m05-native-install.ts                 # installs typescript@7.0.2 into .m05-native/
node scripts/shadow-analysis.ts src --json .shadow/src.json
node scripts/shadow-analysis.ts test/fixtures/backend-conformance
node scripts/shadow-analysis.ts src --self-check   # must report zero divergences
npx vitest run test/shadow.compare.test.ts
```

`--self-check` runs the adopted backend on **both** sides. It is the cheapest
check that the comparison itself is sound: a divergence there is a normalizer
reading something unstable, and every parity number after it is noise. It is
also asserted in `pnpm test` (`test/shadow.compare.test.ts`), over three
fixture roots, without the native engine installed.

If `.m05-native/` is missing the run stops with an error. It does not fall back
to comparing the adopted backend with itself: a report whose zero divergences
mean "the shadow backend never ran" is the failure DESIGN.md §3.4 forbids.

## Parity — `src` (347 functions, 1,901 call sites)

| Dimension | Parity | Counts |
|---|---|---|
| functions | 99.1% | 344/347 (differ 3) |
| callee resolution | 96.5% | 1834/1901 (differ 67) |
| call-graph edges | 99.8% | 543/544 (ts6-only 1) |
| unresolved classification | 99.9% | 1899/1901 (differ 2) |
| direct effects | 96.7% | 1866/1930 (differ 64) |
| propagated effects | **100%** | 347/347 |
| capabilities | **100%** | 347/347 |
| authority (via `diffAuthority`) | **100%** | 347/347 |
| diagnostics | **100%** | 10/10 |
| runtime wrappers | 100% | 0/0 (none in `src`) |

- authority diff, TS6 as base and TS7 as head: **0 increases, 0 decreases, 0
  `unknown` gained, 0 `unknown` lost**
- CI decision: both would pass — **agree**
- `unknown` rate: TS6 38.9%, TS7 38.9%, delta **+0.0 pt**
- divergences: **137, of which 1 high-risk**; 128 classified `not-yet-ported`,
  9 open (below). The one high-risk entry is a `not-yet-ported` shape reported
  by direction, not an unexplained disagreement: `cli/analyze.ts#analyze` calls
  `options.backend.extractProject(dir)`, a receiver the adopted backend follows
  and the shadow backend does not (`resolution:literal-receiver`)
- duration of the `analyze()` call alone (the harness's own fact extraction is
  not timed): three runs — TS6 678/719/769 ms, TS7 395/398/411 ms — **0.53x to
  0.58x**, so roughly 1.7–1.9x faster. TS7 is faster, in the direction ADR-0001
  measured, and it still buys no gate — see below for why the factor is not
  ADR-0001's 3–4x

### The speedup is smaller than ADR-0001's, and not because of dilution

ADR-0001 measured the native engine 3–4x faster. Here it is 1.7–1.9x. The
obvious explanation — that Ambit's pure-JavaScript downstream (summarize,
propagate, diagnose) is the same on both sides and dilutes the compiler's
advantage — is **wrong**, and the measurement says so. `extractProject` alone,
three runs each on `src`:

| | run 1 | run 2 | run 3 |
|---|---|---|---|
| `typescript-legacy` | 1041 ms | 716 ms | 626 ms |
| `typescript-native` | 494 ms | 376 ms | 391 ms |

Extraction on its own is ~0.58x — the same factor as the whole `analyze()`
call. The downstream is small enough not to matter; the advantage is smaller
*inside the extraction itself*.

What changed between ADR-0001's probe and this backend is how much is asked of
the checker. `scripts/m05-probe/native.ts` walks each file once and resolves
each callee; this backend asks for types, signatures, symbol parents,
declaration handles and their resolutions, many times per call site. A
plausible reading is that the native API's per-query cost (it answers out of
process) dominates as the query count rises — **but that is a hypothesis, not a
measurement**: no request count or transport time was collected on this run.
`API({ collectTiming: true })` would answer it, and has not been run here.

The conclusion that does follow is the one that matters for §3.5: the faster
engine gets *less* advantageous as Ambit's analysis gets more query-heavy, so
performance is weaker as a migration argument than ADR-0001's number suggested,
not stronger.

### Effect of the `backend?: TsBackend` option on Ambit's own coverage

The one `src/` change adds an injection point, and an injected call is one more
call site Ambit cannot resolve. Measured, not inferred —
`node src/cli/main.ts check src --coverage`, before and after:

| | call sites | unresolved | `unresolved-symbol` | `unknown` rate |
|---|---|---|---|---|
| HEAD | 1929 | 439 | 11 | 38.9% (135/347) |
| with the option | 1930 | 440 | 12 | 38.9% (135/347) |

One site: `options.backend.extractProject(dir)`. The default path still calls
`legacyTsBackend.extractProject` by name and still resolves, which is why
`resolved` (678), `stub`, `pure`, `mutation` and the `unknown` rate are all
unchanged. Exit code 0 both ways.

### What these numbers do not mean

**100% authority parity is not "TS7 is ready".** It says the two backends'
*downstream results* agree on this tree, not that their semantic frontends are
equivalent. The layer above it is where they differ — callee resolution 96.5%,
direct effects 96.7%, 137 divergences — and on a different repository the chain

    callee resolution differs
    → stub match differs
    → direct effect differs
    → propagation differs
    → an authority false negative

is exactly how an upstream difference becomes a downstream one. Nothing here
measured that chain on code outside `src` and the fixtures.

The honest reading of this note is: there is now a measuring instrument, and its
first reading found three semantic bugs. It is not a migration verdict, and the
numbers must not be quoted as one.

## Parity — fixture corpus

| Root | functions | authority | decision | divergences (high-risk) |
|---|---|---|---|---|
| `backend-conformance` | 100% | 97.9% | agree | 7 (1) |
| `backend-smoke` | 100% | 93.3% | agree | 27 (3) |
| `propagation` | 93.3% | 100% | agree | 1 (0) |
| `cross-module` | 100% | 77.8% | agree | 12 (2) |
| `contracts` | 90.0% | 100% | agree | 2 (0) |

The fixture high-risk entries all trace to a `NOT_PORTED` shape (below); they
are high-risk by *direction* (the shadow side reports less), which is the right
way to report them, and classified so a reader can tell a gap from a
disagreement.

## Defects found and fixed

Each was found by the shadow run and each is in the shadow backend, not in the
adopted one. Each has a regression test in `test/shadow.compare.test.ts`
asserting that the comparison *reports* the shape with the right direction and
risk — the backend itself cannot be tested in `pnpm test`, because the compiler
it needs is not a dependency.

1. **A callback passed by reference was not left `unknown`** (2
   `shadow-less-unknown` on `backend-conformance/generics.ts`). Callability was
   decided from the callee's *declaration*, so a callback *parameter*
   (`xs.map(f)` inside a higher-order function) had a declaration that was not
   function-valued and the site read as fully analyzed. DESIGN.md §4.2 rule 4
   is explicit: "if it cannot be inferred, `unknown`". Fixed by deciding
   callability from the argument's *type*, as the adopted backend does, with
   `any`/`unknown` counted as callable.
2. **A module-scope rebinding lost its `state_write`** (1
   `shadow-less-authority` on `src`, `runtime/enforce.ts#setUnscopedPolicy`).
   `unscopedPolicy = policy` is not a property write, and a mutation rule that
   only examined property/element accesses dropped it. Fixed by porting
   `classifyAssignment`'s leaf walk and locality rule as written.
3. **Every `jsDocRange` started at the wrong place** (6 divergences on
   `backend-conformance`). On this API a JSDoc node's own text is trivia:
   `getStart()` skips *past* the comment and `getFullStart()` sits wherever the
   preceding trivia began. Fixed by walking the trivia from the full start to
   the block that ends where the node ends.

## Open divergences (9 on `src`)

1. **JSDoc block attachment differs between the compilers** (3, category
   `function`). Where a declaration is preceded by a file-level block *and* its
   own, `getJSDocCommentsAndTags` reports one block and `node.jsDoc` reports
   two; `getLeadingCommentRanges` reports two as well, so the trivia is not a
   way around it. Both sides fall back to "no single block to add a tag to"
   when they see more than one — the sides simply disagree about which
   declarations reach that fallback. Affects `cli/github.ts#githubData`,
   `runtime/hono.ts#ambitHandler`, `stubs/pure-builtins.ts#members`. Not
   root-caused further; it is a genuine API difference, not a port gap.
2. **`Object.defineProperty` with an opaque callback** (3, category
   `callee-resolution` — `runtime/child-process.ts#installChildProcessHook`,
   `runtime/fs.ts#patch`, `runtime/pg.ts#installPgHook`; plus
   `runtime/context.ts#runInContext` under `unresolved-classification`). The
   shadow side sets `unknownCallback` where the adopted side does not — the
   shadow side is *more* conservative, so the direction is safe, and propagated
   authority is unaffected (authority parity is 100%). Root cause not
   established.
3. **`options.backend.extractProject(dir)`** (1 `direct-effect`, 1
   `unresolved-classification` at `cli/analyze.ts:83`). The same
   `resolution:literal-receiver` gap as the high-risk call-edge entry, reaching
   two more dimensions. Both sides still leave the site unresolved; the adopted
   one names it.

None of these is a reason to distrust the adopted backend, and none has been
attributed to one compiler being wrong: `ts6-suspect` / `ts7-suspect` are
written by hand into `KNOWN_DIVERGENCES` and only with a root-cause line.

## What is not ported

`NOT_PORTED` in `scripts/shadow/native-ts7-backend.ts` is the list, and
`scripts/shadow/compare.ts` reads it so a divergence that lands in one of these
shapes is classified `not-yet-ported` rather than counted as a disagreement.

| Shape | What the adopted backend does | Cost measured |
|---|---|---|
| `qualified-name:installed-type-receiver` | names a receiver by its declared package type (`checker: ts.TypeChecker` → `typescript.TypeChecker.getTypeAtLocation`) | **63 of 137** divergences on `src` — the largest single gap. Both sides still call the site unresolved for the same reason; only the name differs, so `--coverage`'s breakdown loses a name, not a verdict |
| `qualified-name:constructed-receiver` | names a receiver by the class it was constructed from (`pg.Pool.query`) | shows on `backend-smoke` |
| `qualified-name:factory-receiver` | names a receiver by the type an imported factory returned | shows on `backend-smoke` |
| `qualified-name:re-export-hop` | names a binding by the package it was re-exported from | 2 high-risk on `cross-module` |
| `resolution:literal-receiver` | follows a receiver certainly holding one object literal | 1 high-risk on `backend-conformance` (`any-typed.ts#callsAnyTypedMember`) |
| `resolution:instance-member` | follows a receiver certainly holding one constructed instance | as above |
| `project:no-tsconfig-fallback` | scans for `.ts` files when there is no `tsconfig.json` | the shadow backend throws instead; the native API opens a project by config path |

## Approaches that did not work

- **`block.getStart(sourceFile)` for a JSDoc range.** The obvious fix for
  defect 3 and it changes nothing: a JSDoc node's text is trivia either way.
- **`getLeadingCommentRanges` as a substitute for `getJSDocCommentsAndTags`.**
  Returns the same two blocks `node.jsDoc` does, so it does not close open
  divergence 1.
- **Reusing one `API` instance across runs.** Not attempted on purpose:
  ADR-0001 reason 2 is that the native snapshot answers *stale* unless told
  which files changed. One instance per `extractProject`, closed after,
  sidesteps that for a one-shot shadow run; it does not solve it, and a
  resident path would have to implement `fileChanges` invalidation first.

## Unresolved risks

- The shadow backend is a **subset**, and the parity numbers are only honest
  because the subset is enumerated. A shape added to the adopted backend and
  not to `NOT_PORTED` would quietly become an "unclassified divergence" rather
  than a known gap.
- The comparison keys call sites on `(symbol, location, ordinal)`. Two calls at
  one position in a different source order between backends would pair
  incorrectly. The identity self-check would not catch it; nothing has shown it.
- `test/shadow.compare.test.ts` covers the comparison, not the shadow backend.
  The backend's only regression signal is re-running
  `node scripts/shadow-analysis.ts` and reading this note's numbers.
- **`classification` is a heuristic; `risk` and `direction` are not.**
  `KNOWN_DIVERGENCES` matches on substrings of the rendered pair, so a rule
  written for a not-ported shape can also swallow a genuine regression in a
  shape that *is* ported — a namespace-import name that stopped resolving would
  read as `not-yet-ported` like the rest. Direction and risk are computed from
  the values themselves and are the signal to trust; classification is a
  reading aid for triaging a long list.

## Next steps, in order

The ordering is by what each step would *resolve*, not by size. Two things move
ahead of tidy-up work: the gap that sits on Ambit's own value chain, and the
corpus that would tell us whether any of these numbers survive contact with
code nobody here wrote.

1. **Port `installedTypeQualifiedNameOf` / `packageTypeNameOf`** (the
   receiver's declared package type). 63 of the 137 divergences on `src`, and
   the reason it comes first is not the count: a receiver-origin name is what
   turns `pool.query(...)` into `pg.Pool.query`, which is what a stub table can
   key on, which is what makes the call a `db_read`. The chain
   `receiver origin → qualified name → stub lookup → effect → authority` is
   Ambit's product, so a gap on it outranks a position or JSDoc-attachment
   difference. `KNOWN_DIVERGENCES` already carries a `kind=stub` vs
   `kind=unresolved` rule, which is that failure mode written down.
2. Port the constructed-receiver, factory-receiver and `re-export-hop` origins —
   the same chain, fewer occurrences here.
3. **Run the shadow backend in CI**, as a nightly or opt-in job rather than in
   `pnpm test`: install the native compiler, run `backend-conformance` and
   `src`, compare the high-risk count with the previous run, upload the JSON.
   What `pnpm test` protects today is the *comparator*; nothing protects the
   shadow backend from regressing, and without that this note is a snapshot
   rather than telemetry.
4. **Run the shadow analysis on real third-party repositories** — the same move
   `docs/measurements/2026-09-11-*` made for `ambit diff`, and it belongs this
   early for a reason. `src` is a poor witness for the ecosystem: one coding
   style, one set of dependencies, one tsconfig, one module pattern, and the
   very shapes the backend was written against. A repository built on Next.js,
   Express, Hono, NestJS, Prisma, Drizzle, tRPC, Zod, or a vendor SDK can
   produce divergence shapes nothing here has seen. Until that runs, 99.x% on
   `src` is **self-hosting parity**, not ecosystem parity, and only the second
   one says anything about adoption.
5. **Replace the substring classifier with structured data.** The backend
   should report *why* it could not do something — an `unsupportedFeature:
   "installed-type-receiver"` on the call site — and `compare.ts` should
   classify on that field. Classification should read data, not parse rendered
   text.
6. Make the call-site key more semantic than `(symbol, location, ordinal)`: the
   syntactic kind and the callee's textual shape would survive a source order
   that differs between backends, which the ordinal does not and the identity
   self-check cannot catch.

Only after these is there anything to say about TS7 as an authoritative backend,
and the thing to say would be about **ecosystem parity**, not about `src`.

## The one measurement that would settle the performance question

The note above records that the native engine's advantage is 1.7–1.9x here
rather than ADR-0001's 3–4x, that the pure-JavaScript downstream is not the
cause, and that the query-count reading is a hypothesis. One run would decide
it, and it is worth doing alongside step 1 because the two touch the same code:

- **legacy side** — count `getTypeAtLocation`, `getResolvedSignature`,
  `getSymbolAtLocation` and alias-resolution calls over one `extractProject`.
- **native side** — `API({ collectTiming: true })` already reports
  `requestCount`, `bytesSent`, `bytesReceived`, `serverTimeMs` and
  `transportOverheadMs`; `scripts/m05-probe/native.ts` prints them today.

If the native engine is fast inside and the cost is crossing the API boundary
thousands of times, the conclusion is **not** that Ambit needs a faster
compiler. It is that the extraction asks the wrong shape of question: a call
site currently costs a symbol lookup, a type, a signature, a declaration
resolution and a parent walk, each a separate crossing. A coarser request —
one `analyzeCallSite` returning symbol, declaration, signature, receiver type
and origin together — would then be worth more than any engine change, and more
than a rewrite in another language.

That is a hypothesis with an obvious experiment attached, and nothing in this
note is evidence for it yet.
