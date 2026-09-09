import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/fixtures/**", "node_modules/**"],
    // The two distribution e2e files both build and pack the repo. Running
    // them in parallel workers means two `tsc` processes writing the same
    // `dist/` while the other tars it — a race that passes on a fast machine
    // and fails elsewhere. `test/support/pack.ts` memoizes the pack, which
    // only helps if the files share a process.
    fileParallelism: false,
    // Most of this suite drives the CLI as a subprocess, and one `node
    // src/cli/main.ts` costs seconds: Node strips types for the whole source
    // tree on every start, and nothing is cached (DESIGN.md §6.2 is not
    // implemented). Vitest's 5 s default leaves a test that spawns the CLI
    // twice failing on a loaded machine and passing on an idle one — a
    // timeout, not an assertion, which is the least useful failure there is.
    // The e2e files already opt out one by one; this is the same decision for
    // the rest.
    testTimeout: 60_000,
  },
});
