# Ambit

**Review changes in what AI-written TypeScript is allowed to do.**

A code diff says what changed. An authority diff says what became possible.

An agent can widen a function's authority faster than a human can review it.
Ambit makes authority explicit in the source, checks it, and puts increases in
front of a reviewer.

- **Contracts** declare a function's authority, as JSDoc on ordinary
  TypeScript.
- **`ambit check`** fails code that exceeds the contract written today.
- **`ambit diff`** fails a change that grants authority the base commit did
  not, unless an approval in the same change covers it.

The third exists because the second can be satisfied by editing the contract
rather than the code, which is what the demonstration below does.

Experimental, `0.x`, and not a sandbox. Known blind spots are documented in
[What Ambit does not guarantee](#what-ambit-does-not-guarantee).

## Quick start

Requires Node.js 24.

```sh
npm i -D ambit-ts
npx ambit init src       # propose `@effects` for the functions that have none
npx ambit check src      # check the code against what they now declare
npx ambit diff HEAD src  # and what the change to them allows that HEAD did not
```

The contracts are JSDoc, so `npm remove ambit-ts` leaves ordinary TypeScript
that still type-checks and runs. The flags, the exit codes, and the GitHub
Actions output are in **[CLI and CI](#cli-and-ci)**.

## The accident, and the fix that is not one

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

No file here contains both the declaration and the `fetch`, and each is locally
unremarkable — a rates module fetching a rate. The violation exists only in the
path between the three, which is why a rule that reads one file at a time has
nothing to fire on.

Now the second edit — the one Ambit itself offers as a fix candidate, in the
`--format json` output an agent reads (`"kind":"widen"`):

```diff
-/** @effects pure */
+/** @effects network */
 export function priceOrder(subtotal: number, region: string): number {
```

```console
$ node src/cli/main.ts check test/fixtures/accident; echo "exit=$?"
files=3 functions=3 declared=1
exit=0
```

Green. Nothing about the code moved — `priceOrder` still reaches the same
`fetch` through the same two calls. What changed is that it is now allowed to.
`check` validates code against the contract currently written, so widening the
contract is always a way to pass it. That is what the second gate reads:

```console
$ node src/cli/main.ts diff HEAD test/fixtures/accident; echo "exit=$?"
base HEAD (58d9a0b) vs the working tree, over test/fixtures/accident

1 authority increased without approval:

  pricing.ts#priceOrder (pricing.ts:4)
    + network
      -> applyTax (tax.ts:3)
      -> currentRate (rates.ts:3)
      operation: fetch (rates.ts:4)
    - `pricing.ts#priceOrder` `effect:network` — <why this increase is correct>

Add each line above to ambit.approvals.md, with the reason, and
commit it in the same change (DESIGN.md §6.3). An approval already in the base
grants nothing.

2 symbols unchanged, out of 3 symbols compared.
exit=1
```

That is a real run, with `test/fixtures/accident`'s declaration widened in the
working tree. The path is the one `check` printed, and the last line is what to
paste into `ambit.approvals.md` if the increase is the correct change. Only
increases are gated — narrowing is never taxed — and an approval that was
already in the base grants nothing, so the record is made in the change that
makes the increase.

TypeScript accepts both edits: the types line up either way. It tells you
whether a value has the type you expect, not whether a function is allowed to do
what it does.

## Where this sits

| Tool | Primary abstraction |
|---|---|
| TypeScript | the types of values |
| ESLint | code-level lint rules |
| dependency-cruiser | module dependency edges |
| Effect-TS | effects represented in program values and types |
| a runtime sandbox | isolation of the running process |
| **Ambit** | **authority propagated across function calls, and the change in it** |

Ambit's abstraction is the authority a function holds after propagation, which
is why a `pure` function calling an undeclared helper that calls `fetch` is an
error on the pure function, with the path reported — no single file contains the
violation. A module graph that is entirely legal can still contain a `pure`
helper that opens a socket. And where Effect-TS puts effects in the types of the
values you construct — so the code is written in that style throughout — Ambit's
static contracts are JSDoc comments on ordinary TypeScript: adding them changes
no runtime behavior, and removing Ambit is a small diff.

A sandbox is the other axis: it decides what a process may do while it runs, and
knows nothing about which function asked. Ambit's runtime hooks are the narrow
overlap, opt-in per entrypoint — *Static check, runtime block*, below.

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

Effects are inferred from bundled tables covering `fetch`/`undici`/`ky`, the
`node:fs`, `node:http`/`https`/`net`, and `node:child_process` builtins (with
or without the `node:` prefix), and six clients (`pg`, `mysql2`, `knex`,
`@prisma/client`, `openai`, `@anthropic-ai/sdk`). Everything else resolves to `unknown` — never to `pure` —
and `--strict` turns those warnings into errors.

For code you cannot edit — third party, generated, or not yours yet — declare
the same contracts in `ambit.config.ts`:

```ts
import { defineConfig } from "ambit-ts/config";

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
import { installFetchHook, withAmbit } from "ambit-ts/runtime";

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
handler's `@capabilities` and `@budget`, so the checker reads the values the
runtime will enforce, and the contract survives a build that strips comments.
`@effects` and `@entrypoint` stay in the JSDoc, because the runtime never reads
them. Writing the tags as well is allowed and still checked — `AMB-E010` /
`AMB-E011` fail on a disagreement. `docs/DESIGN.md` §4.1 has the rule, and §4.4
the two registrations it cannot read.

At run time `withAmbit` puts that capability set on the context, and four hooks
check operations against it — `installFetchHook()`, `installFsHook()`,
`installChildProcessHook()`, `installPgHook(pg)`. An ungranted operation throws
`AmbitCapabilityError` before the socket, the file, or the process is reached,
every decision is recorded on the context's audit trail, and `timeMs` is
measured against the wall clock. Each install returns the function that
restores the original, so removing Ambit is one call.

A grant names `http:<method>:<host>`, `fs:read:` / `fs:write:`, `proc:spawn:`,
or `db:read:` / `db:write:`. What each target is taken from at the call, and why
a shell spawn names the shell rather than the program inside the command string,
is `docs/DESIGN.md` §4.4 "Target formats".

### Framework adapters

Two exist, and both carry the contract in the registration instead of a
hand-written `withAmbit`: `ambitHandler` on Hono
([docs/integrations/hono.md](docs/integrations/hono.md)), and `ambitRoute` on
Next.js App Router, for Node.js **Route Handlers** in `app/**/route.ts` only —
Server Actions, `middleware.ts`, the Pages Router and the Edge runtime are
**not enforced** ([docs/integrations/nextjs.md](docs/integrations/nextjs.md)).

Express, BullMQ and the rest have no adapter. A route registered without one
establishes no context, and `setUnscopedPolicy("allow" | "warn" | "deny")`
decides what its operations do — `allow` by default, so adopting the runtime
does not break code that has no contracts yet.

## CLI and CI

| Command | What it does |
|---|---|
| `ambit check <dir>` | Static check. `--coverage`, `--strict`, `--format json`, `--format github` |
| `ambit init <dir>` | Proposes `@effects` for undeclared functions, writing nothing. `--config` for the ones no comment can carry |
| `ambit diff <ref> [dir]` | Compares the working tree's authority against a base ref and fails on an increase no approval covers. `--strict` also fails where the analysis reached less than it did |

Exit codes: **0** when nothing was reported, **1** on an error, **2** when the
analysis itself could not run — never **0** for "could not tell". That exit code
is the whole CI integration:

```yaml
- run: npx ambit check src --strict
```

Both gates run in this repository's own workflow —
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) has the `diff` step, and
the comment above it on why the base ref it names is the right one only for a
repository that merges each pull request as a single commit.

`--format github` turns each diagnostic into a GitHub Actions annotation on the
declaration that broke, carrying the whole call path into the pull request:

```console
$ node src/cli/main.ts check test/fixtures/accident --format github; echo "exit=$?"
::error file=test/fixtures/accident/pricing.ts,line=4,col=17,title=AMB-E001::priceOrder declares pure but calls currentRate which has effects [network]%0A-> applyTax (tax.ts:3)%0A-> currentRate (rates.ts:3)%0Aoperation: fetch (rates.ts:4)
files=3 functions=3 declared=1
exit=1
```

`diff` annotates the same way, and an increase that *was* approved stays
visible as a `::notice` carrying the reason that was given, rather than
disappearing — the point of the ledger is that no increase passes unseen.

Three rules decide what counts. A **new symbol** has no base to compare
against, so the authority it holds is an increase in full — added code is not
exempt for having no history. A **capability** is compared by containment, not
by text: `http:get:*` narrowing to `http:get:api.example.com` is not an
increase, and the reverse is. And each authority is approved **separately**, so
a function that gains both an effect and a capability needs two lines.

A change can also make Ambit see *less* than it did — a call through a client no
stub table covers, added to a function that was already `unknown`. That is not
authority and is not approved by a line; `diff` reports it in its own section
and exits 0, and `diff --strict` is what turns it into a failure. Leave the flag
off until the packages you call are covered by stubs — `docs/limitations.md`
says why.

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

The patch widens the contract to what the code actually does — the second edit
in *The accident*, above. It is marked `consistentWithContract: false` and
carries the callers it would affect, so the reader can tell "the contract was
wrong" from "the code was wrong". Ambit does not invent the other patch, the one
that keeps the contract and rewrites the code; `ambit diff` is what keeps the
widening one from being applied in silence.

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
- **That a green `check` means the authority did not change.** `check` validates
  code against the contract currently written, so widening the contract makes it
  green again — *The accident*, above. Reviewing the increase is `ambit diff`'s
  job, and the next bullet is what that misses.
- **That `ambit diff` sees every increase.** It compares the symbols both sides
  extracted, and a handler written inline in argument position —
  `router.post("/x", async (ctx) => { … })` — is not an extracted function, so
  authority added inside its body is reported by nothing, in `diff` and
  `diff --strict` alike. Binding the handler to a name makes it an ordinary
  symbol again. A function renamed within a file, or moved in a way git did not
  report as a rename, reads as a deletion plus a new symbol instead — an
  over-report, which is the direction the comparison is built to fail in
  ([limitations](docs/limitations.md#what-ambit-diff-can-and-cannot-see)).
  `check --coverage`'s `unknown-rate` is what says how much was visible in the
  first place; a green `diff` on its own does not.
- **That an approved increase is a safe one.** An approval line in
  `ambit.approvals.md` records that an increase was put in front of a reviewer,
  in the same pull request, where it can be read. It does not record that the
  reviewer was right, and Ambit cannot check that a person wrote the line at
  all — branch protection and a `CODEOWNERS` entry on the file are what make
  that true.
- **Targets finer than the resource.** A database target names the database, not
  the table — Ambit does not read table names out of SQL — and a shell spawn
  names the shell, not the program inside the command string.
- **That `costUsd` and `llmCalls` are enforced.** They are parsed and validated.
  Nothing increments them.

[docs/limitations.md](docs/limitations.md) has all of this in detail.

## Status

Ambit is experimental and not production-ready. It is versioned `0.x`, and
semver's 0.x rule is in force: **a minor release may make a breaking change** —
diagnostic ids, the NDJSON field shape, and everything else on the guaranteed
surface can still move. What that surface is, and what is explicitly not on it,
is [DESIGN.md §9.2](docs/DESIGN.md#92-the-guaranteed-surface); every change to
it is announced in [CHANGELOG.md](CHANGELOG.md). `check src` over Ambit's own source — 40 files,
339 functions — takes 1.13–1.51 s across five runs; `diff HEAD src`, which
analyzes two trees, takes 2.03–2.25 s across five runs. Nothing is cached, so a
re-check costs the same. The analysis backend has been measured on a
300-file project (458 ms, 348 MiB peak) as part of choosing it; the CLI on top
of it has not. What is implemented and what is not, milestone by milestone with
the measured numbers behind it, is in [docs/status.md](docs/status.md).

The analysis runs on the TypeScript Compiler API (`typescript` 6.0.3, the
JavaScript implementation) rather than the faster native TypeScript 7, for
reasons [ADR-0001](docs/adr/0001-analysis-backend.md) records along with what
would reopen the decision.

## Working on Ambit itself

There is no build step during development: `.ts` runs directly under Node's
type stripping.

```sh
git clone https://github.com/sano-suguru/ambit.git && cd ambit && pnpm install
node src/cli/main.ts check src --coverage
```

That last command needs nothing prepared — it checks Ambit's own source, and
exit 0 is the fastest evidence a change did what it claimed:

```console
warning: extractProject declares fs_read but calls something that could not be resolved (checker/backend/legacy-ts.ts:55)
warning: loadProjectConfig declares fs_read but calls something that could not be resolved (checker/backend/legacy-ts.ts:165)
...
files=40 functions=339 declared=14
declared-by: jsdoc=14 config=0
unknown-rate=37.8% (128/339 functions) boundary-rate=0.0% (0/339 functions)
```

`pnpm test`, `pnpm exec tsc --noEmit` and `biome ci .` are the rest of the
gate; [AGENTS.md](AGENTS.md) is the working agreement, including what belongs
in which document.

## Docs / License

- [docs/DESIGN.md](docs/DESIGN.md) — the product specification.
- [docs/adr/](docs/adr/README.md) — why each design is the one in the spec.
- [docs/diagnostics/](docs/diagnostics/README.md) — the diagnostic code ledger.
- [CHANGELOG.md](CHANGELOG.md) — every breaking change to the guaranteed surface.
- [docs/limitations.md](docs/limitations.md) — where the analysis is narrower
  than the model suggests. Corner cases below that level are in
  [docs/analysis-limitations.md](docs/analysis-limitations.md).
- [docs/status.md](docs/status.md) — the current measured numbers, and the
  verdict they support. The runs behind them are in [docs/measurements/](docs/measurements/).
- [docs/open-questions.md](docs/open-questions.md) — what is undecided.
- [ROADMAP.md](ROADMAP.md) — what has to be proved next.
- [CONTRIBUTING.md](CONTRIBUTING.md) — how a change is proposed and verified.

MIT licensed; see [LICENSE](LICENSE). An *ambit* is the range of one's
authority, which is the thing this tracks. Ambit is one person's experiment:
no support commitment, no release schedule yet.
