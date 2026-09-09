# Ambit

**Declare what AI-written TypeScript is allowed to do, and check it mechanically.**

An agent can widen a function's authority faster than a human can review it.
Ambit — the range of one's authority — makes that range an explicit JSDoc
contract and verifies it.

- **Can this function reach the network?** `@effects` is checked statically and
  propagated through the call graph.
- **Can it read or write this database?** `@capabilities` is checked statically
  and may only narrow from caller to callee.
- **How much time or money may an entrypoint spend?** `@budget` is parsed and
  validated; `timeMs` is the one limit enforced while the code runs.
- **What happens when an agent quietly widens what a function can do?** The
  check fails, naming the observed effects and the call path they came from.

## The accident

```ts
/** @effects pure */
export function calculateTax(order: Order): Money { /* ... */ }
```

An agent adds a `fetch()` call inside it. The next check fails:

```console
$ node src/cli/main.ts check src
error: calculateTax declares pure but performs [network] directly (tax.ts:2)
files=1 functions=1 declared=1
```

## The problem

TypeScript tells you whether a value has the type you expect. It does not tell
you whether a function is allowed to do what it does. For human-written code
that gap is closed by review and convention, which do not scale when an agent
rewrites a codebase in one session. AI has
cut the cost of producing code, not the cost of deciding whether that code
should be allowed to do what it does. Ambit moves that decision out of
convention and into an executable contract.

## What is actually enforced

| | Static check | Runtime block | Audit only | Unsupported |
|---|---|---|---|---|
| `@effects` | yes | — | — | — |
| `@capabilities`, caller→callee narrowing | yes | — | — | — |
| `@capabilities`, `globalThis.fetch` | — | yes | recorded on the context | — |
| `@capabilities`, literal URL in source | yes (`http:<method>:<host>`) | — | — | — |
| `@capabilities`, URL built at runtime | warns (`AMB-W003`) | yes, for `fetch` | recorded on the context | — |
| `@capabilities`, DB table / LLM target | — | — | — | not derived from source |
| `@effects` for `node:fs` / `child_process` / `pg` / `mysql2` / Prisma / OpenAI / Anthropic | yes | — | — | no runtime hook |
| `@budget timeMs` | — | yes (`throw` / `warn` / `abort`) | — | — |
| `@budget costUsd`, `llmCalls` | parsed and validated | — | — | no hook increments them |
| `@entrypoint` vs. the `withAmbit` beside it | yes, in the same file (`AMB-E010`) | — | — | no adapter links the two |

Contracts are ordinary JSDoc — `@effects`, `@capabilities`, `@budget`,
`@entrypoint`, and `@boundary reason="…"`, which stops analysis of a body and
trusts its declared contract in its place. Runtime blocking comes from `withAmbit(...)`
around an entrypoint plus `installFetchHook()`; with no active context the
process-wide `setUnscopedPolicy` decides, defaulting to `allow`.

Effects are inferred from bundled tables covering `fetch`, the Node.js builtins
named above, and five packages (`pg`, `mysql2`, `@prisma/client`, `openai`,
`@anthropic-ai/sdk`). Everything else resolves to `unknown` — never to `pure`,
and `--strict` turns those warnings into errors. Linking a contract to the
handler that actually runs, after a build or bundler moves either half, is
DESIGN.md §12 and still open.

## Why not ESLint / Effect-TS / dependency-cruiser

**ESLint custom rules.** A lint rule fires on the AST node in front of it.
Ambit's unit is the call graph: an `@effects pure` function that calls an
undeclared helper that calls `fetch` is an error at the declaration, with the
path reported. Where a call cannot be resolved, Ambit reports `unknown`
instead of passing it, so the frontier of the analysis stays visible rather
than silently counting as safe.

**Effect systems such as Effect-TS.** There, effects live in the types of the
values you construct, so the code is written in that style throughout. Ambit's
contracts are JSDoc comments on ordinary TypeScript: adding them changes no
runtime behavior, removing Ambit is a small diff, and the code still
type-checks and runs either way.

**dependency-cruiser.** Its rules constrain the import edges between modules.
Ambit constrains what one function may do and which resource it may touch, and
it answers to an agent: `check --format json` is NDJSON,
one diagnostic per line, carrying the declared and observed contract, the
propagation path, and applicable edits.

## Quick start

Requires Node.js 24.

```sh
git clone https://github.com/sano-suguru/ambit.git
cd ambit && pnpm install
node src/cli/main.ts check <dir>   # --coverage, --strict, --format json
```

`check` exits 0 when nothing was reported, 1 when an error was, and 2 when the
analysis itself could not run.

To use Ambit in another project, build a tarball — it is not published to
npm yet:

```sh
pnpm pack                                   # → ambit-0.0.0.tgz
cd /path/to/your-project
npm install -D /path/to/ambit/ambit-0.0.0.tgz && npx ambit check src
```

`npm remove ambit` undoes it; the `@effects` comments left behind still
type-check and run. Both paths are covered by `test/e2e.install.test.ts`.

## Status

Ambit is experimental and not production-ready. Diagnostic ids and the NDJSON
field shape can still change. The milestone-by-milestone account of what is
implemented and what is not, with the measured coverage numbers behind it, is
in [docs/status.md](docs/status.md).

## Docs / License

- [docs/DESIGN.md](docs/DESIGN.md) — the product specification, written in
  Japanese; everything else in this repository is English.
- [docs/diagnostics/](docs/diagnostics/README.md) — the diagnostic code ledger.
- [docs/limitations.md](docs/limitations.md) — where the analysis is narrower
  than the model suggests.

Licensed under [LICENSE](LICENSE). Ambit is one person's experiment: there is
no support commitment and no release schedule yet.
