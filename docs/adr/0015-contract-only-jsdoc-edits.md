# ADR-0015: An edit confined to contract tags does not re-extract importers

- Status: Accepted (2026-09-13) — extends 0014
- Decides: `docs/DESIGN.md` §6.2, the contract-tag row of the invalidation table
- Evidence: [`docs/measurements/2026-09-13-resident-jsdoc-narrowing.md`](../measurements/2026-09-13-resident-jsdoc-narrowing.md)

## Context

Phase 4 re-extracts the reverse-import closure of every edit, because a change to
what a module exports changes how its importers' calls resolve. Phase 5 measured
the cost of that on a contract edit in a high-fan-out file: 432 of 448 files on
drizzle-orm and 419 of 557 on immich re-extracted for one `@effects` line, at
the same total cost as a cold run.

The shortcut that suggests itself — "the file's JSDoc changed and nothing else,
so re-extract that file" — rests on a claim about the compiler, not about Ambit.
JSDoc is type syntax in a JavaScript file, which `allowJs` puts in the store; a
`.tsx` file reads JSX pragmas out of comments; a line break inside a comment
moves automatic semicolon insertion; a tag's host can move. That Ambit's pass 2
never reads a callee's JSDoc is necessary and says nothing about any of these.

## Options

- **Any JSDoc edit in a `.ts` file.** Relies on the checker ignoring every JSDoc
  tag and description in TypeScript files. Probably true, and not something this
  repository has a test that could show false.
- **Edits confined to Ambit's own tags** (`@effects`, `@capabilities`, `@budget`,
  `@entrypoint`, `@boundary`), proved from two parses. Relies only on TypeScript
  having no tag of those names, which is a fact about a name table.
- **Leave the closure as it is.** Correct, and pays the phase 5 cost on exactly
  the edit an agent loop makes most.

## Decision

The second. The backend proves, per edited file, that the token tree, every
non-JSDoc comment, and every non-contract part of every attached JSDoc block are
identical, and that the file is `.ts`, `.mts` or `.cts` and parses cleanly. Only
when every reported edit passes does it re-extract the edited files alone, and it
says so; the resident layer checks the answer against what it offered. Anything
else takes the phase 4 closure.

The impact range is not narrowed. The edited file is re-summarized and its
changed symbols are closed under callers as before, so an importer whose
authority depends on the edited contract is still re-propagated. What is skipped
is re-extraction, never re-checking.

## Consequences

- §6.2's table has a row for it, more specific than "a file's text": the table is
  still a minimum, and the new row's minimum is the edited file plus every
  function whose authority can depend on it.
- A description, `@param` or `@deprecated` edit still pays the closure. Widening
  to them needs evidence about the checker that this ADR deliberately did not
  take on.
- `project-update` — program construction and binding — is untouched: pass 1
  and `createProgram` stay whole-project. Where it dominates, the measured total
  moves less than the re-extracted count does.
