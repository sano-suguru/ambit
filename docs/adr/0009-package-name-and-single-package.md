# ADR-0009: The npm package is `ambit-ts`, and it stays a single package

- Status: Accepted (2026-09-10)
- Decides: `docs/DESIGN.md` §3.1, §6 (distribution), §6.1
- Evidence: none measured — a registry fact

## Context

`docs/DESIGN.md` named `@ambit/cli`, `@ambit/runtime`, `@ambit/core`,
`@ambit/checker` and `@ambit/stubs`. Neither the name `ambit` nor the scope
`@ambit` is obtainable: `ambit` is a live package with a maintained owner, and
the scope answers as owned. The specification named a distribution that could
never be published.

## Decision

**One unscoped package, `ambit-ts`, with subpath exports** — `ambit-ts`,
`ambit-ts/config`, `ambit-ts/runtime`, `ambit-ts/runtime/hono`,
`ambit-ts/runtime/next`. The `bin` stays `ambit` and the config file stays
`ambit.config.ts`; neither is a registry name. §6.1's separation of
responsibilities is expressed as directories, not as five packages.

**The runtime is not split out yet.** §6 asks that the compiler not be a
required production dependency, and one package does not satisfy that:
`typescript` is a `dependencies` entry, so importing only `ambit-ts/runtime`
installs the compiler. There are no production adopters, so the cost of two
release processes and a version pair that can drift buys nothing anyone can
collect. §6 states the gap rather than leaving it implied (P4).

The subpath is what makes deferring safe: after a split, `ambit-ts/runtime` can
re-export the new package, so the specifier a consumer wrote does not change —
which matters because a specifier is part of §9.2's guaranteed surface.

## Alternatives rejected

- **A new scope (`@ambitjs`, …).** Free to create, and would have kept the
  five-package shape — but the shape was never the goal, and it costs the plain,
  searchable name.
- **The personal scope `@snsgr/*`.** Reads as a personal fork rather than the
  project's distribution.
- **Splitting into two packages now.** Pays §6's cost now for a benefit nobody
  can yet collect.
- **Contesting or buying `ambit`.** The owner is active and the package is in
  use. Not attempted.

## Revisit when

- A production adopter installs `ambit-ts` for `ambit-ts/runtime` alone.
- The `ambit` name or the `@ambit` scope becomes obtainable.
