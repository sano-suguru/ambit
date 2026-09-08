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
the code does not yet do, fix the code or file it under `docs/DESIGN.md`
§12 (未解決の問題); don't paper over the gap with a note that the code is
still catching up.

`docs/DESIGN.md` §2 sets the project's design-principle priority order
(P1→P5); follow it when principles conflict.

Do not increase the apparent guarantee surface by assumption. Guarantee
only what Ambit can actually verify, and keep everything else visible.

## Scope

Ambit is still a Draft. Make the smallest change that correctly solves the
requested problem.

Do not:

- add features that were not requested
- refactor unrelated code
- add abstractions for hypothetical future requirements
- expand to new languages, runtimes, or backends without a concrete need
- treat the native TypeScript backend as adopted before its §3.5
  validation gate passes
- assign performance numbers to a backend that has not been run

"May be useful later" is not sufficient justification for added
complexity.

## Architecture

`src/core/` and `src/stubs/` MUST NOT import `typescript`. The only file
allowed to import it is `src/checker/backend/legacy-ts.ts` —
`test/architecture.test.ts` enforces this boundary. `legacy-ts.ts` is the
current connection-layer implementation, not an adopted product backend;
treat it as disposable until §3.5 validation is done.

Compiler-specific objects, types, and internal IDs MUST NOT leak outside
the connection layer — not into diagnostics, persisted formats, or public
symbol IDs (`docs/DESIGN.md` §3.4).

## Toolchain

Node.js 24, pnpm (single package — no workspaces; splitting into
`@ambit/*` packages waits until npm publish is in view), TypeScript
5.9.3, Vitest, Biome.

Non-obvious constraints:

- No build step during development. Run `.ts` files directly via Node's
  type stripping (e.g. `node src/cli/main.ts check <dir> --format json`).
  `tsc` is for type checking only (`--noEmit`).
- `erasableSyntaxOnly` is enabled in `tsconfig.json`: no `enum`,
  `namespace`, or parameter properties.
- Relative imports use the `.ts` extension, not `.js`.

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

## Documents

- Actual behavior → `src/`, `test/`
- Product specification → `docs/DESIGN.md`
- Diagnostic codes → `docs/diagnostics/`
- Agent working rules → this file
- External-facing explanation → `README.md`

Do not write product specification into this file.

RFC procedure (`docs/DESIGN.md` §9) applies from the first npm publish
onward. Before that, edit `docs/DESIGN.md` and this file directly.

## Language

Write in English: `README.md`, diagnostic message text, `docs/diagnostics/`,
this file. Write in Japanese: `docs/DESIGN.md`, RFCs, commit messages,
issues. Keep `effects`, `capabilities`, `budget`, `boundary`, and `unknown`
in English in both.
