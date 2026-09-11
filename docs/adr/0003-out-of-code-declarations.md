# ADR-0003: Declaring contracts in `ambit.config.ts`

- Status: Accepted (2026-09-09)
- Decides: `docs/DESIGN.md` §4.1 "Out-of-code declarations", "Overloads and
  bodyless declarations"
- Evidence: none measured

## Context

P3 (incremental adoption) requires that a contract can be declared for code the
writer cannot edit: third-party code, generated code, code not yet theirs. JSDoc
reaches none of it, and cannot be attached unambiguously to some declaration
sites even in code the writer owns.

## Decision

**`ambit.config.ts` may declare contracts for stable symbol identities that
cannot reliably carry JSDoc.** The same five tags, with the same meaning.

| | Rule |
|---|---|
| Namespace | config's ⊃ JSDoc's. Config can additionally name accessors (`Cls.get total`) and anonymous default exports (`default`), for which JSDoc is still not adopted |
| Cannot be named at all | object-literal members with computed, string or numeric keys; inline callback arguments; functions declared inside functions |
| Precedence | JSDoc > config, with the difference warned about (`AMB-W005`) |
| Glob ambiguity | An exact key beats a glob. Two globs hitting one symbol is a configuration error: exit 2 |
| Discovery | Walk up from the `<dir>` passed to `check` / `init`, stopping at the first `package.json` or `.git`. cwd is not consulted. Keys resolve relative to the config file |
| User-defined effects | Expanded into standard effects at parse time. Only expanded names appear in diagnostics |

## Why

**Path stability and uniqueness of a comment's attribution are separate
problems.** `get x` and `set x` have two declarations under one name, and an
anonymous default export has no name. A config key is where the writer states
which declaration is meant, so a qualifier like `get x` rides inside the key;
JSDoc infers attribution from where it is written and has no place to carry the
same qualifier. Opening the config side first lets the side that cannot touch
the code — this decision's actual purpose — move forward.

**Glob ambiguity is an error, not a precedence puzzle.** Defining "more
specific" requires deciding containment between globs, and which of
`src/**/a.ts` and `src/a/*.ts` is more specific is not decidable in general.
Order-wins would entrust a contract's meaning to the key order of an object
literal, invisibly to the reader.

**Discovery walks up from `<dir>`, not cwd**, because `ambit check src` means
"check `src`". Under cwd, `cd packages/a && ambit check ../b/src` would apply
a's config to b's code. Keys relative to the config file mean the same config
points at the same symbols under both `ambit check src` and `ambit check .`.

**User-defined effects are expanded, not emitted as written**, because expansion
is many-to-one: with `payments` and `sync` both `["network", "db_write"]`, there
is no deciding which name an observed set should be called by. `observed` is
what the analysis observed, not the writer's vocabulary.

**An overload set is one declaration site, and it is the implementation.** A
signature is a type, not code that runs; a tag written there is `AMB-E003`
rather than silently dropped. A call into a set with no implementation is
`unknown` — resolving to a bodyless declaration would make the observed set
empty and the caller look `pure` whatever the implementation does (§3.4). This
is also a termination requirement: if more than one function corresponds to one
declaration path, §4.2 rule 7's fixed point does not converge.

## Consequences

The asymmetry that JSDoc can syntactically be written on an accessor yet is not
adopted is not derived from principle — it is the result of deciding only the
config side first. It is recorded in
[`docs/open-questions.md`](../open-questions.md), and there is room to close it
once JSDoc's attribution notation is settled.

`.json` is not among the config formats: there is no gain in one more way to
write config for which `defineConfig`'s type checking does not apply.
