import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/fixtures/**", "node_modules/**"],
    env: {
      // Every `execFile("node", [CLI_PATH, ...])` in this suite pays for
      // stripping the whole `src/` tree again — measured at ~450ms per
      // `check` invocation, run close to 100 times. Node's own module
      // compile cache removes that, measured serially at 133s -> 107s.
      // Must be absolute: several tests spawn the CLI with a scratch `cwd`
      // (e2e.config.test.ts, e2e.runtime.test.ts, e2e.install.test.ts), and
      // a relative path would resolve against that cwd instead — missing
      // the cache and littering the scratch project under test with a
      // `node_modules/.cache/` of its own.
      NODE_COMPILE_CACHE: path.join(import.meta.dirname, "node_modules", ".cache", "ambit-ncc"),
    },
    // Coordinates the one `pnpm pack` the distribution e2e files need
    // (`test/support/pack.ts`) across worker processes, so parallel files
    // can share a scratch directory instead of racing on `dist/`.
    globalSetup: ["test/support/global-setup.ts"],
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
