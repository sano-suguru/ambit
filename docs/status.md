# Implementation status against the milestones

Where the code stands against `docs/DESIGN.md` §11's milestones. This file
records *implementation status*, not design — the specification itself is
`docs/DESIGN.md`, and nothing here changes it.

Measured on 2026-09-09, Node.js v24.20.0, macOS (darwin arm64), Apple M1,
8 cores, 16 GiB. Every number below was run, not estimated.

**Verdict: not a release candidate.** M0.5 has not been run at all, M1 is
missing `init` and any incremental path, and M2–M4 are partial. The details
are per row.

## Baseline commands

```sh
pnpm test                     # 179 tests, 14 files — pass
pnpm exec tsc --noEmit        # pass
./node_modules/.bin/biome ci .  # pass
node src/cli/main.ts check src --coverage   # exit 0
```

`pnpm exec biome ci .` returns 1 in one local shell because of a
user-installed command wrapper, not because of this repository —
`pnpm exec biome --version` fails the same way. Run the binary directly
(`./node_modules/.bin/biome ci .`) to see the real exit code, which is 0. CI
runs `pnpm exec biome ci .` in GitHub Actions, where no such wrapper exists.

## Ambit's own source (`check src --coverage`)

| Figure | Value |
|---|---|
| files analyzed | 17 |
| functions extracted | 136 |
| functions with a declared `@effects` | 4 |
| `unknown` rate | 63.2% (86/136) |
| `boundary` rate | 0.0% (0/136) |
| call sites | 692 — resolved 193, stub 3, known-pure 208, unresolved 288 |
| unresolved by reason | `builtin-method` 102, `external-module` 180, `unresolved-symbol` 5, `callback-parameter` 1 |
| skipped function-like nodes | 60 (`callback-argument` 54, `nested-function` 6) |
| exit code | 0 |

The 63% unknown rate is dominated by `external-module` (180), which is almost
entirely calls into the `typescript` compiler API from the connection layer —
the one file that is meant to be replaceable. It is a real number, not a
target that has been met: DESIGN.md §10's goal is 30% for an *adopting team*
after three months, which no one has done.

### Check latency

| Run | Wall clock |
|---|---|
| `check src`, five consecutive runs | 0.78 / 0.73 / 0.73 / 0.75 / 0.75 s |
| `check src` after changing one contract comment | 0.74 s |

The re-check costs the same as the first check because **nothing is cached**.
DESIGN.md §6.2's resident/incremental path is not implemented, so "初回検査"
and "変更後の再検査" are the same operation. That is the honest reading of
these numbers, and the reason no threshold has been set: there is nothing yet
to compare against.

## Milestones

### M0 — specification, diagnostic ledger, RFC procedure, scope

| | |
|---|---|
| Spec section | §11 M0 |
| Acceptance | review complete |
| Implemented | `docs/DESIGN.md`, `docs/diagnostics/README.md` (11 codes), `AGENTS.md` |
| Evidence | files in tree |
| Outstanding | `rfcs/` and `conformance/` are deferred to first publish by §9. The npm scope `@ambit` is **not** secured; the package is named `ambit` and is `private: true`. |

### M0.5 — backend comparison and adoption gate

| | |
|---|---|
| Spec section | §3.5, Appendix A |
| Acceptance | publish §3.5 evidence, adopt a default backend by RFC |
| Implemented | nothing beyond Appendix A's preliminary probe |
| Evidence | none — Appendix A explicitly records the native engine failing to start |
| Outstanding | **All five gates.** No API-conformance suite, no TS 5.x compatibility comparison, no update-correctness matrix, no performance or memory comparison, no distribution/maintenance assessment. `src/checker/backend/legacy-ts.ts` remains a disposable connection layer, not an adopted product backend. No performance number is assigned to any unrun backend. |

### M1 — effects, unknown, coverage, JSON diagnostics, init, resident path

| | |
|---|---|
| Spec section | §4.2, §4.3, §5.1–5.3, §6.2 |
| Acceptance | dogfooding on Ambit itself; diagnostics update on a contract-comment-only change; schema and measurement conditions fixed |
| Implemented | `@effects` parsing and propagation (rules 1–7 incl. cycles, constructors, `super`, object literals), `unknown`, `--coverage`, NDJSON diagnostics with `engine`, `--strict`, `fixes[].edits` for AMB-E001, `ambit init` contract inference |
| Evidence | `test/{effects,propagate,summarize,diagnose,construction,cli,fix}.test.ts`; `check src --coverage` exit 0; `test/backend.legacy-ts.test.ts` self-hosting block; `test/init.test.ts` round-trips every proposal through `check` |
| Outstanding | **`ambit init` writes no config** — it proposes JSDoc (§4.1's inference half) but `ambit.config.ts` is not implemented, so out-of-code contracts, user-defined effects, per-directory `strict`, and the price table have nowhere to live. **No resident or incremental check** (§6.2) — measured above: a re-check costs the same as a first check. **No versioned JSON Schema** for the diagnostic format (§5.2); the shape is fixed in code and documented, not schema-validated. |

### M2 — capabilities, budget, runtime hooks, framework adapters, 50 stubs

| | |
|---|---|
| Spec section | §4.4, §4.5, §4.6 |
| Acceptance | conformance tests for the planned hook targets; contract-to-handler mapping; 50 bundled stub packages |
| Implemented | `@capabilities` narrowing (static, crosses undeclared functions, target globs), `@entrypoint` warning, `@boundary` with mandatory reason and separate coverage accounting, `@budget` parsing/validation, runtime `withAmbit` + `globalThis.fetch` blocking + `timeMs` enforcement + `runtime.unscoped` |
| Evidence | `test/contracts.test.ts` (26), `test/runtime.test.ts` (mock-level, 13), `test/e2e.runtime.test.ts` (real socket, through the installed package, 4) |
| Outstanding | **Only `fetch` is hooked.** `node:fs`, `node:http`/`https`/`net`, `child_process`, `pg`/`mysql2`/Prisma/Drizzle/MongoDB, OpenAI/Anthropic/Vercel AI — none. **`costUsd` and `llmCalls` are not enforced**; nothing increments them. **No framework adapters** (Express/Hono/Next.js/BullMQ). **No contract-to-handler mapping** — the capability list is written twice, in JSDoc and in `withAmbit`, and Ambit does not check they agree (§12). **The static half of §4.4's 二重強制 is not implemented**: a literal URL outside the granted target is not rejected at check time. **No `@budget` loop-pattern warnings.** Bundled stubs: 52 call entries across 9 namespaces (`fetch`, `globalThis`, `undici`, `node:http`, `node:https`, `node:net`, `node:fs`, `node:fs/promises`, `node:child_process`), 45 constructor entries, and 29 pure-builtin methods — **not** 50 packages. Nothing bundled produces `db_read`, `db_write`, or `llm`. |

### M3 — concrete fix patches, agent protocol

| | |
|---|---|
| Spec section | §5.3, §7 |
| Acceptance | connect one external agent; distinguish analysis failure from contract loosening during iteration |
| Implemented | `fixes[].edits` for AMB-E001: one applicable `widen` patch with `impact`, marked `consistentWithContract: false` |
| Evidence | `test/fix.test.ts` — one test applies the emitted edit mechanically and re-checks clean; a separate test fixes the code *without* touching the contract and re-checks clean |
| Outstanding | **`ambit agent` does not exist** — no NDJSON protocol, no iteration limit, no human-approval gate for loosening fixes, no per-cycle `unknown`-rate tracking. No fix candidates for any diagnostic other than AMB-E001. No contract-preserving candidate (by design — §5.3 forbids fabricating one). |

### M4 — editor integration, SBOM, npm distribution

| | |
|---|---|
| Spec section | §6, §8 |
| Acceptance | editor compatibility with the chosen compiler; one pilot team |
| Implemented | tarball distribution: `pnpm pack` → install into a clean project → `npx ambit check` → `npm remove`, with a distribution-only build (`tsconfig.build.json` → `dist/`) |
| Evidence | `test/e2e.install.test.ts` (6) — installs into a scratch project, drives the installed bin, uninstalls, and confirms the consumer's own code still type-checks and runs |
| Outstanding | **Not published to npm** (requires approval; the `@ambit` scope is unsecured and the package is `private: true`). **No editor integration** — no LSP, no Language Service Plugin, no extension. **`ambit sbom` does not exist**, nor does dependency-effect-diff reporting (§8) or stub trust levels in diagnostics. **No pilot team** — that is an external condition, not a technical one, and cannot be substituted with self-testing. |

### M5 — Phase 1 exit criteria

Out of reach and out of scope for technical work: §10's exit condition is a
real team showing a measured change in delivery speed and incident rate. No
sample, self-test, or synthetic benchmark substitutes for it. Nothing in this
repository claims progress against it.

## Contract tag support, at a glance

| Tag | Parsed | Statically checked | Runtime-enforced | Audit only |
|---|---|---|---|---|
| `@effects` | yes | yes (§4.2 rules 1–7) | — | — |
| `@capabilities` | yes | yes (caller→callee narrowing) | `fetch` only | recorded on the context |
| `@budget` | yes | validation only | `timeMs` only | — |
| `@entrypoint` | yes | warns without `@capabilities` | establishes the context via `withAmbit` | — |
| `@boundary` | yes | excludes the body; reason required | — | counted in `--coverage` |
| `unknown` | n/a | propagated, reported, counted; `--strict` promotes it | — | — |
