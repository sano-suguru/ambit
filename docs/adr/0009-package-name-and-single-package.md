# ADR-0009: The npm package is `ambit-ts`, and it stays a single package

- Status: Accepted (2026-09-10)
- Decides: `docs/DESIGN.md` §3 (Runtime library, Development and distribution),
  §6 (distribution), §6.1 (Package responsibilities), §9 (the npm-name bullet)
- Evidence: none measured — a registry fact, recorded below

## Context

`docs/DESIGN.md` named `@ambit/cli`, `@ambit/runtime`, `@ambit/core`,
`@ambit/checker` and `@ambit/stubs`, and §9 listed securing the `@ambit` scope
as M0 work still to do. Neither name is obtainable.

Checked against the npm registry on 2026-09-10 with an authenticated account:

- `ambit` is taken. It is `ambit@1.1.12`, a date-range parser, last published
  2022-06-13, by an owner who maintains the npm CLI itself. It is a live
  package with a maintained owner, so it will not come free.
- The `@ambit` scope is taken. `GET /-/org/ambit/user` answers
  `{"ambit":"owner"}`, where a scope that does not exist answers
  `{"error":"Scope not found"}`. Every `@ambit/*` name in the specification was
  therefore unpublishable, not merely unclaimed.

So the specification named a distribution that could never be published. The
name has to change, and the package layout the old names implied has to be
restated as something true.

## Decision

**The package is `ambit-ts`: one unscoped package, with subpath exports.**

- Specifiers are `ambit-ts`, `ambit-ts/config`, `ambit-ts/runtime`,
  `ambit-ts/runtime/hono` and `ambit-ts/runtime/next`.
- The `bin` stays `ambit`, and the config file stays `ambit.config.ts`. A bin
  name is independent of the package name, and neither of those two names is a
  registry name, so nothing forces them to change with it.
- §6.1's separation of responsibilities is expressed as directories
  (`src/core`, `src/checker`, `src/cli`, `src/runtime`, `src/stubs`) rather
  than as five packages.

**The runtime is not split out yet.** §6 asks that the compiler and the
development CLI not be required production dependencies, and one package does
not satisfy that: `typescript@6.0.3` is a `dependencies` entry of `ambit-ts`,
so a process importing only `ambit-ts/runtime` installs the compiler too. The
package stays single until a production adopter exists, and the runtime is
split out at that point. The gap is stated in §6 rather than left implied —
guaranteeing only what is true is §2 P4.

The subpath `ambit-ts/runtime` is what makes deferring safe: after the split it
can be a re-export of the new package, so the specifier a consumer wrote does
not change. That matters because from the first publish onward a specifier
change is an RFC change (§9).

## Alternatives considered

- **A new scope (`@ambitjs`, `@ambit-ts`, …).** A scope is free to create, so
  this would have kept the five-package shape. Rejected because the shape was
  never the goal: five packages for a project with no users is five release
  processes and five version numbers to keep in step, and §6.1 already allowed
  directories. It would also have cost the plain, searchable name.
- **The personal scope `@snsgr/*`.** Available immediately, since the account
  owns it. Rejected because it reads as a personal fork rather than the
  project's distribution, and §9 puts the stewardship of the name in the
  project — a name under an individual's scope contradicts that before the
  question is even asked.
- **Splitting into two packages now (`ambit-ts` and `ambit-ts-runtime`).** This
  would satisfy §6's production-dependency rule immediately. Rejected because
  the rule protects a production adopter and there is none: the cost is paid
  now, in two release processes and a version pair that can drift, against a
  benefit that nobody can yet collect. §6 records the gap so that the deferral
  is visible rather than forgotten.
- **Contesting or buying `ambit`.** The owner is active and the package is in
  use. Not attempted.

## Consequences

- `docs/DESIGN.md` no longer names a package that cannot exist.
- `src/checker/backend/legacy-ts.ts`'s runtime-wrapper table keys on the
  written module specifier, so the rename is part of the checker's behavior,
  not only of the manifest: a key that does not match stops `withAmbit` /
  `ambitHandler` / `ambitRoute` specs from being read as declarations (§4.4).
  `test/e2e.install.test.ts` now asks all three through the installed package,
  where the alias resolves through emitted `.d.ts` files rather than through a
  fixture's ambient `declare module`.
- The `typescript` production dependency is now a stated limitation of the
  distribution rather than an unnoticed contradiction of §6.

## Revisit when

- A production adopter installs `ambit-ts` for `ambit-ts/runtime` alone.
- The `ambit` name or the `@ambit` scope becomes obtainable.
