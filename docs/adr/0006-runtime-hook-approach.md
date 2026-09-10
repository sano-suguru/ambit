# ADR-0006: Monkeypatching for builtins, client wrapping for `pg`, and the target formats

- Status: Accepted
- Decides: `docs/DESIGN.md` §4.4 "The approach to runtime hooks"
- Evidence: measured on Node.js v24.19.0 / macOS (darwin arm64), recorded inline
  below where no other document holds it. Anything not measured is marked
  **unmeasured**.

## Context

`@capabilities` is enforced at run time by intercepting the operations a grant
names. Which interception mechanism is used decides whether an ungranted
operation can be **blocked** or only **noticed**, and §4.4's coverage table may
not claim the first where only the second is true.

## (a) The hooking approach

Options considered:

1. monkeypatch — replace methods on the module object.
2. `diagnostics_channel` — subscribe to the official event notifications.
3. Loader hooks — resolve `node:fs` to a replacement module via
   `module.register`.
4. Client wrapping — wrap the prototype of the module or instance the caller
   passes in.

Chosen: monkeypatch for `globalThis.fetch`, `node:fs` / `node:fs/promises` and
`node:child_process`; client wrapping for `pg`.

Reasons:

- `diagnostics_channel` **cannot block**. Measured: even when a subscriber
  throws, `publish()` returns normally and the exception becomes an
  `uncaughtException` on the next tick. This is the answer to §12's "distinguish
  having an audit notification from being able to block": a path that can only
  notify is not counted as blocking. No case requiring audit alone has appeared,
  so it is not adopted this time — adopting it would not fill in the blocking
  column anyway.
- Loader hooks do **not exceed** what monkeypatching already covers. Measured: if
  the properties of `require("fs")` are replaced before the ESM namespace of
  `node:fs` has been created, a later named import
  `import { readFileSync } from "node:fs"` also sees the replaced function.
  Conversely, if `node:fs` is imported first and replacement happens after, named
  imports and the `import * as` namespace stay bound to the original functions,
  and only property access via `fs.readFileSync()` is covered. That difference is
  a difference in adoption order, not in approach.
- Client wrapping is used for `pg` because Ambit does not depend on `pg`. The
  caller passes the module to `installPgHook(pg)`, and Ambit wraps
  `Pool.prototype.query` / `Client.prototype.query`. If Ambit imported `pg`
  itself, users who do not use `pg` would gain a dependency.
- The performance impact — the overhead of going through the replaced function —
  is **unmeasured**.

Loader hooks were also weighed on cost, not only coverage: rewriting resolution
of `node:` builtins brings reentrancy control, worker threads and `--import`
ordering with it, and none of that buys a call the monkeypatch misses.

## (b) The target format for `node:fs` and `node:child_process`

Options considered:

1. Use the **absolute path** resolved at call time as the target (adopted).
2. Use the string as written in the source as the target (relative paths stay
   relative).
3. Ignore paths and permit per operation only (`fs:read:*`).

Reason: what is visible at call time is the resolved path, and that is the only
form that can be matched against a grant. Under 2, `./data/x` and
`/srv/app/data/x` would be different targets for the same file, and a grant's
meaning would depend on where the process was started. The cost of normalization
(one `path.resolve`) is **unmeasured**.

For the shell forms of the process API (`exec`, `execSync`, `shell: true`), the
program actually launched is inside the shell string and is not determined without
a shell parser, so the target is the shell itself. The first word of the shell
string is not claimed as "the real command". This is for the same reason as not
reading table names out of arbitrary SQL; the location changes but the claim does
not.

The character set for a target segment is widened to "anything but a comma — the
`@capabilities` separator — and control characters", because paths contain
spaces, `+`, `~` and `%`. This relaxation can only act in the closing direction:
a mistyped tag becomes a target that matches nothing, and shows up as a denial.

## (c) DB client: `pg`, not Prisma

Options considered: `pg` / `@prisma/client`. Chosen: `pg`.

Reason: `pg` has stable replacement points in `Pool.prototype.query` /
`Client.prototype.query`, and can be written in the same symmetric install /
restore shape as `installFetchHook`. Prisma's official extension point `$extends`
**returns a new client**, so a restore putting the original client back cannot be
written — a hook with no restore does not satisfy P5 (being able to back out).
Also, the client does not exist without running `prisma generate`, and testing
against a real connection is heavy. A performance comparison of the two is
**unmeasured**.

The direction of a `pg` query is decided by the **same rules** as the static side
(the SQL keyword table in `src/stubs/data-clients.ts`). Putting the rules in two
places would let the static check and the runtime give different answers about
the same statement, so the rules live in one place under `src/core/` and both
read them.
