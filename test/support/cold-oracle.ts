/**
 * A cold `analyze()` over one directory, rendered to stdout, **in a process of
 * its own**.
 *
 *     node test/support/cold-oracle.ts <dir>
 *
 * The differential suite's ordinary oracle is an in-process `analyze()` call,
 * which is right for almost every row: it is the same function `ambit check`
 * runs, and running it beside the resident session is what makes the comparison
 * cheap enough to do after every mutation.
 *
 * It is the wrong oracle for exactly one class of bug — **anything the two
 * paths share that can go stale**. Node's ESM loader caches a module by URL for
 * the life of the process, so a config that came back stale would come back
 * stale for the resident session *and* for the in-process oracle, the two would
 * agree byte for byte, and the comparison would certify a wrong answer. That is
 * not hypothetical: it is the defect this file was written after finding
 * (`docs/resident-check-path.md`, correction 7).
 *
 * A separate process shares no module registry and no cache with the session,
 * so an agreement between the two is evidence rather than a coincidence.
 * Slower, which is why it is used for the config rows and not for all of them.
 *
 * @effects fs_read, process
 */
import process from "node:process";
import { analyze } from "../../src/cli/analyze.ts";
import { renderAnalysis } from "./render-analysis.ts";

const dir = process.argv[2];
if (dir === undefined) {
  process.stderr.write("usage: node test/support/cold-oracle.ts <dir>\n");
  process.exit(2);
}

try {
  process.stdout.write(renderAnalysis(await analyze(dir)));
} catch (error) {
  // Exit 2, matching `ambit check`: an analysis that could not run must never
  // be reported as an empty successful result (DESIGN.md §3.4).
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
