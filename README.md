# Ambit

**Declare what AI-written TypeScript is allowed to do, and check it mechanically.**

An agent can widen a function's authority faster than a human can review it.
Ambit — the range of one's authority — makes that range an explicit JSDoc
contract and verifies it.

## The accident

Three files. `priceOrder` declares `pure`; `applyTax` and `currentRate` declare
nothing at all.

```ts
// pricing.ts
/** @effects pure */
export function priceOrder(subtotal: number, region: string): number {
  return applyTax(subtotal, region);
}

// tax.ts
export function applyTax(subtotal: number, region: string): number {
  return Math.round(subtotal * (1 + currentRate(region)));
}

// rates.ts
const FALLBACK_RATE = 0.08;

export function currentRate(region: string): number {
  void fetch(`https://rates.example.com/${region}`);  // <- the agent's one added line
  return FALLBACK_RATE;
}
```

The added line is two calls away from the declaration it breaks. The next check
fails, and prints the way from one to the other:

```console
$ node src/cli/main.ts check test/fixtures/accident; echo "exit=$?"
error: priceOrder declares pure but calls currentRate which has effects [network] (pricing.ts:4)
  -> applyTax (tax.ts:3)
  -> currentRate (rates.ts:3)
  operation: fetch (rates.ts:4)
files=3 functions=3 declared=1
exit=1
```

No file here contains both the declaration and the `fetch`. Every file is
locally unremarkable: `rates.ts` fetches a rate, which is what a rates module
does, and nothing in it mentions `pure`. The violation exists only in the path
between the three, which is why a rule that reads one node, one function, or one
file at a time has nothing to fire on.

TypeScript accepts that edit — the types still line up. It tells you whether a
value has the type you expect, not whether a function is allowed to do what it
does. Ambit moves that judgement out of convention and into an executable
contract.

## Quick start

Requires Node.js 24.

```sh
git clone https://github.com/sano-suguru/ambit.git && cd ambit && pnpm install
node src/cli/main.ts check src
```

That last command needs nothing prepared — it checks Ambit's own source:

```console
warning: extractProject declares fs_read but calls something that could not be resolved (checker/backend/legacy-ts.ts:55)
warning: loadProjectConfig declares fs_read but calls something that could not be resolved (checker/backend/legacy-ts.ts:164)
...
files=37 functions=286 declared=11
```

Point `check` at your own directory next, and run `ambit init` to have it
propose `@effects` for the functions that have none.

> **Not on npm yet.** To use Ambit in another project, build a tarball:
> `pnpm pack`, then `npm install -D /path/to/ambit-0.0.0.tgz`. `npm remove ambit`
> undoes it, and the `@effects` comments left behind still type-check and run.

See **[CLI and CI](#cli-and-ci)** below for the flags, the exit codes, and the
GitHub Actions output.

## What Ambit controls

Contracts are JSDoc tags on ordinary TypeScript. Two of them can also be
declared by the runtime registration beside a handler instead — see *Static
check, runtime block* below.

| Tag | Declares | Checked |
|---|---|---|
| `@effects` | what side effects a function may perform | statically, propagated through the call graph |
| `@capabilities` | which resources it may reach | statically — may only narrow from caller to callee — and at run time by four hooks |
| `@budget` | how much an entrypoint may spend | parsed and validated; of its three limits only `timeMs` is enforced while the code runs |
| `@entrypoint` | where a request enters | warned when it declares no capability set (`AMB-W002`) |
| `@boundary reason="…"` | that a body is not analysed, and its declared contract is trusted in its place | counted separately in `--coverage` |

Which tag is enforced where, tag by tag, is in
[docs/status.md](docs/status.md#contract-tag-support-at-a-glance).

Effects are inferred from bundled tables covering `fetch`/`undici`, the
`node:fs`, `node:http`/`https`/`net`, and `node:child_process` builtins, and
five clients (`pg`, `mysql2`, `@prisma/client`, `openai`,
`@anthropic-ai/sdk`). Everything else resolves to `unknown` — never to `pure` —
and `--strict` turns those warnings into errors.

For code you cannot edit — third party, generated, or not yours yet — declare
the same contracts in `ambit.config.ts`:

```ts
import { defineConfig } from "ambit/config";

export default defineConfig({
  effects: { payments: ["network", "db_write"] },
  contracts: {
    "src/legacy/billing.ts#charge": { effects: ["payments"] },
  },
  strict: ["src/app/**"],
});
```

Where a symbol has both, the JSDoc contract is the one in force and the
difference is reported as a warning (`AMB-W005`). `ambit init --config`
proposes config entries for the declarations no comment can carry — accessors,
anonymous default exports, and a class with no constructor.

## Static check, runtime block

`ambit check` reads the source and nothing that runs, so adopting the static
check means writing the declarations and nothing more. Runtime enforcement is
the opposite: it is adopted **per entrypoint**. Every entrypoint needs its own
`withAmbit` or adapter registration, and a JSDoc tag alone never turns it on.

```ts
import { installFetchHook, withAmbit } from "ambit/runtime";

installFetchHook();

/**
 * @entrypoint
 * @effects network
 */
async function refreshRates(currency: string): Promise<void> {
  await fetch(`https://api.example.com/rates?base=${currency}`);
  // await fetch("https://elsewhere.example/steal"); // AMB-E009 if this line is added
}

export const refresh = withAmbit(
  {
    capabilities: ["http:get:api.example.com"],
    budget: { timeMs: 500, costUsd: 0.01, onExceed: "throw" },
  },
  refreshRates,
);
```

That file passes `ambit check` as written; uncommenting the second `fetch`
fails it.

**The capability list and the budget are written once, in the registration.**
A literal `spec` whose `handler` names a declaration in the same file *is* that
handler's `@capabilities` and `@budget`, so the checker reads the same values
the runtime will enforce. That keeps the contract a value in the module, which
survives a build that strips comments and a bundler that renames everything.
`@effects` and `@entrypoint` stay in the JSDoc, because the runtime never reads
them. Writing the tags as well is still allowed and still checked —
`AMB-E010` / `AMB-E011` fail the check if the two halves disagree.
(`docs/DESIGN.md` §4.1 "Where declarations live" has the full rule; §4.4 "The
range this does not reach" covers what happens when a `spec` cannot supply the
declaration.)

At run time `withAmbit` puts that capability set on the context, and four hooks
check operations against it — `installFetchHook()`, `installFsHook()`,
`installChildProcessHook()`, `installPgHook(pg)`. An ungranted operation throws
`AmbitCapabilityError` before the socket, the file, or the process is reached,
every decision is recorded on the context's audit trail, and `timeMs` is
measured against the wall clock. Each install returns the function that
restores the original, so removing Ambit is one call.

A grant names `http:<method>:<host>`, `fs:read:` / `fs:write:` with the path
resolved to an absolute path at the call, `proc:spawn:` with argv[0] as
written, or `db:read:` / `db:write:` with the database the connection names.

### Framework adapters

On Hono, the adapter registers the same handler instead of a hand-written
`withAmbit`:

```ts
import { Hono } from "hono";
import { ambitHandler } from "ambit/runtime/hono";

const app = new Hono();

app.get("/rates", ambitHandler(
  { capabilities: ["http:get:api.example.com"], budget: { timeMs: 500 } },
  refreshRates,
  (c) => [c.req.query("currency") ?? "USD"] as const,
));
```

Next.js App Router is supported for Node.js **Route Handlers** in
`app/**/route.ts`, through `ambitRoute`. Server Actions, `middleware.ts`, the
Pages Router, and any route on the Edge runtime are **not enforced** — see
[docs/integrations/nextjs.md](docs/integrations/nextjs.md) for the registration,
the `instrumentation.ts` hook install, and the coverage table.

Express, BullMQ and the rest have no adapter. A route registered without one
establishes no context, and `setUnscopedPolicy("allow" | "warn" | "deny")`
decides what its operations do — `allow` by default, so adopting the runtime
does not break code that has no contracts yet.

## CLI and CI

| Command | What it does |
|---|---|
| `ambit check <dir>` | Static check. `--coverage`, `--strict`, `--format json`, `--format github` |
| `ambit init <dir>` | Proposes `@effects` for undeclared functions. `--config` for the ones no comment can carry |
| `ambit diff <ref> [dir]` | Compares the working tree's authority against a base ref and fails on an increase |

Exit codes: **0** when nothing was reported, **1** on an error, **2** when the
analysis itself could not run. That exit code is the whole CI integration:

```yaml
- run: npx ambit check src --strict
```

`--format github` turns each diagnostic into a GitHub Actions annotation on the
declaration that broke, carrying the whole call path into the pull request:

```console
$ node src/cli/main.ts check test/fixtures/accident --format github; echo "exit=$?"
::error file=test/fixtures/accident/pricing.ts,line=4,col=17,title=AMB-E001::priceOrder declares pure but calls currentRate which has effects [network]%0A-> applyTax (tax.ts:3)%0A-> currentRate (rates.ts:3)%0Aoperation: fetch (rates.ts:4)
files=3 functions=3 declared=1
exit=1
```

## For coding agents

`check --format json` emits NDJSON — one diagnostic per line, then a summary
line — meant to be piped into an agent loop. Where a diagnostic carries a
patch, the agent applies the edits and re-checks without a human in the loop;
`AMB-E001` is the one that carries a patch today.

```console
$ node src/cli/main.ts check src --format json
{"id":"AMB-E001","severity":"error","contract":{"declared":["pure"],"observed":["network"]},"fixes":[{"kind":"widen","consistentWithContract":false,"edits":[{"file":"tax.ts","range":[[0,4],[0,17]],"replacement":"@effects network"}]}], ...}
{"kind":"summary","filesAnalyzed":1,"functionsExtracted":1,"functionsDeclared":1}
# the agent applies fixes[0].edits — ranges are 0-based, end-exclusive
$ node src/cli/main.ts check src --format json    # re-check
```

The patch Ambit offers widens the contract to what the code actually does. It
is marked `consistentWithContract: false` and carries the callers it would
affect, so the agent — or the human reading its output — can tell "the contract
was wrong" from "the code was wrong". Ambit does not invent the other patch,
the one that keeps the contract and rewrites the code.

## Why not ESLint / Effect-TS / dependency-cruiser

| Tool | Primary abstraction |
|---|---|
| ESLint | code-level lint rules |
| dependency-cruiser | module dependency edges |
| Effect-TS | effects represented in program values and types |
| **Ambit** | **authority propagated across function calls** |

Ambit's abstraction is the authority a function holds after propagation, which
is why a `pure` function calling an undeclared helper that calls `fetch` is an
error on the pure function, with the path reported — no single file contains the
violation. A module graph that is entirely legal can still contain a `pure`
helper that opens a socket. And where Effect-TS puts effects in the types of the
values you construct — so the code is written in that style throughout — Ambit's
static contracts are JSDoc comments on ordinary TypeScript: adding them changes
no runtime behavior, and removing Ambit is a small diff.

## What Ambit does not guarantee

Ambit stops the violations it can detect and states the rest. It does **not**
claim:

- **Whole-program soundness.** No alias analysis is performed: a locally created
  value handed elsewhere and then mutated (`sink(out); out.push(x)`) still reads
  as local mutation. Property and method calls resolve from the receiver's
  value, which `const` does not freeze.
- **That `unknown` is safe.** A call Ambit cannot resolve is reported and
  counted, never folded into `pure`. `--strict` makes it an error.
- **Enforcement on the Edge runtime.** Every hook Ambit installs is a Node.js
  one, so an Edge route has no capability checked at all.
- **Interception beyond four hooks.** `fetch`, `node:fs`, `node:child_process`
  and `pg`. `mysql2`, Prisma and the LLM SDKs have static effects but no hook,
  so calling them is neither blocked nor recorded. Native addons, child
  processes, and other `worker_threads` workers are outside every hook.
- **That the declaration cannot simply be widened.** `check` validates code
  against the contract currently written, so changing the contract can make it
  green again. `ambit diff <ref>` is what reviews increases in authority, and it
  has documented blind spots of its own
  ([limitations](docs/limitations.md#what-ambit-diff-can-and-cannot-see)).
- **Targets finer than the resource.** A database target names the database, not
  the table — Ambit does not read table names out of SQL — and a shell spawn
  names the shell, not the program inside the command string.
- **That `costUsd` and `llmCalls` are enforced.** They are parsed and validated.
  Nothing increments them.

[docs/limitations.md](docs/limitations.md) has all of this in detail.

## Status

Ambit is experimental and not production-ready; diagnostic ids and the NDJSON
field shape can still change. `check src` over Ambit's own source — 37 files,
286 functions — takes 1.04–1.21 s across five runs; `diff HEAD src`, which
analyzes two trees, takes 1.83–2.56 s across five runs. Nothing is cached, so a
re-check costs the same. The analysis backend has been measured on a
300-file project (458 ms, 348 MiB peak) as part of choosing it; the CLI on top
of it has not. What is implemented and what is not, milestone by milestone with
the measured numbers behind it, is in [docs/status.md](docs/status.md).

The analysis runs on the TypeScript Compiler API (`typescript` 6.0.3, the
JavaScript implementation). That is a decision, not an accident: native
TypeScript 7 (the Go implementation) is three to four times faster and was still
not adopted, because its API is published entirely under `unstable/` and,
unless it is told which files changed, it answers from a stale snapshot without
saying so.
[ADR-0001](docs/adr/0001-analysis-backend.md) records the decision and what
would reopen it.

## Docs / License

- [docs/DESIGN.md](docs/DESIGN.md) — the product specification.
- [docs/adr/](docs/adr/README.md) — why each design is the one in the spec.
- [docs/diagnostics/](docs/diagnostics/README.md) — the diagnostic code ledger.
- [docs/limitations.md](docs/limitations.md) — where the analysis is narrower
  than the model suggests.
- [docs/status.md](docs/status.md) — what is implemented, with measured numbers.
- [ROADMAP.md](ROADMAP.md) — milestones and the Phase 1 exit criterion.

MIT licensed; see [LICENSE](LICENSE). Ambit is one person's experiment:
no support commitment, no release schedule yet.
