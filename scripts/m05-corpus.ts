/**
 * Generates the scale corpus for DESIGN.md §3.5 gate 4.
 *
 *     node scripts/m05-corpus.ts <outDir> [fileCount]
 *
 * `src/` (35 files) and `test/fixtures/realistic-api` (16) are the corpora made
 * of code someone wrote, and they are the ones worth trusting about *shape*.
 * Neither reaches the 300-file size §3.5's allowance table sets a number for,
 * so this generates a corpus that does — deterministically, so the measurement
 * can be repeated rather than described.
 *
 * The generated code is not padding. Each module contains the call shapes the
 * comparison is about — a cross-module import, a re-export through a barrel, a
 * `node:` builtin call, a default-lib method, a contract comment, and a call
 * into the previous module — because a corpus of isolated pure functions would
 * measure parsing and almost no type resolution, which is exactly the
 * comparison §3.5 forbids (「構文解析のみと型解析を含む検査を速度比較しない」).
 *
 * The tsconfig it writes names `"types": ["node"]` explicitly. That is not a
 * neutral choice and is recorded as such in `docs/status.md`: TypeScript 7.0.2
 * does not include `node_modules/@types/*` automatically the way 5.9.3 does, so
 * without the explicit entry the two backends resolve different numbers of
 * calls and their timings stop being comparable. Making it explicit is what
 * lets gate 4 measure speed instead of re-measuring gate 2.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const outDir = path.resolve(process.argv[2] ?? "");
const count = Number(process.argv[3] ?? 300);
if (!process.argv[2]) throw new Error("usage: node scripts/m05-corpus.ts <outDir> [fileCount]");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(path.join(outDir, "modules"), { recursive: true });

writeFileSync(
  path.join(outDir, "tsconfig.json"),
  `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        types: ["node"],
      },
      include: ["**/*.ts"],
    },
    null,
    2,
  )}\n`,
);

for (let i = 0; i < count; i++) {
  const previous = i === 0 ? undefined : `./mod${i - 1}.ts`;
  writeFileSync(
    path.join(outDir, "modules", `mod${i}.ts`),
    [
      `import { join } from "node:path";`,
      previous ? `import { compute${i - 1} } from "${previous}";` : "",
      "",
      `/** @effects pure */`,
      `export function pure${i}(value: number): number {`,
      `  return value * ${i + 1};`,
      `}`,
      "",
      `export function paths${i}(parts: readonly string[]): string {`,
      `  return join(...parts);`,
      `}`,
      "",
      `export function collect${i}(values: readonly number[]): number[] {`,
      `  const seen = new Set<number>();`,
      `  for (const value of values) seen.add(pure${i}(value));`,
      `  return [...seen].filter((n) => n > 0);`,
      `}`,
      "",
      `export function compute${i}(values: readonly number[]): number {`,
      previous
        ? `  return collect${i}(values).length + compute${i - 1}(values);`
        : `  return collect${i}(values).length;`,
      `}`,
      "",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );
}

writeFileSync(
  path.join(outDir, "index.ts"),
  `${Array.from({ length: count }, (_, i) => `export { compute${i} } from "./modules/mod${i}.ts";`).join("\n")}\n`,
);

console.log(`wrote ${count} modules + a barrel to ${outDir}`);
