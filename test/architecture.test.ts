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

describe("architecture constraint: the M0.5 comparison probes stay out of the product", () => {
  // DESIGN.md §3.5's gate probes live under `scripts/` and load a second
  // TypeScript compiler from `.m05-native/`, outside this package's
  // dependencies. They are measurement code: nothing shipped may import them,
  // and no second compiler may enter `src/` without the backend decision in
  // §3.5 changing first. The `typescript` rule above would not catch either,
  // because neither is spelled `"typescript"`.
  const FORBIDDEN = [
    { pattern: /from\s+["'][^"']*scripts\//, what: "scripts/" },
    { pattern: /from\s+["']typescript-native/, what: '"typescript-native"' },
    { pattern: /\.m05-native/, what: "the M0.5 native compiler install" },
  ];

  it("no file under src/ reaches the comparison probes or a second compiler", async () => {
    const files = await listTsFiles(path.join(PROJECT_ROOT, "src"));
    for (const file of files) {
      const relative = path.relative(PROJECT_ROOT, file);
      const content = await readFile(file, "utf8");
      for (const { pattern, what } of FORBIDDEN) {
        expect(pattern.test(content), `${relative} references ${what}`).toBe(false);
      }
    }
  });

  it("the published package does not ship the probes or the native install", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"),
    ) as { files: readonly string[]; dependencies: Record<string, string> };
    expect(manifest.files).not.toContain("scripts");
    // A second compiler as a dependency would also collide on
    // `node_modules/.bin/tsc` and silently change what `pnpm exec tsc` means
    // (docs/status.md, M0.5 gate 5).
    expect(Object.keys(manifest.dependencies)).toEqual(["typescript"]);
  });
});

describe("architecture constraint: the config layer is independent of the compiler", () => {
  // DESIGN.md §4.1 (c): `ambit.config.ts` is loaded by importing it, not by
  // parsing it, and the contracts it declares are plain data about symbol ids
  // the backend already produced. Named file by file rather than left to the
  // src/-wide rule above, because these three are the ones a future change
  // would be tempted to give a parser — and the `ambit-ts/config` entry point is
  // imported by *consumer* projects, where pulling in a compiler would be a
  // dependency they never asked for.
  const CONFIG_FILES = ["src/core/config.ts", "src/config.ts", "src/checker/config.ts"];

  it("neither the config types, the ambit-ts/config entry, nor the loader imports typescript", async () => {
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
  // DESIGN.md §3.4, on runtime enforcement: "Independent of the compiler. Do
  // not make the analysis engine a production dependency". A production
  // process that enforces capabilities must
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
