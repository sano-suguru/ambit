import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /**
     * One scratch directory for the whole `vitest run`, shared by every
     * worker process. `test/support/pack.ts` uses it to coordinate the one
     * `pnpm pack` the suite needs, across whichever files race for it.
     */
    packDir: string;
  }
}

/**
 * Runs once before any test file, in its own process, and hands every
 * worker the same scratch directory via `provide`/`inject`.
 *
 * Deliberately does no packing itself: a `globalSetup` that built the
 * distribution tarball would run on every `vitest run`, including running
 * one test file in isolation, putting a build back into the development
 * loop AGENTS.md says to keep out of it. `pack.ts` still builds lazily, on
 * first use, into the directory this hands out.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ambit-pack-"));
  project.provide("packDir", dir);
  return async () => {
    await fs.rm(dir, { recursive: true, force: true });
  };
}
