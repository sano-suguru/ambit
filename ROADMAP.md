# Roadmap

What Ambit is aiming at, and how it would know it got there. The design itself is
`docs/DESIGN.md`; what is actually implemented today, with the measured numbers,
is [docs/status.md](docs/status.md).

## Phase 1 exit criterion

**Producing one team that can show "2× faster to production for AI-generated
code, half the serious incidents".** Support for other languages is considered
only after that. Speeding up analysis alone does not count as meeting the
criterion.

## Success metrics

Measured in Phase 1.

| Metric | Target |
|---|---|
| `unknown` rate (median across adopting teams, three months after adoption) | 30% or below. The denominator, the trust categories for boundaries, and the analysis engine version are published too |
| Proportion of agent-generated PRs whose contract violations were stopped before production | Being able to measure it at all is the first goal |
| Lead time from generation to production | Improved against the pre-adoption baseline |
| Number of serious incidents | Reduced against the pre-adoption baseline |
| Cost of backing out | The removal procedure for whatever was adopted — JSDoc, settings, adapters — is tested automatically. Opt-in wrappers are handled separately |
| Latency of the initial check and of a re-check after a change | Measured separately on a representative project. Compared against the allowances set before adoption (`docs/DESIGN.md` §3.5) |
| Memory and communication volume during analysis | The conditions including child processes, and the measurement scope, are published |

## Milestones

| M | Content | Exit criterion |
|---|---|---|
| M0 | The specification, the diagnostic code list, the RFC procedure, securing the scope | Review complete |
| M0.5 | Compare native API and legacy API on conformance, TS 5.x compatibility, startup and distribution, and initial and update performance | Publish the evidence for `docs/DESIGN.md` §3.5, and adopt a default backend and a support range. Do not rest on unverified speedups |
| M1 | JSDoc, effect propagation, unknown, coverage, JSON diagnostics, init, the shared checker, the resident and update paths | Dogfooding on Ambit itself. Diagnostics updated even when only contract comments changed. The schema and the performance measurement conditions settled |
| M2 | Entry-point capabilities / budget, fetch / fs / child_process / DB and LLM hooks, Express / Hono / Next.js adapters | Conformance trials for the planned targets, mapping contracts to handlers, 50 standard stub packages. Publish what is and is not actually supported |
| M3 | Concrete fix patches, the `ambit agent` protocol | Connected to one external agent. Analysis failures and contract loosening during iteration distinguished |
| M4 | Editor integration, `ambit sbom`, npm distribution | Editor compatibility with the chosen compiler confirmed. One pilot team |
| M5 | Phase 1 exit criteria met | Success metrics and check performance published |

The actual order of work differs from this table: M1 — the first vertical slice,
as far as `docs/DESIGN.md` §4.2's propagation rules and §5.1's NDJSON
diagnostics working — has been put ahead of M0.5, the backend comparison. The
reason is that the connection-layer isolation of §3.4 lets contract analysis
proceed independently of the backend, and that in solo development running two
tracks in parallel is what costs the most efficiency. The definitions of the milestones themselves are
unchanged.

M0.5 is settled: the decision is [ADR-0001](docs/adr/0001-analysis-backend.md)
and the measurements are in
[`docs/measurements/m0.5-backend-comparison.md`](docs/measurements/m0.5-backend-comparison.md).

## Supply chain (M4)

Not implemented. The shape it is meant to take: Ambit rides the existing
`package-lock.json` / `pnpm-lock.yaml` and npm provenance (Sigstore) and layers
the contract layer's information on top.

- `ambit sbom` attaches the effects and capabilities obtained from stubs to each
  dependency package in the SBOM.
- If effects widen through a dependency update, `ambit check` reports the
  difference.

The stub trust levels this rests on are part of the contract model, not of the
roadmap; they are specified in `docs/DESIGN.md` §8.
