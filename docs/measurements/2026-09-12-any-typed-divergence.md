# The `any-typed` divergence: one call site, traced to its first branch

- Date: 2026-09-12
- Engines: `typescript-legacy@6.0.3` (adopted) and `typescript-native@7.0.2` (shadow)
- Follows: `docs/measurements/2026-09-12-ts7-shadow-hardening.md`, "Dependencies
  removed is a different question"

That note reported that installing `drizzle-orm`'s dependencies took the
comparison from 43 divergences to 167, and from 6 high-risk to 138 — including
105 `shadow-less-unknown` and, at four `mysql2` sites, the shadow backend
reporting `db_read, db_write` where the adopted backend reported nothing. It
listed three readings and declined to pick one: a checker difference, a module
resolution difference, or an artifact of the corpus.

**It was the corpus, and the corpus is ours.** One line of
`test/corpus/corpus.json` produced all 105.

## Result

| `drizzle-orm`, divergences / high-risk | no deps | `--with-deps` |
|---|---|---|
| `baseUrl` set (as measured in the hardening note) | 43 / 6 | 167 / **138** |
| `baseUrl` removed | 43 / 6 | **31 / 6** |

With the corpus entry corrected, `--with-deps` reports callee-resolution parity
100%, authority parity 100%, `shadow-less-unknown` **0** and authority increases
**0**. The 105 and the 2 were never a disagreement between the compilers about
Ambit's semantics.

Two details of that table are worth reading rather than skipping.

- **The hermetic arm does not move at all** (43 / 6 either way). Without
  dependencies installed, a specifier that resolved to the shadowing local
  directory and one that resolved to nothing both came out `any-typed`, in the
  same count. `node scripts/bench-corpus.ts` is byte-identical before and after
  for the same reason, so no number in `docs/status.md` moves.
- **With dependencies the count is now *below* the hermetic one** — 31 against
  43. Supplying the types resolves twelve divergences rather than creating
  them, which is the direction a parity measurement should move in when the
  project is given what it actually compiles against. The previous reading, in
  which dependencies quadrupled the divergence count, was the artifact.

## The first branch point

The four `mysql2` sites are one expression,
`mysql2/session.ts:155` — `conn.query(query, params)`, where

```ts
import type { Connection as CallbackConnection } from 'mysql2';
…
const conn = (… as {} as { connection: CallbackConnection }).connection;
```

Dumping the chain under the adopted backend, with dependencies installed:

```
import 'mysql2'  ->  <src>/mysql2/index.ts        // drizzle's own adapter directory
conn             ->  CallbackConnection, flags=Any, symbol=undefined
conn.query       ->  any
```

The bare specifier `'mysql2'` did not reach `node_modules/mysql2`. It reached
`drizzle-orm/src/mysql2/`, which is drizzle's own adapter for that driver and
exports no `Connection`, so the annotation resolved to nothing and the receiver
read `any`.

`test/corpus/corpus.json` gave `drizzle-orm` `"baseUrl": "."` alongside the
`"~/*"` mapping it actually needs. With `baseUrl` pointing at the measured
subtree, a bare specifier is resolved against it first — and `drizzle-orm/src`
contains a directory named after nearly every driver it supports
(`mysql2`, `pg`, `better-sqlite3`, `expo-sqlite`, `gel`, `knex`, `kysely`, …).
Each one shadowed its own package.

Isolated by changing one option at a time, dependencies installed, everything
else held:

| `compilerOptions` | `'mysql2'` resolves to | `conn` | `~/*` |
|---|---|---|---|
| `baseUrl: "."` + `paths` | `<src>/mysql2/index.ts` | `any` | works |
| `paths` only | installed `mysql2` | `Connection` | **works** |
| neither | installed `mysql2` | `Connection` | broken |

`paths` without `baseUrl` resolves relative to the `tsconfig.json`, which is
exactly what the `~/*` mapping needs and nothing more. That is the fix.

## The compiler difference underneath is real, and was measured separately

The corpus mistake is ours. What made it *visible as a divergence* is not:

| `compilerOptions` | TypeScript 6.0.3 | TypeScript 7.0.2 |
|---|---|---|
| `baseUrl: "."` + `paths` | `<src>/mysql2/index.ts` → `any` | installed `mysql2` → `Connection` |
| `paths` only | installed `mysql2` → `Connection` | installed `mysql2` → `Connection` |

Same tsconfig, same files, same installed packages. **6.0.3 applies the
deprecated `baseUrl` fallback to a bare specifier under
`moduleResolution: Bundler`; 7.0.2 does not.** Reproduce both halves:

```sh
node scripts/shadow-corpus.ts drizzle-orm --with-deps   # installs, compares
```

Two things follow, and only the first is actionable today.

1. **A project whose `tsconfig.json` sets `baseUrl` can be analyzed
   differently by the two backends**, wherever a source directory is named
   after a dependency. `baseUrl` is common in the wild, and a directory named
   after the package it wraps is the ordinary shape of an adapter layer — this
   is not a contrived case, which is why it was found in the first real
   repository the comparison was pointed at with its types present.
2. **Which answer is right depends on who is asking.** Ambit analyzes what the
   user's own compiler sees, and under `baseUrl` the user's `tsc` resolves the
   way 6.0.3 does, so the adopted backend agrees with the project's own type
   check. A bundler at runtime resolves the way 7.0.2 does. The two are not the
   same question, and nothing here settles which one an effect analysis should
   answer. Recorded in `docs/open-questions.md`.

## What this changes about the corpus

The hardening note argued that a parity measurement needs dependencies, and
that argument stands — it is how this was found. What it under-stated is the
other half: **a generated tsconfig is part of the measurement, and a wrong one
manufactures divergences that look exactly like semantic ones.** 105 of them
here, at risk `high`, in a class (`shadow-less-unknown`) that had never appeared
before and that reads as the shadow backend knowing something the adopted one
does not.

Two guards follow from that, and both are in this change:

- `corpus.json`'s `drizzle-orm` entry carries the reason `baseUrl` is absent, so
  a future edit that re-adds it has to argue with a measured number rather than
  with a plausible-looking option.
- A gap between `--with-deps` and the hermetic run is a signal about the corpus
  before it is a signal about either compiler, and that is the order to read
  them in. The gap has not closed — 31 against 43 — and it should not: the
  hermetic arm is missing types and some of its divergences are that, not
  semantics. What changed is its *sign*. Dependencies now resolve divergences
  (43 → 31) where before they quadrupled them (43 → 167), and a run where
  supplying more information makes the two backends disagree more is the shape
  to distrust.

## What is left

The 31 divergences that survive on `drizzle-orm` with its dependencies present
are the real ones, and they are the same shapes the hardening note listed:
21 `unresolved-classification/shadow-more-unknown` (safe direction,
unexplained) and 6 `direct-effect/shadow-less-authority`. None of them is on a
`NOT_PORTED` shape. The hermetic arm's 43 include those 31 plus twelve the
missing types manufacture, which is the second reason to prefer the
dependency-resolved arm for anything but a regression gate.

The corpus-wide 204 still needs the same treatment this note gave the 105:
pick one, dump the chain, find the first branch. The difference is that the
next one starts from a corpus whose configuration has been checked.
