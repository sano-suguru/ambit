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

describe("architecture constraint: the config layer is independent of the compiler", () => {
  // DESIGN.md §4.1 (c): `ambit.config.ts` is loaded by importing it, not by
  // parsing it, and the contracts it declares are plain data about symbol ids
  // the backend already produced. Named file by file rather than left to the
  // src/-wide rule above, because these three are the ones a future change
  // would be tempted to give a parser — and the `ambit/config` entry point is
  // imported by *consumer* projects, where pulling in a compiler would be a
  // dependency they never asked for.
  const CONFIG_FILES = ["src/core/config.ts", "src/config.ts", "src/checker/config.ts"];

  it("neither the config types, the ambit/config entry, nor the loader imports typescript", async () => {
    for (const relative of CONFIG_FILES) {
      const content = await readFile(path.join(PROJECT_ROOT, relative), "utf8");
      expect(TYPESCRIPT_IMPORT.test(content), `${relative} imports "typescript"`).toBe(false);
      // Nor by way of the connection layer, which does import it.
      expect(/from\s+["'][^"']*backend\//.test(content), `${relative} imports the backend`).toBe(
        false,
      );
    }
  });

  it("src/core/ and src/stubs/ still import neither typescript nor the checker", async () => {
    // The `src/`-wide rule above allows `src/checker/` to reach the backend;
    // core and stubs may not reach either (DESIGN.md §6.1).
    for (const dir of ["core", "stubs"]) {
      const files = await listTsFiles(path.join(PROJECT_ROOT, "src", dir));
      expect(files.length, `expected .ts files under src/${dir}`).toBeGreaterThan(0);
      for (const file of files) {
        const relative = path.relative(PROJECT_ROOT, file);
        const content = await readFile(file, "utf8");
        expect(TYPESCRIPT_IMPORT.test(content), `${relative} imports "typescript"`).toBe(false);
        expect(
          /from\s+["'][^"']*\/checker\//.test(content),
          `${relative} imports the checker`,
        ).toBe(false);
      }
    }
  });
});

describe("architecture constraint: the runtime is independent of the analysis engine", () => {
  // DESIGN.md §3.4: 「ランタイム強制 … コンパイラから独立。解析エンジンを
  // 本番依存にしない」. A production process that enforces capabilities must
  // not have to load a TypeScript compiler or Ambit's checker to do it.
  const FORBIDDEN = [
    { pattern: /from\s+["']typescript["']/, what: '"typescript"' },
    { pattern: /from\s+["'][^"']*\/checker\//, what: "src/checker/" },
  ];

  it("no file under src/runtime/ imports typescript or the checker", async () => {
    const files = await listTsFiles(path.join(PROJECT_ROOT, "src", "runtime"));
    expect(files.length, "expected to find .ts files under src/runtime").toBeGreaterThan(0);
    for (const file of files) {
      const relative = path.relative(PROJECT_ROOT, file);
      const content = await readFile(file, "utf8");
      for (const { pattern, what } of FORBIDDEN) {
        expect(pattern.test(content), `${relative} imports ${what}`).toBe(false);
      }
    }
  });
});
