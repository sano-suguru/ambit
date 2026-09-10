# ADR-0010: The RFC procedure takes effect at 1.0 or the first external adopter, and a guaranteed surface takes its place until then

- Status: Accepted (2026-09-10)
- Decides: `docs/DESIGN.md` §9.1 (when the procedure takes effect), §9.2 (the guaranteed surface), §9.3 (versioning)
- Evidence: none measured — this is a procedure decision
- Confirms: ADR-0001 and ADR-0009 both describe §9's trigger as the first npm
  publish, which is what this record changes. Their decisions stand; only the
  sentence about *when* an RFC would have been required is superseded here

## Context

§9 required an RFC for four kinds of change — the meaning of a diagnostic code,
the standard effects, the propagation rules, and the default backend or the
supported TypeScript range — and put `rfcs/` and `conformance/` in place "from
the first public release onward".

Publishing to npm was about to make that true. On a solo project with no
dependents, it would have made every one of those four changes into a document
the author writes, reviews and approves alone. `AGENTS.md` already rejects that
shape of work in a different context: if the write-up is longer than the patch,
write the patch.

The trigger was also measuring the wrong event. What a written approval
procedure buys is that a second party is told before their work breaks. A
tarball on a registry that nothing depends on produces no such party. The two
were conflated because, for most projects, publishing and acquiring dependents
happen close enough together to look like one event; here they do not.

Dropping the procedure entirely was the opposite error. Ambit's product is a
contract that can be trusted, so "the meaning of a declaration does not move
without warning" is not a process nicety — it is the thing being sold. A
governance change that removes the guarantee removes the product.

## Decision

Separate *when the procedure starts* from *what the procedure protects*, and
give each its own trigger.

1. The RFC requirement takes effect at **1.0, or at the first external adopter —
   `ROADMAP.md` M4's pilot team — whichever comes first.** `rfcs/` and
   `conformance/` arrive on the same trigger. The four RFC-requiring changes are
   not narrowed.
2. §9.2 names a **guaranteed surface** and holds at every version, before the
   trigger included: the meaning of the JSDoc tags and standard effects,
   diagnostic ids and their meanings, the NDJSON field shape,
   `ambit.approvals.md`'s format, the CLI's commands, flags and exit codes, and
   the package's subpath exports and their exported names. A breaking change to
   any of them is announced in `CHANGELOG.md` at the release that makes it.
3. §9.2 also names what is **not** guaranteed, so the surface cannot grow by
   assumption: anything outside the subpath exports, the measured `unknown` rate
   and the resolution of the analysis behind it, added stubs and added runtime
   hooks, and whether anything is cached.
4. §9.3 states the 0.x rule: while the major version is 0, a minor release may
   break the guaranteed surface. The announcement obligation does not vary with
   the version number.
5. §5.2's `id` row said an `id` is "never deleted or reused", unconditionally,
   while `docs/diagnostics/README.md` said ids were unstable until 1.0. The two
   could not both be true and the disagreement predates this record. §5.2 is
   qualified to hold **from 1.0**, which is the reading that survives 0.1.0
   shipping 18 codes with an admitted right to renumber them. The 0.x latitude
   is bounded by (2): a renumbering is announced, never silent.

The subpath exports are on the guaranteed list although §6.1 calls the modules
behind them internal. A consumer's `import` is not an internal detail, and it
is the one part of the surface whose breakage stops another project's build
outright.

Three ledgers, not one document, are what carry (2) and (3): `CHANGELOG.md` for
what changed, `docs/diagnostics/` for what each code means, and `docs/adr/` for
why a design is the one in the specification. That is what an RFC directory
would have provided, minus the self-approval.

## Alternatives considered

- **Let §9 take effect at the first publish, as written.** Rejected: it produces
  RFCs with one author and one reviewer, for changes nobody has yet depended on.
  The cost is real and the protection is zero until a dependent exists.
- **Remove the RFC requirement outright and keep only the CHANGELOG.** Rejected:
  the four RFC-requiring changes are the ones whose blast radius is an adopter's
  whole codebase, and once there is an adopter, "it was in the changelog" is a
  notification rather than a decision they could influence. Deferring the
  procedure is not the same as deciding against it.
- **Trigger on the first external adopter alone, without 1.0.** Rejected:
  publishing 1.0 is itself the claim that the surface is stable, so it cannot be
  the one milestone that leaves the procedure switched off. Whichever comes
  first is the honest reading.
- **Put the guaranteed surface in `README.md` only.** Rejected by the
  specification/status split (`AGENTS.md`): the sentence "changing a diagnostic
  id is a breaking change" is true whether or not any code exists, and a reader
  has to know it to use Ambit correctly. That makes it `docs/DESIGN.md` text.

## Consequences

- Between now and the trigger, a design decision costs an edit to
  `docs/DESIGN.md` and one `docs/adr/` record — unchanged from today's practice,
  which is now what the specification actually says.
- Every release carries a `CHANGELOG.md` obligation that no release carried
  before, and that obligation does not wait for 1.0.
- The line between "we broke something" and "we can now see more" is written
  down. Adding a stub or a hook may turn a passing check into a failing one, and
  §9.2 classifies that as visibility rather than breakage (P3, P4). Without the
  second list, every stub addition would have argued for a major bump.
- `docs/DESIGN.md` §9 gained three subsections and no chapter was renumbered.
- ADR-0001 and ADR-0009 now contain a stale description of §9's trigger. They
  are write-once records and were not edited; this record is where the change
  lives, and `docs/adr/README.md` says so.

## Revisit when

- A pilot team adopts Ambit, or 1.0 is cut — at which point the procedure starts
  rather than the decision being revisited.
- A second maintainer joins, which supplies the reviewer the rejected first
  alternative assumed.
