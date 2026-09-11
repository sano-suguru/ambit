# Contributing

Ambit is pre-1.0 with no external adopters. This file is the procedure: how a
change is proposed, what record it leaves, and what is verified before it lands.
What Ambit *is* is [`docs/DESIGN.md`](docs/DESIGN.md); the working rules for
coding agents are [`AGENTS.md`](AGENTS.md).

## Verification

Every change runs these three, and they all have to be green:

```sh
pnpm test
pnpm exec tsc --noEmit
pnpm exec biome ci .
```

A change to the analysis also runs Ambit against its own source and against
real third-party code:

```sh
node src/cli/main.ts check src --coverage
node scripts/bench-corpus.ts
```

Quote numbers you measured; never predict them, and give every number one
home. **A current summary metric has exactly one canonical home:
[`docs/status.md`](docs/status.md).** The runs behind it — the raw output, the
per-change history, a spike — go in [`docs/measurements/`](docs/measurements/),
dated, and are cited from `docs/status.md` rather than restated in it. A number
that appears in two files will eventually disagree with itself.

## How a design change is made

Which procedure applies depends on a trigger, and the trigger is **1.0, or the
first external adopter, whichever comes first**
([`docs/DESIGN.md`](docs/DESIGN.md) §9.1). Publishing to npm is not the trigger.

**Before the trigger — now:**

1. Edit `docs/DESIGN.md` directly.
2. Write the record in [`docs/adr/`](docs/adr/README.md) — but only if the
   decision needs one. A decision that is easily reversible and carries no
   compatibility or security consequence gets no ADR; git history is enough.
3. If the change touches `docs/DESIGN.md` §9.2's guaranteed surface, add a
   `CHANGELOG.md` entry in the same change. This obligation holds at every
   version, before and after the trigger.

**From the trigger onward:** a change to the meaning of diagnostic codes, the
standard effects, the propagation rules, the default backend, or the range of
TypeScript supported goes through `rfcs/` first, and the accepted RFC becomes
the record. `rfcs/` and `conformance/` are put in place on that same trigger;
until then the conformance tests are Vitest under `test/`.

## Where a document belongs

Duplication is the failure mode, not omission. One fact, one home.

| Document | What goes in it |
|---|---|
| `README.md` | Enough for a reader to decide in five minutes whether to use Ambit |
| `docs/DESIGN.md` | The current design, and the limits of what it guarantees |
| `docs/adr/` | **Why** a design is the one in the specification |
| `docs/limitations.md` | What Ambit cannot do today, for someone deciding whether to adopt |
| `docs/analysis-limitations.md` | The same, at the AST corner-case level, for whoever maintains the checker |
| `docs/status.md` | The canonical home of every current summary metric, and the verdict they support |
| `docs/measurements/` | The runs behind those metrics — raw output, per-change history, spikes — dated, and never updated in place |
| `docs/open-questions.md` | What is undecided |
| `ROADMAP.md` | What has to be proved next |
| `docs/diagnostics/` | The reference for each diagnostic code |
| `CHANGELOG.md` | Breaking changes to `docs/DESIGN.md` §9.2's guaranteed surface |
| `AGENTS.md` | Working rules for coding agents |

Before writing a paragraph, ask: **who makes a wrong decision in the next three
months if this is not written?** If there is no answer, git history already
holds it.

## Language

English: `README.md`, `docs/DESIGN.md`, `docs/adr/`, `docs/integrations/`,
`docs/limitations.md`, `docs/analysis-limitations.md`, `docs/open-questions.md`,
`ROADMAP.md`, diagnostic message text, `docs/diagnostics/`, and all comments and
test names in `src/`, `test/`, `scripts/`.

Japanese: `docs/goals/`, RFCs, commit messages, issues.

`effects`, `capabilities`, `budget`, `boundary`, and `unknown` stay in English
in both.
