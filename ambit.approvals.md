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
- `checker/config.ts#configDependencies` `effect:fs_read` — reads `ambit.config.ts` and the files it imports, to know what the config's value actually depends on; reading is the whole operation
- `checker/config.ts#resolveRelativeSpecifier` `effect:fs_read` — `statSync`s the candidate paths a relative specifier could name, to find which one exists
- `checker/config.ts#importInFreshRegistry` `effect:process` — starts a worker thread so a config that imports another module is evaluated against a module registry of its own; Node's registry would otherwise hand it a cached copy of an edited dependency, and serving that as current is what §3.4 forbids. A config that imports nothing starts no thread
- `checker/config.ts#loadConfig` `effect:process` — inherited from `importInFreshRegistry`, and only on the branch that needs it
- `cli/analyze.ts#analyze` `effect:process` — inherited from `loadConfig`. `analyze` starts no process of its own; the thread belongs to loading a config that imports something
- `checker/resident.ts#isFile` `effect:fs_read` — `statSync` behind the fingerprint's upward walk
- `checker/resident.ts#readOrUndefined` `effect:fs_read` — reads a fingerprint input (tsconfig, config, `package.json`, lockfile) to hash it
- `checker/resident.ts#findUpward` `effect:fs_read` — walks up from the analysis root looking for those files, the same search the backend and §4.1 (c) already do
- `checker/resident.ts#computeFingerprint` `effect:fs_read` — builds `ProjectFingerprint` from those files, every generation, because §6.2 makes the session and not its caller responsible for noticing a tsconfig or a dependency that changed
- `checker/resident.ts#runGeneration` `effect:fs_read` — inherited from `computeFingerprint`; one generation of the resident lifecycle
- `checker/resident.ts#runGeneration` `effect:process` — inherited from `loadConfig`, per generation
- `checker/resident.ts#ResidentSession.static open` `effect:fs_read` — inherited from `runGeneration`; opening a session runs the first check
- `checker/resident.ts#ResidentSession.static open` `effect:process` — inherited from `loadConfig`, via that first check
- `checker/resident.ts#openResidentSession` `effect:fs_read` — the function-shaped entry point to the above; adds nothing of its own
- `checker/resident.ts#openResidentSession` `effect:process` — likewise
- `checker/resident.ts#ResidentSession.update` `effect:fs_read` — inherited from `runGeneration`
- `checker/resident.ts#ResidentSession.update` `effect:process` — inherited from `loadConfig`
- `checker/resident.ts#ResidentSession.update` `effect:state_write` — the generation commit itself, the assignment to the session's own fields. This is the authority a resident path holds that a one-shot run does not, and keeping it visible is the point of the entry
- `checker/resident.ts#ResidentSession.close` `effect:state_write` — sets the closed flag and releases the backend session
