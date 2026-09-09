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

In CI the same run annotates the declaration that broke, carrying the whole
path into the pull request:

```console
$ node src/cli/main.ts check test/fixtures/accident --format github; echo "exit=$?"
::error file=test/fixtures/accident/pricing.ts,line=4,col=17,title=AMB-E001::priceOrder declares pure but calls currentRate which has effects [network]%0A-> applyTax (tax.ts:3)%0A-> currentRate (rates.ts:3)%0Aoperation: fetch (rates.ts:4)
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
does. For human-written code that gap is closed by review and convention, which
do not scale when an agent rewrites a codebase in one session. AI has cut the
cost of producing code, not the cost of judging it. Ambit moves that judgement
out of convention and into an executable contract.

## Quick start

```sh
git clone https://github.com/sano-suguru/ambit.git && cd ambit && pnpm install && node src/cli/main.ts check src
```

Requires Node.js 24. That last command needs nothing prepared — it checks
Ambit's own source. Point `check` at your own directory instead, with
`--coverage`, `--strict`, `--format json`, or `--format github`. `ambit init`
proposes `@effects`
for undeclared functions, and proposes nothing for one that reached `unknown`.
`check` exits 0 when nothing was reported, 1 on an error, and 2 when the
analysis itself could not run.

To use Ambit in another project, build a tarball — it is not published to npm
yet:

```sh
pnpm pack                                   # → ambit-0.0.0.tgz
cd /path/to/your-project
npm install -D /path/to/ambit/ambit-0.0.0.tgz && npx ambit check src
```

`npm remove ambit` undoes it; the `@effects` comments left behind still
type-check and run. In CI, the exit code is the whole integration:

```yaml
- run: npx ambit check src --strict
```

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

`@capabilities` and `@budget` are also what a `withAmbit` / `ambitHandler`
registration writes. A literal one is that handler's declaration, so the tag
need not repeat it; where both are written and they disagree, the check fails
(`AMB-E010`, `AMB-E011`).

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
`withAmbit` or `ambitHandler` registration, and a JSDoc tag alone never turns
it on.

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
fails it. The capability list and the budget are written **once**, in the
registration: a literal `spec` whose `handler` names a declaration in the same
file *is* that handler's `@capabilities` and `@budget`, so the checker reads
the same values the runtime will enforce. Writing the tags as well is still
allowed and still checked — `AMB-E010` / `AMB-E011` fail the check if the two
halves ever disagree. Keeping the contract in the `spec` rather than the
comment is what makes it a value in the module, so it survives a build that
strips the comments and a bundler that renames everything.

`@effects` and `@entrypoint` stay in the JSDoc. The dividing line is whether
the runtime needs the value: the hooks match against `capabilities` and the
budget's `timeMs` is measured against the wall clock, while `@effects` is only
ever read statically (DESIGN.md §4.1「宣言の出所」).

Where a `spec` cannot supply the declaration — a capability list or budget
built at runtime, or a handler declared in another module — the JSDoc tag is
still required. Those registrations are reported as `AMB-W004`, and an
entrypoint left with no capability set is `AMB-W002` on top of it; neither is
silently treated as unknown.

On Hono, the adapter registers the same handler instead of a hand-written
`withAmbit`:

```ts
import { Hono } from "hono";
import { ambitHandler } from "ambit/runtime/hono";

const app = new Hono();

app.get("/rates", ambitHandler(
  { capabilities: ["http:get:api.example.com"], budget: { timeMs: 500, costUsd: 0.01 } },
  refreshRates,
  (c) => [c.req.query("currency") ?? "USD"] as const,
));
```

### Next.js (App Router)

On Next.js the adapter registers a Route Handler. `app/**/route.ts` exports one
function per HTTP method, so the contract goes in the `ambitRoute` call the
method is assigned from:

```ts
// app/rates/route.ts
import { ambitRoute } from "ambit/runtime/next";

/**
 * @entrypoint
 * @effects network
 */
async function currentRate(currency: string): Promise<{ readonly rate: number }> {
  const response = await fetch(`https://api.example.com/rates?base=${currency}`);
  return (await response.json()) as { readonly rate: number };
}

export const GET = ambitRoute(
  { capabilities: ["http:get:api.example.com"], budget: { timeMs: 500 } },
  currentRate,
  (request) => [request.nextUrl.searchParams.get("base") ?? "USD"] as const,
);
```

The hooks have to be installed once per server process, before any route runs.
Next.js has one place for that — `instrumentation.ts` at the project root, whose
`register()` it calls once at startup:

```ts
// instrumentation.ts
import {
  installChildProcessHook,
  installFetchHook,
  installFsHook,
} from "ambit/runtime";

export function register(): void {
  // `register()` runs on the Edge runtime too, where none of these hooks
  // apply — `node:fs` and `node:child_process` do not exist there and nothing
  // would be enforced. The Node.js runtime is the only one that gets them.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  installFetchHook();
  installFsHook();
  installChildProcessHook();
}
```

`installPgHook(pg)` goes there too where the app uses `pg`; it takes the module
from the caller rather than importing it, so it is left out above to keep the
snippet dependency-free.

**A route on the Edge runtime is not enforced.** `export const runtime = "edge"`
takes the route off Node.js, and every hook Ambit installs is a Node.js one —
`node:fs` and `node:child_process` do not exist there, and the `register()`
above deliberately installs nothing when `NEXT_RUNTIME` is not `nodejs`, so
**no capability is checked** on such a route: nothing is intercepting the
operations. Nothing else about `ambitRoute` on Edge is claimed either — no test
runs there, so whether the context is established at all is unverified. Phase 1
guarantees the Node.js runtime only (DESIGN.md §12「エッジランタイム」), and the
honest form for an Edge route today is to leave it unwrapped, so that nothing
about it reads as enforced.

At run time `withAmbit` puts that same set on the context, and four hooks check
operations against it — `installFetchHook()`, `installFsHook()`,
`installChildProcessHook()`, `installPgHook(pg)`. An ungranted operation throws
`AmbitCapabilityError` before the socket, the file, or the process is reached,
every decision is recorded on the context's audit trail, and `timeMs` is
measured against the wall clock. Each install returns the function that
restores the original, so removing Ambit is one call.

A grant names `http:<method>:<host>`, `fs:read:` / `fs:write:` with the path
resolved to an absolute path at the call, `proc:spawn:` with argv[0] as
written, or `db:read:` / `db:write:` with the database the connection names.
Which tag is enforced where, tag by tag, is in
[docs/status.md](docs/status.md#contract-tag-support-at-a-glance).

## Why not ESLint / Effect-TS / dependency-cruiser

| Tool | What it constrains |
|---|---|
| ESLint | the AST node in front of the rule |
| dependency-cruiser | the import edges between modules |
| Effect-TS | effects encoded in the values you construct |
| **Ambit** | **what one function may do, and which resource it may touch** |

**ESLint custom rules.** A lint rule fires on the AST node in front of it.
Ambit's unit is the call graph: an `@effects pure` function that calls an
undeclared helper that calls `fetch` is an error on the pure function, with the
path reported. Where a call cannot be resolved, Ambit reports `unknown` instead
of passing it, so the frontier of the analysis stays visible rather than
silently counting as safe.

**Effect systems such as Effect-TS.** There, effects live in the types of the
values you construct, so the code is written in that style throughout. Ambit's
static contracts are JSDoc comments on ordinary TypeScript: adding them changes no
runtime behavior, removing Ambit is a small diff, and the code still
type-checks and runs either way.

**dependency-cruiser.** Its rules constrain the import edges between modules. A
module graph that is entirely legal can still contain a `pure` helper that
opens a socket.

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

## Limitations

- **`unknown` is not `pure`.** A call Ambit cannot resolve is reported and
  counted, and `--strict` makes it an error.
- **Widening the declaration silences the check.** An agent that edits the
  `@effects` tag along with the code — including by applying the `widen` fix
  Ambit itself offers — gets a green check again: measured on the example
  above, `pure` → `network` on `priceOrder` takes it from exit 1 to exit 0.
  Catching that needs a comparison against a base ref, which Ambit does not
  have.
- **Four runtime hooks, no more.** `fetch`, `node:fs`, `node:child_process` and
  `pg`. `mysql2`, Prisma and the LLM SDKs have static effects but no hook, so
  calling them is neither blocked nor recorded.
- **`costUsd` and `llmCalls` are parsed and validated, not enforced.** Nothing
  increments them.
- **A database target names the database, not the table.** Ambit does not read
  table names out of SQL, and a shell spawn names the shell, not the program
  inside the command string.
- **One framework adapter (Hono).** A route registered without it establishes
  no context, and `setUnscopedPolicy("allow" | "warn" | "deny")` decides what
  its operations do — `allow` by default, so adopting the runtime does not
  break code that has no contracts yet.

[docs/limitations.md](docs/limitations.md) has the rest, in detail.

## Status

Ambit is experimental and not production-ready; diagnostic ids and the NDJSON
field shape can still change. `check src` over Ambit's own source — 29 files,
238 functions — takes 0.88–1.24 s across five runs. Nothing is cached, so a
re-check costs the same. The analysis backend has been measured on a
300-file project (458 ms, 348 MiB peak) as part of choosing it; the CLI on top
of it has not. What is implemented and what is not, milestone by milestone with
the measured numbers behind it, is in [docs/status.md](docs/status.md).

The analysis runs on the TypeScript Compiler API (`typescript` 6.0.3, the
JavaScript implementation). That is a decision, not an accident: it was
compared against native TypeScript 7 (the Go implementation), which is three to
four times faster and was still not adopted — its API is published entirely
under `unstable/`, it answers from a stale snapshot without saying so unless it
is told which files changed, and none of its speed was needed to meet any
threshold set beforehand. [docs/DESIGN.md](docs/DESIGN.md) §3.5 records the
decision and what would reopen it; [docs/status.md](docs/status.md) has the
measurements.

## Docs / License

- [docs/DESIGN.md](docs/DESIGN.md) — the product specification, written in
  Japanese; the other documents here are English.
- [docs/diagnostics/](docs/diagnostics/README.md) — the diagnostic code ledger.
- [docs/limitations.md](docs/limitations.md) — where the analysis is narrower
  than the model suggests.

MIT licensed; see [LICENSE](LICENSE). Ambit is one person's experiment:
no support commitment, no release schedule yet.
