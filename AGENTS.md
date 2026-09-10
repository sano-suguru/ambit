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

## Decision priorities

State as fact only what code or tests demonstrate. Treat `docs/DESIGN.md`
as recorded intent, and future possibilities as neither. Keep verified and
not-yet-verified claims clearly separated; do not present an assumption as
a fact.

When code and `docs/DESIGN.md` disagree, do not silently pick one. The
disagreement is a finding: surface it, and record the resolution in
`docs/DESIGN.md` (before the first publish, edit it directly — see
Documents below) — but only if the resolution is a design decision. Test
it against: would this sentence still be true if all the code were
discarded? If yes, it belongs in `docs/DESIGN.md`. If no, it's
implementation status, and belongs in `README.md` or `test/`, not in
`docs/DESIGN.md` — see Documents below. Where the spec requires something
the code does not yet do, fix the code. File it under `docs/DESIGN.md` §12
(Open Questions) only when the gap is an open design question rather than
missing work — see Scope below. Don't paper over the gap with a note that
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

None of the above licenses leaving a known defect in place. A defect you
have root-caused, in code you are already touching, is in scope. Fix it.

Recording a fixable defect instead of fixing it is not a deliverable. It
converts a solvable problem into a permanent one, and writing up why it
was not fixed usually costs more than the fix. If the write-up is longer
than the patch would have been, write the patch.

Deferring needs a reason that survives being said out loud. There is no
one else to escalate to on a solo project, so the only honest reasons are
that the fix turns on a design question with no settled answer — one that
needs its own investigation, which is what `docs/DESIGN.md` §12 is for —
or that it is genuinely a different problem from the one in front of you.
"Out of scope" is a conclusion, not a reason. When you do defer, the
record is one line: an issue, or a §12 bullet. Never an essay.

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

Node.js 24 (pnpm 12, single package — no workspaces; splitting into
`@ambit/*` packages waits until npm publish is in view), TypeScript
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
  to run — see `docs/DESIGN.md` §3.1 and §12. `volta.node` and CI's
  `node-version` pin one representative patch within that range; only
  `engines` is the actual promise.
- `@types/node`'s major tracks the supported Active LTS major (currently
  24.x). Do not bump it ahead of `engines` — a newer major would type
  APIs that do not exist on the runtime Ambit claims to support.
- `typescript` is pinned to `6.0.3`, and the number has a rule behind it:
  **the newest stable release of the JS-implementation line that leaves
  `pnpm test`, `tsc --noEmit`, `biome ci`, and `check src` / `check
  realistic-api` counts unchanged.** 6.0.3 was measured against that rule and
  changed nothing (`docs/status.md`, M0.5). It is the analysis engine behind
  `src/checker/backend/legacy-ts.ts`, adopted by `docs/DESIGN.md` §3.5, and it
  doubles as the build-time compiler for `tsc --noEmit` — see §12 for why that
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
  observed, and recorded in `docs/status.md` under M0.5 gate 5. The M0.5
  comparison compiler lives in `.m05-native/` (gitignored), installed by
  `node scripts/m05-native-install.ts`; `test/architecture.test.ts` keeps it
  out of `src/` and out of the published package.
- `scripts/` holds the M0.5 measurement procedures. It is linted and
  formatted by Biome but is outside `tsconfig.json`'s `include` and outside
  `package.json`'s `files`: the native probes load a compiler that is not
  installed by default, so they cannot be type-checked, and nothing there
  is shipped or run by `ambit check`.

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

`pnpm test` is not the whole signal. Run Ambit against its own source:

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
- Agent working rules → this file
- External-facing explanation → `README.md`
- Framework integration guides → `docs/integrations/`
- Implementation limitations in detail (README's overflow) →
  `docs/limitations.md`
- Milestone-by-milestone implementation status, with measured numbers →
  `docs/status.md`
- Milestones, success metrics, Phase 1 exit criterion → `ROADMAP.md`

Do not write product specification into this file.

`docs/DESIGN.md` carries the current design and the limits of what it
guarantees — nothing else. The options that were considered, the measurements
behind a choice, and what would have happened otherwise go in a `docs/adr/`
record, which `docs/DESIGN.md` links to in one line. Test the split the same way
as the specification/status one: a sentence that would still be true if all the
code were discarded **and** that a reader has to know to use Ambit correctly
belongs in `docs/DESIGN.md`; a sentence that only explains how the project
arrived there belongs in the ADR. Never renumber a `docs/DESIGN.md` chapter —
`src/` and `test/` cite them by number in the hundreds.

RFC procedure (`docs/DESIGN.md` §9) applies from the first npm publish
onward. Before that, edit `docs/DESIGN.md` directly and write the record in
`docs/adr/`.

## Language

Write in English: `README.md`, `docs/DESIGN.md`, `docs/adr/`,
`docs/integrations/`, `docs/limitations.md`, `ROADMAP.md`, diagnostic message
text, `docs/diagnostics/`, this file. Write in Japanese: `docs/goals/`, RFCs,
commit messages, issues. Keep `effects`, `capabilities`,
`budget`, `boundary`, and `unknown` in English in both.
