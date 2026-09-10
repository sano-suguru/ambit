# ADR-0003: Declaring contracts in `ambit.config.ts`, and which declaration sites can be named

- Status: Accepted (2026-09-09)
- Decides: `docs/DESIGN.md` §4.1 "Out-of-code declarations", "Overloads and
  bodyless declarations"
- Evidence: none measured

## Context

P3 (incremental adoption) requires that a contract can be declared for code the
writer cannot edit: third-party code, generated code, and code not yet theirs.
JSDoc cannot reach any of it, and cannot be attached unambiguously to some
declaration sites even in code the writer owns.

## Decision

The same five contracts can be declared in `ambit.config.ts` by naming the
symbol. Four sub-decisions follow, each with its own alternatives.

## (a) config's namespace ⊃ JSDoc's namespace

Options considered:

1. config's namespace = JSDoc's namespace. Declaration sites that produce
   AMB-E003 cannot be named in config either.
2. Any declaration site with a declaration path also has its JSDoc adopted.
   AMB-E003 shrinks to "nodes with no stable path" only.
3. **config's namespace ⊃ JSDoc's namespace** (adopted). Config can additionally
   name accessors (`Class.get total` / `Class.set total`) and anonymous default
   exports (`default`), for which writing JSDoc is still not adopted.

Path stability and uniqueness of a comment's attribution are separate problems.
`get x` and `set x` have two declarations under the same name, and an anonymous
default export has no name. A config key is the place where the writer states
explicitly which declaration is meant, so a qualifier like `get x` can be carried
inside the key; JSDoc, by contrast, is a path that infers attribution from where
it is written, and has no place to carry the same qualifier. What §12's "JSDoc
limits and symbol identification" has left undecided is the latter notation, not
the former. Opening up only the config side first lets the side that cannot touch
the code — this section's actual purpose — move forward.

Under 1 the effects of getters, setters and anonymous default exports would ride
on propagation with nowhere at all to declare them, leaving them in
`--coverage`'s `unknown`.

**The honest limit of this decision**: 3 leaves the asymmetry that "JSDoc can
syntactically be written at this position, yet is not adopted". This is not a
distinction derived from principle; it is the result of deciding only the config
side of §12's open item first. If the notation on the JSDoc side is settled,
there is room to move toward 2 (§12).

## (b) Ambiguity between glob keys is a configuration error

Options considered:

1. Later entry wins by written order.
2. The more specific key wins.
3. **Make ambiguity a configuration error** (adopted; exact matches being the
   only exception).

2 is not taken because defining "more specific" requires deciding the containment
relation between globs, and which of `src/**/a.ts` and `src/a/*.ts` is more
specific is not decidable in general. 1 is not taken because it would entrust the
meaning of a contract to the key order of an object literal, and which way it
fell would not be visible to the reader (the same reason as §3.4). An exact match
can be the exception because it needs no containment judgment and the writer's
intent is unique.

What would happen if 3 were not chosen: the contract of an existing symbol would
silently change with the order in which lines were added to config, and a change
that loosens a contract would not appear in diff review.

## (c) Config is found by walking up from `<dir>`

Options considered:

1. cwd as the origin.
2. **Walk up from `<dir>`** (adopted).
3. Require `--config`.

`ambit check src` means "check `src`", not "check the project in cwd". Under 1,
`cd packages/a && ambit check ../b/src` would ignore b's contracts and apply a's
config, which the reader cannot explain. 3 adds one step at adoption time, which
is against P3 (incremental adoption).

Keys are relative to the config file so that the same config points at the same
symbols under both `ambit check src` and `ambit check .`. Making them relative to
`<dir>` would shift every key merely because the checked range was narrowed.

`.json` is not among the formats because there is no gain in adding one more way
to write config for which `defineConfig`'s type checking does not apply (the
`effects` definitions and `strict` are not expressions, so they could be written
in JSON, but there is no need for that).

What would happen if 2 were not chosen: in a monorepo, the correspondence between
what is checked and which config applies would become cwd-dependent, and CI and
local runs would apply different contracts.

## (d) User-defined effects are expanded at parse time

Options considered:

1. Emit the defined name as written.
2. **Emit the expansion** (adopted).
3. Emit both.

Expansion is many-to-one. If `payments: ["network", "db_write"]` and
`sync: ["network", "db_write"]` are both defined, there is no deciding which name
to call an observed `{network, db_write}` by. `observed` is the set the analysis
observed, not the writer's vocabulary, so inventing an inverse mapping would make
a name that was never written appear in a diagnostic. Using defined names only in
`declared` would leave `declared` and `observed` in different vocabularies, and
their difference unreadable. 3 writes the same set two ways and makes it
ambiguous which one the check used.

## Overloads: one declaration site, and it is the implementation

A signature is a type, not code that runs, so it is not a declaration site for a
contract; a contract tag written there is reported as AMB-E003 rather than
dropped. "Write it on the implementation" is actionable advice, whereas dropping
it silently is exactly the "declaration that does nothing" that §4.1 forbids.

A call into a set with no implementation is `unknown`. Resolving to a bodyless
declaration would make the observed effects the empty set, and the caller would
look `pure` whatever the implementation does — the "converting an analysis
failure into no violations" that §3.4 forbids.

This rule is not a matter of notation but also a termination requirement. If more
than one function corresponds to a single declaration path, the fixed-point
iteration of §4.2 rule 7 does not converge, because each iteration overwrites the
other's state. The declaration path and the function the backend returns must be
one to one.
