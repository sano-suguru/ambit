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
  validated; of its three limits only `timeMs` is enforced while the code runs.
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
rewrites a codebase in one session. AI has cut the cost of producing code, not
the cost of judging it. Ambit moves that judgement out of convention and into
an executable contract.

## What is actually enforced

Contracts are JSDoc tags on ordinary TypeScript. `@effects` says what side
effects a function may perform, `@capabilities` which resources it may reach,
`@budget` how much an entrypoint may spend, `@entrypoint` marks where a request
enters, and `@boundary reason="…"` stops analysis of a body and trusts its
declared contract in its place.

```ts
import { installFetchHook, withAmbit } from "ambit/runtime";

installFetchHook();

/**
 * @entrypoint
 * @effects network
 * @capabilities http:get:api.example.com
 * @budget timeMs=500 costUsd=0.01
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
fails it. The capability list appears twice on purpose: the JSDoc is what the
checker reads, the literal array is what the runtime enforces, and `AMB-E010`
fails the check if the two ever disagree. `budget` is duplicated the same way
and checked the same way (`AMB-E011`), so widening `timeMs` in one half alone
fails too.

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

The contract travels as a value in the module, so it reaches the running
handler after a build that strips the comments and after a bundler renames
everything — the runtime reads no JSDoc and no file paths. The third argument
maps the request to the handler's arguments, which keeps the framework's own
API (`c.req.*`, in no stub table) out of the contract-bearing function. A route
registered without the adapter establishes no context at all, and what its
operations do then is `setUnscopedPolicy`'s decision.

Runtime enforcement is therefore adopted **per entrypoint**: every entrypoint
needs its own `withAmbit` or `ambitHandler` registration — roughly six lines
per route in `test/fixtures/realistic-api` — and JSDoc tags alone never turn it
on. The static check is the opposite: `ambit check` reads the JSDoc and nothing
else, so adopting it means writing the tags and nothing more (keying contracts
to `method + path`, so that one middleware could cover every route, was
reconsidered and rejected — DESIGN.md §4.4). `AmbitCapabilityError`
and `AmbitBudgetError` are not translated into HTTP statuses: they go to the
framework's error handler, because a denial means this server's own code
exceeded its grant, which is not what 403 says.

At run time `withAmbit` puts that same set on the context, and four hooks
check operations against it: `installFetchHook()` for `globalThis.fetch`,
`installFsHook()` for `node:fs` and `node:fs/promises`,
`installChildProcessHook()` for `node:child_process`, and
`installPgHook(pg)` for the `pg` client. An ungranted operation throws
`AmbitCapabilityError` before the socket, the file, or the process is
reached; every decision, allowed or denied, is recorded on the context's
audit trail; and `timeMs` is measured against the wall clock. Each install
returns the function that restores the original, so removing Ambit is one
call. Outside any entrypoint
`setUnscopedPolicy("allow" | "warn" | "deny")` decides, defaulting to `allow`,
so adopting the runtime does not break code that has no contracts yet.

The capability targets are `http:<method>:<host>`, `fs:read:` / `fs:write:`
with the path resolved to an absolute path at the call, `proc:spawn:` with
argv[0] as written, and `db:read:` / `db:write:` with **the database the
connection names**. A hook on a database client does not make table-level
permissions decidable: Ambit does not read table names out of SQL, and the
exception says so where a grant like `db:read:users` fails. A shell spawn
names the shell, not the program inside the command string, and says that
too.

| | Static check | Runtime block | Audit only | Unsupported |
|---|---|---|---|---|
| `@effects` | yes | — | — | — |
| `@capabilities`, caller→callee narrowing | yes | — | — | — |
| `@capabilities`, `globalThis.fetch` | — | yes | recorded on the context | — |
| `@capabilities`, literal URL in source | yes (`http:<method>:<host>`) | — | — | — |
| `@capabilities`, URL built at runtime | warns (`AMB-W003`) | yes, for `fetch` | recorded on the context | — |
| `@capabilities`, `node:fs` / `node:fs/promises` | — | yes (`fs:read:` / `fs:write:`, absolute path) | recorded on the context | a named ESM import bound before the hook was installed |
| `@capabilities`, `node:child_process` | — | yes (`proc:spawn:`, argv[0] as written) | recorded on the context | which program a shell command string runs |
| `@capabilities`, `pg` (`Pool`/`Client.query`) | — | yes (`db:read:` / `db:write:`, per database) | recorded on the context | table-level targets |
| `@capabilities`, DB table / LLM target | — | — | — | never derived, from source or from SQL at run time |
| `@effects` for the covered Node APIs, and for `pg` | yes | — | — | — |
| `@effects` for `mysql2`, `@prisma/client`, other DB clients | yes | — | — | no runtime hook |
| `@effects` for the LLM SDKs (`openai`, `@anthropic-ai/sdk`) | yes | — | — | no runtime hook |
| `@budget timeMs` | — | yes (`throw` / `warn` / `abort`) | — | — |
| `@budget costUsd`, `llmCalls` | parsed and validated | — | — | no hook increments them |
| `@entrypoint` vs. the `withAmbit` / `ambitHandler` beside it | yes, in the same file: the capability set (`AMB-E010`) and the budget (`AMB-E011`) | — | — | a spec and handler split across modules (`AMB-W004`) |
| `@entrypoint` handler → runtime context | — | yes, via `withAmbit` or `ambit/runtime/hono` | recorded on the context | Express, Next.js, BullMQ — unadapted |

Effects are inferred from bundled tables covering `fetch`/`undici`, the
`node:fs`, `node:http`/`https`/`net`, and `node:child_process` builtins, and
five clients (`pg`, `mysql2`, `@prisma/client`, `openai`,
`@anthropic-ai/sdk`). Everything else resolves to `unknown` — never to `pure`,
and `--strict` turns those warnings into errors. Matching a contract to the
handler that actually runs is settled by explicit registration (DESIGN.md
§4.4), which is why the set is written twice; removing that duplication would
take a build-time transform, and that is still open.

## Why not ESLint / Effect-TS / dependency-cruiser

**ESLint custom rules.** A lint rule fires on the AST node in front of it.
Ambit's unit is the call graph: an `@effects pure` function that calls an
undeclared helper that calls `fetch` is an error on the pure function, with the
path reported. Where a call cannot be resolved, Ambit reports `unknown`
instead of passing it, so the frontier of the analysis stays visible rather
than silently counting as safe.

**Effect systems such as Effect-TS.** There, effects live in the types of the
values you construct, so the code is written in that style throughout. Ambit's
contracts are JSDoc comments on ordinary TypeScript: adding them changes no
runtime behavior, removing Ambit is a small diff, and the code still
type-checks and runs either way.

**dependency-cruiser.** Its rules constrain the import edges between modules.
Ambit's unit is one function: what it may do, and which resource it may touch.
A module graph that is entirely legal can still contain a `pure` helper that
opens a socket.

## Designed for coding agents

`check --format json` emits NDJSON: one diagnostic per line, then a summary
line, meant to be piped into an agent loop:

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

## Quick start

```sh
git clone https://github.com/sano-suguru/ambit.git && cd ambit && pnpm install && node src/cli/main.ts check src
```

Requires Node.js 24. That last command needs nothing prepared — it checks
Ambit's own source: 29 files, 236 functions, 0.87–1.35 s across five runs.
Nothing is cached, so a re-check costs the same, and nothing larger than that
has been measured yet; `docs/status.md` has the numbers.

Point `check` at your own directory instead, with `--coverage`, `--strict`, or
`--format json`. `ambit init` proposes `@effects` for undeclared functions, and
proposes nothing for one that reached `unknown`. `check` exits 0 when nothing
was reported, 1 on an error, and 2 when the analysis itself could not run.

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

To use Ambit in another project, build a tarball — it is not published to npm
yet:

```sh
pnpm pack                                   # → ambit-0.0.0.tgz
cd /path/to/your-project
npm install -D /path/to/ambit/ambit-0.0.0.tgz && npx ambit check src
```

`npm remove ambit` undoes it; the `@effects` comments left behind still
type-check and run. Both paths are covered by `test/e2e.install.test.ts`. In
CI, the exit code is the whole integration:

```yaml
- run: npx ambit check src --strict
```

## Status

Ambit is experimental and not production-ready; diagnostic ids and the NDJSON
field shape can still change. What is implemented and what is not, milestone by
milestone with the measured numbers behind it, is in
[docs/status.md](docs/status.md).

## Docs / License

- [docs/DESIGN.md](docs/DESIGN.md) — the product specification, written in
  Japanese; the other documents here are English.
- [docs/diagnostics/](docs/diagnostics/README.md) — the diagnostic code ledger.
- [docs/limitations.md](docs/limitations.md) — where the analysis is narrower
  than the model suggests.

MIT licensed; see [LICENSE](LICENSE). Ambit is one person's experiment:
no support commitment, no release schedule yet.
