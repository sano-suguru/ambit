# Ambit Design Specification

- Status: Draft
- Revision: 5 (Draft) — the chapters that were not specification were moved out: the backend gates to [ADR-0001](adr/0001-analysis-backend.md), the RFC procedure to [`CONTRIBUTING.md`](../CONTRIBUTING.md), the open questions to [`docs/open-questions.md`](open-questions.md). Chapter numbers are unchanged
- Intended readers: developers of Ambit itself, contributors, design reviewers
- Change procedure: direct edit plus a record in `docs/adr/` until the trigger in §9.1; RFC from there on
- What this file is: **the current design, and the limits of what it guarantees** — nothing else. **Why** a design is the one written here is in [`docs/adr/`](adr/README.md); what is implemented today, with measured numbers, is [`docs/status.md`](status.md); what is still undecided is [`docs/open-questions.md`](open-questions.md); where the project is going is [`ROADMAP.md`](../ROADMAP.md)

---

## 1. Purpose

Ambit detects when a change **expands the authority that executable code can exercise**, and makes that expansion reviewable in CI — for AI-generated changes above all, because they arrive faster than they can be read.

It does this through four things:

1. **Declared contracts** — side effects, permissions, and budget attached to existing TypeScript as JSDoc tags, changing neither the body nor the signature.
2. **Conservative static propagation** — what cannot be resolved stays `unknown` and stays visible.
3. **Authority diffing** — `ambit diff` compares two trees and fails on an unapproved increase.
4. **Optional runtime enforcement** — for the operations a hook actually covers.

Ambit is not a sandbox and claims no whole-program soundness. Which of its surfaces it promises not to change without announcing it, and which it explicitly does not promise, is §9.2.

## 2. Design Principles

| # | Principle | Consequence |
|---|---|---|
| P1 | Ride on a language AI is already good at | Invent no new syntax. User code uses TypeScript's syntax and type system |
| P2 | Constrain AI's range of action, not its capability | Forbid designs that assume "the next model will not get this wrong" |
| P3 | Incremental adoption. Do not forbid the absence of declarations | Undeclared is `unknown`. Make it visible rather than forbidden |
| P4 | Do not hide what cannot be guaranteed | State external boundaries, dynamic code, constraints decidable only at runtime, and unsupported backends explicitly |
| P5 | Ride existing distribution, and allow backing out at any time | Ship on npm. Build no bespoke runtime or registry. Test the removal procedure automatically |

When principles conflict, P1 → P5 is the priority order.

P1 constrains the user's syntax, not Ambit's own implementation language: using a native implementation of the compiler would change neither.

## 3. Scope and Implementation Base

### 3.1 Target and technology stack

| Item | Content |
|---|---|
| Target language | TypeScript. Emphasis on incremental adoption in existing TS 5.x code. Compatibility across all of 5.x is not guaranteed while unverified |
| Type-check settings of target code | `strict: true` recommended, not required. Separate from Ambit's own `strict` for contracts |
| Implementation language of Ambit itself | TypeScript, `strict: true` |
| Baseline runtime | Node.js 24 LTS. Additional versions are added to the support table after verification |
| Adopted analysis backend | The JS-implemented TypeScript Compiler API (`ts.createProgram` + type checker), §3.5. The version tracks the latest stable release of that line (6.0.3 as of 2026-09) |
| Ambit-specific static analysis | Function summaries, call relationships, fixed-point computation of effects, capability comparison, diagnostics, fix candidates — all in TypeScript |
| Editor integration | Uses the same checker as the CLI. The approach is settled after verification |
| Runtime library | `ambit-ts/runtime`. Entry-point context, `AsyncLocalStorage`, audit hooks, optional `contract()` |
| Development and distribution | pnpm; one npm package, `ambit-ts` (§6). No build during development: `.ts` runs under Node's type stripping, and `tsc --noEmit` type-checks only. Vitest, Biome, GitHub Actions |
| Domain | Cloud backends: HTTP APIs, jobs and workflows, LLM agents, data processing |

Bun / Deno / edge runtimes are outside Phase 1's guarantee. Observing that they work does not implicitly extend the guarantee to them.

**The target language's compatibility, Ambit's build compiler, and the analysis engine's version are managed separately.** Choosing the build-time tsc does not by itself decide how user code is analyzed.

### 3.2 Why TypeScript

Types, symbols, and call signatures are useful for statically checking effect contracts, and Ambit obtains them from the TypeScript compiler.

They are not sufficient. That a value has a type, or that `getResolvedSignature` succeeds, does not determine the implementation reached at run time: with overloads the selected declaration may have no body, and with callbacks only the function-type declaration may be available. Where Ambit cannot resolve, it leaves `unknown` and does not treat a guess as a guarantee.

### 3.3 Non-goals

- Extending TypeScript's syntax; a bespoke transpiler, runtime, or build system
- Other languages such as Python — not started until the Phase 1 exit criterion ([`ROADMAP.md`](../ROADMAP.md)) is met. The contract model and diagnostic format are nonetheless kept language-independent
- **Static** guarantees about execution time, memory, or cost
- Browser and frontend code
- Completeness. The goal is "stop the violations that can be detected, and state explicitly what cannot be"
- Reimplementing TypeScript's type system

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

What a second backend would additionally have to satisfy is [ADR-0001](adr/0001-analysis-backend.md).

### 3.5 The default backend

**The default is the JS-implemented TypeScript Compiler API** (`typescript` 6.0.3, `src/checker/backend/legacy-ts.ts`). Native TypeScript — the Go implementation — is not adopted. Why, and what the choice costs, is [ADR-0001](adr/0001-analysis-backend.md); the measurements are in `docs/status.md`. Changing the default requires an RFC (§9.1).

**The gates any backend is judged by.** These are not history: a re-evaluation runs against the same five. The latency and memory allowances are fixed before a comparison begins, and are in [ADR-0001](adr/0001-analysis-backend.md).

1. **API conformance**: aliased imports / re-exports, generics, overloads, callbacks, unions, `any`, recursion, JSDoc, and Unicode positions. Distinguish having type information from having the implementation determined.
2. **Compatibility with existing code**: representative TS 5.x code and tsconfigs. Record unsupported settings and type-diagnostic differences.
3. **Correctness of updates**: change function bodies, contract comments, exports, settings, and stubs individually, and confirm that the dependent contracts and diagnostics are updated.
4. **Performance**: with the same code, contract checks, diagnostic results, and coverage, measure initial and post-change time, memory including child processes, and communication volume. Do not compare parse-only speed against a check that includes type analysis.
5. **Distribution and maintenance**: target OS / CPU, startup, npm distribution, and the burden of tracking API updates.

Gates 1–3 have no allowance: they either pass or they do not, and are not traded against speed. Do not assign performance numbers to a backend that has not been run. If a gate cannot be passed, state that the default remains undecided rather than picking a winner.

**The conditions for revisiting**, written down in advance:

- The `unstable` name comes off the native API.
- §6.2's resident check path is implemented, so that re-query latency — the native implementation's real advantage — can show up in the product at all. Re-run gates 3 and 4 then.
- The JS-implementation line stops producing stable releases, which would collapse the premise behind the version-tracking rule in §3.1.

## 4. Contract Model

### 4.1 Form of declarations

Contracts are declared by default with **JSDoc tags**. An ordinary declaration changes neither the function body nor its signature. Declarations come also from `ambit.config.ts` ("Out-of-code declarations" below) and from the `spec` of `withAmbit` / `ambitHandler` / `ambitRoute` (§4.4). All three declare the same five contracts with the same meaning.

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
| `@effects` | Any function or method | Checked by the propagation rules of §4.2 | None (static only) |
| `@capabilities` | Any function or method | Checked by the narrowing rule | What is attached to an entry point is enforced (§4.4) |
| `@budget` | Mainly entry points | Pattern warnings such as `llm` inside a loop | What is attached to an entry point is enforced (§4.5) |
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

An entry point with no runtime enforcement has no `spec`, so its `@capabilities` / `@budget` are written in JSDoc (or config). "The JSDoc tag becomes optional" holds only where a `spec` can supply the declaration; it never means "there need be no contract".

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

The contracts that can be declared are the same five as in JSDoc, with the same meaning. Being in config does not make them weaker. `strict` is an array of globs following the same rules as the `file` part, and applies the same promotion as `--strict` only to the diagnostics of matching files (§4.3).

If a symbol has both JSDoc and config, JSDoc wins and the difference is warned about. Differences are compared per tag.

**Overloads and bodyless declarations**

An overload set is **one declaration site, and that site is the implementation.** A signature is a type, not code that runs. Therefore a signature, an `abstract` member, and a `declare function` inside a `.ts` file are none of them declaration sites: `--coverage` counts them as `bodyless-declaration`, a contract tag written there is reported as AMB-E003 and not adopted, and a call into a set with no implementation is `unknown` (`overload-without-body`).

This rule is a termination requirement as well as a notation: the declaration path and the function the backend returns must be one to one, or §4.2 rule 7's fixed-point iteration does not converge.

**(a) Notation of the `symbol` part, and which declaration sites can be named**

`symbol` is the checker's internal declaration path itself (joined with `"."`: `Class.method`, `obj.member`, `Class.constructor`), and config can name that set plus accessors (`Class.get total` / `Class.set total`) and anonymous default exports (`default`).

These last two have a declaration path, but **writing JSDoc on them is still not adopted** (AMB-E003). Members with computed, string, or numeric keys cannot be named even in config. The resulting asymmetry — config's namespace is wider than JSDoc's — is an open question, not a distinction derived from principle ([`docs/open-questions.md`](open-questions.md)).

**(b) Globs in the `file` part, and the priority when several entries hit the same symbol**

The `file` part interprets `*` (any string not crossing `/`) and `**` (zero or more directory levels). The `symbol` part is not globbed.

- A key containing no glob characters always wins over a key containing a glob.
- If two or more glob keys hit the same symbol, both keys are listed and the run stops with exit 2. Ambiguity between globs is a configuration error, not something resolved by written order or by a specificity rule.

**(c) The formats read, and the search origin**

- Formats: `ambit.config.ts` / `.mts` / `.js` / `.mjs`, looked for in that order; only the first found is used.
- Search origin: from the `<dir>` of `check <dir>` / `init <dir>` upward through parents. cwd is not consulted. The walk stops once it has examined a directory holding a `package.json` or a `.git`, so that a config outside the project is not silently picked up.
- The `file` part of `contracts` keys and the patterns in `strict` are resolved **relative to the directory holding the config file**, so that the same config points at the same symbols under both `ambit check src` and `ambit check .`.

**(d) How user-defined effects appear in diagnostics**

`effects: { payments: ["network", "db_write"] }` is **expanded into standard effects at parse time**. Only expanded standard effect names appear in a diagnostic's `contract.declared` / `contract.observed`; user-defined names exist only on the input side. The value of a definition may only be standard effect names, defined names are not expanded recursively, and a collision with a standard effect name exits 2.

**Adoption via `ambit init`**

`ambit init` infers the effects of existing code from the evidence in §4.2 and emits JSDoc additions as fix candidates (§5, `fixes[].edits`). Functions it cannot infer remain `unknown` and appear in `--coverage`.

Not being able to propose a contract is not a reason to say nothing: where such a function holds the unresolvable call in **its own** body, `ambit init` reports those call sites and what each one's reason implies — carrying no fix candidate, and never proposing `@boundary`, because §4.3 tallies a boundary apart from succeeding at analysis ([ADR-0011](adr/0011-reporting-why-a-contract-cannot-be-proposed.md)). A function that only inherited `unknown` from a callee is not reported; the callee that holds the call is.

`ambit init --config` emits the same inference, only for **declaration sites where JSDoc cannot be placed** — the two kinds in (a), plus `Class.constructor` where the class writes no constructor. For functions that reached `unknown`, neither JSDoc nor config is proposed, for the same reason as §4.3: so that "could not tell" is not turned into a declaration.

### 4.2 Effects

What a function does to the outside world.

| Name | Meaning |
|---|---|
| `pure` | Touches nothing outside. Depends only on its arguments, with no side effect observable from outside the function (mutation of values created inside the function does not count — see below) |
| `network` | External network communication (`fetch`, `node:http`, any socket) |
| `db_read` / `db_write` | Reading from / writing to a data store |
| `fs_read` / `fs_write` | The file system |
| `state_write` | Modifying a value reachable from outside the function. Assignment to arguments, module-scope bindings, or `this`, and destructive method calls on them such as `Array.push` / `Map.set` / `Set.add` |
| `llm` | LLM API calls. Implies `network` and is subject to budget |
| `env` | Non-deterministic input such as environment variables, the clock, and randomness |
| `process` | `child_process`, signals, `process.exit` |
| `unknown` | Not analyzable. May include any effect |

User-defined effects can be declared in `ambit.config.ts` as combinations of standard effects.

**Local mutation and `pure`**

`pure` **permits mutation of values created inside the function**. Only mutation of a value reachable from outside the function is `state_write` ([ADR-0004](adr/0004-local-mutation-and-pure.md)).

The decision looks at the **root** of the mutation target (`a` for `a.b.c = 1`, `out` for `out.push(x)`). Only these roots are local:

- An identifier bound by `const` inside that function whose initializer is an array literal, an object literal, or a `new` expression
- A mutation target that is itself an array literal, an object literal, or a `new` expression
- A `this` whose binding function is the direct operand of a `new` expression — a value `new` has just allocated, which nobody else holds yet
- The `this` in the constructor body of a class with no `extends`. With `extends`, the base constructor runs first and may already have passed `this` outward, so it is not local

Everything else (arguments, any other `this`, module scope, bindings of an enclosing function, `let` / `var`, a non-identifier root, an unresolvable root) is `state_write`. Destructuring assignment puts each target through the same rule, and one non-local target makes the whole `state_write`. Falling to an effect rather than to `unknown` on the undecidable side is for the same reason as §4.2's "operations whose read/write direction is not statically determined".

Like rule 7, this is **not a soundness claim**: if a locally created value is handed elsewhere and then mutated (`sink(out); out.push(x)`), Ambit judges it local mutation. No alias analysis is performed, and the gap is expressed neither by `boundary` nor by `unknown`, so it is stated here.

A destructive method that takes a callback by reference (`arr.sort(cmp)`) is settled by rule 4, on the actual argument. The receiver's own verdict is unchanged either way.

**Handling of invalid tags**

If `@effects` contains a name not in the table above, that tag is not adopted. The function is treated as undeclared — not implicitly degraded to `pure` — and AMB-E002 is reported. Since it is undeclared, no violation exists and AMB-E001 does not co-occur. This is a parsing rule, different in kind from the propagation rules below, which presuppose an adopted contract.

**Propagation rules**

1. The known actions a function performs directly, and the known effects propagated from its callees, must be contained in the set the function declared. A known action exceeding the declaration is a violation.
2. `pure` is another name for the empty set. Calling a function with known side effects from `pure` is a violation.
3. A function that calls `unknown` contains `unknown` regardless of its declaration. If a declared function contains it, that is a **warning** (whether or not the declaration is `pure`). Ambit's `strict: true` can promote it to an error.
4. Higher-order functions: the effects of a callback parameter are inferred from the actual argument at the call site. Do not treat inference as complete on the basis of a type signature alone. If it cannot be inferred, `unknown`.
5. Methods, getters, generators, and `async` functions follow the same rules. `await` is transparent.
6. Calls through dynamic `import()`, `eval`, `new Function`, or an `any` type are `unknown`.
7. A call through a property resolves from the **value** of the receiver, not from the type annotation, so `const handlers: H = { read }` and `const handlers = { read }` give the same result. It resolves only when a single object literal is definitely behind the receiver; anything else (arguments, `let` bindings, literals containing a spread) is `unknown`. This is not a soundness claim: `const` fixes the binding but does not freeze the properties. Method resolution on class instances rests on the same premise.

A contract tag written at a position that cannot declare a contract enters neither propagation nor checking, and is reported as AMB-E003. A declaration that does nothing is not allowed to look like a guarantee.

Cycles in the call graph are propagated to a fixed point. Changing the analysis backend does not implicitly change the meaning of the contract model.

**"Undeclared" and "`unknown`" are not the same thing.** If a callee declares `@effects`, the caller trusts that declaration and uses it in propagation; whether the callee's body is consistent with it is checked in the callee's own diagnostics. If the callee has no declaration, propagation continues from the observed effect set inferred recursively from its body. `unknown` arises only on reaching rule 6's "not analyzable". "Undeclared" is therefore something `--coverage` makes visible in its tallies, not an input to the propagation rules. If `unknown` remains inside a declared callee, it appears as that callee's own AMB-W001 and does not propagate to a caller that trusted the declaration.

A diagnostic that is only about `unknown` (rule 3's warning) leaves `ambit check`'s exit code at 0, as long as no known action exceeds a declaration. That is a separate matter from §3.4's "do not pass off an analysis failure as no violation"; this one is about handling "analyzed, but unclear".

**Evidence for effect detection**

Ambit declarations (`contract()` / JSDoc / config); effect definitions for Node.js standard modules and major libraries (`src/stubs/`, bundled and maintained by Ambit); an `ambit.stubs.json` a third party bundles in its own package. If there is none of these, `unknown`.

**Operations whose read/write direction is not statically determined**

For an operation where the same method reads or writes depending on the statement, such as `pg`'s `query(sql)`, the stub table returns a **set** of effects. The decision is made only from the leading keyword of a literal string, or of the static leading part of a template literal; where that does not settle it, both `db_read` and `db_write` are returned. Returning only the read is not taken: a dynamically assembled `UPDATE` would then pass `@effects db_read`, which runs against §3.4. The price is that a read-only function assembling its statement dynamically must also declare `db_write`.

This rule applies to the direction of the effect only. Table names are not read out of SQL to derive capabilities (§4.4).

### 4.3 Handling `unknown`

`unknown` is Ambit's core concept, representing the unresolved extent of a guarantee. Code with no declaration is not assigned `unknown`; inference continues on it as far as possible (§4.2). `unknown` arises only on paths that remained unanalyzable after inference.

- Do not forbid it. The moment it is forbidden, incremental adoption stops working.
- `ambit check --coverage` outputs the proportion of the codebase that depends on `unknown` and where it occurs. It is a primary KPI, but not the whole guarantee: trust in boundary declarations and the trust level of stubs are shown alongside it.
- The ways to reduce it are adding verifiable declarations, adding stubs, or explicit isolation via `boundary` (§4.6). Moving something to a boundary is tallied separately from succeeding at analysis.
- `strict` can be set per directory in `ambit.config.ts`.
- For a measurement in which the backend or its version changed, state that change. A rise or fall caused by a compatibility difference is not an improvement in contracts.

### 4.4 Capabilities

If effects are "what it does", capabilities are "what it may do it to".

- Form: `<resource>:<action>:<target>`. `target` may be globbed (`http:get:*.example.com`).
- Only **narrowing** is possible from caller to callee. A callee requiring a broader capability than its caller is a violation.
- An entry point states `@entrypoint` and `@capabilities` explicitly. Leaving them unspecified is warned about as equivalent to `unknown`.
- **Dual enforcement**: violations decidable statically, such as literal URLs and known clients, are stopped by the checker; dynamic URLs and table names are matched by the corresponding runtime hook. Operations with no hook are not guaranteed blockable.

**What the static side matches**

The checker matches only `http:<method>:<host>`, and only at the HTTP entry points in the bundled stubs (`fetch`, and `get` / `request` of `node:http` / `node:https`). A host is determined only if it is a literal string, or if the static leading part of a template literal terminates the authority; where the static part ends partway through the authority (`` `https://api.${env}.example.com/` ``), a prefix match may not claim a host. An undetermined target is `unknown` rather than "no requirement", and the diagnostic says it is the runtime's responsibility. The host is taken as written (including the port, excluding userinfo); default ports are neither filled in nor elided.

**Table names are not read out of SQL statements** to derive `db:` capabilities. The ability to decide table-level permissions for arbitrary SQL is not assumed, and changing where it is read from does not change the claim.

**Runtime enforcement is per entry point**

`ambit-ts/runtime` pushes the capability set onto `AsyncLocalStorage` when an entry point is entered; supported operations from then on are matched against that set. `AsyncLocalStorage` holds the context; the blocking is implemented by the adapter.

- A framework adapter (`ambit-ts/runtime/hono` and so on) wraps the handler at each route registration. It is not one middleware for the whole application: contracts differ per route, and placing `spec` and the handler in the same call is the premise of the agreement check below.
- Where there is no adapter, insert `withAmbit(spec, handler)` by hand.

**Mapping contracts to handlers**

A contract reaches the runtime as a **value inside the module**: `withAmbit(spec, handler)`, or an adapter's `ambitHandler(spec, handler, decode)` / `ambitRoute(spec, handler, decode)`. Nothing is generated, nothing is read from JSDoc at run time, and the runtime refers to neither symbol IDs, file paths, nor function names — so a contract survives a build that drops comments, and bundling and minification ([ADR-0005](adr/0005-mapping-contracts-to-handlers.md); keying on an HTTP route path instead was rejected in [ADR-0007](adr/0007-http-route-keys.md)).

The third parameter `decode` builds the handler's arguments from the framework's `Context`. It is separate so that framework-dependent calls stay inside the registration expression and the handler stays statically analyzable. `decode` runs **inside** the context: reading the request body counts toward `timeMs`.

The runtime overhead — one context and one `decode` — is **unmeasured**.

**Removing the double declaration**

When a `spec` fixes `capabilities` / `budget` as literals and `handler` is an identifier naming a declaration in the same file, that value **is read as that handler's own `@capabilities` / `@budget` declaration**. There is no need to write the same content again in JSDoc. `@effects` and `@entrypoint` stay in JSDoc.

The agreement check (`AMB-E010` / `AMB-E011`) **stays; neither its meaning nor its severity changes.** If both are written and they disagree, it is an error. What changed is only that the JSDoc side may be absent. This is why `spec` is last in the merge order. `spec.budget` and `@budget` are compared the same way, with `onExceed` aligned to its default `throw` first, and a limit present on only one side counted as a disagreement; the capability and budget halves are judged independently.

**The range this does not reach**, where JSDoc is required: when `spec` is not a literal, and when `handler` is declared in another file. Both are made visible with `AMB-W004`, whose message states that an unreadable `spec` declares nothing. If the entry point still has no declaration, `AMB-W002` is emitted alongside. It is never silently made `unknown`.

**The check this gives up**, stated explicitly: with the declaration in one place there is no pair, so `AMB-E010`'s "the pair disagrees" no longer catches an edit that widens only `spec`. This is not a reduction in the guaranteed surface — `AMB-E010` / `AMB-E011` never caught capability expansion itself, and an edit widening both sides at once always passed silently. A declaration written in `spec` shows up in `ambit diff` like every other contract, is bound from its callers by the narrowing rule (`AMB-E005`), and its literal targets are checked by `AMB-E009`.

**Handlers whose contract cannot be found**

A handler registered without an adapter (`app.get(path, handler)` directly) pushes no context, and supported operations inside it are decided by `runtime.unscoped` (`allow` default / `warn` / `deny`). The adapter **does not push a context with an empty capability set** for a handler whose contract cannot be found: the empty set is a total denial, and it would make a missing registration indistinguishable from a policy decision. Since the adapter's registration API requires `spec`, "registered via the adapter but with no contract" cannot be created.

**How denial is conveyed**

`AmbitCapabilityError` / `AmbitBudgetError` are not translated into an HTTP status; they reach the framework's error handler as they are. 403 means "the client lacks permission", whereas what happened is "the server's code exceeded its own grant" ([ADR-0005](adr/0005-mapping-contracts-to-handlers.md)).

**The approach to runtime hooks**

The rationale for each choice is [ADR-0006](adr/0006-runtime-hook-approach.md); what each hook covers in detail, with versions and installation order, is [`docs/limitations.md`](limitations.md).

| Target | Approach | Blocks and audits |
|---|---|---|
| `globalThis.fetch` | monkeypatch (`installFetchHook`) | yes |
| `node:fs` / `node:fs/promises` | monkeypatch (`installFsHook`) | yes |
| `node:child_process` | monkeypatch (`installChildProcessHook`) | yes |
| `pg` | client wrapping (`installPgHook(pg)`) | yes |
| `mysql2`, `@prisma/client`, `drizzle-orm`, `mongodb`, LLM SDKs (`openai`, `@anthropic-ai/sdk`, `ai`) | no hook | no |

A row marked "no hook" has static effects but nothing intercepting it at run time: calling it is neither blocked nor recorded. The performance impact of going through a replaced function is **unmeasured**.

Denial follows the shape of the API: synchronous APIs `throw`, callback APIs use `process.nextTick(callback, error)`, Promise APIs reject. `existsSync` throws rather than returning `false` — "does not exist" and "must not look" are different answers.

**Target formats.** For `node:fs` and `node:child_process` the target is the **absolute path resolved at call time** — `fs:read:<glob>`, `fs:write:<glob>`, `proc:spawn:<command>` — because that is the only form visible at call time and matchable against a grant. Globs may be written only on the granting side, and `*` crosses `/`. Operations taking two paths require `fs:write` on the destination and `fs:read` on the source. For the shell forms of `child_process` (`exec`, `shell: true`) the target is **the shell itself**, not a guess at the program inside the shell string — the same reason as not reading table names out of arbitrary SQL.

**`pg`.** The direction of a query is decided by the **same keyword table** as the static side (`src/stubs/data-clients.ts`), which lives under `src/core/` so that the static check and the running process cannot disagree about the same statement. Where the keyword cannot be read, **both** `db:read` and `db:write` are required. The target is the **database name**, not a table name: a table-level target such as `db:read:users` has meaning only in the static narrowing rule, and `pg`'s hook does not satisfy it. This asymmetry is stated in the README and in the diagnostic text. Where the database cannot be determined, the target is `unknown` and only a grant like `db:read:*` lets it through.

Behavior with no context is specified by `runtime.unscoped`: `allow` (the default, for early adoption) / `warn` / `deny`.

Per-function `@capabilities` is not enforced by the default runtime; it is used only for the static narrowing rule. Where finer granularity is needed, the opt-in `contract()` pushes a new context inside.

Node.js's Permission Model is considered as an outer frame for the whole process. It is not a substitute for per-entry-point checking, and is distinguished from a guarantee of isolation against malicious code.

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

- **Declaration**: the per-request or per-job limit, on the entry point.
- **Measurement**: elapsed time, LLM call count, and estimated cost (price table × token count) accumulate on the context.
- **Block**: `onExceed` is `throw` (default) / `warn` / `abort` (via `AbortSignal`). It does not extend to undoing spending already incurred, or to force-stopping work that does not support cancellation.
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
- A function budget sits inside the entry-point budget; a child's consumption is added to the parent's.
- A transform injecting wrappers from JSDoc is a Phase 1 non-goal.

The price table is written in `ambit.config.ts`, and Ambit bundles defaults. Which of `timeMs` / `costUsd` / `llmCalls` is actually enforced today is in [`docs/limitations.md`](limitations.md).

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
- A `@boundary` without an accompanying `@effects` is a violation. The bargain is "we do not look inside, and in exchange we trust the outward declaration"; with nothing declared to trust, it merely removes the check. An undeclared dimension is `unknown` rather than the empty set, leaving the hole visible from the caller.
- Inside a boundary, supported runtime enforcement stays in effect. Only the static check is stopped.
- To make an entire third-party module a boundary, name the package in config.

### 4.7 Types and null safety

Type safety such as optional access is not reimplemented. It is delegated to the analysis backend, and its diagnostics are converted into Ambit's structured diagnostics.

A non-null assertion `!` does not by itself make a type `any`, and is distinguished from a call through `any`.

## 5. Structured Diagnostics

The primary consumer of diagnostics is the AI agent. Human-facing display is a rendering of the structured diagnostics.

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

`ambit check --format github` emits the same structured diagnostics as GitHub Actions workflow commands (`::error file=...,line=...,col=...,title=<id>::<body>`), folding each step of the call path and `contract.operation` into the body with `%0A` so the path is readable from the annotation alone. `severity` maps onto `error` / `warning` / `notice`, and `location.file` is rewritten relative to the workspace. This format exists to satisfy §6's "do not require a dedicated CI plugin" and does not affect consumers of the NDJSON.

**Authority records.** `--format json` follows the diagnostics with one `kind: "authority"` record per analyzed function — not a diagnostic, but the authority that function holds. Every function is emitted, including those with no violation.

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

- In `declared`, `null` means "there is no tag" and `[]` means "declared `pure`". A tag that could not be parsed (`AMB-E002`) goes on the `null` side: a broken declaration is not read as a narrower grant than one never written.
- `observed` / `required` are post-propagation. `unknown` is not an authority but a separate claim — "the analysis did not reach" — so it is an independent boolean on each of `effects` and `capabilities` (§4.3).
- `paths` is attached only to authority actually reached; `via` and `operation` are built by the same computation as `AMB-E001`. No path is attached to authority merely declared (§5.3).
- Records are in symbol ID order and the arrays within them are sorted, so analyzing the same tree twice produces identical output.
- The position is between the diagnostic lines and the `kind: "summary"` line, so consumers that read the last record as `summary` are not broken. `init` does not emit these.

These records are an artifact of the checker and are never read at run time; `ambit diff` (§6) computes the authority difference from them alone.

`via` is a sequence of functions, each element positioned at that function's declaration. The position of the operation causing the effect is held by `contract.operation`.

### 5.2 Fields

| Field | Content |
|---|---|
| `id` | A stable diagnostic code. Never deleted or reused — **from 1.0**. While the major version is 0 an `id` may still be renumbered or reworded, announced in `CHANGELOG.md` like any other change to the guaranteed surface (§9.2, §9.3). The ledger in [`docs/diagnostics/`](diagnostics/README.md) carries each code's current meaning either way |
| `severity` | `error` / `warning` / `info` |
| `category` | `effects` / `capabilities` / `budget` / `boundary` / `types` |
| `contract` | The declared/observed difference and path. The shape varies by `category`: `effects` is `{declared, observed, via}`, `capabilities` is `{declared, required, excess, via}`. No extra discriminator field is added — consumers look at `category` |
| `fixes` | Fix candidates. `consistentWithContract` distinguishes fixes that keep the contract from those that loosen it |
| `fixes[].impact` | Callers affected by a fix that loosens the contract |
| `contract.operation` | `{qualifiedName, file, line}` — the position of the stub call causing the effect, within the last function of `via`. Attached only to `AMB-E001`. Where the position cannot be determined, the field is omitted entirely; the declaration position is not used as a substitute |
| `engine` | `{name, version}`. Identification of the analysis backend that produced the diagnostic |

Diagnostics are managed by a versioned JSON Schema. Metadata lines that would break existing NDJSON consumers are not added without notice.

### 5.3 Design notes

- `fixes[].edits` are applicable, concrete patches. A candidate that is only a summary, or that contains ellipses, is not emitted as an automatically applicable fix.
- Where a fix that keeps the contract can be generated, it is placed higher, with loosening candidates after it. Candidates that cannot be generated are not fabricated for the sake of ranking.
- The meaning of diagnostic codes is listed in [`docs/diagnostics/`](diagnostics/README.md), and changing one is a change to the guaranteed surface (§9.2).
- The format does not depend on the host language. Compiler-specific objects and in-snapshot IDs are never used as public symbol IDs.
- A symbol ID's declaration path is joined with `"."` (`src/tax.ts#Foo.bar`). Members of object literals use the same notation, so `const handlers = { read() {} }` is `handlers.read`. Names that collide with the joiner (computed, string, or numeric keys) have no stable notation and are given no symbol ID.
- `location` is 1-based; edit ranges are 0-based and end-exclusive, and string offsets are unified on UTF-16 units. Positions from the backend are converted and validated.

## 6. Toolchain

```text
ambit init      Propose inferred effects as JSDoc fix candidates. --config proposes additions to ambit.config.ts
ambit check     Static checking. --format json / github / --coverage / --strict
ambit diff      Authority difference against a base ref. --format github
ambit run       Run with runtime enforcement enabled (for development)
ambit agent     The agent loop
ambit stubs     Generate and search stubs for dependency packages
ambit sbom      Emit dependencies together with their effects and capabilities as an SBOM
```

What is implemented today is [`docs/status.md`](status.md).

`ambit diff <ref> [dir]` compares the working tree's authority against the base ref's and emits what has increased.

- The base ref is materialized into a temporary directory with `git worktree`, placed in the OS temporary directory, never inside the tree being checked, and cleaned up unconditionally.
- The same subdirectory on both sides goes through the same analysis. Symbol IDs contain a path relative to the checked directory (§5.3), so if the target shifts, every symbol looks new.
- If the working tree has `node_modules`, it is symlinked into the base side, so that a difference in environment rather than in contracts is not reported as a diff.
- A file git reports as renamed carries its symbols with it: the base side's ids are re-expressed under the new path before the comparison. Only git's own rename detection is used; no other guess about identity is made. What this does *not* cover is in §6.3.
- The comparison itself is a pure function of the two sets of `kind: "authority"` records and the rename map, and touches git not at all.
- An increase must be approved to pass (§6.3).
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

Reducing authority is not what this command watches for: failing on a decrease would give the writer a reason not to touch contracts at all. `unknown` is not authority (§4.3), so it does not count as an increase, but it is reported.

**Distribution and integration.** One package, `ambit-ts`: `npm install -D ambit-ts` installs the CLI and the runtime together. Production uses `ambit-ts/runtime` and the necessary adapters; the compiler and the development CLI are not to be required production dependencies, and **the single package does not yet meet this** — `typescript` is a `dependencies` entry, so importing only the runtime still installs the compiler. The runtime splits out at the first production adopter ([ADR-0009](adr/0009-package-name-and-single-package.md)).

CI integrates via the exit code and the structured output; no dedicated CI plugin or Action is required (§5.1). Editors obtain diagnostics from the same checker as the CLI. A JSDoc declaration by itself does not change runtime behavior: the settings and steps needed to deliver contracts to the runtime are stated explicitly per framework in [`docs/integrations/`](integrations/).

### 6.1 Package responsibilities

| Responsibility area | Content |
|---|---|
| `src/core` | The contract model, analysis representation, capability comparison, diagnostic format. Does not depend on a compiler API |
| `src/checker` | Contract analysis using information from the connection layer, inference, coverage, fix candidates |
| `src/cli` | Commands, exit codes, structured output, control of iterative checking |
| `src/runtime` (`ambit-ts/runtime`) | Context, matching and blocking of supported operations, budget measurement, adapters |
| `src/stubs` | Contract definitions and trust information for external libraries |

This is a separation of responsibilities, not a package list. It is expressed as directories inside the single `ambit-ts` package, and the subpath exports (`ambit-ts`, `ambit-ts/config`, `ambit-ts/runtime`, `ambit-ts/runtime/hono`, `ambit-ts/runtime/next`) are what a consumer sees of it. A later split of the runtime keeps those specifiers working by re-export, because a specifier is part of the guaranteed surface (§9.2).

### 6.2 Iterative checking and caching

For agents and editors, a resident check path holds the analysis engine's state together with Ambit's function summaries and dependency information. One-shot `ambit check` is retained as well.

- Rather than only the changed files, walk the contract dependencies backwards and re-check the affected callers. Update ranges containing recursion to a fixed point.
- Invalidation conditions include changes to JSDoc, out-of-code contracts, stubs, tsconfig, dependency resolution, and the analysis engine version. Do not ignore a change to contract comments alone, even when type information is unchanged.
- Do not carry snapshot-specific types and symbol IDs across an update. Maintain a correspondence to files and declaration paths.
- Measure initial analysis, type-information retrieval, contract analysis, transfer, and diagnostic output separately.

### 6.3 Approving an authority increase

`ambit diff` (§6) detects that authority grew. Detection alone cannot gate a
pull request: a change that legitimately adds authority has to be able to say
so, or the gate blocks honest work and is switched off.

Any approval mechanism has to meet four criteria, recorded here so that a later
reconsideration has something in the specification to test itself against:

1. **The approval is a reviewable record in the repository.** A mechanism whose
   record lives in a CI provider's state — a label, a re-run, an environment
   approval — leaves nothing in the tree and does not support the claim that a
   human reviewed the increase.
2. **A stale approval does not let an increase through.**
3. **Moving and renaming code is not taxed**, or the ledger becomes a file
   rewritten by every refactoring, which is ritual rather than review.
4. **The apparent guarantee surface does not grow** (P4). That an increase can
   be approved says nothing about whether the approver was right.

**The approval ledger.** A file named `ambit.approvals.md`, found by walking up
from the checked directory and stopping at the first directory holding a
`package.json` or `.git` — the same search `ambit.config.ts` uses (§4.1 (c)).

Approvals are the lines whose first non-space character is `-`, below a heading
whose text is `Approvals`; every other line is prose and is ignored, so the file
carries its own explanation. A file with no such heading is read as approvals
throughout. An approval line is:

```text
- `<symbol id>` `<authority>` — <reason>
```

The symbol id is as §5.3 defines it and as `ambit diff` prints it. The authority
is `effect:<name>` or `capability:<resource>:<action>:<target>`, matched as
**exact text**: an approval of `capability:http:get:*` does not cover
`capability:http:get:api.example.com`. Containment is how a *grant* relates to a
*requirement* (§4.4); an approval is neither — it is a record that one named
increase was looked at, and one line must not quietly cover a family of them.
The reason is free text and is required. `ambit diff` prints the line to add for
every increase it fails on, so the ledger is filled in by copying.

A `-` line inside the approvals region that does not parse is reported with its
line number and grants nothing. It does not by itself change the exit code: the
increase it failed to approve is still unapproved, and that is what fails.

**An approval is valid only in the comparison that adds it.** The ledger is read
on *both* sides of the diff. For each `(symbol id, authority)` pair, the number
of approvals in force is the head side's count of that pair minus the base
side's. A line already in the base grants nothing, forever. Three properties
follow, and they are how the rule meets criteria 1 and 2:

- The record of an approval is a line added to a file in the pull request that
  introduces the increase — reviewed by whoever reviews the diff.
- An approval cannot go stale, because it cannot outlive its own comparison.
  Authority removed and later reintroduced needs a new line.
- The ledger is append-only and never needs pruning. Because what counts is the
  *count* of a pair, re-approving later means appending a second identical line.
  Deleting lines can only reduce what is approved, never grant.

**What an approval is not.** It records that a line was added alongside an
increase and shown in the diff. It does not establish that a human wrote it,
that the human was right, or that the increase is safe — **Ambit cannot verify
any of the three, and does not claim to** (P4). An agent can write an approval
line exactly as a human can. What makes a human necessary is the repository's
own branch protection: requiring review, and naming `ambit.approvals.md` in
`CODEOWNERS`. That is outside Ambit, and stating it is part of the design rather
than a gap in it.

The same holds for the shape of the check. `ambit diff` compares two trees, so a
change made outside the agent loop — hand-edited JSDoc, a rewritten
`ambit.config.ts`, an updated stub — reaches the gate exactly as an agent's
change does. An in-loop approval is an ergonomic step, not the enforcement
point; this is.

**What rename detection does not see.** §6 carries symbols across a file git
reports as renamed. Two cases remain, and both surface as an unapproved increase
that costs an approval line: a function renamed *within* a file (git reports no
rename, and matching two declaration paths inside one file would be a guess
about identity — the guess that hides a function which gained authority), and a
file whose rename git does not detect, because the move was accompanied by
enough editing, or because the new path is not yet tracked. Both are
over-reporting, never under-reporting, which is the direction §3.4 requires.

## 7. The Agent Loop

`ambit agent` embeds no agent implementation: it defines a protocol over NDJSON
and connects an arbitrary agent. It is not implemented, and the shape it is
meant to take is in [`ROADMAP.md`](../ROADMAP.md).

What matters to the design here is that approval enforced only inside an agent
loop reaches only what the agent did. A contract, setting, or stub edited by
hand reaches CI instead, where `ambit diff` compares the whole tree against the
base ref and the approval ledger is what lets a legitimate increase through
(§6.3).

## 8. Supply Chain

Stub trust levels, highest first: **bundled with Ambit > provided by the package author > community > automatically inferred.** The trust level is included in diagnostics, so that a contract read out of an inferred stub is never presented as one the package's author wrote.

The versions of the analysis engine are pinned and recorded alongside (§3.4), so that an analysis difference caused by an engine update is distinguishable from a contract difference in the user's dependency packages.

`ambit sbom` and dependency-update reporting are not implemented; the shape they are meant to take is in [`ROADMAP.md`](../ROADMAP.md).

## 9. Governance

The specification, diagnostic codes, checker, runtime, and stubs are all open source.

### 9.1 When the RFC procedure takes effect

Changes to the meaning of diagnostic codes, the standard effects, the
propagation rules, the default backend, or the range of TypeScript supported
require an RFC **from 1.0, or from the first external adopter, whichever comes
first**. Publishing to npm is not the trigger: an RFC needs a second party, and
a registry entry with no dependent supplies none
([ADR-0010](adr/0010-when-governance-takes-effect.md)).

Until then, a decision is made by editing this file directly and writing the
record in [`docs/adr/`](adr/README.md). The procedure itself — how to propose,
how a record is written, what is verified before a change lands — is
[`CONTRIBUTING.md`](../CONTRIBUTING.md). §9.2 and §9.3 hold at every version,
before and after the trigger.

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

The Phase 1 exit criterion, the metrics, and their targets are in [`ROADMAP.md`](../ROADMAP.md).

## 11. Milestones

M0 through M5 and the order they are actually being worked in are in [`ROADMAP.md`](../ROADMAP.md); what each has actually reached, with measured numbers, is [`docs/status.md`](status.md).

## 12. Open Questions

What is still undecided is [`docs/open-questions.md`](open-questions.md). It is kept out of this file so that what Ambit guarantees is not read alongside what it has not decided.
