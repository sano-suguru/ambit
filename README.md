# Ambit

A **contract layer** on top of TypeScript, paired with a toolchain built for AI coding agents.

Ambit is not a new language. It doesn't change the grammar — it adds declarations for "effects, capabilities, and budget" to existing code, and mechanically stops contract violations in AI-written code. The name comes from *ambit*: the range of one's authority or activity. Ambit guarantees only what's inside the declared range, and doesn't hide what's outside it.

## Why not a new language

- AI is expected to write more accurate code in languages it has seen more of in training. We don't assume the model will learn a new language.
- We build on existing assets (npm / tsc / CI / editors).
- Contract declarations are added to existing TypeScript. This keeps the diff small on the way out, and the exit path is tested automatically.

We're aiming for the next step after what TypeScript did to JavaScript.

## Why TypeScript

Static checking of contracts benefits from type, symbol, and call-signature information. Ambit gets that information from the TypeScript compiler, and takes on the inference, propagation, and checking of contracts itself.

But a resolved call signature doesn't always mean the runtime call target is uniquely determined. For callbacks, dynamic dispatch, and calls that can't be statically resolved, Ambit works with the set of possible call targets, or with `unknown`.

## What Ambit itself is built with

**The leading candidate is to implement contract analysis, the CLI, and the runtime in TypeScript, and delegate type analysis to the Go-based native TypeScript compiler via its official API.** We distinguish the implementation language from the language the type-analysis engine runs in.

- The native API is `unstable` as of the distributed version we checked (7.0.2). We'll fix the client and engine versions, verify conformance, performance, and the maintenance burden of tracking API updates, before adopting it as the product default.
- The legacy TypeScript Compiler API is our baseline for spec verification and TS 5.x compatibility comparison. Whether the product permanently maintains two engines is undecided.
- Depending directly on Go's internal compiler, or adding Rust, is something we'll compare only if a concrete problem shows up — missing functionality in the official API, or communication overhead, for example.
- The runtime doesn't bundle a compiler. The CLI and the editor integration share one contract checker.

The native backend's speed advantage is unproven on Ambit itself. Verification results and the adoption criteria are recorded in the [design spec](docs/DESIGN.md).

## What it does

```ts
/** @effects pure */
export function calculateTax(order: Order): Money { /* ... */ }

/**
 * @effects network, db_read
 * @capabilities db:read:users
 */
export async function getUser(id: UserId): Promise<User | null> { /* ... */ }

/**
 * @entrypoint
 * @capabilities db:read:users, http:get:api.example.com
 * @budget timeMs=500 costUsd=0.01
 */
export async function GET(req: Request): Promise<Response> { /* ... */ }
```

- Declarations are JSDoc. They don't change the function body or its signature. Unrecognized tags don't change normal TypeScript runtime behavior.
- If an AI writes code that calls `fetch` inside `calculateTax`, `ambit check` stops it.
- Undeclared code isn't forbidden. It's treated as `unknown`, making the unanalyzed range visible instead of hiding it.
- `ambit init` infers effects for existing code and proposes JSDoc as fix candidates. Adoption becomes "approve a suggestion" instead of "write declarations by hand."
- Diagnostics are machine-readable from the start. Fix candidates and impact analysis are included, ready for an agent to consume directly.
- Static checking is per-function; runtime enforcement is per-entrypoint. Dynamic capability and budget checks run through the corresponding runtime adapter.
- For an agent's iterative checking, Ambit keeps compiler state and contract-analysis results, and re-checks only what a change could affect. Comment-only contract edits are included in what gets re-checked.

## What it doesn't do

- Change the grammar, build a custom transpiler, build a custom runtime, or build a custom package registry
- Support other languages such as Python (out of scope until Phase 1's exit criteria are met)
- Target browsers, frontend code, operating systems, or embedded systems
- Design around the assumption that "the next model won't make this mistake"
- Guarantee performance without measurement, or guarantee runtime enforcement for unsupported APIs or execution environments

## Initial target

**Node.js cloud backends** — the kind of code AI agents write in bulk today: SaaS APIs, workflows, LLM agents, data processing. The initial baseline environment is Node.js 24 LTS.

Target-code TypeScript compatibility and the version of the analysis engine Ambit itself uses are managed separately. Supported combinations are published as they're verified.

## Documentation

- [docs/DESIGN.md](docs/DESIGN.md) — design spec: analysis backend, contract model, diagnostics, toolchain, verification results, milestones
- [docs/diagnostics/](docs/diagnostics/README.md) — diagnostic code ledger

## Status

Design and technical verification are underway alongside initial implementation. The spec changes through RFCs. This spec is a Draft, and does not finalize the native analysis backend as a product decision.
