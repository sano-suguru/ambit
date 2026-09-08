import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

async function listTsFiles(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTsFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

const TYPESCRIPT_IMPORT = /from\s+["']typescript["']/;
const ALLOWED_BACKEND_DIR = "src/checker/backend";

describe("architecture constraint: only the connection layer depends on typescript", () => {
  it('no file under src/ outside src/checker/backend/ imports "typescript"', async () => {
    const files = await listTsFiles(path.join(PROJECT_ROOT, "src"));
    expect(files.length, "expected to find .ts files under src").toBeGreaterThan(0);

    for (const file of files) {
      const relative = path.relative(PROJECT_ROOT, file);
      if (relative.startsWith(`${ALLOWED_BACKEND_DIR}/`)) continue;

      const content = await readFile(file, "utf8");
      expect(TYPESCRIPT_IMPORT.test(content), `${relative} imports "typescript"`).toBe(false);
    }
  });

  it(`src/checker/backend/ actually contains the connection layer's typescript import`, async () => {
    // Positive control: if this regresses to 0, the regex above stopped
    // matching (e.g. an import style change) and the test above would
    // pass vacuously.
    const files = await listTsFiles(path.join(PROJECT_ROOT, ALLOWED_BACKEND_DIR));
    const importers: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (TYPESCRIPT_IMPORT.test(content)) importers.push(path.relative(PROJECT_ROOT, file));
    }

    expect(
      importers.length,
      `expected at least one file under ${ALLOWED_BACKEND_DIR} to import "typescript"`,
    ).toBeGreaterThan(0);
  });
});
