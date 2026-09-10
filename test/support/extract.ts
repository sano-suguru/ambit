import { legacyTsBackend } from "../../src/checker/backend/legacy-ts.ts";
import type { ExtractedProject } from "../../src/core/index.ts";

const cache = new Map<string, Promise<ExtractedProject>>();

/**
 * Memoized `legacyTsBackend.extractProject`, keyed by the absolute root
 * path. A fixture tree does not change during a test run, and
 * `ExtractedProject` is readonly, so repeated calls against the same root
 * within one test file can share the same `ts.Program` build instead of
 * paying for it again on every `it()`.
 *
 * Do not use this for a `fs.mkdtemp` scratch copy — those roots are unique
 * per call by construction, so there is nothing to share, and caching them
 * would only grow the map for no benefit.
 */
export function extractFixture(root: string): Promise<ExtractedProject> {
  let cached = cache.get(root);
  if (!cached) {
    cached = legacyTsBackend.extractProject(root);
    cache.set(root, cached);
  }
  return cached;
}
