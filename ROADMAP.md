# Roadmap

What Ambit has to **prove** next, in order. Not what it has to build — features
are how a proof gets attempted, not the goal.

The design is [`docs/DESIGN.md`](docs/DESIGN.md); what is actually implemented
today, with the measured numbers, is [`docs/status.md`](docs/status.md).

## Current product hypothesis

**Reviewers of TypeScript changes need authority-delta review on every pull
request** — a mechanical answer to "did this change let the code do something
it could not do before?", whoever wrote the change. The need is sharpest for
AI-assisted and agent-generated changes, because reading the diff no longer
scales to how fast the diff arrives.

Phase 1 validates this on real production-bound pull requests.

## Current bottleneck

**External pilot evidence.** `ambit-ts@0.2.0` installs from npm, and README's
Quick start and pull-request gate run as written outside this repository
([`docs/status.md`](docs/status.md)). The open question is whether authority
diffs change reviewer decisions on real production-bound pull requests, and
only a pilot can answer it.

`unknown` is the main technical risk to observe during that pilot, not a gate in
front of it. The corpus median is 52.9%, but on three third-party backends the
gate's usefulness tracked standing noise and whether real increases were
reported, not the rate ([`docs/status.md`](docs/status.md)). Which unresolved
names are worth fixing is answerable only from a pilot's own pull requests.

## Next proof

**One external repository uses `ambit diff` as a real CI signal** — gating, not
advisory, on a codebase nobody here wrote.

That is the first claim about Ambit that is not self-reported. Everything before
it is preparation for it:

| To prove | What would show it | Where it stands |
|---|---|---|
| The analysis sees enough of a real codebase to be worth gating | Corpus median `unknown` materially below 52.9% — enough that an external pilot is credible. **This is a pre-adoption heuristic with no target number, not a Phase 1 criterion** | 52.9% — [`docs/status.md`](docs/status.md) |
| The gate does not block honest work | An adopter's approval ledger stays under a handful of lines per pull request in steady state | Measured only on this repository: five lines for the change that introduced it |
| Contracts survive a real build | An adopter's bundled, minified production build enforces what its source declared | Verified in `test/e2e.*` only; no external build |
| The cost of backing out is real | An adopter removes Ambit and their code still type-checks and runs | `test/e2e.install.test.ts` proves it for a scratch project, not for an application |

The corpus figure is a pre-adoption heuristic and **not a Phase 1 criterion.**
The corpus is five repositories with no dependencies installed, measured by
whoever is working on Ambit; an adopting team's code, with its own
`node_modules`, is a different population, and its `unknown` rate is set largely
by which dependencies it uses. [`docs/status.md`](docs/status.md) says the same
thing beside the numbers themselves.

## Phase 1 exit criterion

**An external pilot team keeps `ambit diff` on its production-bound pull
requests, and its reports change what reviewers do.** Support for other
languages is considered only after that. Speeding up analysis alone does not
count.

Every item below is observable within one pilot — from its pull requests, its
approval ledger, and its reviewers. These are **candidate metrics**: none has a
numeric target, because there is no pilot baseline to set one against, and a
number chosen before one exists would be a guess.

### Evidence of product value

What Phase 1 has to show.

| Evidence | What would show it |
|---|---|
| Sustained use | `ambit diff` stays on as a CI signal for production-bound pull requests, rather than being switched off or routinely ignored |
| Authority increases detected | `ambit diff` reports increases on the pilot's own pull requests |
| Reviewer action | A report leads a reviewer to reject a change, narrow its scope, correct a contract, or write down why an increase is correct |
| A catch reviewers credit | A reviewer judges a reported increase as one they might have missed without Ambit |

### Adoption guardrails

Not evidence of value on their own. They are the conditions under which the
evidence above counts: value shown by a pilot that finds the gate too slow,
too noisy, or impossible to remove is not Phase 1 met.

| Guardrail | What would show it holds |
|---|---|
| Review cost stays acceptable | The pilot does not find the added review time unacceptable; lead time is compared with its pull requests before adoption |
| `unknown` and noise do not stop use | No standing report on an unchanged tree, and no `unknown`, leads the pilot to stop gating |
| Cost of backing out | The removal procedure is tested automatically |
| Initial-check and re-check latency | Measured separately on a representative project, against the allowances in [ADR-0001](docs/adr/0001-analysis-backend.md) |

**`unknown` is tracked relative to the pilot's own repository, not against an
absolute rate.** The rate is set largely by a repository's dependencies, so a
single threshold would say more about the dependency tree than about Ambit. On
three third-party backends, what the gate was worth tracked standing noise on
an unchanged tree and whether a real increase was reported at all, not the
absolute rate ([`docs/status.md`](docs/status.md)). What a pilot reports, with
the denominator, boundary trust categories, and engine version:

- the change in its `unknown` rate from its first run
- whether any `unknown` blocks continued use, and which
- how concentrated the unresolved names are (`--coverage`'s
  `top-unresolved-names`), since a few packages behind most of it are fixable
  with stubs

## Long-term hypothesis

Not a Phase 1 criterion, and not observable from one pilot: **teams ship
AI-assisted and agent-generated TypeScript to production faster, with fewer
serious incidents, because authority increases are reviewed mechanically
instead of by reading every line.** The earlier exit criterion stated it as
"2× faster to production for AI-generated code, half the serious incidents".

Serious incidents are rare, and one that did not happen cannot be observed, so
a single team over a few months cannot show a reduction; a change in one team's
delivery speed has too many other causes to attribute. Testing either needs
several teams, a longer window, and a measurement design that does not exist
yet.

## Milestones

The milestones are the build plan behind the proofs above. What each has
actually reached is in [`docs/status.md`](docs/status.md).

| M | What it builds | Exit criterion |
|---|---|---|
| M0 | Specification, diagnostic ledger, scope | Review complete |
| M0.5 | Backend comparison on five gates | A default backend adopted on published evidence, not on unverified speedups |
| M1 | Effects, `unknown`, coverage, JSON diagnostics, `init`, the resident path | Dogfooding on Ambit itself; diagnostics update on a contract-comment-only change |
| M2 | Capabilities, budget, runtime hooks, framework adapters, 50 stubs | Conformance trials for the planned targets; publish what is and is not supported |
| M3 | Concrete fix patches, the `ambit agent` protocol | Connected to one external agent; analysis failure distinguished from contract loosening |
| M4 | Editor integration, `ambit sbom`, npm distribution | **One pilot team** — the "next proof" above |
| M5 | Phase 1 exit criterion met | The pilot evidence above and check performance published |

M1 was put ahead of M0.5 deliberately: §3.4's connection-layer isolation lets
contract analysis proceed independently of the backend, and in solo development
running two tracks in parallel is what costs the most. M0.5 is settled — the
decision is [ADR-0001](docs/adr/0001-analysis-backend.md) and the measurements
are in
[`docs/measurements/m0.5-backend-comparison.md`](docs/measurements/m0.5-backend-comparison.md).

## Supply chain (M4)

Not implemented. The shape it is meant to take: Ambit rides the existing
lockfile and npm provenance (Sigstore) and layers the contract information on
top — `ambit sbom` attaching each dependency's effects and capabilities from its
stubs, and `ambit check` reporting when a dependency update widens effects. The
stub trust levels this rests on are part of the contract model, and are
specified in `docs/DESIGN.md` §8.
