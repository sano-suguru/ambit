# Authority approvals

Every increase in authority that `ambit diff` reports has to be looked at by a
person before it lands. This file is where that is recorded (`docs/DESIGN.md`
§6.3).

Each `- ` line below approves **one** authority gained by **one** symbol. Any
other line — this paragraph included — is prose and is ignored.

```text
- `<symbol id>` `<authority>` — <reason>
```

`ambit diff` prints the line to add for every increase it fails on, so the way
to fill this in is to copy what it printed and replace the reason.

Two things about the rule that are easy to get wrong:

- **A line counts only in the comparison that adds it.** The ledger is read on
  both sides of the diff, so once a line is in the base branch it grants
  nothing, forever. Authority removed and later added back needs a new line.
- **Append; do not edit or reuse.** What is counted is how many lines name a
  pair, not whether one does. Re-approving the same pair later means appending
  a second identical line. Deleting a line can only ever lower what is
  approved, so it is safe but never necessary — old lines are history.

An approval says a person looked at the increase and accepted it. It does not
say the person was right, and Ambit cannot check that this file was written by
a person at all. What makes that true is branch protection and a `CODEOWNERS`
entry naming this file.

## Approvals

- `cli/approvals.ts#findApprovalsFile` `effect:fs_read` — walks up from the checked directory looking for this ledger; reads directory entries only
- `cli/approvals.ts#isProjectBoundary` `effect:fs_read` — tests for `package.json` / `.git` to stop that walk at the project root
- `cli/approvals.ts#loadApprovals` `effect:fs_read` — reads this ledger, once per side of a comparison
- `cli/worktree.ts#gitRaw` `effect:process` — runs `git`, like the `git` helper beside it, but returns stdout untrimmed for `-z` output
- `cli/worktree.ts#renamedFiles` `effect:process` — runs `git diff --find-renames` to learn which files moved
