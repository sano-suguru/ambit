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
  },
});
