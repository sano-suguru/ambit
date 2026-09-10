# Ambit Design Specification

- Status: Draft
- Revision: 2 (Draft) — separating the analysis backend, and folding in the technical evaluation
- Intended readers: developers of Ambit itself, contributors, design reviewers
- Change procedure: RFC (under `rfcs/`, chapter 9)
- How to read this revision: a revision proposal for review. Adoption of the native backend is decided after the verification gates in 3.5 have been passed

---

## 1. Purpose

In an environment where AI agents generate code faster than humans can review it, provide a foundation for **mechanically detecting and blocking contract violations in generated code**, without replacing TypeScript.

Ambit provides three things.

1. **A contract layer** — attach side effects (effects), permissions (capabilities), and budget (budget) to existing code as declarations, and enforce them with static and runtime checks.
2. **Structured diagnostics** — return check results not only for humans but in a machine-readable form that AI agents can consume.
3. **An agent-integrated toolchain** — make generate → check → fix → run → deploy a single loop.

## 2. Design Principles

| # | Principle | Consequence |
|---|---|---|
| P1 | Ride on a language AI is already good at | Invent no new syntax. User code uses TypeScript's syntax and type system |
| P2 | Constrain AI's range of action, not its capability | Forbid designs that assume "the next model will not get this wrong" |
| P3 | Incremental adoption. Do not forbid the absence of declarations | Undeclared is `unknown`. Make it visible rather than forbidden |
| P4 | Do not hide what cannot be guaranteed | State external boundaries, dynamic code, constraints decidable only at runtime, and unsupported backends explicitly |
| P5 | Ride existing distribution, and allow backing out at any time | Ship on npm. Build no bespoke runtime or registry. Test the removal procedure automatically |

When principles conflict, P1 → P5 is the priority order.

P1 is not a constraint that all of Ambit's own processing run in JavaScript. Using a native implementation of the compiler does not change the user's syntax or contract declarations.

Check speed affects how many iterations an agent can run and how long development waits. Measure the initial check and the re-check after a change separately, and choose an implementation together with correctness, coverage, and maintenance burden.

## 3. Scope and Implementation Base

### 3.1 Target and technology stack

| Item | Content |
|---|---|
| Target language | TypeScript. Emphasis on incremental adoption in existing TS 5.x code; verify compatibility of accepted syntax, settings, and type decisions on the native engine. Do not guarantee compatibility across all of 5.x while it is unverified |
| Type-check settings of target code | `strict: true` recommended, not required. Separate from Ambit's own `strict` for contracts |
| Implementation language of Ambit itself | TypeScript, `strict: true` |
| Baseline runtime | Node.js 24 LTS. Additional Node.js versions are added to the support table after verification |
| First candidate for type analysis | The Go-implemented native TypeScript, used through the official TypeScript API client |
| Adopted analysis backend | The JS-implemented TypeScript Compiler API (`ts.createProgram` + type checker). Adopted as the default in §3.5. The version tracks the latest stable release of the JS-implementation line (6.0.3 as of 2026-09; 5.9.3 at the time of the preliminary evaluation in appendix A) |
| Ambit-specific static analysis | Function summaries, call relationships, fixed-point computation of side effects, capability comparison, diagnostics, and fix candidates are to be implemented in TypeScript |
| Editor integration | Uses the same checker as the CLI. Choose among a Language Service Plugin, an LSP connection, or a thin editor extension after verifying fit |
| Runtime library | `@ambit/runtime`. Implemented in TypeScript and run as JavaScript. Entry-point context, `AsyncLocalStorage`, audit hooks, optional `contract()` |
| Development and distribution | pnpm (single package; splitting into `@ambit/*` waits until npm publish is in view). During development there is no build: `.ts` runs directly under Node 24's type stripping, and `tsc --noEmit` is for type checking only. The test runner is Vitest (changed from node:test); the linter and formatter is Biome. Conformance tests, GitHub Actions, npm |
| Domain | Cloud backends: HTTP APIs, jobs and workflows, LLM agents, data processing |

Bun / Deno / edge runtimes are outside Phase 1's guarantee. Even where they have been observed to work, they are not implicitly given the same guarantee as Node.js.

**The target language's compatibility, Ambit's build compiler, and the analysis engine's version are managed separately.** Choosing the build-time tsc does not by itself decide how user code is analyzed.

### 3.2 Why TypeScript

Types, symbols, and call signatures are useful for statically checking effect contracts. Ambit obtains this information from the TypeScript compiler and analyzes contracts on top of it.

That a value has a type, or that `getResolvedSignature` succeeds, does not mean the implementation reached at runtime is uniquely determined. With overloads the selected declaration may have no body; with callbacks only the function-type declaration may be obtained.

Beyond type analysis, Ambit handles possible callees, the correspondence between actual arguments and callbacks, library summaries, and paths that cannot be analyzed. Where it cannot resolve, it leaves `unknown` and does not treat a guess as a guarantee.

### 3.3 Non-goals

- Extending TypeScript's syntax, a bespoke transpiler, a bespoke runtime, a bespoke build system
- Support for other languages such as Python. Not started until the Phase 1 exit criteria (chapter 10) are met. The contract model and diagnostic format are nonetheless kept language-independent
- **Static** guarantees about execution time, memory, or cost
- Browser and frontend code
- Completeness (detecting every violation statically). The goal is "stop the violations that can be detected, and state explicitly what cannot be"
- Reimplementing TypeScript's type system
- An unfounded wholesale move to Rust or Go, or a lock-in to running everything in JavaScript
- Promising permanent product support, before the evaluation, for the two type-analysis backends prepared as a basis for comparison

### 3.4 Separating the analysis backend

Processing is split into the following responsibilities.

| Layer | Responsibility | Initial policy |
|---|---|---|
| Compiler connection | Loading the project, and obtaining ASTs, positions, types, symbols, call signatures, and compiler diagnostics | Evaluate the official native API first. Use the legacy API as the basis for comparison |
| Ambit's analysis representation | Representing contracts, function summaries, callee candidates, unresolved reasons, and evidence positions | Do not expose compiler-specific objects to external diagnostics or persisted formats |
| Contract analysis | Effect propagation, capability checks, coverage, impact range, fix candidates | Shared by the CLI and the editor |
| Presentation and control | Output for the CLI, editors, agents, and CI | Display or forward common diagnostics to each use |
| Runtime enforcement | Capability matching, budget measurement, blocking of supported operations | Independent of the compiler. Do not make the analysis engine a production dependency |

In a configuration that connects to the Go engine through the native API's distributed client, type analysis runs on the Go side even though Ambit is implemented in TypeScript.

The distributed version 7.0.2 examined in the M0.5 preliminary evaluation exposes `typescript/unstable/sync`, `typescript/unstable/async`, and others. Do not treat these as a stable API; the following are required.

- Pin the client and the engine to the same distributed version. Run the conformance tests and the compatibility trials when updating.
- Concentrate use of the native API in the connection layer, and insulate the contract model and diagnostic format from API changes.
- Measure the cost of per-call API round trips, AST transfer, and type-information retrieval. Use batched queries and caching where possible.
- Do not convert a failure to start, an unsupported setting, or an analysis failure into "no violations". State explicitly what could not be analyzed and what failed, and return an exit code by which CI can tell a failure apart.
- Do not switch between the evaluation backends without notice. Give diagnostics, coverage, and performance records information that identifies the analysis engine and its version. The output schema is versioned in chapter 5.

Embedding the Go internal compiler directly is compared only if the official API lacks required information, or if communication and transfer become the dominant factor in measurements. Evaluate the cost of tracking internal APIs, shims, and forks.

If Rust is added, make the target of the improvement explicit as well. Do not assume that adopting a Rust parser alone can replace TypeScript's type analysis. Do not make a three-language Go / Rust / TypeScript construction an initial requirement.

### 3.5 Verification gates for backend adoption

Verify the following in M0.5 and record the results before deciding the product's default backend. §9 decides where the record goes: before the first public release, directly into this file; after it, into an RFC. M0.5 was carried out before publication, so "Default backend (decided)" below is that record.

1. **API conformance**: run a conformance test covering aliased imports / re-exports, generics, overloads, callbacks, unions, `any`, recursion, JSDoc, and Unicode positions. Distinguish having type information from having the implementation determined.
2. **Compatibility with existing code**: compare representative TS 5.x code and tsconfigs. Record unsupported settings and type-diagnostic differences, and do not hide the migration they require.
3. **Correctness of updates**: change function bodies, contract comments, exports, settings, and stubs individually, and confirm that the dependent contracts and diagnostics are updated.
4. **Performance**: with the same code, contract checks, diagnostic results, and coverage, measure initial and post-change time, memory including child processes, and communication volume. Do not compare parse-only speed against a check that includes type analysis.
5. **Distribution and maintenance**: verify target OS / CPU, startup, npm distribution, and the burden of tracking API updates.

Set the latency and memory allowances the pilot requires before comparing. Do not assign performance numbers to a backend that has not been run. If a gate cannot be passed, compare continuing with the legacy API, embedding Go directly, and adding Rust according to the cause found, and state explicitly that the default remains undecided.

#### Allowances (set before the comparison)

The numbers are decided before the comparison begins. If you measure first and then pick a value that passes, the gate drops nothing. The basis is the agent loop of chapter 7, in which one iteration runs `ambit check` once.

| Item | Allowance | Rationale |
|---|---|---|
| Initial-check latency (30-file scale) | within 3 seconds | In one generate → check → fix iteration, the check must not be the dominant wait |
| Initial-check latency (300-file scale) | within 10 seconds | Same. Must not degrade worse than linearly in file count |
| Backend re-query after a one-file change | within 500 milliseconds | The premise on which 6.2's resident path holds. Beyond this, latency remains even after going resident |
| Memory (peak RSS summed over parent and child processes, 300-file scale) | within 1 GiB | A standard CI execution environment, and the ability to coexist with an editor |
| Communication volume (one check in a process-separated configuration) | Must not be the dominant factor in latency. Transfer time must not exceed 50% of the total | The line for deciding 3.4's "communication and transfer become the dominant factor in measurements" |

Conformance, compatibility, and correctness of updates (gates 1–3) have no allowance. They either pass or they do not, and are not traded against speed.

#### Default backend (decided: 2026-09-09)

**The default for the initial release is the JS-implemented TypeScript Compiler API (`typescript` 6.0.3, `src/checker/backend/legacy-ts.ts`).** Native TypeScript (the Go implementation, distributed version 7.0.2) is not adopted. The measurements are in the M0.5 section of `docs/status.md`. What is written here is only the decision and the facts it rests on.

Because this is before the first public release, no RFC was raised; this file was edited directly, per the procedure in §9. Changing the default from here on follows §9 and requires an RFC.

The reasons for the decision, in order of weight.

1. **The cost of adoption does not match what it buys.** Every entry point of the native API is published under a name containing `unstable/*`. Adoption means writing a second backend implementation on top of it (2,100 lines at present), reconstructing missing primitives such as the equivalent of `getFullyQualifiedName` ourselves, and additionally taking on responsibility for snapshot invalidation.
2. **Gate 3 shows a difference in correctness, not cost.** Unless `fileChanges` is passed, the native implementation **silently returns a stale answer** (measured: after rewriting a contract comment it answers with the pre-change state, with no error and no warning). The JS implementation rebuilds the program every time, so it has no way of going stale. Against §3.4's "do not convert an analysis failure into no violations", adopting it would mean newly taking on a path by which a violation silently disappears.
3. **Speed buys none of the gates.** The allowance table above was decided before the comparison, and the JS implementation passes all of it (median 458 ms on 300 files against an allowance of 10 seconds; peak RSS 348 MiB against an allowance of 1 GiB). The native implementation is 3–4× faster, but as long as being faster passes not a single item, that is not a reason for the decision.

**Gate 2 was initially placed as the first reason for this decision. It is withdrawn.** That the distributed version 7.0.2 does not pick up `node_modules/@types/*` automatically is exactly as measured, as is the fact that Ambit's own source produces 0 type errors on 5.9.3 and 198 on 7.0.2, and that of the 1,213 calls in `src/`, 1,212 versus 1,143 resolved (58 of the 69 difference being `external`). But **this is not a property of the Go port; it is a change in TypeScript 6 and later**: the JS-implemented 6.0.3 was afterwards confirmed to behave identically to 7.0.2. It therefore cannot be counted as a native-specific drawback. Writing `"types": ["node"]` explicitly in tsconfig resolves it, and this repository, having adopted 6.0.3, does exactly that.

Gate 1 (API conformance) is not why the native implementation was dropped. The required primitives are present, JSDoc tag positions can be obtained as AST nodes, and positions matched in UTF-16 code units. The only thing missing is `getFullyQualifiedName`, which looks reconstructible from the symbol's parent chain (confirmed for one shape). This is a record that it is a cost, not a barrier.

**The conditions for revisiting this decision** are written down in advance.

- The `unstable` name comes off the native API, so that the cost of writing a second backend stops being the cost of betting on an unstable API.
- The resident check path of §6.2 is implemented. The native implementation's real advantage is not the initial check but re-querying (after a one-file change, 1.0–1.9 ms native against 214–272 ms for the JS implementation). With no resident path in existence, that difference shows up nowhere in the product. Re-run gates 3 and 4 once it is implemented.
- The JS-implementation line stops producing stable releases. This decision depends on the versioning rule of "track the latest stable release of the JS-implementation line" (§3.1, `AGENTS.md`), and if there is nothing left to track, the premise behind gate 5's maintenance cost collapses.

The price of making the JS implementation the default is recorded too. `typescript` 6.0.3 is not npm's `latest` (as of 2026-09, `latest` is 7.0.2). Which tsconfig options are accepted differs by version, and 6.0.3 sits exactly at the crossing point (measured, by giving the same file to three compilers).

| tsconfig | 5.9.3 | 6.0.3 | 7.0.2 |
|---|---|---|---|
| `baseUrl` / `downlevelIteration` | accepted | TS5101 "deprecated, will stop working in TS 7" | TS5102 "removed" |
| `importsNotUsedAsValues` | accepted | accepted | TS5023 "unknown" |
| `stableTypeOrdering` | TS5023 "unknown" | accepted | accepted |
| `deduplicatePackages` | TS5023 "unknown" | TS5023 "unknown" | accepted |

6.0.3 rejects, as "deprecated", settings that 7.0.2 removed, and accepts some of the settings 7.0.2 introduced. It is closer to the TS 7 side of tsconfig than staying on 5.9.3 would have been, but it is not the same. This asymmetry is left in §12's "TypeScript version compatibility".

## 4. Contract Model

### 4.1 Form of declarations

Contracts are declared by default with **JSDoc tags**. An ordinary declaration changes neither the function body nor its signature. Declarations come not only from JSDoc but also from `ambit.config.ts` ("Out-of-code declarations" below) and from the `spec` of `withAmbit` / `ambitHandler` / `ambitRoute` ("Where declarations live" below, §4.4). All three declare the same five contracts with the same meaning.

```ts
/** @effects pure */
export function calculateTax(order: Order): Money { /* ... */ }

/**
 * @effects network, db_read
 * @capabilities db:read:users, http:get:api.example.com
 */
export async function getUser(id: UserId): Promise<User | null> { /* ... */ }

/**
 * @entrypoint
 * @capabilities db:read:users, http:get:api.example.com
 * @budget timeMs=500 costUsd=0.01 llmCalls=2
 */
export async function GET(req: Request): Promise<Response> { /* ... */ }
```

| Tag | Attached to | Static check | Runtime enforcement |
|---|---|---|---|
| `@effects` | Any function or method | Checked by the propagation rules of 4.2 | None (static only) |
| `@capabilities` | Any function or method | Checked by the narrowing rule | What is attached to an entry point is enforced (4.4) |
| `@budget` | Mainly entry points | Pattern warnings such as `llm` inside a loop | What is attached to an entry point is enforced (4.5) |
| `@entrypoint` | HTTP handlers, jobs, queue consumers | Warns about undeclared entry points | This is where the context is established |

**The granularity trade-off**

- Static checking is done finely, at **function granularity**.
- Runtime enforcement is done coarsely, at **entry-point granularity**. Rather than wrapping every function, it matches the capabilities of a request or job.
- Only per-function runtime measurement needs to catch a start and an end, so an opt-in `contract()` wrapper is provided. It is not used by default.

**Where declarations live (decided: 2026-09-10)**

Which contract goes where is decided by exactly one question: **does it have to reach runtime?**

| Contract | Does the runtime read it | Where it lives |
|---|---|---|
| `@effects` | No (static propagation only) | JSDoc |
| `@entrypoint` / `@boundary` | No | JSDoc |
| `capabilities` | The hooks match against it | `spec`, if runtime enforcement is in place |
| `budget` | `timeMs` is measured and blocks | Same |

JSDoc disappears at build time. Putting data that must reach runtime there requires inventing a delivery mechanism every time (the reason §4.4 chose explicit registration). Conversely `effects` is not needed at runtime, so JSDoc is the right place for it. This split lines up exactly with "the granularity trade-off" above (static = per function, runtime = per entry point).

An entry point with no runtime enforcement has no `spec`, so its `@capabilities` / `@budget` are written in JSDoc (or config). That does not change. "The JSDoc tag becomes optional" holds only where a `spec` can supply the declaration; it does not mean "there need be no contract".

Merging is per tag, in the priority order JSDoc > config > `spec`. The reason `spec` comes last is given in §4.4's "Removing the double declaration".

**Out-of-code declarations (decided: 2026-09-09)**

Where the code cannot be touched (third-party code, generated code, early adoption), the same contracts can be declared in `ambit.config.ts` by naming the symbol.

```ts
import { defineConfig } from "ambit/config";

export default defineConfig({
  effects: { payments: ["network", "db_write"] },
  contracts: {
    "src/legacy/billing.ts#charge": { effects: ["payments"] },
    "src/app/api/**/route.ts#GET": { entrypoint: true, capabilities: ["db:read:*"] },
    "src/cart.ts#Cart.get total": { effects: ["db_read"] },
  },
  strict: ["src/app/**"],
});
```

The contracts that can be declared are the same five as in JSDoc (`effects` / `capabilities` / `budget` / `entrypoint` / `boundary`), with the same meaning. Being in config does not make them weaker. `strict` is an array of globs following the same rules as the `file` part, and applies the same promotion as `--strict` only to the diagnostics of matching files (§4.3).

If a symbol has both JSDoc and config, JSDoc wins and the difference is warned about. Differences are compared per tag (`effects` in JSDoc and `capabilities` in config is not a difference but a complement).

**Overloads and bodyless declarations (decided: 2026-09-09)**

An overload set is **one declaration site**, and that site is the implementation. A signature is a type, not code that runs. Therefore:

- A signature (`function f(x: string): string;`), an `abstract` member, and a `declare function` inside a `.ts` file are none of them declaration sites for a contract. `--coverage` counts them as `bodyless-declaration`.
- A contract tag written there is not adopted, and is reported as AMB-E003. "Write it on the implementation" is actionable advice, whereas dropping it silently is exactly the "declaration that does nothing" that §4.1 forbids.
- Calls resolve to the implementation. A call into a set with no implementation (a `declare` with no body in the project) is `unknown` (`overload-without-body`). Resolving to a bodyless declaration would make the observed effects the empty set, and the caller would look `pure` whatever the implementation does. That falls under the "converting an analysis failure into no violations" that §3.4 forbids.

This rule is not a matter of notation but also a termination requirement. If more than one function corresponds to a single declaration path, the fixed-point iteration of §4.2 rule 7 does not converge (each iteration overwrites the other's state). The declaration path and the function the backend returns must be one to one.

**(a) Notation of the `symbol` part, and which declaration sites can be named**

`symbol` is the checker's internal declaration path itself (joined with `"."`: `Class.method`, `obj.member`, `Class.constructor`), and config can name that set plus the following two kinds.

- Accessors: `Class.get total` / `Class.set total`
- Anonymous default exports: `default`

These two kinds have a declaration path, but **writing JSDoc on them is still not adopted** (still AMB-E003). Members with computed, string, or numeric keys cannot be named even in config.

Three options were considered:

1. config's namespace = JSDoc's namespace. Declaration sites that produce AMB-E003 cannot be named in config either
2. Any declaration site with a declaration path also has its JSDoc adopted. AMB-E003 shrinks to "nodes with no stable path" only
3. **config's namespace ⊃ JSDoc's namespace** (adopted)

The reason for adopting it is that path stability and uniqueness of a comment's attribution are separate problems. `get x` and `set x` have two declarations under the same name, and an anonymous default export has no name. A config key is the place where the writer states explicitly which declaration is meant, so a qualifier like `get x` can be carried inside the key; JSDoc, by contrast, is a path that infers attribution from where it is written, and has no place to carry the same qualifier. What §12's "JSDoc limits and symbol identification" has left undecided is the latter notation, not the former. Opening up only the config side first lets the side that cannot touch the code (this section's actual purpose) move forward.

What would happen if 2 were chosen: in exchange for being able to write JSDoc on a getter, the set of "functions where JSDoc cannot be placed" that `ambit init --config` should propose shrinks to implicit constructors and third-party code only, and the early-adoption gap becomes a JSDoc question again rather than a config one. What would happen if 1 were chosen: the effects of getters/setters and anonymous default exports ride on propagation, yet there is nowhere at all to declare them, and they stay in `--coverage`'s `unknown`.

**The honest limit of this decision**: 3 leaves the asymmetry that "JSDoc can syntactically be written at this position, yet is not adopted". This is not a distinction derived from principle; it is the result of deciding only the config side of §12's open item first. If the notation on the JSDoc side is settled, there is room to move toward 2 (§12).

**(b) Globs in the `file` part, and the priority when several entries hit the same symbol**

The `file` part interprets `*` (any string not crossing `/`) and `**` (zero or more directory levels). The `symbol` part is not globbed.

- A key containing no glob characters (an exact match) always wins over a key containing a glob.
- If two or more glob keys hit the same symbol, both keys are listed and the run stops with exit 2.

Three options were considered:

1. Later entry wins by written order
2. The more specific key wins
3. **Make ambiguity a configuration error** (adopted; exact matches being the only exception)

2 is not taken because defining "more specific" requires deciding the containment relation between globs, and which of `src/**/a.ts` and `src/a/*.ts` is more specific is not decidable in general. 1 is not taken because it would entrust the meaning of a contract to the key order of an object literal, and which way it fell would not be visible to the reader (the same reason as §3.4). An exact match can be the exception because it needs no containment judgment and the writer's intent is unique.

What would happen if 3 were not chosen: the contract of an existing symbol would silently change with the order in which lines were added to config, and a change that loosens a contract would not appear in diff review.

**(c) The formats read, and the search origin**

- Formats: `ambit.config.ts` / `ambit.config.mts` / `ambit.config.js` / `ambit.config.mjs`. They are looked for in this order and only the first one found is used. If several exist in the same directory, the rest are not read.
- Search origin: from the `<dir>` of `check <dir>` / `init <dir>` upward through parents, using the first one found. cwd is not consulted. The walk stops once it has examined a directory holding a `package.json` or a `.git` — so that a config outside the project is not silently picked up.
- The `file` part of `contracts` keys and the patterns in `strict` are resolved **relative to the directory holding the config file**.

Three options were considered:

1. cwd as the origin
2. **Walk up from `<dir>`** (adopted)
3. Require `--config`

`ambit check src` means "check `src`", not "check the project in cwd". Under 1, `cd packages/a && ambit check ../b/src` would ignore b's contracts and apply a's config, which the reader cannot explain. 3 adds one step at adoption time, which is against P3 (incremental adoption).

Keys are relative to the config file so that the same config points at the same symbols under both `ambit check src` and `ambit check .`. Making them relative to `<dir>` would shift every key merely because the checked range was narrowed.

`.json` is not among the formats because there is no gain in adding one more way to write config for which `defineConfig`'s type checking does not apply (the `effects` definitions and `strict` are not expressions, so they could be written in JSON, but there is no need for that).

What would happen if 2 were not chosen: in a monorepo, the correspondence between what is checked and which config applies would become cwd-dependent, and CI and local runs would apply different contracts.

**(d) How user-defined effects appear in diagnostics**

`effects: { payments: ["network", "db_write"] }` is **expanded into standard effects at parse time**. Only expanded standard effect names appear in a diagnostic's `contract.declared` / `contract.observed`. User-defined names exist only on the input side, in config and JSDoc.

Three options were considered:

1. Emit the defined name as written
2. **Emit the expansion** (adopted)
3. Emit both

Expansion is many-to-one. If `payments: ["network", "db_write"]` and `sync: ["network", "db_write"]` are both defined, there is no deciding which name to call an observed `{network, db_write}` by. `observed` is the set the analysis observed, not the writer's vocabulary, so inventing an inverse mapping would make a name that was never written appear in a diagnostic. Using defined names only in `declared` would leave `declared` and `observed` in different vocabularies, and their difference unreadable. 3 writes the same set two ways and makes it ambiguous which one the check used.

The value of a definition may only be standard effect names; defined names are not expanded recursively. If a defined name collides with a standard effect name, exit 2.

What would happen if 1 were not chosen: in exchange for diagnostic text becoming readable in the user's vocabulary, the names appearing in `observed` would depend on the contents of config, and the same code would produce different diagnostics merely because config changed.

**Adoption via `ambit init`**

`ambit init` infers the effects of existing code from the evidence in 4.2 and emits JSDoc additions as fix candidates in diagnostics (chapter 5, `fixes[].edits`). Functions it cannot infer remain `unknown` and appear in `--coverage`.

`ambit init --config` emits the results of the same inference, only for **declaration sites where JSDoc cannot be placed**, as an append patch for `ambit.config.ts`. The targets are the two kinds in (a), plus the construction of a class that does not write a constructor (`Class.constructor`). The latter has a declaration path but no place at all to write the comment, so, for the same reason as the two kinds in (a), only config can declare it. For functions where JSDoc can be placed, JSDoc is proposed as before. For functions that reached `unknown`, neither is proposed — for the same reason as §4.3: so that "could not tell" is not turned into a declaration.

### 4.2 Effects

What a function does to the outside world.

| Name | Meaning |
|---|---|
| `pure` | Touches nothing outside. Depends only on its arguments, with no side effect observable from outside the function (mutation of values created inside the function does not count — see "Local mutation and `pure`" below) |
| `network` | External network communication (`fetch`, `node:http`, any socket) |
| `db_read` / `db_write` | Reading from / writing to a data store |
| `fs_read` / `fs_write` | The file system |
| `state_write` | Modifying a value reachable from outside the function. Assignment to arguments, module-scope bindings, or `this`, and destructive method calls on them such as `Array.push` / `Map.set` / `Set.add` |
| `llm` | LLM API calls. Implies `network` and is subject to budget |
| `env` | Non-deterministic input such as environment variables, the clock, and randomness |
| `process` | `child_process`, signals, `process.exit` |
| `unknown` | Not analyzable. May include any effect (for its relation to being simply undeclared, see immediately after the propagation rules) |

User-defined effects can be declared in `ambit.config.ts` as combinations of standard effects (for example `payments: ["network", "db_write"]`).

**Local mutation and `pure` (decided: 2026-09-09)**

`pure` **permits mutation of values created inside the function**. Only mutation of a value reachable from outside the function is treated as `state_write`, and if it exceeds the declaration it becomes a violation under propagation rule 1.

Three options were considered:

1. **Permit local mutation, and count only externally reachable mutation as an effect** (adopted)
2. Report every mutation as an effect. `pure` would not even permit a `push` onto `const out: T[] = []`
3. Leave mutation outside the effect model. A destructive method would fall to `unknown` because its effect is undetermined even when the name resolves

There are two reasons for adopting 1.

First, 1 is semantically correct. Mutation of a value created inside the function is unobservable from the caller as long as that value has not escaped. Counting an unobservable action as an effect turns `pure` from "touches nothing outside" into "is not written in a particular way", which makes it a style rule rather than principle P2 (constraining the range of action).

Second, 3 (leaving it alone) was in fact inflating `unknown`. In `ambit check src --coverage` on 2026-09-09, 69 of the 131 unresolved sites originating from `builtin-method` (`Array.push` 50, `Map.set` 13, `Set.add` 6) were destructive methods, and most of them were appends to locally created arrays and Maps. Principle P4 requires not hiding what cannot be guaranteed, but continuing to count an unobservable action as `unknown` is inaccuracy in the opposite direction from hiding (it shows the guaranteed range as narrower than it is), and it distorts §4.3's practice of treating the `unknown` rate as a primary KPI. The before/after measurements are recorded in `docs/status.md`.

What would happen if 2 were chosen: the ordinary way to write a pure function in TypeScript (`push` onto a local array and return it) could no longer declare `pure`, and `pure` would become a tag almost nobody can actually declare. Adding a new name to the effect table does not make P3's incremental adoption work if users cannot use it.

What would happen if 1 were not chosen (i.e. staying with 2 or 3): under 3, `state_write` would not exist, and a function doing `param.push(x)` could declare `@effects pure` while that remained only an `unknown` **warning**, leaving `ambit check`'s exit code at 0 (§4.3). A state in which a function that rewrites its arguments can call itself `pure` runs against §3.4's "do not pass off an analysis failure as no violation".

**The rule for deciding locality**

The decision looks at the **root** of the mutation target (`a` for `a.b.c = 1`, `out` for `out.push(x)`). Only when the root is one of the following is it regarded as local.

- An identifier bound by `const` inside that function whose initializer is an array literal, an object literal, or a `new` expression
- A mutation target that is itself an array literal, an object literal, or a `new` expression
- A `this` whose binding function is the direct operand of a `new` expression (`new function () { this.x = 1 }`). It is a value `new` has just allocated, and nobody else holds it yet
- The `this` in the constructor body of a class with no `extends`. That constructor is what allocated the object, and it leaves only as the return value. With `extends`, the base constructor runs first and may already have passed `this` outward, so it is not local

Everything else (arguments, any other `this`, module scope, bindings of an enclosing function, `let` / `var` bindings, a root that is an expression rather than an identifier, and a root that cannot be resolved) is `state_write`. Destructuring assignment (`[a.x] = xs`, `({ y: o.z } = v)`) puts each assignment target through the same rule one at a time, and if even one is not local the whole is `state_write`. Falling to an effect rather than to `unknown` on the undecidable side is for the same reason as returning both `db_read` and `db_write` in §4.2's "operations whose read/write direction is not statically determined".

Like rule 7, this is **not a soundness claim**. If a locally created value is handed elsewhere and then mutated (`sink(out); out.push(x)`), Ambit judges it local mutation. No alias analysis is performed. This gap is expressed neither by `boundary` nor by `unknown`, so it is stated explicitly here.

The table of destructive methods follows the same inclusion rule as the `pure` table. Only names that showed up in measurements, and their in-place-mutation sibling methods on the same builtin type, are listed; when in doubt, not listed. In either table, an omission merely falls to `unknown`; it does not break in the direction of widening a guarantee.

A destructive method that takes a callback by reference (`arr.sort(cmp)`) carries `unknown` by rule 4. If the root is externally reachable it holds both `state_write` and `unknown`.

**Handling of invalid tags**

If `@effects` contains a name not in the table above (including a typo), that tag is not adopted as a contract. The function is treated as undeclared (it is not implicitly degraded to `pure`) and AMB-E002 is reported. Since it is undeclared, no violation exists and AMB-E001 does not co-occur. This is a parsing/adoption rule, and is different in kind from the propagation rules below (which presuppose an adopted contract).

**Propagation rules**

1. The known actions a function performs directly, and the known effects propagated from its callees, must be contained in the set the function declared. A known action exceeding the declaration is a violation.
2. `pure` is another name for the empty set. Calling a function with known side effects from `pure` is a violation.
3. A function that calls `unknown` contains `unknown` regardless of its declaration. If a declared function contains it, that is a **warning** (whether or not the declaration is `pure`). Ambit's `strict: true` can promote it to an error.
4. Higher-order functions: the effects of a callback parameter are inferred from the actual argument at the call site. Do not treat inference as complete on the basis of a type signature alone. If it cannot be inferred, `unknown`.
5. Methods, getters, generators, and `async` functions follow the same rules. `await` is transparent.
6. Calls through dynamic `import()`, `eval`, `new Function`, or an `any` type are `unknown`.
7. A call through a property resolves from the **value** of the receiver. Because it follows the entity rather than the type annotation, `const handlers: H = { read }` and `const handlers = { read }` give the same result. It resolves only when a single object literal is definitely behind the receiver; anything else (arguments, `let` bindings, literals containing a spread) is `unknown`. This is not a soundness claim. `const` fixes the binding but does not freeze the properties, so it cannot beat reassignment. Method resolution on class instances rests on the same premise.

If a contract tag is written at a position that cannot declare a contract (a node with no symbol ID), that declaration enters neither propagation nor checking. It is not dropped silently but reported as AMB-E003. A declaration that does nothing is not allowed to look like a guarantee.

Cycles in the call graph are propagated to a fixed point using strongly connected components or the like. Changing the analysis backend does not implicitly change the meaning of the contract model.

"Undeclared" and "`unknown`" are not the same thing. If a callee declares `@effects`, the caller trusts that declaration and uses it in propagation (whether the callee's own body is consistent with that declaration is checked separately, in the callee's own diagnostics — the shape of an ordinary modular effect system). If the callee has no declaration, propagation continues using the observed effect set inferred recursively from the callee's own body. `unknown` actually arises only on reaching the "not analyzable" of rule 6: dynamic `import()`, `eval`, a call through an `any` type, an unresolvable callee, and so on. "Undeclared" therefore does not by itself mean `unknown`; it is something `--coverage` (4.3) makes visible in its tallies, not an input to the propagation rules. If `unknown` remains inside a declared callee, it appears as that callee's own AMB-W001 and does not propagate to a caller that trusted the declaration.

A diagnostic that is only about `unknown` (the warning of rule 3) leaves `ambit check`'s exit code at 0, as long as no known action exceeds a declaration. This is a separate matter from 3.4's "do not pass off an analysis failure as no violation"; this one is about handling "analyzed, but unclear".

**Evidence for effect detection**

- Ambit declarations (`contract()` / JSDoc / config)
- Effect definitions for Node.js standard modules and major libraries (`stubs/`, bundled and maintained by Ambit itself)
- An `ambit.stubs.json` a third party bundles in its own package
- If there is none of these, `unknown`

**Operations whose read/write direction is not statically determined**

For an operation where the same method is a read or a write depending on the statement's content, such as `pg`'s `query(sql)`, the stub table returns a set of effects (not a single effect). The decision is made only from the leading keyword of a literal string, or of the static leading part of a template literal, and where that does not settle it, both `db_read` and `db_write` are returned. A design that returns only the read is not taken: a dynamically assembled `UPDATE` would pass a contract of `@effects db_read`, which runs against 3.4's "do not pass off an analysis failure as no violation". The price of this over-approximation is that a read-only function that assembles its statement dynamically also needs to declare `db_write`.

This rule applies to the direction of the effect only. Table names are not read out of SQL to derive capabilities (see 4.4's caveat, "the ability to decide table-level permissions for arbitrary SQL is not assumed").

### 4.3 Handling `unknown`

`unknown` is Ambit's core concept, representing the unresolved extent of a guarantee. Code with no declaration is not something assigned `unknown`; it is something inference continues on as far as possible (4.2). `unknown` arises only on paths that remained unanalyzable even after inference.

- Do not forbid it. The moment it is forbidden, incremental adoption stops working.
- `ambit check --coverage` outputs the proportion of the codebase that depends on `unknown` and where it occurs. It is treated as a primary KPI, but this number alone is not regarded as expressing the whole guarantee. Trust in boundary declarations and the trust level of stubs are shown alongside it.
- The ways to reduce `unknown` are adding verifiable declarations, adding stubs, or explicit isolation via `boundary` (4.6). Moving something to a boundary is tallied separately from succeeding at analysis.
- `strict` can be set per directory in `ambit.config.ts`. Tighten new code while leaving legacy code at warnings.
- For a measurement in which the backend or its version changed, state that change. Do not confuse a rise or fall in `unknown` caused by a compatibility difference with an improvement in contracts.

### 4.4 Capabilities

If effects are "what it does", capabilities are "what it may do it to".

- Form: `<resource>:<action>:<target>`. `target` may be globbed (`http:get:*.example.com`).
- Only **narrowing** is possible from caller to callee. If a callee requires a broader capability than its caller, that is a violation.
- An entry point states `@entrypoint` and `@capabilities` explicitly, in JSDoc or in `ambit.config.ts`. Leaving them unspecified is warned about as equivalent to `unknown`.
- **Dual enforcement**: violations that can be decided statically, such as literal URLs and known clients, are stopped by the checker. Dynamic URLs, table names and the like are matched by the corresponding runtime hook. Operations with no hook are not guaranteed blockable.

**What the static side matches**

The checker matches only `http:<method>:<host>`, and only at the HTTP entry points in the bundled stubs (`fetch`, and `get` / `request` of `node:http` / `node:https`). A host is regarded as determined only if it is a literal string, or if the static leading part of a template literal terminates the authority. Where the static part ends partway through the authority, as in `` `https://api.${env}.example.com/` ``, a prefix match is not allowed to claim a host. A target that cannot be determined is treated as `unknown` rather than as no requirement, and the diagnostic text says that it is the runtime's responsibility. The host is taken as written in the source (including the port, excluding userinfo). Default ports are neither filled in nor elided.

Table names are not read out of SQL statements to derive `db:` capabilities. The reason is the same as the caveat above (the ability to decide table-level permissions for arbitrary SQL is not assumed), and changing where it is read from does not change the claim.

**Runtime enforcement is per entry point**

`@ambit/runtime` pushes the capability set onto `AsyncLocalStorage` at the moment an entry point is entered. Supported operations from then on are matched against that set. `AsyncLocalStorage` is responsible for holding the context; the blocking itself is implemented by the adapter.

The following ways of establishing the context are provided.

- A framework adapter (`ambit/runtime/hono` and so on) wraps the handler at each route registration. It maps the declaration to the actual handler and pushes the context at run time. It is not one middleware inserted for the whole application: contracts differ per route, and placing `spec` and the handler in the same call is the premise of the agreement check below.
- Where there is no adapter, insert `withAmbit(spec, handler)` by hand.

The capability set need be written in one place only. A literal array in a `withAmbit` wrapping a handler declared in the same file *is* that handler's `@capabilities` declaration ("Removing the double declaration" below). Only when it is also written in JSDoc does the checker check **agreement at the source level**: under the same conditions as reading a declaration (a literal array, and a `handler` naming a declaration in the same file), it compares the two as sets and errors if they disagree. A dynamically assembled array and a handler in another file can be read neither as a declaration nor for comparison, so they are made visible with a warning (they are not passed silently). The same rule applies to adapter registration (the decision below).

**Mapping contracts to handlers (decided)**

This is the part of the identically named item in chapter 12 for which the approach and the adoption procedure have been decided. Everything concerning performance is **unmeasured**.

Options:

1. **Explicit registration** — pass the handler and the contract (`spec`) to the adapter together. The contract becomes a runtime value inside the module.
2. **Contract-data generation** — `ambit check` writes out contract data (symbol ID → contract) from JSDoc, and the runtime reads it and matches it against the running handler.
3. **Both** — explicit registration as the base, with contract data filling in for unregistered handlers.

Chosen: 1 (explicit registration). The adapter takes the form `ambitHandler(spec, handler, decode)`, placing `spec` (the contract) and `handler` (the function that declared the contract) in the same call.

Reasons:

- Because the contract is a **value inside the module**, it reaches runtime as-is even through a build that drops comments (`tsc`, esbuild, SWC JSDoc removal) and after bundling and minification. The runtime does not read JSDoc, and refers to neither symbol IDs, file paths, nor function names. The condition of not bringing a type-analysis engine into the runtime is automatically satisfied as well.
- 2 requires a key linking the contract data to the running handler. **As long as the key is a symbol**, every candidate (symbol ID = file path + declaration path, `fn.name`) is something bundlers and minifiers rewrite, and is not preserved by default (measurements in "Reconsidered: an HTTP key" below). A transform that injects wrappers from JSDoc is a Phase 1 non-goal in §4.5, so an approach premised on that transform cannot be chosen now. Keys other than symbols are treated separately below.
- 2 further introduces a failure mode in which the generated contract data goes **stale**. Run in a state where the source has been fixed but `ambit check` has not been passed, the runtime enforces a contract that is written nowhere in the current source. That is a state in which the static check and execution silently give different answers about the same contract, and it is not taken.
- 3 does not solve 2's key problem and adds a failure mode (which to take when a registered contract and the contract data disagree). While 1 suffices, there is nothing to pay for the addition.
- The runtime overhead (one context and one `decode`) is **unmeasured**.

What would happen otherwise:

- Taking only 2 and not 1 would make post-bundle mapping a conditional guarantee — "it works if you have a build setting like `--keep-names`" — and in configurations without that setting there would be nothing but handlers whose contracts cannot be found.
- Taking neither would leave the adapter unable to push a context without knowing the contract, and the capabilities of a handler declaring `@entrypoint` would never be matched at run time.

**Reconsidered: an HTTP key (the decision does not change)**

The "reasons for rejecting 2" above concern the case of a symbol as the key. An HTTP entry point has another key, `method + path`, and bundlers do not rewrite it. The question was posed again: if option 2 were rebuilt around `method + path`, could the contract be delivered to every route with the single line `app.use(ambitMiddleware(contracts))`, without touching existing route registrations? Measurements were on Node.js v24.19.0 / macOS (darwin arm64), esbuild 0.28.2, hono 4.13.7. The spike is not left in the working tree.

What was compared: (A) the current explicit registration, (B) `ambit check --emit-contracts` emits contract data keyed on `method + path` and one framework middleware reads it, (C) B as the default with A only for routes the key cannot resolve.

Measurements:

- **Survival of the key**: under `esbuild --bundle --minify --format=esm`, all 15/15 route path literals in the spike survived intact (including `/users/:email`, `/posts/:id{[0-9]+}`, `/files/*`, and `/loop/one` registered by looping over an array). Function declaration names were crushed to one character; measured `fn.name` went `listUsers`→`"a"`, `getUser`→`"u"`, `createOrder`→`"c"`. However, `--keep-names` is **a single flag**, not a build plugin, and with it every `fn.name` comes back (1213B → 1520B). So "a symbol key is not preserved" is a statement about defaults, and does not stand as an objection to a path key. The question is right on this point.
- **Whether the key is readable at run time (hono)**: inside `app.use("*")`, the `c.req.routePath` readable **before** `next()` returns the middleware's own `/*`. Since the contract must be pushed before the handler, `routePath` is not enough. `c.req.matchedRoutes` holds `[/*, /users/:email]` already before `next()`, and would serve as a key. It is a different API per framework, and is unverified outside hono.
- **Whether the key is determined on the static side**: walking the spike's 14 `app.*` registrations with the TypeScript AST, a literal path is obtainable for 12/14 (86%). The two that are not are one registered by looping over an array, and `app.route("/api", sub)` itself. The problem is the remaining one: `sub.get("/items", …)` is statically `/items` while the runtime key is `/api/items`. Unless mounts are resolved, the result is 11 keys that match at run time, **1 key that does not**, and 2 with no key. A key that does not match is worse than no key: that route silently falls to `runtime.unscoped`, while the emit side reports having covered 12/14. A gap that would be visible with no key is invisible here. (If the same path is also registered on the parent app, another route's contract could apply, but this is **unmeasured**.)
- **The proportion against `test/fixtures/realistic-api` cannot be measured**. The fixture has 0 `app.<method>(...)` and 0 `new Hono()`; there is no denominator (what it has is 7 `ambitHandler` registrations). The current checker has no path for extracting `method + path` either (`RUNTIME_WRAPPER_NAMES` holds the three `withAmbit`, `ambitHandler`, `ambitRoute`, none of which carries a `method + path`), so against an arbitrary application it is 0/N. The 86% above is the spike's number, not the fixture's.
- **Adoption cost**: across the fixture's 7 routes, `ambitHandler` registration accounts for 44 lines (orders 10 / users 13 / audit 21) = 6.3 lines per route. Putting A into an API with N existing routes costs roughly 6N lines; B costs 1 line plus one emit step in the build/CI. This difference is a real advantage of B, and not a small one.

A (no change) is chosen even so. The reasons are not about key survival, but these three:

1. **The separation of `decode` is lost.** What B wraps is the framework's handler itself (`(c) => …`), and inside it is `c.req.json()`. The `Context` API is not in the stub table, so the function that declared the contract contains `unknown` (`AMB-W001` / `AMB-W003`). The third parameter `decode` exists precisely to avoid this. Extracting a domain function restores static analysis, but then the key points at the route handler while the JSDoc sits on the domain function. B does not reduce the mapping problem; it only moves where it lives.
2. **Mounting makes the gap invisible.** As measured above, an extraction that does not resolve `app.route()` produces an `/items` counted as having a key statically, while the runtime key is `/api/items` and will never match. Under A, a route with no registration is visible from the absence of `ambitHandler` in the source; under B it is hidden beneath a report of full coverage. That runs head-on against the principle of not counting the unverifiable toward the guarantee (§2). Making B safe would make mount resolution a hard requirement, and a configuration in which `app.route()`'s arguments cannot be traced statically cannot meet it.
3. **There is no build-independent answer to the staleness of the generated artifact** (next item).

C is not taken either. C inherits 1 and 2 wholesale from B, and on top of that adds "which to take when a registered contract and the contract data disagree". B's one-line advantage is eroded by exactly the amount of A that has to be written for the routes the key cannot resolve.

**The answer to contract-data staleness, were B or C to be taken**

They are not taken, but they were not rejected without an answer, so it is written down. `ambit check --emit-contracts` embeds in the contract data a content hash (per file) of the source the contract was read from. The runtime checks it at startup and **fails to start** if it does not match.

- `warn` is not taken. It is a state in which the static check and execution keep running while giving different answers about the same contract, and adding one line of log does not change the failure mode. This is precisely the reason 2 was rejected.
- `deny` (pushing a deny-everything context) is not taken either. The empty set is a total denial, and for the same reason as the decision not to push an empty context for "a handler whose contract cannot be found", it makes an accident of build ordering indistinguishable from a policy decision.
- Failing to start is chosen because the cause of a mismatch is always a fixable accident — "`ambit check` was not run". Stopping execution means no progress until it is fixed.

This answer has a premise, though: that the source is present at startup. In a configuration that bundles for distribution, the source is not part of the artifact and there is nothing to check the hash against. Checking it would require a build step carrying the hash into the artifact, and that is exactly the coupling to the build that B was supposed to avoid. The third reason refers to this.

**Removing the double declaration (decided: 2026-09-10)**

When a `spec` fixes `capabilities` / `budget` as literals and `handler` is an identifier naming a declaration in the same file, that value **is read as that handler's own `@capabilities` / `@budget` declaration**. There is no need to write the same content again in JSDoc. `@effects` and `@entrypoint` stay in JSDoc (§4.1 "Where declarations live").

The discriminator is the single question of whether it has to reach runtime. `capabilities` is what the hooks match against, and `budget`'s `timeMs` is measured and blocks. Both have to reach runtime, and JSDoc disappears at build time, so the authoritative copy lives in `spec`. `effects` is not used at runtime, so it stays in JSDoc.

Rejected alternatives:

- **Make JSDoc authoritative and deliver it to the runtime** (option 2 above / `--emit-contracts` / the middleware approach). The three reasons above apply unchanged, and the judgment does not change. In addition, the double writing arises **only for people who put runtime enforcement in place**, and those people have already written the wrapper. Making `spec` authoritative adds not one line and removes two from JSDoc, whereas making JSDoc authoritative requires a delivery mechanism **on top of** the existing wrapper. The intrusion does not shrink; only the machinery grows.
- **A build-time transform that injects wrappers from JSDoc** (a Phase 1 non-goal in §4.5). It brings in coupling to the build step just as option B does, and is rejected for the same reason.
- **Put `@effects` in `spec` too**. `effects` is attached to every function, and a wrapper that exists only at entry points cannot carry it. The granularity does not match.
- **Infer `@entrypoint` from the fact of being wrapped**. `@entrypoint` is one line and was never duplicated in the first place. Inferring it would make "forgot to wrap" indistinguishable from "not an entry point".

The agreement check (`AMB-E010` / `AMB-E011`) **stays. Neither its meaning nor its severity changes.** If both are written and they disagree, it is an error. What changed is only that "the JSDoc side may be absent", not that "disagreement is allowed". This is why `spec` is placed last in the merge: if JSDoc or config declares something, that takes effect, and `spec` is compared against that declaration. The same rules as `withAmbit` apply to `ambitHandler(spec, handler, decode)` and `ambitRoute(spec, handler, decode)`.

The check this decision gives up is stated explicitly. In the era of writing it twice, an edit that widened only `spec` was caught by `AMB-E010` as "the pair disagrees". Once the declaration is in one place there is no pair, so that way of catching it is gone. This is not a reduction in the contract's guaranteed surface, however. `AMB-E010` / `AMB-E011` were never a mechanism for catching capability expansion itself; they were a mechanism for watching that duplicates did not disagree (an edit widening both sides at once always passed silently). A declaration written in `spec` shows up in the diff like every other Ambit contract, is bound from its callers by the narrowing rule of §4.4 (`AMB-E005`), and its literal targets are checked by `AMB-E009`.

There remains a range this does not reach, and JSDoc is required there: when `spec` is not a literal, and when `handler` is a declaration in another file (§12 (3)). Both are made visible with `AMB-W004`, whose message states that "an unreadable `spec` declares nothing; here the handler's own `@capabilities` / `@budget` is the only declaration". If the entry point still has no declaration, `AMB-W002` is emitted alongside. It is never silently made `unknown`.

The agreement check is not limited to `@capabilities`. `spec.budget` and `@budget` are treated the same way: if `spec.budget` is a literal object and each value is a literal, that is the declaration. If `@budget` is also written, they are compared, and if any of `timeMs` / `costUsd` / `llmCalls` / `onExceed` disagrees it is `AMB-E011`; a limit present on only one side is also treated as a disagreement. `onExceed` is compared after aligning both sides to the default `throw` (the JSDoc side gets the default at `@budget` parse time, so there is no "absent" state to compare against an omission on the `spec` side). The two halves are judged independently: a `spec` may write one half as a literal and assemble the other at run time, and only the half that could not be compared is made visible with `AMB-W004`. A separate id was used rather than extending `AMB-E010` because `AMB-E010`'s `contract` field holds capability strings (`declared` / `required` / `excess`), and a budget disagreement has nothing that fits there.

**Why `decode` is separated**

A framework's `Context` API is not in Ambit's stub table. If a handler directly contains framework calls such as `c.req.json()`, that handler contains `unknown` (`AMB-W001` / `AMB-W003`) and the capabilities it declared end up "not fully determined". Separating `decode` (the function building the handler's arguments from the `Context`) into the third parameter confines framework-dependent calls to the single registration expression, and leaves the handler that declared the contract a framework-independent, statically analyzable function. `decode` runs **inside** the context: reading the request body counts toward `timeMs` as well.

**Handlers whose contract cannot be found**

A handler registered without going through an adapter (writing `app.get(path, handler)` directly) pushes no context. Supported operations inside such a handler are decided by `runtime.unscoped` (`allow` default / `warn` / `deny`). The adapter **does not push a context with an empty capability set** for a handler whose contract cannot be found: the empty set is a total denial, and it would make the accident of a missing registration indistinguishable from a policy decision. Concentrating on the single `unscoped` setting reads better than splitting the reason for denial into two systems. Since the adapter's registration API requires `spec`, the state of "registered via the adapter but with no contract" cannot be created.

**How denial is conveyed**

`AmbitCapabilityError` / `AmbitBudgetError` are not translated by the adapter into an HTTP status; they are thrown to the framework's error handler as they are. 403 means "the client lacks permission", whereas what actually happened is "the server's code exceeded its own grant", which is a different thing. 504 likewise claims a state of the gateway. Translating would also bring the choice of either exposing the exception message (the list of permitted capabilities) to the client, or dropping information in order not to. Leave it to the framework's default error handler, and record it in the application's log.

**The approach to runtime hooks (decided)**

(a), (b) and (c) below are the parts of chapter 12's "Coverage and fragility of runtime hooks" for which the approach, the target format, and DB client support have been decided. Measurements were on Node.js v24.19.0 / macOS (darwin arm64); anything not measured is marked "unmeasured".

**(a) The hooking approach, and what can be blocked versus audited only**

Options:

1. monkeypatch — replace methods on the module object.
2. `diagnostics_channel` — subscribe to the official event notifications.
3. Loader hooks — resolve `node:fs` to a replacement module via `module.register`.
4. Client wrapping — wrap the prototype of the module or instance the caller passes in.

Chosen:

| Target | Approach | Blocks | Audits |
|---|---|---|---|
| `globalThis.fetch` | monkeypatch (`installFetchHook`) | yes | yes |
| `node:fs` / `node:fs/promises` | monkeypatch (`installFsHook`) | yes | yes |
| `node:child_process` | monkeypatch (`installChildProcessHook`) | yes | yes |
| `pg` | client wrapping (`installPgHook(pg)`) | yes | yes |
| `mysql2`, `@prisma/client`, `drizzle-orm`, `mongodb`, LLM SDKs (`openai`, `@anthropic-ai/sdk`, `ai`) | no hook | no | no |

Reasons:

- `diagnostics_channel` **cannot block**. Measured: even when a subscriber throws, `publish()` returns normally and the exception becomes an `uncaughtException` on the next tick. This is the answer to §12's "distinguish having an audit notification from being able to block": a path that can only notify is not counted as blocking. No case requiring audit alone has appeared, so it is not adopted this time (adopting it would not fill in the blocking column anyway).
- Loader hooks do **not exceed** what monkeypatching already covers. Measured: if the properties of `require("fs")` are replaced before the ESM namespace of `node:fs` has been created, a later named import `import { readFileSync } from "node:fs"` also sees the replaced function. Conversely, if `node:fs` is imported first and replacement happens after, named imports and the `import * as` namespace stay bound to the original functions, and only property access via `fs.readFileSync()` is covered. That difference is a difference in adoption order, not in approach.
- Client wrapping is used for `pg` because Ambit does not depend on `pg`. The caller passes the module to `installPgHook(pg)`, and Ambit wraps `Pool.prototype.query` / `Client.prototype.query`. If Ambit imported `pg` itself, users who do not use `pg` would gain a dependency.
- The performance impact (the overhead of going through the replaced function) is **unmeasured**.

What would happen otherwise:

- Adopting only `diagnostics_channel` would let us say "there is a hook" while calls pass straight through. The documentation would be putting a blocking mark on something that does not block.
- Adopting loader hooks would take on the fragility of rewriting resolution of `node:` builtins — reentrancy control, worker threads, `--import` ordering — without widening what is covered.
- Importing `pg` from Ambit's side would put `pg` into the dependency graph of users who do not use `pg`.

Installation modes and what they cover (`node:fs` / `node:child_process`):

| Installation | Calls covered | Calls not covered |
|---|---|---|
| Preload (running `install*Hook()` ahead of the application's module graph via `node --import` / `--require`) | `import { readFileSync } from "node:fs"`, `import fs from "node:fs"; fs.readFileSync()`, `require("fs").readFileSync()` | Only the common exclusions below |
| In-graph (calling `install*Hook()` at the top of the entry module) | `fs.readFileSync()` (via the default export's or `require`'s properties) | Already-bound named imports `import { readFileSync } from "node:fs"`, and `import * as fs from "node:fs"` |

Not covered under either installation: paths where `node:fs`'s internals call without going through the public API, native addons, inside child processes, and other workers of `worker_threads` (the hook must be installed per worker).

How denial is conveyed follows the shape of the API: synchronous APIs `throw`, callback APIs use `process.nextTick(callback, error)`, and Promise APIs reject. `existsSync` throws on denial rather than returning `false` — "does not exist" and "must not look" are different answers, and returning `false` would turn the latter into the former.

Node.js's own module loader reads files with the public `fs.readFileSync` (measured). After `installFsHook()`, therefore, `require()` and dynamic `import()` also go through the hook. Performing a lazy load while `runtime.unscoped` is `deny`, or inside a context that does not hold `fs:read`, gets that load denied. This is behavior as specified, and is documented in `docs/limitations.md` as part of the installation procedure.

**(b) The target format for `node:fs` and `node:child_process`**

Options:

1. Use the **absolute path** resolved at call time as the target.
2. Use the string as written in the source as the target (relative paths stay relative).
3. Ignore paths and permit per operation only (`fs:read:*`).

Chosen: 1. `fs:read:<glob over an absolute path>`, `fs:write:<glob over an absolute path>`, `proc:spawn:<command>`.

- Path arguments are normalized at call time: `Buffer` via `toString()`, `file:` URLs via `fileURLToPath`, and relative paths via `path.resolve` against `process.cwd()` at the time of the call.
- Globs may be written only on the granting side. `*` crosses `/` (the existing meaning of `globMatches` is used as is). `fs:read:/srv/app/*` also matches `/srv/app/a/b.txt`. There is no way to write a grant covering exactly one directory level.
- Operations taking an fd (`fs.readSync(fd)`, `FileHandle.read`) have no path by the time the fd exists. Read versus write is decided from the flags and matched at `open` / `openSync` / `promises.open`. `createReadStream` / `createWriteStream` go through `fs.open`, so they are caught at the same entry point (measured).
- Operations taking two paths (`rename`, `copyFile`, `link`) require `fs:write` on the destination and `fs:read` on the source.
- `proc:spawn:<command>`: `spawn` / `execFile` and their `Sync` variants take argv[0] **as written** (no PATH resolution) as the target. `fork` uses `process.execPath`. For the shell forms (`exec`, `execSync`, `shell: true`), the program actually launched is inside the shell string and is not determined without a shell parser, so the target is **the shell itself** (`options.shell` if it is a string, otherwise `/bin/sh`). The exception message says "a shell was launched / a permitted shell can run an arbitrary program". The first word of the shell string is not claimed as "the real command". This is for the same reason as not reading table names out of arbitrary SQL; the location changes but the claim does not.
- The character set for a target segment is widened to "anything but a comma (the `@capabilities` separator) and control characters". Paths contain spaces, `+`, `~` and `%`. This relaxation can only act in the closing direction: a mistyped tag becomes "a target that matches nothing", and shows up as a denial.

Reason: what is visible at call time is the resolved path, and that is the only form that can be matched against a grant. The cost of normalization (one `path.resolve`) is **unmeasured**.

What would happen otherwise:

- Choosing 2 would make `./data/x` and `/srv/app/data/x` different targets, so the same file could be written two ways. If cwd changes, the same string points at a different file, so the meaning of a grant would depend on where the process was started.
- Choosing 3 would make it impossible to declare which files may be read, and `fs:read` would mean nothing beyond "reads files".

**(c) DB client: `pg`**

Options: `pg` / `@prisma/client`.

Chosen: `pg`.

Reason: `pg` has stable replacement points in `Pool.prototype.query` / `Client.prototype.query`, and can be written in the same symmetric install / restore shape as `installFetchHook`. Prisma's official extension point `$extends` **returns a new client**, so a restore putting the original client back cannot be written. Also, the client does not exist without running `prisma generate`, and testing against a real connection is heavy. A performance comparison of the two is **unmeasured**.

What would happen otherwise: choosing Prisma would give a hook with no restore, which does not satisfy P5 (being able to back out).

Operations and the capabilities they require:

| Operation | Capability required |
|---|---|
| `Pool.query(text, …)` / `Client.query(text, …)` where `text`'s leading keyword is `select` / `show` / `explain` / `describe` | `db:read:<database name>` |
| The same, where the leading keyword is `insert` / `update` / `delete` / `create` / `drop` and the like | `db:write:<database name>` |
| The same, where `text` is not a string, its leading keyword cannot be read, or a `Submittable` is passed | **both** `db:read:<…>` and `db:write:<…>` |
| The configuration-object form `query({ text })` | `text` is judged by the same rules as above |

- The direction is decided by the **same rules** as the static side (the SQL keyword table in `src/stubs/data-clients.ts`). Putting the rules in two places would let the static check and the runtime give different answers about the same statement. The rules live in one place under `src/core/`, and both read them.
- The target is the **database name**, not a table name. What can be determined from a `pg` client goes as far as the database connected to, and reading tables out of arbitrary SQL is forbidden by the caveat above. A table-level target such as `db:read:users` has meaning only in the static narrowing rule (AMB-E005), and `pg`'s runtime hook does not satisfy it. This asymmetry is stated explicitly in the README and in the diagnostic text.
- Where the database connected to cannot be determined (no path in the `connectionString`, environment variables only, and so on), the target is `unknown`. A narrow grant like `db:read:app` does not satisfy it; only a database-agnostic grant like `db:read:*` lets it through. The exception message says "the database connected to could not be determined".

Publish the supported libraries, versions, operations, and the limits of the guarantee. The mere existence of a hook into a DB client is not taken to mean that table-level permissions can be decided for arbitrary SQL.

Behavior with no context is specified by `runtime.unscoped`: `allow` (the default, for early adoption) / `warn` / `deny`.

Per-function `@capabilities` is not enforced by the default runtime. It is used only for checking the narrowing rule in the static check. Where finer granularity is needed, the opt-in `contract()` pushes a new context inside.

Node.js's Permission Model is considered as an outer frame for the whole process, on Node.js versions that support it. It is not a substitute for per-entry-point checking, and is also distinguished from a guarantee of isolation against malicious code.

### 4.5 Budget

A budget is **not a type; it is a declaration, a measurement, and a block**. It is not guaranteed statically.

**Default: per entry point**

```ts
/**
 * @entrypoint
 * @effects llm, db_read
 * @budget timeMs=3000 costUsd=0.05 llmCalls=1 onExceed=throw
 */
export async function POST(req: Request): Promise<Response> { /* ... */ }
```

- **Declaration**: write the per-request or per-job limit on the entry point.
- **Measurement**: accumulate elapsed time, LLM call count, and estimated cost (price table × token count) on the context. The corresponding hooks catch `llm` calls.
- **Block**: `onExceed` is `throw` (default) / `warn` / `abort` (cancellation via `AbortSignal`). It does not extend to undoing spending already incurred, or to force-stopping work that does not support cancellation.
- **Static assistance**: warn about patterns indicating a possible violation, such as `llm` inside a loop, or more than one `llm` function reachable from an entry point with `llmCalls=1`.

**Opt-in: per function**

```ts
import { contract } from "@ambit/runtime";

export const summarize = contract(
  { budget: { timeMs: 1000, llmCalls: 1 } },
  async (doc: Document): Promise<string> => { /* ... */ },
);
```

- `contract()` returns a function of the same type as the original. The contract object must be a literal, and the checker reads it from the AST as it does JSDoc.
- A function budget sits inside the entry-point budget, and a child's consumption is added to the parent's.
- A transform injecting wrappers from JSDoc is a Phase 1 non-goal. Introducing it later requires an RFC, and the legacy tsc transformer API is not regarded as an extension point common to all backends.

The price table is written in `ambit.config.ts`, and Ambit itself bundles defaults. Reserving budget before a call, parallel execution, reconciling estimates against actuals, and handling calls for which no strict upper bound can be given are left as design questions in chapter 12.

### 4.6 Boundary

A guarantee holds within the range Ambit can analyze and enforce. Do not hide the boundary.

```ts
/**
 * @boundary reason="legacy SDK, not annotated"
 * @effects network
 */
export function callLegacySdk(payload: Payload) { return legacy.send(payload); }
```

- `@boundary` is an explicit declaration of trust: "do not statically check inside this function; trust the effects and capabilities it declares outward."
- `reason` is required. It is tallied in diagnostics and in `--coverage`.
- A `@boundary` without an accompanying `@effects` is a violation. The bargain of a boundary is "we do not look inside, and in exchange we trust the outward declaration", and if there is nothing declared to trust, it merely removes the check. A dimension that is not declared (such as permissions when `@capabilities` was not written) is treated as `unknown` rather than the empty set, leaving the hole visible from the caller.
- Inside a boundary, supported runtime enforcement stays in effect. Only the static check is stopped.
- To make an entire third-party module a boundary, name the package in config.

### 4.7 Types and null safety

Type safety such as optional access is not reimplemented. It is delegated to the chosen TypeScript analysis backend, and its diagnostics are converted into Ambit's structured diagnostics.

A non-null assertion `!` does not by itself make a type `any`. It is distinguished from a call through `any`, and how assertions are handled in contract analysis is settled by the conformance tests and an RFC.

## 5. Structured Diagnostics

The primary consumer of diagnostics is the AI agent. Human-facing display is implemented as a rendering of the structured diagnostics.

### 5.1 Output format

`ambit check --format json` outputs NDJSON (one diagnostic per line). Below is one diagnostic, formatted for readability.

```json
{
  "id": "AMB-E001",
  "severity": "error",
  "category": "effects",
  "message": "calculateTax declares pure but calls fetchRate which has effects [network]",
  "location": {"file": "src/tax.ts", "line": 42, "col": 12, "endLine": 42, "endCol": 40},
  "contract": {
    "declared": ["pure"],
    "observed": ["network"],
    "via": [{"symbol": "src/rates.ts#fetchRate", "file": "src/rates.ts", "line": 10}],
    "operation": {"qualifiedName": "fetch", "file": "src/rates.ts", "line": 12}
  },
  "fixes": [
    {
      "rank": 1,
      "kind": "widen",
      "summary": "Allow network effects in calculateTax",
      "confidence": 0.95,
      "consistentWithContract": false,
      "edits": [{"file": "src/tax.ts", "range": [[40,0],[40,20]], "replacement": "/** @effects network */"}],
      "impact": {"callersAffected": ["src/checkout.ts#total"], "pureCallersBroken": 1}
    }
  ],
  "docs": "https://ambit.dev/diag/AMB-E001",
  "engine": {"name": "typescript-legacy", "version": "6.0.3"}
}
```

`ambit check --format github` outputs the same structured diagnostics as GitHub Actions workflow commands (`::error file=...,line=...,col=...,title=<diagnostic ID>::<body>`). The body folds each step of the call path and `contract.operation` after the diagnostic message, separated by `%0A`, so that the path is readable from the annotation alone. `severity` maps `error` / `warning` / `info` onto `error` / `warning` / `notice` respectively, and since `location.file` is a path relative to the checked directory, it is rewritten to be relative to the workspace where annotations are resolved. This output format exists to satisfy §6's "do not require a dedicated CI plugin", and does not affect consumers of the NDJSON.

`ambit check --format json` follows the diagnostics with one `kind: "authority"` record per analyzed function. This is not a diagnostic; it is the authority that function holds. Every function is emitted, including those with no violation.

```json
{
  "kind": "authority",
  "symbol": "src/tax.ts#calculateTax",
  "location": {"file": "src/tax.ts", "line": 42, "col": 12, "endLine": 42, "endCol": 40},
  "entrypoint": false,
  "effects": {"declared": [], "observed": ["network"], "unknown": false},
  "capabilities": {"declared": null, "required": ["http:get:api.example.com"], "unknown": false},
  "paths": [
    {
      "authority": "network",
      "kind": "effect",
      "via": [{"symbol": "src/rates.ts#fetchRate", "file": "src/rates.ts", "line": 10}],
      "operation": {"qualifiedName": "fetch", "file": "src/rates.ts", "line": 12}
    }
  ]
}
```

- In `declared`, `null` means "there is no tag" and `[]` means "declared `pure`". They are distinguished. A tag that could not be parsed (`AMB-E002`) goes on the `null` side. A broken declaration is not read as a narrower grant than one that was never written.
- `observed` / `required` are post-propagation values. `unknown` is not an authority but a separate claim — "the analysis did not reach" — so it is held as an independent boolean on each of `effects` and `capabilities` (§4.3).
- `paths` is attached only to authority actually reached, and `via` and `operation` are built by the same computation as `AMB-E001`. No path is attached to authority that is merely declared but not reached by the body (§5.3, do not fabricate paths).
- Records are in symbol ID order, and the arrays within a record are sorted. Analyzing the same tree twice produces identical output. This is so that ordering jitter does not show up as a diff.
- The position is between the existing diagnostic lines and the `kind: "summary"` line. Existing consumers that read the last record as `summary` are not broken (§5.2). `init` does not emit these: its proposals are output about "contracts that do not exist yet", not about the current state of authority.

This is an artifact of the checker side and is never read at run time. What §4.4's option 2 rejected was contract data **distributed to the runtime**, which this output is not. `ambit diff` (§6) computes the authority difference from these records alone.

`via` is a sequence of functions, and each element's position is that function's declaration position. The position of the operation that causes the effect (the line of `fetch(...)`) is held by `contract.operation`. This exists so that a reader can reach the operation's line from the diagnostic alone; the meaning of `via` is unchanged.

This example assumes that line 41, the target of the fix, is the 20 characters `/** @effects pure */`. The positions are illustrative; an actual patch is generated from the analyzed source file. Since no concrete patch that keeps the contract can be generated, only the loosening candidate is shown. A pseudo-patch containing the ellipses of the original specification is not emitted as an applicable fix.

### 5.2 Fields

| Field | Content |
|---|---|
| `id` | A stable diagnostic code. Never deleted or reused |
| `severity` | `error` / `warning` / `info` |
| `category` | `effects` / `capabilities` / `budget` / `boundary` / `types` |
| `contract` | The declared/observed difference and path of a contract diagnostic. The shape varies by `category`: `effects` is `{declared, observed, via}`, `capabilities` is `{declared, required, excess, via}` (`declared` is the granted capabilities, `required` is what the body needs, and `excess` is the part of that which `declared` does not permit). No extra discriminator field is added — consumers look at `category`. Application to compiler-derived type diagnostics and the like is defined in the schema |
| `fixes` | Fix candidates. `consistentWithContract` distinguishes fixes that keep the contract from those that loosen it |
| `fixes[].impact` | Callers and the like affected by a fix that loosens the contract |
| `contract.operation` | The position of the operation causing the effect. `{qualifiedName, file, line}`. The position of the stub call causing that effect, within the last function of `via` (or the diagnosed function if `via` is empty). Attached only to effect-excess diagnostics (`AMB-E001`). Where the position cannot be determined — the effect comes only from the callee's `@effects` declaration with no corresponding operation in the body, or it comes from an assignment or mutation with no named operation — the field is omitted entirely. The declaration position is not used as a substitute |
| `engine` | `{name, version}`. Identification of the analysis backend that produced the diagnostic (`name` is the implementation name of the connection layer, `version` is the version of the compiler that backend depends on) |

Diagnostics are managed by a versioned JSON Schema. The schema version, the Ambit version, the representation of analysis failures, and coverage's denominator and trust categories are defined in M1 (only the `engine` field is settled ahead of that). Metadata lines that would break existing NDJSON consumers are not added without notice.

### 5.3 Design notes

- `fixes[].edits` are applicable, concrete patches. A candidate that is only a summary, or that contains ellipses, is not emitted as an automatically applicable fix.
- Where a fix that keeps the contract can be generated, it is placed higher, with loosening candidates after it. Candidates that cannot be generated are not fabricated for the sake of ranking.
- The representation for when a loosening candidate cannot be generated is defined in the schema. The consistency of "always present a candidate" with "always a concrete patch" is settled in M1.
- The meaning of diagnostic codes is listed in `docs/diagnostics/`, and breaking changes require an RFC.
- The format does not depend on the host language. Compiler-specific objects and in-snapshot IDs are never used as public symbol IDs.
- A symbol ID's declaration path is joined with `"."` (`src/tax.ts#Foo.bar`). Members of object literals use the same notation, so `const handlers = { read() {} }` is `handlers.read`. Names that collide with the joiner (computed, string, or numeric keys) have no stable notation and are given no symbol ID (see the open items remaining in §12).
- `location` is 1-based; edit ranges are 0-based and end-exclusive by default, and string offsets are unified on UTF-16 units. Positions from the backend are converted and validated.

## 6. Toolchain

```text
ambit init      Propose inferred effects as JSDoc fix candidates. --config proposes additions to ambit.config.ts
ambit check     Static checking. --format json / github / --coverage / --strict
ambit diff      Authority difference against a base ref. --format github
ambit run       Run with runtime enforcement enabled (for development)
ambit agent     The agent loop (chapter 7)
ambit stubs     Generate and search stubs for dependency packages
ambit sbom      Emit dependencies together with their effects and capabilities as an SBOM
```

`ambit diff <ref> [dir]` compares the working tree's authority against the base ref's and emits what has increased.

- The base ref is materialized into a temporary directory with `git worktree`. It is placed in the OS temporary directory, never inside the tree being checked. It is cleaned up unconditionally, on success and on failure.
- The same subdirectory on both sides goes through the same analysis. Symbol IDs contain a path relative to the checked directory (§5.3), so if the target shifts, every symbol looks new.
- If the working tree has `node_modules`, it is symlinked into the base side. Measured, the side without it gains 19 more unresolved calls and produces `any-typed` entries present on only one side. This is so that a difference in environment, rather than in contracts, is not reported as a diff.
- The comparison itself is a pure function taking only the two sets of `kind: "authority"` records, and touches git not at all (§6.1, "capability comparison").
- If analysis fails on either side, exit code 2. Not having been able to compare is not reported as "nothing increased" (§3.4).

Exit codes:

| What happened | Exit code |
|---|---|
| An existing symbol's authority increased | 1 |
| A new symbol with authority appeared | 1 |
| Authority only decreased | 0 (reported) |
| A symbol only disappeared | 0 (reported) |
| A new symbol with no authority | 0 |
| `unknown` increased (authority did not) | 0 (reported) |
| Analysis failed on either side | 2 |

Reducing authority is not what this command watches for. Failing on a decrease would give the writer a reason not to touch contracts at all. `unknown` is not authority (§4.3) so it does not count as an increase, but it is reported.

- Distribution is `npm install -D @ambit/cli` and `npm install @ambit/runtime`. The supported OS / CPU and distribution conditions of any native binary are published.
- Production uses `@ambit/runtime` and the necessary adapters and contract data. The compiler and the development CLI are not made required production dependencies.
- Editors obtain diagnostics and fix candidates from the same checker as the CLI. Do not assume the legacy Language Service Plugin works unchanged on the native version. The chosen approach is verified by M4.
- CI integrates via the exit code and the structured output. A dedicated CI plugin is not required. On GitHub Actions, the output of `ambit check --format github` becomes annotations directly (§5.1). Installing a dedicated Action or plugin is not demanded.
- A JSDoc declaration by itself does not change runtime behavior. The settings and steps needed to deliver contracts to the runtime are stated explicitly per framework.

### 6.1 Package responsibilities

| Package | Responsibility |
|---|---|
| `@ambit/core` | The contract model, analysis representation, capability comparison, diagnostic format. Does not depend on a compiler API |
| `@ambit/checker` | Contract analysis using information from the connection layer, inference, coverage, fix candidates |
| `@ambit/cli` | Commands, exit codes, structured output, control of iterative checking |
| `@ambit/runtime` | Context, matching and blocking of supported operations, budget measurement, adapters |
| `@ambit/stubs` | Contract definitions and trust information for external libraries |
| Editor connection package | Connection to the shared checker. The name and the Plugin / LSP approach are settled after verification |

The compiler connection layer is implemented separately from the checker, but whether it becomes an independently published npm package is undecided. Do not add public API that is not needed.

The table above is a goal for package splitting; expressing the same separation of responsibilities as directories within a single package is acceptable (`AGENTS.md` Toolchain).

### 6.2 Iterative checking and caching

For agents and editors, design a resident check path that holds the analysis engine's state together with Ambit's function summaries and dependency information. One-shot `ambit check` is retained as well. The startup and connection method and the CLI option names are settled in M1.

- Rather than only the changed files, walk the contract dependencies backwards and re-check the callers affected.
- Update ranges containing recursion to a fixed point.
- Include changes to JSDoc, out-of-code contracts, stubs, tsconfig, dependency resolution, and the analysis engine version among the invalidation conditions.
- Do not ignore a change to contract comments alone, even when the compiler's type information is unchanged.
- Do not carry snapshot-specific types and symbol IDs across an update. Maintain a correspondence to files, declaration paths, and the like.
- Measure initial analysis, type-information retrieval, contract analysis, transfer, and diagnostic output separately, to make clear where the latency comes from.

## 7. The Agent Loop

```text
[generate] → ambit check → [diagnostics JSON] → [fix] → ambit check → ... → ambit run → [test] → [deploy]
```

- `ambit agent` does not embed an agent implementation. It defines a protocol and connects an arbitrary agent.
- Tasks, diagnostics, and patches are exchanged as NDJSON over stdio or HTTP. Initially stdio is preferred.
- Each iteration is able to use the resident check path. The approach in which an external agent invokes the one-shot CLI is retained as well.
- If fixes for the same diagnostic `id` at the same position fail N times (default 3), stop and escalate to a human.
- Fixes that loosen a contract (`consistentWithContract: false`) require human approval (relaxable in config).
- Record the `unknown` rate on each cycle and warn if it increases. Distinguish engine changes and analysis failures from an ordinary improvement cycle.

The limits of enforcing approval solely inside the agent loop, and how to detect direct changes to contracts, settings, and stubs in CI, are treated in chapter 12.

## 8. Supply Chain

Use the existing `package-lock.json` / `pnpm-lock.yaml` and npm provenance (Sigstore), and layer the contract layer's information on top.

- `ambit sbom` attaches the effects and capabilities obtained from stubs to each dependency package in the SBOM.
- If effects widen through a dependency update, `ambit check` reports the difference.
- Stub trust levels: bundled with Ambit > provided by the package author > community > automatically inferred. Include the trust level in diagnostics.
- Pin and record the versions of the analysis client and the native engine as well. Distinguish analysis differences caused by an engine update from contract differences in the user's dependency packages.

## 9. Governance

- The specification, diagnostic codes, checker, runtime, and stubs are all open source.
- Proposal into `rfcs/` → review → adoption. Changes to the meaning of diagnostic codes, the standard effects, or the propagation rules require an RFC.
- Changing the default backend, or making a breaking change to the range of TypeScript supported, also requires an RFC.
- Publish a conformance test suite (`conformance/`) and keep alternative implementations possible. Keep the connection trials against a type engine separate from trials of the contract model itself.
- Put the stewardship of the trademark and the specification in writing at an early stage. Securing the npm scope `@ambit` is M0 work and is not described as already done.
- `rfcs/` and `conformance/` are put in place from the first public release onward. Until then this file is edited directly, and the conformance tests are substituted by Vitest under `test/`.

## 10. Success Metrics

Measured in Phase 1.

| Metric | Target |
|---|---|
| `unknown` rate (median across adopting teams, three months after adoption) | 30% or below. The denominator, the trust categories for boundaries, and the analysis engine version are published too |
| Proportion of agent-generated PRs whose contract violations were stopped before production | Being able to measure it at all is the first goal |
| Lead time from generation to production | Improved against the pre-adoption baseline |
| Number of serious incidents | Reduced against the pre-adoption baseline |
| Cost of backing out | The removal procedure for whatever was adopted — JSDoc, settings, adapters — is tested automatically. Opt-in wrappers are handled separately |
| Latency of the initial check and of a re-check after a change | Measured separately on a representative project. Compared against the allowances set before adoption |
| Memory and communication volume during analysis | The conditions including child processes, and the measurement scope, are published |

Producing one team that can show "2× faster to production for AI-generated code, half the serious incidents" is the Phase 1 exit criterion. Support for other languages is considered only after that. Speeding up analysis alone does not count as meeting the exit criterion.

## 11. Milestones

| M | Content | Exit criterion |
|---|---|---|
| M0 | This specification, the diagnostic code list, the RFC procedure, securing the scope | Review complete |
| M0.5 | Compare native API and legacy API on conformance, TS 5.x compatibility, startup and distribution, and initial and update performance | Publish the evidence for 3.5, and adopt a default backend and a support range. Do not rest on unverified speedups. Being before the first public release, it was recorded directly in this file rather than in an RFC, per §9 (§3.5 "Default backend (decided)"; measurements in `docs/status.md`) |
| M1 | JSDoc, effect propagation, unknown, coverage, JSON diagnostics, init, the shared checker, the resident and update paths | Dogfooding on Ambit itself. Diagnostics updated even when only contract comments changed. The schema and the performance measurement conditions settled |
| M2 | Entry-point capabilities / budget, fetch / fs / child_process / DB and LLM hooks, Express / Hono / Next.js adapters | Conformance trials for the planned targets, mapping contracts to handlers, 50 standard stub packages. Publish what is and is not actually supported |
| M3 | Concrete fix patches, the ambit agent protocol | Connected to one external agent. Analysis failures and contract loosening during iteration distinguished |
| M4 | Editor integration, ambit sbom, npm distribution | Editor compatibility with the chosen compiler confirmed. One pilot team |
| M5 | Phase 1 exit criteria met | Success metrics and check performance published |

The preliminary evaluation in appendix A is part of M0.5, not its completion. M0.5 proper was settled in §3.5 "Default backend (decided)", and the measurements are in `docs/status.md`. The numbers in appendix A.2 have been **superseded**: a comparison including the native side, which could not be measured there, is in `docs/status.md`, and A.2 remains as the record of the time.

The actual order of work differs from this table: M1 (the first vertical slice, as far as §4.2's propagation rules and §5.1's NDJSON diagnostics working) has been put ahead of M0.5 (the backend comparison). The reason is that the connection-layer isolation of §3.4 lets contract analysis proceed independently of the backend, and that in solo development running two tracks in parallel is what costs the most efficiency. The definitions of the milestones themselves are unchanged.

## 12. Open Questions

- **Stability of the native API**: resolved for now by §3.5 "Default backend (decided)" — since it is not adopted, there is no obligation to track it. What remains is watching the conditions for revisiting. All 12 subpaths of distributed version 7.0.2's entry points are published under `unstable/*` (`unstable/sync`, `unstable/ast`, …), and daily dev builds go out on `next` behind `latest`. The client and the engine are tied together by an exact-match `optionalDependencies` specification, so the package manager prevents version skew between them. Re-evaluate once §3.5's condition for revisiting (the `unstable` name coming off) is met.
- **Startup and performance of the native version**: resolved. The halt in appendix A.2 was environment-specific; it starts on macOS (darwin/arm64). A speed and memory comparison under identical conditions was carried out, and the results are in the M0.5 section of `docs/status.md`. What remains is the second of §3.5's conditions for revisiting — re-running gates 3 and 4 after implementing §6.2's resident path — which is M1 work.
- **TypeScript version compatibility**: what §3.5 decided is **which one is the default**, not that only one backend will ever be supported. Two things are undecided. (1) How far 6.0.3 can read a TS 7-side tsconfig — as the table in §3.5 shows, 6.0.3 rejects with TS5023 a tsconfig containing `deduplicatePackages`, which only 7.0.2 accepts, so under that configuration `ambit check` does not even start. Whether to detect this and turn it into a diagnostic is undecided. (2) Whether to carry a second backend as a product. This question only acquires meaning once §3.5's conditions for revisiting are met, and there is no reason to ask it now.
- **The rule for tracking the analysis engine's version**: alongside §3.5's decision, the version was defined as "the latest stable release of the JS-implementation line that leaves the counts of `pnpm test` / `tsc --noEmit` / `biome ci` / `check src` and `check realistic-api` unchanged" (measured at 6.0.3; every count unchanged). When to re-evaluate this rule is undecided. Whether a deadline of the same shape as Node.js's "deadline for tracking the baseline runtime's LTS" should be set is undecided.
- **Indirect calls in frameworks**: the call paths of Express, NestJS's DI, Next.js, Hono and the like. How far dedicated stubs and entry-point declarations can absorb them is verified in M1.
- **Type assertions and non-null assertions**: `as any` and `!` are not treated identically. Settle the rule for when the type survives but the contract-level callee is not determined.
- **`pure` and accessors**: modification of external state and arguments was settled as `state_write` in §4.2 "Local mutation and `pure`". What remains is accessors: how far a property reference `o.x` — which can trigger a getter and run arbitrary code — should be treated as a call is undecided. Success in obtaining type API information is not a proof of purity.
- **Coverage and fragility of runtime hooks**: the applicable range of each approach (`diagnostics_channel` audits only and cannot block, loader hooks do not exceed monkeypatching's range, `pg` uses client wrapping), the difference in coverage caused by ESM and initialization order, and the target formats for `node:fs` / `node:child_process` / `pg` were settled in §4.4 "The approach to runtime hooks (decided)". What remains is (1) by what approach to add the unhooked `mysql2`, `@prisma/client`, `drizzle-orm`, `mongodb`, and LLM SDKs — for Prisma, because `$extends` cannot express a restore, the approach itself is undecided. (2) Tracking library updates: there is no mechanism for detecting that a replacement point (`Pool.prototype.query` and the like) changed upstream, and at present the supported versions are merely written in `docs/limitations.md`. (3) The installation procedure for each `worker_threads` worker and for child processes.
- **Mapping contracts to handlers**: the approach (explicit registration), how contracts arrive through builds that drop comments and after bundling, and the treatment of handlers whose contract cannot be found (`runtime.unscoped`) were settled in §4.4 "Mapping contracts to handlers (decided)", and the reconsideration of keying on `method + path` was settled in the same section's "Reconsidered: an HTTP key" (explicit registration unchanged). (1) The double declaration (JSDoc and `spec`) was settled in §4.4 "Removing the double declaration (decided: 2026-09-10)", in the direction of reading a literal `spec` as the declaration; a transform injecting wrappers from JSDoc is not taken. What remains is (2) the registration procedure for execution paths with no adapter (BullMQ, `worker_threads`, CLI entry points). Next.js was closed by `ambit/runtime/next`'s `ambitRoute` (App Router Route Handlers on the Node.js runtime only; Server Actions, `middleware.ts`, the Pages Router, and the edge runtime are out of scope and continue to have no adapter). (3) How the agreement check should handle a registration whose `spec` and handler are in different files or modules (currently excluded from comparison via `AMB-W004`).
- **Edge runtimes**: Phase 1 guarantees Node.js only. For anything else, state explicitly whether runtime enforcement exists.
- **Precision of budget blocking**: settle the guaranteed range for price-table updates, reserving limits, parallel calls, reconciling actuals, work that does not support cancellation, and calls for which no estimated upper bound can be obtained.
- **`unknown` fatigue**: in addition to per-directory strict, confirm the total volume of warnings and the measurement denominator in practice.
- **Abuse of boundary and contract loosening**: are `reason` and coverage enough? Consider how to connect JSDoc / config / stubs changes made outside the agent to an approval in protected CI. `ambit diff` (§6) has taken care of **detecting** loosening, but there is no **approval**. Because a PR that legitimately increases authority cannot pass the gate, diff remains non-gating in CI (`docs/status.md`). Which of an allowlist, a pinned baseline, or "this increase is approved" to take is undecided.
- **JSDoc limits and symbol identification**: the declaration-path notation for get/set accessors (`Class.get name` / `Class.set name`) and anonymous default exports (`default`), and config's ability to name them, were settled in §4.1 "Out-of-code declarations" (a). Two things remain. (1) Notation for object-literal members with no identifier name (computed, string, or numeric keys), and for names that can collide with the declaration path's joiner `"."`. These still cannot be named even in config, and remain in AMB-E003 and in `--coverage`'s skipped. (2) Whether to resolve the asymmetry §4.1(a) left — that JSDoc can syntactically be written on getters and anonymous default exports with a declaration path, yet is not adopted. Resolving it requires first deciding how to fix JSDoc's attribution uniquely.
- **Gaps in entry-point granularity**: per-function capabilities within a single request are statically checked only, by default. Confirm this trade-off in the pilot.
- **Monorepos**: verify multiple tsconfigs, project references, config discovery, unknown at project boundaries, and update propagation.
- **Editor integration**: do not assume the legacy Language Service Plugin is compatible on the native version. Confirm the LSP connection, diagnostic integration, and reuse of the same analysis results.
- **Fix candidates and the diagnostic schema**: settle the representation for when a concrete patch cannot be generated safely, when a type diagnostic carries no contract information, and for analysis failures.
- **Separating the build compiler from the analysis engine**: §3.1 states that the target language's compatibility, the build compiler, and the analysis engine's version are managed separately, but in the implementation (`package.json`) a single `typescript` serves both `tsc --noEmit` (the build) and `legacy-ts.ts` (the comparison analysis backend; see appendix A.1). Because `legacy-ts.ts` passes `ts.version` straight into a diagnostic's `engine.version`, updating only the build tsc can silently change the engine string in diagnostics. In M0.5, separation by a second alias was **rejected on measurement**: `typescript@7` also declares `bin: { tsc }`, so installing it under an alias still takes `node_modules/.bin/tsc` and `pnpm exec tsc` silently becomes a different compiler (`docs/status.md`, M0.5 gate 5). If separation becomes necessary, take a different route than an alias (the `.m05-native/` approach, or splitting packages).
- **The deadline for tracking the baseline runtime's LTS**: §3.1's baseline runtime is a single Active LTS (Node.js 24 as of 2026-09), and lines that are in maintenance or unverified are not declared in `engines`. Node.js 24 moves to Maintenance LTS on 2026-10-20, and Node.js 26 becomes Active LTS on 2026-10-28 ([Node.js Release Schedule](https://github.com/nodejs/Release)). By that date, either complete verification on Node.js 26 (a §3.5-level conformance check is not required, but confirming that the tests and CI pass is) together with the move of `engines` / `@types/node` / CI, or explicitly decide anew to keep 24 as the baseline while it is in Maintenance LTS. Left alone, the policy that "the baseline runtime is the Active LTS" simply stops holding.

## Appendix A. Record of the M0.5 Preliminary Evaluation

### A.1 Environment and artifacts examined

| Item | Value |
|---|---|
| Node.js | v24.19.0 |
| Native TypeScript | npm `typescript` 7.0.2 |
| Legacy TypeScript | 5.9.3 (installed under a comparison alias) |
| Oxc | `oxc-parser` 0.148.0 |
| Target | Synthetic code. No real project was provided |

The distributed version's type definitions and implementation have entry points for types, symbols, call signatures, JSDoc, post-change snapshots, and communication measurement. **This is confirmation that the API exists, not completed confirmation that it works on the native version.**

### A.2 Measurements and limits

On the legacy API, 102 files and 2,009 calls were measured 5 times sequentially, each in an independent Node process.

| Scope | Median |
|---|---:|
| Compiler import and Program construction | 708.9 ms |
| Type diagnostic retrieval | 125.8 ms |
| Extracting types, signatures, contracts and so on for all calls | 92.6 ms |
| All of the above | 953.5 ms |
| Program update after a contract-comment change and re-query of 9 calls | 21.5 ms |
| Peak RSS of the Node process | 247.7 MiB |

- Fixture generation and Node's own startup are not included in the initial measurement above. The OS file cache was not cooled.
- Since each stage's median is computed independently, their sum does not match the median of the total.
- The measurement after the comment change is a partial re-query. It is not an incremental check speed including Ambit's effect propagation and a full diagnostic update.
- The 9 cases include aliased imports, generics, overloads, callbacks, any, non-null assertions, unions, Unicode positions, and recursion. The assertions in the script succeeded on all 5 runs. This does not demonstrate conformance across all language features, nor an `unknown` rate.
- The Go engine could not obtain `/proc/self/exe` and halted before initialization. The same path's ENOENT was confirmed with Node's readlink too. **The comparison of the native version's speed, memory, and API behavior is incomplete.** This is not evidence that it does not work on Linux generally. — **Added 2026-09-09**: this halt was environment-specific. The same distributed version 7.0.2 starts on macOS (darwin/arm64), and the comparison of API conformance, correctness of updates, speed, and memory was completed (the M0.5 section of `docs/status.md`). It has not been re-confirmed on Linux.
- Oxc succeeded in parsing small TS functions and comments. Type analysis, contract checking, and speed comparison were not carried out.

### A.3 References

- [TypeScript API source](https://github.com/microsoft/TypeScript/tree/main/packages/typescript/src/api)
- [Implementation of the synchronous API](https://github.com/microsoft/TypeScript/blob/main/packages/typescript/src/api/sync/api.ts)
- [The former development repository for the native TypeScript port](https://github.com/microsoft/typescript-go)
- [Oxlint's type-aware checks](https://oxc.rs/docs/guide/usage/linter/type-aware.html)
- [tsgolint's shim generation](https://github.com/oxc-project/tsgolint/blob/main/tools/gen_shims/main.go)
- [The Oxc parser](https://oxc.rs/docs/guide/usage/parser.html)
- [Node.js release list](https://nodejs.org/en/about/previous-releases)
- [Constraints of the Node.js Permission Model](https://nodejs.org/download/release/v25.6.1/docs/api/permissions.html)

Do not equate the web's main branch with the pinned distributed version's API. The direct API confirmation in this preliminary evaluation was done against distributed version 7.0.2.
