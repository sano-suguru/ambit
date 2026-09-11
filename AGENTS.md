# AGENTS.md

Guidance for coding agents working in this repository. `CLAUDE.md` is a
one-line import of this file — edit this file, not that one.

Ambit is a contract layer on top of TypeScript for AI-generated code:
JSDoc tags (`@effects` / `@capabilities` / `@budget` / `@entrypoint` /
`@boundary`) declare side effects, permissions, and budget, and `ambit check`
stops contract violations. The full specification is `docs/DESIGN.md`. Read
the relevant section before changing contract semantics, propagation rules,
diagnostics, backend behavior, or supported TypeScript behavior — do not
rely on a summary of it here.

## Non-negotiables

These override everything below when they conflict. Everything after this
section explains them.

1. **Never turn `unknown` into safe without positive evidence.** A failure to
   start, an unsupported setting, or an unresolved call is never reported as
   "no violations" (§3.4).
2. **State as fact only what code or tests demonstrate.** `docs/DESIGN.md` is
   recorded intent; future possibilities are neither.
3. **Measure before claiming an improvement.** Quote numbers you ran. Never
   predict one, and never assign a performance number to a backend that has
   not been run.
4. **Run the verification suite before reporting completion** — `pnpm test`,
   `pnpm exec tsc --noEmit`, `biome ci .`, and for analysis changes
   `check src --coverage` and `scripts/bench-corpus.ts`. If you could not
   verify, say so.
5. **Never weaken or delete a test to make a change pass, and never pin a
   defect with one.** A test asserting wrong behavior makes the defect read
   as the specification.
6. **Fix a defect you root-caused when it causes, blocks, or falls inside the
   change you are already making.** There, recording it instead is not a
   deliverable: if the write-up would be longer than the patch, write the
   patch. A defect *outside* that scope is recorded in one line and left —
   abandoning the current goal to chase it is its own failure.
7. **Do not renumber a `docs/DESIGN.md` chapter without migrating every
   reference in the same change.** `src/` and `test/` cite them by number in
   the hundreds, so the numbers are effectively an API; leaving a heading
   behind as a pointer is the cheaper move, but it is a choice, not a law.
8. **Keep the compiler out of `src/core/` and `src/stubs/`.** Only
   `src/checker/backend/legacy-ts.ts` may import `typescript`.
9. **Do not add speculative architecture.** "May be useful later" is not a
   justification; "`docs/DESIGN.md` says so and the code does not do it" always
   is.
10. **When code and `docs/DESIGN.md` disagree, surface it.** Do not silently
    normalize either one.

## Decision priorities

State as fact only what code or tests demonstrate. Treat `docs/DESIGN.md`
as recorded intent, and future possibilities as neither. Keep verified and
not-yet-verified claims clearly separated; do not present an assumption as
a fact.

When code and `docs/DESIGN.md` disagree, do not silently pick one. The
disagreement is a finding: surface it, and record the resolution in
`docs/DESIGN.md` (before §9.1's trigger, edit it directly — see
Documents below) — but only if the resolution is a design decision. Test
it against: would this sentence still be true if all the code were
discarded? If yes, it belongs in `docs/DESIGN.md`. If no, it's
implementation status, and belongs in `README.md` or `test/`, not in
`docs/DESIGN.md` — see Documents below. Where the spec requires something
the code does not yet do, fix the code. File it under
`docs/open-questions.md` only when the gap is an open design question rather
than missing work — see Scope below. Don't paper over the gap with a note that
the code is still catching up.

`docs/DESIGN.md` §2 sets the project's design-principle priority order
(P1→P5); follow it when principles conflict.

Do not increase the apparent guarantee surface by assumption. Guarantee
only what Ambit can actually verify, and keep everything else visible.

## Scope

Ambit is a solo pre-1.0 project with a written specification and no users
yet. That combination sets the rule: **the specification is the scope
boundary, not the size of the diff.**

`docs/DESIGN.md` already describes more than the code does. Closing that
gap is the work. A change that closes it is in scope however large it
turns out to be; a change that leaves it half-closed is not finished just
because it was small. A small diff buys nothing here — there is no
reviewer to spare and no released behavior to protect — and it costs the
only thing that matters yet, which is a product that works.

Out of scope is what nothing asks for:

- features neither the request nor `docs/DESIGN.md` calls for
- abstractions for hypothetical future requirements
- refactoring unrelated to the change at hand
- new languages, runtimes, or backends without a concrete need
- reopening the §3.5 backend decision without one of the conditions §3.5
  itself lists having been met
- assigning performance numbers to a backend that has not been run

The last two are not size limits but honesty limits; they hold at any
size.

"May be useful later" is not sufficient justification for added
complexity. "`docs/DESIGN.md` says so and the code does not do it" always
is.

The real constraint is not minimality but completeness: a change must
leave the tree in a state where every claim it makes is true and verified.

### Defects

None of the above licenses leaving a known defect in place **inside the
change you are making**. A defect you have root-caused, that causes, blocks,
or falls within that change, is in scope. Fix it.

Recording such a defect instead of fixing it is not a deliverable. It
converts a solvable problem into a permanent one, and writing up why it
was not fixed usually costs more than the fix. If the write-up is longer
than the patch would have been, write the patch.

A defect **outside** that scope is a different matter, and the rule is the
opposite one: record it in a line and leave it. A goal abandoned partway to
chase an unrelated bug is its own failure, and finishing the change in front
of you is what lets the next one start from a known state.

Deferring *inside* the scope needs a reason that survives being said out
loud. There is no one else to escalate to on a solo project, so the only
honest reason is that the fix turns on a design question with no settled
answer — one that needs its own investigation, which is what
`docs/open-questions.md` is for. "Out of scope" is a conclusion, not a
reason; if it is genuinely out of scope, the paragraph above already covers
it. When you do defer, the record is one line: an issue, or a bullet in
`docs/open-questions.md`. Never an essay.

## Architecture

`src/core/` and `src/stubs/` MUST NOT import `typescript`. The only file
allowed to import it is `src/checker/backend/legacy-ts.ts` —
`test/architecture.test.ts` enforces this boundary. `legacy-ts.ts` is the
**adopted** product backend: `docs/DESIGN.md` §3.5 and
`docs/adr/0001-analysis-backend.md` chose it over native TypeScript 7, with the
measurements in `docs/status.md`. Changing the default now requires an RFC
(§9), and the boundary above is what makes that reviewable — do not weaken it
because the backend is settled.

What any backend must satisfy is `test/backend.conformance.test.ts`, asserted
against the `TsBackend` interface rather than against a compiler. One entry
there is load-bearing rather than descriptive: `ExtractedFile.functions` ids
must be unique per file, because `propagate`'s fixed point does not terminate
otherwise.

Compiler-specific objects, types, and internal IDs MUST NOT leak outside
the connection layer — not into diagnostics, persisted formats, or public
symbol IDs (`docs/DESIGN.md` §3.4).

What declaration a call resolves to is frequently not the one the source
shape suggests: a type annotation makes the checker return the
annotation's member signature rather than the value's own member. Probe
the compiler for the answer before designing around an assumed resolution
path — a plan built on a guess here can look complete and fix nothing.

## Toolchain

Node.js 24 (pnpm 12, single package — no workspaces; the package is
`ambit-ts`, and `docs/DESIGN.md` §6 keeps it single until a production
adopter makes the runtime split worth doing), TypeScript
6.0.3, Vitest 4, Biome.

Non-obvious constraints:

- No build step during development. Run `.ts` files directly via Node's
  type stripping (e.g. `node src/cli/main.ts check <dir> --format json`).
  `tsc --noEmit` is for type checking. The one build that exists,
  `pnpm build` (`tsconfig.build.json` → `dist/`), is for distribution only:
  Node refuses to strip types under `node_modules`
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so an installed Ambit has
  to ship emitted JavaScript. It runs from `prepack`; do not add it to a
  development loop.
- `erasableSyntaxOnly` is enabled in `tsconfig.json`: no `enum`,
  `namespace`, or parameter properties.
- Relative imports use the `.ts` extension, not `.js`.
- Supported runtime is the current Active LTS major of Node.js only
  (`engines.node` in `package.json`), not every version that happens
  to run — see `docs/DESIGN.md` §3.1 and `docs/open-questions.md`. `volta.node` and CI's
  `node-version` pin one representative patch within that range; only
  `engines` is the actual promise.
- `@types/node`'s major tracks the supported Active LTS major (currently
  24.x). Do not bump it ahead of `engines` — a newer major would type
  APIs that do not exist on the runtime Ambit claims to support.
- `typescript` is pinned to `6.0.3`, and the number has a rule behind it:
  **the newest stable release of the JS-implementation line that leaves
  `pnpm test`, `tsc --noEmit`, `biome ci`, and `check src` / `check
  realistic-api` counts unchanged.** 6.0.3 was measured against that rule and
  changed nothing (`docs/measurements/m0.5-backend-comparison.md`). It is the analysis engine behind
  `src/checker/backend/legacy-ts.ts`, adopted by `docs/DESIGN.md` §3.5, and it
  doubles as the build-time compiler for `tsc --noEmit` — see
  `docs/open-questions.md` for why that
  pairing is provisional. 7.x is a different engine (Go), not a newer version
  of this one.
- `tsconfig.json` must name `"types": ["node"]`. TypeScript 6 stopped
  including `node_modules/@types/*` automatically; without the line, every
  `node:` import and Node global in this repository is an error. The same line
  is in the four fixture tsconfigs whose sources use Node builtins
  (`backend-smoke`, `cross-module`, `init`, `propagation`).
  `test/fixtures/realistic-api` deliberately declares `"types": []` — it must
  type-check with nothing installed — so do not add it there.
- Never add a second TypeScript to `package.json`, under an alias or
  otherwise. `typescript@7` also declares `bin: { tsc }`, so the two collide
  on `node_modules/.bin/tsc` and `pnpm exec tsc` silently changes compiler —
  observed, and recorded in `docs/measurements/m0.5-backend-comparison.md`
  under gate 5. The M0.5
  comparison compiler lives in `.m05-native/` (gitignored), installed by
  `node scripts/m05-native-install.ts`; `test/architecture.test.ts` keeps it
  out of `src/` and out of the published package.
- `scripts/` holds the measurement procedures — M0.5's backend comparison, and
  the analysis-quality benchmark (`bench-corpus.ts` over the fixed corpus in
  `test/corpus/corpus.json`, whose checkout is `corpus.ts`'s job). It is linted
  and formatted by Biome but is outside `tsconfig.json`'s `include` and outside
  `package.json`'s `files`: the native probes load a compiler that is not
  installed by default, so they cannot be type-checked, and nothing there
  is shipped or run by `ambit check`. `bench-corpus.ts` fetches from the
  network, so `pnpm test` does not run it.

## Verification

Before considering a change complete, run:

```sh
pnpm test
pnpm exec tsc --noEmit
pnpm exec biome ci .
```

(`pnpm lint` runs `biome check .`, which is not what CI runs — use
`biome ci .` to match `.github/workflows/ci.yml`.)

Do not weaken or delete a test merely to make a change pass. Tests verify
the design; they do not define it. If a test appears to conflict with the
intended design, investigate the mismatch instead of hard-coding behavior
to satisfy the test. If verification cannot be performed, say so
explicitly.

Never pin a defect with a test. A test asserting current, wrong behavior
makes the defect read as the specification and the eventual fix read as a
regression. If you are about to write one, fix the defect instead. If one
already exists, inverting it is part of the fix, not a weakened test —
that is the one case the paragraph above does not cover.

`pnpm test` is not the whole signal. A change to the analysis is also measured
against real third-party code:

```sh
node scripts/bench-corpus.ts
```

The corpus is fixed (`test/corpus/corpus.json`) and pinned twice — by commit
SHA and by the git tree object of each measured subtree — so the benchmark
refuses to run against a drifted checkout. Do not add, drop, or re-scope a
target to move the number; the numbers themselves belong in `docs/status.md`.

Run Ambit against its own source too:

```sh
node src/cli/main.ts check src --coverage
```

Exit code 0 and the `unresolved-by-reason` breakdown are the fastest
evidence that a change did what it claimed, and the fastest way to catch a
new false positive. Quote numbers you measured; never predict them. A
change to call resolution or extraction also belongs in the self-hosting
block in `test/backend.legacy-ts.test.ts`, which asserts against `src/`
directly — fixtures alone cannot catch a shape only the real codebase has.

## Documents

- Actual behavior → `src/`, `test/`
- Product specification → `docs/DESIGN.md`
- **Why** a design is the one in the specification → `docs/adr/`
- Diagnostic codes → `docs/diagnostics/`
- Breaking changes to §9.2's guaranteed surface → `CHANGELOG.md`
- Agent working rules → this file
- External-facing explanation → `README.md`
- Framework integration guides → `docs/integrations/`
- What Ambit cannot do, for someone deciding whether to adopt →
  `docs/limitations.md`
- The same at the AST corner-case level, for whoever maintains the checker →
  `docs/analysis-limitations.md`
- Current measured numbers, and the verdict they support → `docs/status.md`
- The measurement runs behind those numbers, dated → `docs/measurements/`
- What is undecided → `docs/open-questions.md`
- What has to be proved next → `ROADMAP.md`
- How a change is proposed, verified and recorded → `CONTRIBUTING.md`

Do not write product specification into this file.

`docs/DESIGN.md` carries the current design and the limits of what it
guarantees — nothing else. The options that were considered, the measurements
behind a choice, and what would have happened otherwise go in a `docs/adr/`
record, which `docs/DESIGN.md` links to in one line. Test the split the same way
as the specification/status one: a sentence that would still be true if all the
code were discarded **and** that a reader has to know to use Ambit correctly
belongs in `docs/DESIGN.md`; a sentence that only explains how the project
arrived there belongs in the ADR. Do not renumber a `docs/DESIGN.md` chapter
without migrating every reference in the same change — `src/` and `test/` cite
them by number in the hundreds.

RFC procedure (`docs/DESIGN.md` §9) applies from 1.0, or from the first
external adopter, whichever comes first (§9.1) — **not** from the first npm
publish. Until then, edit `docs/DESIGN.md` directly and write the record in
`docs/adr/`.

What does not wait for that trigger is §9.2. A change to the guaranteed
surface — tag meanings, diagnostic ids, the NDJSON field shape,
`ambit.approvals.md`'s format, the CLI's flags and exit codes, the subpath
exports — needs a `CHANGELOG.md` entry in the same change, at every version.
A change to what §9.2's second list covers needs none: added stubs, added
hooks, `unknown`-rate movement, and caching are not the guaranteed surface,
and must not be written up as though they were.

## Language

Write in English: `README.md`, `docs/DESIGN.md`, `docs/adr/`,
`docs/integrations/`, `docs/limitations.md`, `docs/analysis-limitations.md`,
`docs/open-questions.md`, `ROADMAP.md`, `CONTRIBUTING.md`, diagnostic message
text, `docs/diagnostics/`, source comments and test names in `src/`, `test/`
and `scripts/`, this file. Write in Japanese: `docs/goals/`, RFCs,
commit messages, issues. Keep `effects`, `capabilities`,
`budget`, `boundary`, and `unknown` in English in both.

A fixture whose subject *is* non-ASCII text
(`test/fixtures/backend-conformance/unicode.ts`) keeps its non-ASCII
identifiers and string data — that content is the assertion, not prose. Its
comments are still English.

Quote `docs/DESIGN.md` from the current English text, not from a translation of
it. A citation is only worth its section number if the words are actually
there.
