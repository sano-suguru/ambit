# Ambit Design Specification

- Status: Draft
- Revision: 4 (Draft) — chapter 9 gained the trigger that puts the RFC procedure in force (§9.1), the guaranteed surface (§9.2), and the versioning rule (§9.3); §5.2's `id` permanence now says from which version it holds
- Intended readers: developers of Ambit itself, contributors, design reviewers
- Change procedure: direct edit plus a record in `docs/adr/` until chapter 9's trigger; RFC (under `rfcs/`) from there on — see §9.1
- What this file is: the current design, and the limits of what it guarantees. **Why** a design is the one written here is in [`docs/adr/`](adr/README.md); what is implemented today is in `docs/status.md`; where the project is going is in `ROADMAP.md`

---

## 1. Purpose

In an environment where AI agents generate code faster than humans can review it, provide a foundation for **mechanically detecting and blocking contract violations in generated code**, without replacing TypeScript.

Ambit provides three things.

1. **A contract layer** — attach side effects (effects), permissions (capabilities), and budget (budget) to existing code as declarations, and enforce them with static and runtime checks.
2. **Structured diagnostics** — return check results not only for humans but in a machine-readable form that AI agents can consume.
3. **An agent-integrated toolchain** — make generate → check → fix → run → deploy a single loop.

Which of these Ambit promises not to change without announcing it, and which it explicitly does not promise, is §9.2.

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
| Adopted analysis backend | The JS-implemented TypeScript Compiler API (`ts.createProgram` + type checker). Adopted as the default in §3.5. The version tracks the latest stable release of the JS-implementation line (6.0.3 as of 2026-09) |
| Ambit-specific static analysis | Function summaries, call relationships, fixed-point computation of side effects, capability comparison, diagnostics, and fix candidates are to be implemented in TypeScript |
| Editor integration | Uses the same checker as the CLI. Choose among a Language Service Plugin, an LSP connection, or a thin editor extension after verifying fit |
| Runtime library | `ambit-ts/runtime`. Implemented in TypeScript and run as JavaScript. Entry-point context, `AsyncLocalStorage`, audit hooks, optional `contract()` |
| Development and distribution | pnpm. Distributed as one npm package, `ambit-ts` (§6). During development there is no build: `.ts` runs directly under Node 24's type stripping, and `tsc --noEmit` is for type checking only. The test runner is Vitest (changed from node:test); the linter and formatter is Biome. Conformance tests, GitHub Actions, npm |
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

### 3.4 Separating the analysis backend

Processing is split into the following responsibilities.

| Layer | Responsibility | Constraint |
|---|---|---|
| Compiler connection | Loading the project, and obtaining ASTs, positions, types, symbols, call signatures, and compiler diagnostics | The only layer permitted to import a compiler |
| Ambit's analysis representation | Representing contracts, function summaries, callee candidates, unresolved reasons, and evidence positions | Do not expose compiler-specific objects to external diagnostics or persisted formats |
| Contract analysis | Effect propagation, capability checks, coverage, impact range, fix candidates | Shared by the CLI and the editor |
| Presentation and control | Output for the CLI, editors, agents, and CI | Display or forward common diagnostics to each use |
| Runtime enforcement | Capability matching, budget measurement, blocking of supported operations | Independent of the compiler. Do not make the analysis engine a production dependency |

Two rules hold for any backend put behind this layer.

- **Do not convert a failure to start, an unsupported setting, or an analysis failure into "no violations".** State explicitly what could not be analyzed and what failed, and return an exit code by which CI can tell a failure apart.
- **Do not switch backends without notice.** Give diagnostics, coverage, and performance records information that identifies the analysis engine and its version. The output schema is versioned in chapter 5.

What a second backend would additionally have to satisfy, and why the native TypeScript engine is not one today, is [ADR-0001](adr/0001-analysis-backend.md).

### 3.5 The default backend, and the gates it was chosen by

**The default is the JS-implemented TypeScript Compiler API** (`typescript` 6.0.3, `src/checker/backend/legacy-ts.ts`). Native TypeScript — the Go implementation — is not adopted. The decision, its reasons, and the price it carries are [ADR-0001](adr/0001-analysis-backend.md); the measurements are in the M0.5 section of `docs/status.md`. Changing the default requires an RFC (§9).

**The conditions for revisiting the decision**, written down in advance:

- The `unstable` name comes off the native API, so that the cost of writing a second backend stops being the cost of betting on an unstable API.
- The resident check path of §6.2 is implemented. The native implementation's real advantage is not the initial check but re-querying (after a one-file change, 1.0–1.9 ms native against 214–272 ms for the JS implementation). With no resident path in existence, that difference shows up nowhere in the product. Re-run gates 3 and 4 once it is implemented.
- The JS-implementation line stops producing stable releases. This decision depends on the versioning rule of "track the latest stable release of the JS-implementation line" (§3.1, `AGENTS.md`), and if there is nothing left to track, the premise behind gate 5's maintenance cost collapses.

**The gates any backend is judged by.** These are not history: a re-evaluation runs against the same five.

1. **API conformance**: run a conformance test covering aliased imports / re-exports, generics, overloads, callbacks, unions, `any`, recursion, JSDoc, and Unicode positions. Distinguish having type information from having the implementation determined.
2. **Compatibility with existing code**: compare representative TS 5.x code and tsconfigs. Record unsupported settings and type-diagnostic differences, and do not hide the migration they require.
3. **Correctness of updates**: change function bodies, contract comments, exports, settings, and stubs individually, and confirm that the dependent contracts and diagnostics are updated.
4. **Performance**: with the same code, contract checks, diagnostic results, and coverage, measure initial and post-change time, memory including child processes, and communication volume. Do not compare parse-only speed against a check that includes type analysis.
5. **Distribution and maintenance**: verify target OS / CPU, startup, npm distribution, and the burden of tracking API updates.

Conformance, compatibility, and correctness of updates (gates 1–3) have no allowance. They either pass or they do not, and are not traded against speed. Do not assign performance numbers to a backend that has not been run. If a gate cannot be passed, state explicitly that the default remains undecided rather than picking a winner.

#### Allowances (set before any comparison)

The numbers are decided before a comparison begins. If you measure first and then pick a value that passes, the gate drops nothing. The basis is the agent loop of chapter 7, in which one iteration runs `ambit check` once.

| Item | Allowance | Rationale |
|---|---|---|
| Initial-check latency (30-file scale) | within 3 seconds | In one generate → check → fix iteration, the check must not be the dominant wait |
| Initial-check latency (300-file scale) | within 10 seconds | Same. Must not degrade worse than linearly in file count |
| Backend re-query after a one-file change | within 500 milliseconds | The premise on which 6.2's resident path holds. Beyond this, latency remains even after going resident |
| Memory (peak RSS summed over parent and child processes, 300-file scale) | within 1 GiB | A standard CI execution environment, and the ability to coexist with an editor |
| Communication volume (one check in a process-separated configuration) | Must not be the dominant factor in latency. Transfer time must not exceed 50% of the total | The line for deciding 3.4's "communication and transfer become the dominant factor in measurements" |

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

**Where declarations live**

Which contract goes where is decided by exactly one question: **does it have to reach runtime?** ([ADR-0002](adr/0002-where-declarations-live.md))

| Contract | Does the runtime read it | Where it lives |
|---|---|---|
| `@effects` | No (static propagation only) | JSDoc |
| `@entrypoint` / `@boundary` | No | JSDoc |
| `capabilities` | The hooks match against it | `spec`, if runtime enforcement is in place |
| `budget` | `timeMs` is measured and blocks | Same |

An entry point with no runtime enforcement has no `spec`, so its `@capabilities` / `@budget` are written in JSDoc (or config). That does not change. "The JSDoc tag becomes optional" holds only where a `spec` can supply the declaration; it does not mean "there need be no contract".

Merging is per tag, in the priority order JSDoc > config > `spec`.

**Out-of-code declarations**

Where the code cannot be touched (third-party code, generated code, early adoption), the same contracts can be declared in `ambit.config.ts` by naming the symbol ([ADR-0003](adr/0003-out-of-code-declarations.md)).

```ts
import { defineConfig } from "ambit-ts/config";

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

**Overloads and bodyless declarations**

An overload set is **one declaration site**, and that site is the implementation. A signature is a type, not code that runs. Therefore:

- A signature (`function f(x: string): string;`), an `abstract` member, and a `declare function` inside a `.ts` file are none of them declaration sites for a contract. `--coverage` counts them as `bodyless-declaration`.
- A contract tag written there is not adopted, and is reported as AMB-E003.
- Calls resolve to the implementation. A call into a set with no implementation (a `declare` with no body in the project) is `unknown` (`overload-without-body`).

This rule is a termination requirement as well as a notation: the declaration path and the function the backend returns must be one to one, or the fixed-point iteration of §4.2 rule 7 does not converge.

**(a) Notation of the `symbol` part, and which declaration sites can be named**

`symbol` is the checker's internal declaration path itself (joined with `"."`: `Class.method`, `obj.member`, `Class.constructor`), and config can name that set plus the following two kinds.

- Accessors: `Class.get total` / `Class.set total`
- Anonymous default exports: `default`

These two kinds have a declaration path, but **writing JSDoc on them is still not adopted** (still AMB-E003). Members with computed, string, or numeric keys cannot be named even in config.

**The honest limit here**: config's namespace being wider than JSDoc's leaves the asymmetry that "JSDoc can syntactically be written at this position, yet is not adopted". This is not a distinction derived from principle; it is the result of deciding only the config side of §12's open item first.

**(b) Globs in the `file` part, and the priority when several entries hit the same symbol**

The `file` part interprets `*` (any string not crossing `/`) and `**` (zero or more directory levels). The `symbol` part is not globbed.

- A key containing no glob characters (an exact match) always wins over a key containing a glob.
- If two or more glob keys hit the same symbol, both keys are listed and the run stops with exit 2. Ambiguity between globs is a configuration error, not something resolved by written order or by a specificity rule.

**(c) The formats read, and the search origin**

- Formats: `ambit.config.ts` / `ambit.config.mts` / `ambit.config.js` / `ambit.config.mjs`. They are looked for in this order and only the first one found is used. If several exist in the same directory, the rest are not read.
- Search origin: from the `<dir>` of `check <dir>` / `init <dir>` upward through parents, using the first one found. cwd is not consulted. The walk stops once it has examined a directory holding a `package.json` or a `.git` — so that a config outside the project is not silently picked up.
- The `file` part of `contracts` keys and the patterns in `strict` are resolved **relative to the directory holding the config file**, so that the same config points at the same symbols under both `ambit check src` and `ambit check .`.

**(d) How user-defined effects appear in diagnostics**

`effects: { payments: ["network", "db_write"] }` is **expanded into standard effects at parse time**. Only expanded standard effect names appear in a diagnostic's `contract.declared` / `contract.observed`. User-defined names exist only on the input side, in config and JSDoc.

The value of a definition may only be standard effect names; defined names are not expanded recursively. If a defined name collides with a standard effect name, exit 2.

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

**Local mutation and `pure`**

`pure` **permits mutation of values created inside the function**. Only mutation of a value reachable from outside the function is treated as `state_write`, and if it exceeds the declaration it becomes a violation under propagation rule 1 ([ADR-0004](adr/0004-local-mutation-and-pure.md)).

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

`ambit-ts/runtime` pushes the capability set onto `AsyncLocalStorage` at the moment an entry point is entered. Supported operations from then on are matched against that set. `AsyncLocalStorage` is responsible for holding the context; the blocking itself is implemented by the adapter.

The following ways of establishing the context are provided.

- A framework adapter (`ambit-ts/runtime/hono` and so on) wraps the handler at each route registration. It maps the declaration to the actual handler and pushes the context at run time. It is not one middleware inserted for the whole application: contracts differ per route, and placing `spec` and the handler in the same call is the premise of the agreement check below.
- Where there is no adapter, insert `withAmbit(spec, handler)` by hand.

The capability set need be written in one place only. A literal array in a `withAmbit` wrapping a handler declared in the same file *is* that handler's `@capabilities` declaration ("Removing the double declaration" below). Only when it is also written in JSDoc does the checker check **agreement at the source level**: under the same conditions as reading a declaration (a literal array, and a `handler` naming a declaration in the same file), it compares the two as sets and errors if they disagree. A dynamically assembled array and a handler in another file can be read neither as a declaration nor for comparison, so they are made visible with a warning (they are not passed silently). The same rule applies to adapter registration.

**Mapping contracts to handlers**

A contract reaches the runtime as a **value inside the module**: `withAmbit(spec, handler)`, or an adapter's `ambitHandler(spec, handler, decode)` / `ambitRoute(spec, handler, decode)`. Nothing is generated, nothing is read from JSDoc at run time, and the runtime refers to neither symbol IDs, file paths, nor function names — so a contract survives a build that drops comments, and bundling and minification ([ADR-0005](adr/0005-mapping-contracts-to-handlers.md); keying on an HTTP route path instead was reconsidered and rejected in [ADR-0007](adr/0007-http-route-keys.md)).

The third parameter `decode` builds the handler's arguments from the framework's `Context`. It is separate so that framework-dependent calls stay inside the registration expression and the handler that declared the contract stays statically analyzable. `decode` runs **inside** the context: reading the request body counts toward `timeMs` as well.

The runtime overhead — one context and one `decode` — is **unmeasured**.

**Removing the double declaration**

When a `spec` fixes `capabilities` / `budget` as literals and `handler` is an identifier naming a declaration in the same file, that value **is read as that handler's own `@capabilities` / `@budget` declaration**. There is no need to write the same content again in JSDoc. `@effects` and `@entrypoint` stay in JSDoc (§4.1 "Where declarations live"; [ADR-0002](adr/0002-where-declarations-live.md)).

The agreement check (`AMB-E010` / `AMB-E011`) **stays. Neither its meaning nor its severity changes.** If both are written and they disagree, it is an error. What changed is only that "the JSDoc side may be absent", not that "disagreement is allowed". This is why `spec` is placed last in the merge: if JSDoc or config declares something, that takes effect, and `spec` is compared against that declaration.

`spec.budget` and `@budget` are treated the same way: if `spec.budget` is a literal object and each value is a literal, that is the declaration. If `@budget` is also written, they are compared, and if any of `timeMs` / `costUsd` / `llmCalls` / `onExceed` disagrees it is `AMB-E011`; a limit present on only one side is also treated as a disagreement. `onExceed` is compared after aligning both sides to the default `throw`. The two halves are judged independently: a `spec` may write one half as a literal and assemble the other at run time, and only the half that could not be compared is made visible with `AMB-W004`.

**The range this does not reach**, where JSDoc is required: when `spec` is not a literal, and when `handler` is a declaration in another file (§12 (2)). Both are made visible with `AMB-W004`, whose message states that "an unreadable `spec` declares nothing; here the handler's own `@capabilities` / `@budget` is the only declaration". If the entry point still has no declaration, `AMB-W002` is emitted alongside. It is never silently made `unknown`.

**The check this gives up**, stated explicitly: in the era of writing it twice, an edit that widened only `spec` was caught by `AMB-E010` as "the pair disagrees". Once the declaration is in one place there is no pair, so that way of catching it is gone. This is not a reduction in the guaranteed surface — `AMB-E010` / `AMB-E011` never caught capability expansion itself, only disagreement between duplicates, and an edit widening both sides at once always passed silently. A declaration written in `spec` shows up in the diff like every other Ambit contract, is bound from its callers by the narrowing rule above (`AMB-E005`), and its literal targets are checked by `AMB-E009`.

**Handlers whose contract cannot be found**

A handler registered without going through an adapter (writing `app.get(path, handler)` directly) pushes no context. Supported operations inside such a handler are decided by `runtime.unscoped` (`allow` default / `warn` / `deny`). The adapter **does not push a context with an empty capability set** for a handler whose contract cannot be found: the empty set is a total denial, and it would make the accident of a missing registration indistinguishable from a policy decision. Since the adapter's registration API requires `spec`, the state of "registered via the adapter but with no contract" cannot be created.

**How denial is conveyed**

`AmbitCapabilityError` / `AmbitBudgetError` are not translated by the adapter into an HTTP status; they are thrown to the framework's error handler as they are. 403 means "the client lacks permission", whereas what actually happened is "the server's code exceeded its own grant", which is a different thing ([ADR-0005](adr/0005-mapping-contracts-to-handlers.md)).

**The approach to runtime hooks**

What each hook covers, and what it does not. The rationale for each choice is [ADR-0006](adr/0006-runtime-hook-approach.md). Measurements were on Node.js v24.19.0 / macOS (darwin arm64); anything not measured is marked "unmeasured".

**(a) What is hooked, and what each hook can do**

| Target | Approach | Blocks | Audits |
|---|---|---|---|
| `globalThis.fetch` | monkeypatch (`installFetchHook`) | yes | yes |
| `node:fs` / `node:fs/promises` | monkeypatch (`installFsHook`) | yes | yes |
| `node:child_process` | monkeypatch (`installChildProcessHook`) | yes | yes |
| `pg` | client wrapping (`installPgHook(pg)`) | yes | yes |
| `mysql2`, `@prisma/client`, `drizzle-orm`, `mongodb`, LLM SDKs (`openai`, `@anthropic-ai/sdk`, `ai`) | no hook | no | no |

A row marked "no hook" has static effects but nothing intercepting it at run time: calling it is neither blocked nor recorded. The performance impact of going through a replaced function is **unmeasured**.

Installation modes and what they cover (`node:fs` / `node:child_process`):

| Installation | Calls covered | Calls not covered |
|---|---|---|
| Preload (running `install*Hook()` ahead of the application's module graph via `node --import` / `--require`) | `import { readFileSync } from "node:fs"`, `import fs from "node:fs"; fs.readFileSync()`, `require("fs").readFileSync()` | Only the common exclusions below |
| In-graph (calling `install*Hook()` at the top of the entry module) | `fs.readFileSync()` (via the default export's or `require`'s properties) | Already-bound named imports `import { readFileSync } from "node:fs"`, and `import * as fs from "node:fs"` |

Not covered under either installation: paths where `node:fs`'s internals call without going through the public API, native addons, inside child processes, and other workers of `worker_threads` (the hook must be installed per worker).

How denial is conveyed follows the shape of the API: synchronous APIs `throw`, callback APIs use `process.nextTick(callback, error)`, and Promise APIs reject. `existsSync` throws on denial rather than returning `false` — "does not exist" and "must not look" are different answers, and returning `false` would turn the latter into the former.

Node.js's own module loader reads files with the public `fs.readFileSync` (measured). After `installFsHook()`, therefore, `require()` and dynamic `import()` also go through the hook. Performing a lazy load while `runtime.unscoped` is `deny`, or inside a context that does not hold `fs:read`, gets that load denied. This is behavior as specified, and is documented in `docs/limitations.md` as part of the installation procedure.

**(b) The target format for `node:fs` and `node:child_process`**

The target is the **absolute path resolved at call time**: `fs:read:<glob over an absolute path>`, `fs:write:<glob over an absolute path>`, `proc:spawn:<command>`. What is visible at call time is the resolved path, and that is the only form that can be matched against a grant.

- Path arguments are normalized at call time: `Buffer` via `toString()`, `file:` URLs via `fileURLToPath`, and relative paths via `path.resolve` against `process.cwd()` at the time of the call.
- Globs may be written only on the granting side. `*` crosses `/` (the existing meaning of `globMatches` is used as is). `fs:read:/srv/app/*` also matches `/srv/app/a/b.txt`. There is no way to write a grant covering exactly one directory level.
- Operations taking an fd (`fs.readSync(fd)`, `FileHandle.read`) have no path by the time the fd exists. Read versus write is decided from the flags and matched at `open` / `openSync` / `promises.open`. `createReadStream` / `createWriteStream` go through `fs.open`, so they are caught at the same entry point (measured).
- Operations taking two paths (`rename`, `copyFile`, `link`) require `fs:write` on the destination and `fs:read` on the source.
- `proc:spawn:<command>`: `spawn` / `execFile` and their `Sync` variants take argv[0] **as written** (no PATH resolution) as the target. `fork` uses `process.execPath`. For the shell forms (`exec`, `execSync`, `shell: true`), the program actually launched is inside the shell string and is not determined without a shell parser, so the target is **the shell itself** (`options.shell` if it is a string, otherwise `/bin/sh`). The exception message says "a shell was launched / a permitted shell can run an arbitrary program". The first word of the shell string is not claimed as "the real command". This is for the same reason as not reading table names out of arbitrary SQL; the location changes but the claim does not.
- The character set for a target segment is widened to "anything but a comma (the `@capabilities` separator) and control characters". Paths contain spaces, `+`, `~` and `%`. This relaxation can only act in the closing direction: a mistyped tag becomes "a target that matches nothing", and shows up as a denial.

The cost of normalization (one `path.resolve`) is **unmeasured**.

**(c) DB client: `pg`**

`pg` is the one DB client with a hook; Prisma has none, because its extension point `$extends` returns a new client and no restore can be written against it ([ADR-0006](adr/0006-runtime-hook-approach.md)).

Operations and the capabilities they require:

| Operation | Capability required |
|---|---|
| `Pool.query(text, …)` / `Client.query(text, …)` where `text`'s leading keyword is `select` / `show` / `explain` / `describe` | `db:read:<database name>` |
| The same, where the leading keyword is `insert` / `update` / `delete` / `create` / `drop` and the like | `db:write:<database name>` |
| The same, where `text` is not a string, its leading keyword cannot be read, or a `Submittable` is passed | **both** `db:read:<…>` and `db:write:<…>` |
| The configuration-object form `query({ text })` | `text` is judged by the same rules as above |

- The direction is decided by the **same rules** as the static side (the SQL keyword table in `src/stubs/data-clients.ts`), which live in one place under `src/core/` so that the static check and the running process cannot disagree about the same statement.
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
import { contract } from "ambit-ts/runtime";

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

This is an artifact of the checker side and is never read at run time. What [ADR-0005](adr/0005-mapping-contracts-to-handlers.md)'s alternative 2 rejected was contract data **distributed to the runtime**, which this output is not. `ambit diff` (§6) computes the authority difference from these records alone.

`via` is a sequence of functions, and each element's position is that function's declaration position. The position of the operation that causes the effect (the line of `fetch(...)`) is held by `contract.operation`. This exists so that a reader can reach the operation's line from the diagnostic alone; the meaning of `via` is unchanged.

This example assumes that line 41, the target of the fix, is the 20 characters `/** @effects pure */`. The positions are illustrative; an actual patch is generated from the analyzed source file. Since no concrete patch that keeps the contract can be generated, only the loosening candidate is shown. A pseudo-patch containing the ellipses of the original specification is not emitted as an applicable fix.

### 5.2 Fields

| Field | Content |
|---|---|
| `id` | A stable diagnostic code. Never deleted or reused — **from 1.0**. While the major version is 0 an `id` may still be renumbered or reworded, and such a change is announced in `CHANGELOG.md` like any other change to the guaranteed surface (§9.2, §9.3). The ledger in [`docs/diagnostics/`](diagnostics/README.md) is what carries each code's current meaning either way |
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
- A file git reports as renamed between the two sides carries its symbols with it: the base side's ids are re-expressed under the new path before the comparison, so a moved function is compared against itself instead of appearing as a deletion plus a new symbol. Only git's own rename detection is used; no other guess about identity is made. What this does *not* cover is stated in §6.3.
- The comparison itself is a pure function taking the two sets of `kind: "authority"` records and the rename map, and touches git not at all (§6.1, "capability comparison").
- An increase must be approved to pass. The mechanism is §6.3.
- If analysis fails on either side, exit code 2. Not having been able to compare is not reported as "nothing increased" (§3.4).

Exit codes:

| What happened | Exit code |
|---|---|
| An existing symbol's authority increased, unapproved | 1 |
| A new symbol with authority appeared, unapproved | 1 |
| An increase carrying an approval added in this comparison (§6.3) | 0 (reported) |
| A function moved with a renamed file, gaining nothing | 0 (reported as moved) |
| Authority only decreased | 0 (reported) |
| A symbol only disappeared | 0 (reported) |
| A new symbol with no authority | 0 |
| `unknown` increased (authority did not) | 0 (reported) |
| An approval that grants nothing, or a ledger line that did not parse | 0 (reported) |
| Analysis failed on either side | 2 |

Reducing authority is not what this command watches for. Failing on a decrease would give the writer a reason not to touch contracts at all. `unknown` is not authority (§4.3) so it does not count as an increase, but it is reported.

- Distribution is one package, `ambit-ts`: `npm install -D ambit-ts` installs the CLI (`ambit`) and the runtime together. The supported OS / CPU and distribution conditions of any native binary are published.
- Production uses `ambit-ts/runtime` and the necessary adapters and contract data. The compiler and the development CLI are not to be required production dependencies. **The single package does not yet meet this**: `typescript` is a `dependencies` entry of `ambit-ts`, so a process that imports only `ambit-ts/runtime` still installs the compiler. What meets it is a separate runtime package; the decision is to keep the single package until there is a production adopter, and to split the runtime out at that point ([ADR-0009](adr/0009-package-name-and-single-package.md)).
- Editors obtain diagnostics and fix candidates from the same checker as the CLI. The chosen approach — Language Service Plugin, LSP, or a thin extension — is verified by M4.
- CI integrates via the exit code and the structured output. A dedicated CI plugin is not required. On GitHub Actions, the output of `ambit check --format github` becomes annotations directly (§5.1). Installing a dedicated Action or plugin is not demanded.
- A JSDoc declaration by itself does not change runtime behavior. The settings and steps needed to deliver contracts to the runtime are stated explicitly per framework.

### 6.1 Package responsibilities

| Responsibility area | Content |
|---|---|
| `src/core` | The contract model, analysis representation, capability comparison, diagnostic format. Does not depend on a compiler API |
| `src/checker` | Contract analysis using information from the connection layer, inference, coverage, fix candidates |
| `src/cli` | Commands, exit codes, structured output, control of iterative checking |
| `src/runtime` (`ambit-ts/runtime`) | Context, matching and blocking of supported operations, budget measurement, adapters |
| `src/stubs` | Contract definitions and trust information for external libraries |
| Editor connection | Connection to the shared checker. Whether it is a separate package, and the Plugin / LSP approach, are settled after verification |

The compiler connection layer is implemented separately from the checker, but whether it becomes an independently published npm package is undecided. Do not add public API that is not needed.

The table above is a separation of responsibilities, not a package list. It is expressed as directories inside the single `ambit-ts` package, and the subpath exports (`ambit-ts`, `ambit-ts/config`, `ambit-ts/runtime`, `ambit-ts/runtime/hono`, `ambit-ts/runtime/next`) are what a consumer sees of it. A later split of the runtime into a package of its own keeps those specifiers working by re-export, because a specifier is part of the guaranteed surface: changing one is a breaking change and is announced as such (§9.2).

### 6.2 Iterative checking and caching

For agents and editors, design a resident check path that holds the analysis engine's state together with Ambit's function summaries and dependency information. One-shot `ambit check` is retained as well. The startup and connection method and the CLI option names are settled in M1.

- Rather than only the changed files, walk the contract dependencies backwards and re-check the callers affected.
- Update ranges containing recursion to a fixed point.
- Include changes to JSDoc, out-of-code contracts, stubs, tsconfig, dependency resolution, and the analysis engine version among the invalidation conditions.
- Do not ignore a change to contract comments alone, even when the compiler's type information is unchanged.
- Do not carry snapshot-specific types and symbol IDs across an update. Maintain a correspondence to files, declaration paths, and the like.
- Measure initial analysis, type-information retrieval, contract analysis, transfer, and diagnostic output separately, to make clear where the latency comes from.

### 6.3 Approving an authority increase

`ambit diff` (§6) detects that authority grew. Detection alone cannot gate a
pull request: a change that legitimately adds authority has to be able to say
so, or the gate blocks honest work and is switched off. What follows is how it
says so.

Any approval mechanism has to meet four criteria. They are recorded here rather
than only in the record of the decision, so that a later reconsideration has
something in the specification to test itself against:

1. **The approval is a reviewable record in the repository.** Ambit's claim is
   that a human reviews an increase, so a mechanism whose record lives in a CI
   provider's state — a label, a re-run, an environment approval — leaves
   nothing in the tree and does not support the claim.
2. **A stale approval does not let an increase through.** An approval that has
   outlived what it was written for must fail, not pass quietly.
3. **Moving and renaming code is not taxed.** Increases that are artifacts of
   relocation must not be a standing cost, or the ledger becomes a file rewritten
   by every refactoring, which is a ritual rather than review.
4. **The apparent guarantee surface does not grow** (§2, P4). That an increase
   can be approved says nothing about whether the approver was right.

**The approval ledger.** A file named `ambit.approvals.md`, found by walking up
from the checked directory and stopping at the first directory holding a
`package.json` or `.git` — the same search `ambit.config.ts` uses (§4.1 (c)).

Approvals are the lines whose first non-space character is `-`, below a heading
whose text is `Approvals`; every other line is prose and is ignored, so the file
carries its own explanation and may use bullets in it. A file with no such
heading is read as approvals throughout. An approval line is:

```text
- `<symbol id>` `<authority>` — <reason>
```

The symbol id is as §5.3 defines it and as `ambit diff` prints it. The authority
is `effect:<name>` or `capability:<resource>:<action>:<target>`, matched as
**exact text**: an approval of `capability:http:get:*` does not cover
`capability:http:get:api.example.com`. Containment is how a *grant* relates to a
*requirement* (§4.4); an approval is neither, it is a record that one named
increase was looked at, and one line must not quietly cover a family of them.
The reason is free text and is required. `ambit diff` prints the line to add for
every increase it fails on, so the ledger is filled in by copying, not by
recalling the grammar.

A `-` line inside the approvals region that does not parse is reported with its
line number and grants nothing. It does not by itself change the exit code: the
increase it failed to approve is still unapproved, and that is what fails.

**An approval is valid only in the comparison that adds it.** The ledger is read
on *both* sides of the diff. For each `(symbol id, authority)` pair, the number
of approvals in force is the head side's count of that pair minus the base
side's; only that many increases of that pair can be approved. A line that is
already in the base grants nothing, forever.

Three properties follow, and they are how the rule meets criteria 1 and 2:

- The record of an approval is a line added to a file in the pull request that
  introduces the increase — reviewed by whoever reviews the diff, in the
  repository, not in a CI provider's state.
- An approval cannot go stale, because it cannot outlive its own comparison.
  Authority removed and later reintroduced needs a new line; the old one is
  spent.
- The ledger is append-only and never needs pruning. Because what counts is the
  *count* of a pair rather than its presence, re-approving the same pair later
  is appending a second identical line. Deleting lines is permitted and can only
  ever reduce what is approved, never grant.

**What an approval is not.** It records that a line was added alongside an
increase and shown in the diff. It does not establish that a human wrote it,
that the human was right, or that the increase is safe — Ambit cannot verify any
of the three, and does not claim to (P4). What makes a human necessary is the
repository's own branch protection: requiring review, and naming
`ambit.approvals.md` in `CODEOWNERS` so that changing it needs an approver. That
is outside Ambit, and stating it is part of the design rather than a gap in it.

The same holds for the shape of the check itself. `ambit diff` compares two
trees, so a change made outside the agent loop — hand-edited JSDoc, a rewritten
`ambit.config.ts`, an updated stub — reaches the gate exactly as an agent's
change does. §7's in-loop approval is an ergonomic step, not the enforcement
point; this is.

**What rename detection does not see.** §6 carries symbols across a file git
reports as renamed. Two cases remain, and both surface as an unapproved increase
that costs an approval line:

- A function renamed *within* a file. Git reports no rename, and matching two
  declaration paths inside one file would be a guess about identity — the guess
  that hides a function which gained authority on the way.
- A file whose rename git does not detect, because the move was accompanied by
  enough editing to fall under its similarity threshold, or because the new path
  is not yet tracked. Rename detection reads the index and the working tree
  against the base commit; an untracked new file has nothing to be similar to.

Both are over-reporting, never under-reporting, which is the direction §3.4
requires.


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

Approval enforced only inside the agent loop reaches only what the agent did. A contract, setting, or stub edited by hand reaches CI instead, where `ambit diff` compares the whole tree against the base ref and the approval ledger is what lets a legitimate increase through (§6.3).

## 8. Supply Chain

Stub trust levels, highest first: **bundled with Ambit > provided by the package author > community > automatically inferred.** The trust level is included in diagnostics, so that a contract read out of an inferred stub is never presented as one the package's author wrote.

The versions of the analysis engine are pinned and recorded alongside (§3.4), so that an analysis difference caused by an engine update is distinguishable from a contract difference in the user's dependency packages.

`ambit sbom` and dependency-update reporting are not implemented; the shape they are meant to take is in [`ROADMAP.md`](../ROADMAP.md).

## 9. Governance

- The specification, diagnostic codes, checker, runtime, and stubs are all open source.
- Proposal into `rfcs/` → review → adoption. Changes to the meaning of diagnostic codes, the standard effects, or the propagation rules require an RFC.
- Changing the default backend, or making a breaking change to the range of TypeScript supported, also requires an RFC.
- Decision rationale lives in [`docs/adr/`](adr/README.md), not in this file.
- Publish a conformance test suite (`conformance/`) and keep alternative implementations possible. Keep the connection trials against a type engine separate from trials of the contract model itself.
- Put the stewardship of the trademark and the specification in writing at an early stage. The npm name `ambit` and the scope `@ambit` were both already taken by unrelated owners, so the published name is `ambit-ts` ([ADR-0009](adr/0009-package-name-and-single-package.md)); the name is not described as reserved beyond that.

### 9.1 When the RFC procedure takes effect

The four changes listed above require an RFC **from 1.0, or from the first external adopter — the pilot team of [`ROADMAP.md`](../ROADMAP.md) M4 — whichever comes first.** `rfcs/` and `conformance/` are put in place on that same trigger.

Until then, a decision is made by editing this file directly and writing the record in [`docs/adr/`](adr/README.md), and the conformance tests are substituted by Vitest under `test/`. From the trigger onward, the accepted RFC is the record.

Publishing a tarball to npm is not the trigger. An RFC needs a second party; a registry entry with no dependent supplies none ([ADR-0010](adr/0010-when-governance-takes-effect.md)). This moves when the procedure starts, not which changes it covers.

§9.2 and §9.3 are what hold in the meantime, and they hold at every version.

### 9.2 The guaranteed surface

A breaking change is announced in `CHANGELOG.md`, at the release that makes it, for exactly this list:

- the meaning of the JSDoc tags — `@effects`, `@capabilities`, `@budget`, `@entrypoint`, `@boundary` (§4.1) — and of the standard effects (§4.2)
- diagnostic `id`s and what each one means ([`docs/diagnostics/`](diagnostics/README.md), §5.2)
- the NDJSON diagnostic field shape (§5.1, §5.2)
- the format of `ambit.approvals.md` (§6.3)
- the CLI's commands, flags, and exit codes (§6)
- the package's subpath exports — `ambit-ts`, `ambit-ts/config`, `ambit-ts/runtime`, `ambit-ts/runtime/hono`, `ambit-ts/runtime/next` — and the names exported from them (§6.1)

Not on the list, and free to change in any release:

- anything not reachable through those subpath exports, including every module path under `dist/` the export map does not name
- the measured `unknown` rate, and the resolution of the analysis behind it: which calls resolve, which fall to `unknown`, and the reasons `--coverage` breaks them down by
- added stubs (§4.2, §8) and added runtime hooks (§4.4). These are authority Ambit could not see before and now can, so a check that passed may begin to fail — because the code always did what the check now reports (P3, P4)
- whether anything is cached, and any resident or incremental path (§6.2)

### 9.3 Versioning

Semantic versioning, with 0.x read as semver defines it: **while the major version is 0, a minor release may make a breaking change to anything in §9.2's first list.** A patch release does not. §9.2's announcement obligation does not vary with the version number.

## 10. Success Metrics

Measured in Phase 1. The metrics, their targets, and the measurement conditions are in [`ROADMAP.md`](../ROADMAP.md).

The **Phase 1 exit criterion** is producing one team that can show "2× faster to production for AI-generated code, half the serious incidents". Support for other languages (§3.3) is considered only after that; speeding up analysis alone does not count as meeting it.

## 11. Milestones

M0 through M5 and the order they are actually being worked in are in [`ROADMAP.md`](../ROADMAP.md). M0.5 is settled: the decision is [ADR-0001](adr/0001-analysis-backend.md), the measurements are in the M0.5 section of `docs/status.md`.

## 12. Open Questions

What is still undecided. A question that has been answered leaves this list; the
answer is in the section that now specifies it, and the reasoning in
[`docs/adr/`](adr/README.md).

- **Conditions for revisiting the backend decision**: two of §3.5's three conditions are things to watch rather than to decide. All 12 subpaths of the native API's entry points are still published under `unstable/*`, and daily dev builds go out on `next` behind `latest`. The other is Ambit's own work: re-run gates 3 and 4 once §6.2's resident path exists (M1).
- **TypeScript version compatibility**: (1) How far 6.0.3 can read a TS 7-side tsconfig. It rejects with TS5023 a tsconfig containing `deduplicatePackages`, which only 7.0.2 accepts, so under that configuration `ambit check` does not even start; whether to detect this and turn it into a diagnostic is undecided. (2) Whether to carry a second backend as a product. This acquires meaning only once §3.5's conditions for revisiting are met.
- **The rule for tracking the analysis engine's version**: the version is "the latest stable release of the JS-implementation line that leaves the counts of `pnpm test` / `tsc --noEmit` / `biome ci` / `check src` and `check realistic-api` unchanged". When to re-evaluate that rule is undecided, as is whether it needs a deadline of the same shape as the baseline runtime's LTS below.
- **Indirect calls in frameworks**: the call paths of Express, NestJS's DI, Next.js, Hono and the like. How far dedicated stubs and entry-point declarations can absorb them is verified in M1.
- **Type assertions and non-null assertions**: `as any` and `!` are not treated identically. Settle the rule for when the type survives but the contract-level callee is not determined.
- **`pure` and accessors**: how far a property reference `o.x` — which can trigger a getter and run arbitrary code — should be treated as a call is undecided. Success in obtaining type API information is not a proof of purity.
- **Coverage and fragility of runtime hooks**: (1) by what approach to add the unhooked `mysql2`, `@prisma/client`, `drizzle-orm`, `mongodb`, and LLM SDKs — for Prisma, because `$extends` cannot express a restore, the approach itself is undecided. (2) Tracking library updates: there is no mechanism for detecting that a replacement point (`Pool.prototype.query` and the like) changed upstream, and at present the supported versions are merely written in `docs/limitations.md`. (3) The installation procedure for each `worker_threads` worker and for child processes.
- **Mapping contracts to handlers**: (1) the registration procedure for execution paths with no adapter (BullMQ, `worker_threads`, CLI entry points). (2) How the agreement check should handle a registration whose `spec` and handler are in different files or modules — currently excluded from comparison via `AMB-W004`.
- **Edge runtimes**: Phase 1 guarantees Node.js only. For anything else, state explicitly whether runtime enforcement exists.
- **Precision of budget blocking**: settle the guaranteed range for price-table updates, reserving limits, parallel calls, reconciling actuals, work that does not support cancellation, and calls for which no estimated upper bound can be obtained.
- **`unknown` fatigue**: in addition to per-directory strict, confirm the total volume of warnings and the measurement denominator in practice.
- **JSDoc limits and symbol identification**: (1) Notation for object-literal members with no identifier name (computed, string, or numeric keys), and for names that can collide with the declaration path's joiner `"."`. These cannot be named even in config, and remain in AMB-E003 and in `--coverage`'s skipped. (2) Whether to resolve the asymmetry §4.1(a) left — that JSDoc can syntactically be written on getters and anonymous default exports with a declaration path, yet is not adopted. Resolving it requires first deciding how to fix JSDoc's attribution uniquely.
- **Gaps in entry-point granularity**: per-function capabilities within a single request are statically checked only, by default. Confirm this trade-off in the pilot.
- **Monorepos**: verify multiple tsconfigs, project references, config discovery, unknown at project boundaries, and update propagation.
- **Editor integration**: which of a Language Service Plugin, an LSP connection, or a thin editor extension to take is undecided. Confirm the connection, diagnostic integration, and reuse of the same analysis results.
- **Fix candidates and the diagnostic schema**: settle the representation for when a concrete patch cannot be generated safely, when a type diagnostic carries no contract information, and for analysis failures.
- **Separating the build compiler from the analysis engine**: §3.1 states that the target language's compatibility, the build compiler, and the analysis engine's version are managed separately, but in the implementation (`package.json`) a single `typescript` serves both `tsc --noEmit` and `legacy-ts.ts`. Because `legacy-ts.ts` passes `ts.version` straight into a diagnostic's `engine.version`, updating only the build tsc can silently change the engine string in diagnostics. Separation by a second npm alias was **rejected on measurement**: `typescript@7` also declares `bin: { tsc }`, so installing it under an alias still takes `node_modules/.bin/tsc` and `pnpm exec tsc` silently becomes a different compiler (`docs/status.md`, M0.5 gate 5). If separation becomes necessary, take a different route (the `.m05-native/` approach, or splitting packages).
- **The deadline for tracking the baseline runtime's LTS**: §3.1's baseline runtime is a single Active LTS (Node.js 24 as of 2026-09), and lines that are in maintenance or unverified are not declared in `engines`. Node.js 24 moves to Maintenance LTS on 2026-10-20, and Node.js 26 becomes Active LTS on 2026-10-28 ([Node.js Release Schedule](https://github.com/nodejs/Release)). By that date, either complete verification on Node.js 26 (a §3.5-level conformance check is not required, but confirming that the tests and CI pass is) together with the move of `engines` / `@types/node` / CI, or explicitly decide anew to keep 24 as the baseline while it is in Maintenance LTS. Left alone, the policy that "the baseline runtime is the Active LTS" simply stops holding.
