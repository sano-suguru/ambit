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

**External pilot evidence.** `ambit-ts@0.2.0` installs from npm and runs outside
this repository ([`docs/status.md`](docs/status.md)). Whether authority diffs
change reviewer decisions on production-bound pull requests is a question only a
pilot can answer.

## Next proof

**One external repository keeps `ambit diff` on its production-bound pull
requests because the reports change reviewer decisions**, on a codebase nobody
here wrote.

It can start advisory. A `diff` step that blocks nothing and needs no contract
is enough to observe this.

The stronger proof after it is that the same team **voluntarily** makes `diff`
a required check, and keeps it one. Asking a pilot to gate so that a criterion is
met would contaminate the result.

What has to hold for either:

| To prove | What would show it | Where it stands |
|---|---|---|
| The analysis sees enough of a real codebase to be worth reviewing | Corpus median `unknown` materially below 52.9% | 52.9% — [`docs/status.md`](docs/status.md) |
| The gate does not block honest work | Where a pilot gates, its approval ledger stays under a handful of lines per pull request in steady state | Measured only on this repository: five lines for the change that introduced it |
| Contracts survive a real build | An adopter's bundled, minified production build enforces what its source declared | Verified in `test/e2e.*` only; no external build |
| The cost of backing out is real | An adopter removes Ambit and their code still type-checks and runs | `test/e2e.install.test.ts` proves it for a scratch project, not for an application |

The corpus row is a pre-adoption heuristic with no target number, **not a Phase 1
criterion**. The corpus is five repositories with no dependencies installed; a
pilot's own `unknown` rate is set largely by the dependencies it uses.

## Phase 1 exit criterion

Phase 1 is met when an external pilot team:

- keeps `ambit diff` on its production-bound pull requests,
- changes reviewer decisions because of its reports, and
- does not remove it over operational cost.

**Gating is not required.** A team that keeps Ambit as an advisory check has met
Phase 1. A team that voluntarily gates, and stays gated, is stronger evidence,
and the only test of the approval ledger. Support for other languages is
considered only after Phase 1. Speeding up analysis alone does not count.

README documents the current adoption path as See, Shape and Enforce. The stage
a pilot stops at is recorded, not judged.

The items below are candidate metrics, each observable within one pilot. None
has a numeric target, because there is no pilot baseline to set one against.

### Evidence of product value

| Evidence | What would show it |
|---|---|
| Sustained use | `ambit diff` stays on for production-bound pull requests, rather than being switched off or routinely ignored |
| Authority increases detected | `ambit diff` reports increases on the pilot's own pull requests |
| Reviewer action | A report leads a reviewer to reject a change, narrow its scope, correct a contract, or write down why an increase is correct |
| A catch reviewers credit | A reviewer judges a reported increase as one they might have missed without Ambit |
| Voluntary gating (stronger, not required) | The pilot makes `diff` a required check on its own initiative, and keeps it |

### Adoption guardrails

The evidence above counts only while these hold. Value shown by a pilot that
finds Ambit too slow, too noisy, or impossible to remove is not Phase 1 met.

| Guardrail | What would show it holds |
|---|---|
| Review cost stays acceptable | The pilot does not find the added review time unacceptable; lead time is compared with its pull requests before adoption |
| `unknown` and noise do not stop use | No standing report on an unchanged tree, and no `unknown`, leads the pilot to stop using `diff` |
| Cost of backing out | The removal procedure is tested automatically |
| Initial-check and re-check latency | Measured separately on a representative project, against the allowances in [ADR-0001](docs/adr/0001-analysis-backend.md) |

**`unknown` is a risk to observe during the pilot, measured against the pilot's
own first run.** An absolute threshold would say more about a dependency tree
than about Ambit. On three third-party backends, the gate's usefulness tracked
standing noise and whether real increases were reported, not the rate
([`docs/status.md`](docs/status.md)). The pilot reports, with the denominator,
boundary trust categories, and engine version:

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
