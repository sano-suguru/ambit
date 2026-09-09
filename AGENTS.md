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
(未解決の問題) only when the gap is an open design question rather than
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
- treating the native TypeScript backend as adopted before its §3.5
  validation gate passes
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
current connection-layer implementation, not an adopted product backend;
treat it as disposable until §3.5 validation is done.

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
5.9.3, Vitest 4, Biome.

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
- `typescript` is pinned to `5.9.3` on purpose: it is the comparison
  backend behind `src/checker/backend/legacy-ts.ts`, not merely
  unmaintained (`docs/DESIGN.md` §3.1, Appendix A.1). It also currently
  doubles as the build-time compiler for `tsc --noEmit` — see §12 for
  why that pairing is provisional.

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
- Diagnostic codes → `docs/diagnostics/`
- Agent working rules → this file
- External-facing explanation → `README.md`
- Implementation limitations in detail (README's overflow) →
  `docs/limitations.md`
- Milestone-by-milestone implementation status, with measured numbers →
  `docs/status.md`

Do not write product specification into this file.

RFC procedure (`docs/DESIGN.md` §9) applies from the first npm publish
onward. Before that, edit `docs/DESIGN.md` and this file directly.

## Language

Write in English: `README.md`, `docs/limitations.md`, diagnostic message text,
`docs/diagnostics/`, this file. Write in Japanese: `docs/DESIGN.md`, RFCs, commit messages,
issues. Keep `effects`, `capabilities`, `budget`, `boundary`, and `unknown`
in English in both.
