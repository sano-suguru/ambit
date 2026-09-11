# ADR-0010: The RFC procedure starts at 1.0 or the first external adopter

- Status: Accepted (2026-09-10)
- Decides: `docs/DESIGN.md` §9.1, §9.2, §9.3
- Evidence: none measured — a procedure decision
- Confirms: ADR-0001 and ADR-0009 both describe §9's trigger as the first npm
  publish, which is what this record changes. Their decisions stand; only that
  sentence is superseded here

## Context

§9 put the RFC procedure in force "from the first public release onward", and
publishing to npm was about to make that true. On a solo project with no
dependents, every RFC would have one author, one reviewer and one approver.

The trigger measured the wrong event. What a written approval procedure buys is
that a second party is told before their work breaks; a tarball nothing depends
on produces no such party. Dropping the procedure entirely was the opposite
error — what Ambit sells is a contract a reader can trust, which requires that
the meaning of a declaration not move without warning.

## Decision

Separate *when the procedure starts* from *what it protects*, and give each its
own trigger.

**Before 1.0 or the first external adopter, whichever comes first:** a design
change is an edit to `docs/DESIGN.md` plus a `docs/adr/` record. A change to
§9.2's guaranteed surface is announced in `CHANGELOG.md` at the release that
makes it — at every version, 0.x included.

**From that trigger onward:** breaking changes to the meaning of diagnostic
codes, the standard effects, the propagation rules, the default backend, or the
supported TypeScript range require an RFC. `rfcs/` and `conformance/` arrive
then.

§9.2 also names what is **not** guaranteed, so the surface cannot grow by
assumption. §9.3 states the 0.x rule: while the major version is 0, a minor
release may break the guaranteed surface, and the announcement obligation does
not vary with the version number.

One conflict was resolved along the way. §5.2's `id` row said an `id` is "never
deleted or reused", unconditionally, while `docs/diagnostics/` said ids were
unstable until 1.0. §5.2 is qualified to hold **from 1.0** — the reading that
survives 0.1.0 shipping with an admitted right to renumber. The 0.x latitude is
bounded by the announcement obligation: a renumbering is announced, never
silent.

## Alternatives rejected

- **Let §9 take effect at the first publish, as written.** Produces RFCs with
  one author and one reviewer, for changes nobody has yet depended on.
- **Remove the RFC requirement outright, keeping only the CHANGELOG.** Once
  there is an adopter, "it was in the changelog" is a notification rather than a
  decision they could influence. Deferring is not deciding against.
- **Trigger on the first external adopter alone.** Publishing 1.0 is itself the
  claim that the surface is stable, so it cannot be the one milestone that
  leaves the procedure switched off.

## Consequences

- Every release carries a `CHANGELOG.md` obligation that no release carried
  before, and it does not wait for 1.0.
- The line between "we broke something" and "we can now see more" is written
  down: adding a stub or a hook may turn a passing check into a failing one, and
  §9.2 classifies that as visibility rather than breakage (P3, P4). Without that
  second list, every stub addition would have argued for a major bump.

## Revisit when

- A pilot team adopts Ambit, or 1.0 is cut — at which point the procedure starts
  rather than the decision being revisited.
- A second maintainer joins, which supplies the reviewer the first rejected
  alternative assumed.
