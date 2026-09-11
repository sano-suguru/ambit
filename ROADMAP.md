# Roadmap

What Ambit has to **prove** next, in order. Not what it has to build — features
are how a proof gets attempted, not the goal.

The design is [`docs/DESIGN.md`](docs/DESIGN.md); what is actually implemented
today, with the measured numbers, is [`docs/status.md`](docs/status.md).

## Current product hypothesis

**Teams shipping AI-generated TypeScript need authority-delta review on every
pull request** — a mechanical answer to "did this change let the code do
something it could not do before?", because reading the diff no longer scales
to how fast the diff arrives.

Unproven. Zero external adopters.

## Current bottleneck

**`unknown` on real third-party code.** The corpus median is 52.6% — more than
half of all functions on real code depend on a path the analysis did not reach.
A gate that cannot see half the tree is a gate an adopter will not trust.

Second, and not far behind: **there is no adopter to say which half matters.**
The corpus prints the whole unresolved-name histogram, so the next fix is always
measurable; which of those names is worth fixing is not answerable from here.

## Next proof

**One external repository uses `ambit diff` as a real CI signal** — gating, not
advisory, on a codebase nobody here wrote.

That is the first claim about Ambit that is not self-reported. Everything before
it is preparation for it:

| To prove | What would show it | Where it stands |
|---|---|---|
| The analysis sees enough of a real codebase to be worth gating | Corpus median `unknown` under 30% | 52.6% — [`docs/status.md`](docs/status.md) |
| The gate does not block honest work | An adopter's approval ledger stays under a handful of lines per pull request in steady state | Measured only on this repository: five lines for the change that introduced it |
| Contracts survive a real build | An adopter's bundled, minified production build enforces what its source declared | Verified in `test/e2e.*` only; no external build |
| The cost of backing out is real | An adopter removes Ambit and their code still type-checks and runs | `test/e2e.install.test.ts` proves it for a scratch project, not for an application |

## Phase 1 exit criterion

**One team that can show "2× faster to production for AI-generated code, half
the serious incidents".** Support for other languages is considered only after
that. Speeding up analysis alone does not count.

| Metric | Target |
|---|---|
| `unknown` rate, median across adopting teams three months after adoption | 30% or below, with the denominator, boundary trust categories, and engine version published |
| Agent-generated pull requests whose contract violations were stopped before production | Being able to measure it at all is the first goal |
| Lead time from generation to production | Improved against the pre-adoption baseline |
| Serious incidents | Reduced against the pre-adoption baseline |
| Cost of backing out | The removal procedure is tested automatically |
| Initial-check and re-check latency | Measured separately on a representative project, against the allowances in [ADR-0001](docs/adr/0001-analysis-backend.md) |

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
| M5 | Phase 1 exit criteria met | Success metrics and check performance published |

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
