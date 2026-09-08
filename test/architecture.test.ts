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

describe("architecture constraint: core and stubs must not depend on typescript", () => {
  it.for(["src/core", "src/stubs"])('no file under %s imports "typescript"', async (dir) => {
    const files = await listTsFiles(path.join(PROJECT_ROOT, dir));
    expect(files.length, `expected to find .ts files under ${dir}`).toBeGreaterThan(0);

    for (const file of files) {
      const content = await readFile(file, "utf8");
      const importsTypescript = /from\s+["']typescript["']/.test(content);
      expect(importsTypescript, `${path.relative(PROJECT_ROOT, file)} imports "typescript"`).toBe(
        false,
      );
    }
  });
});
