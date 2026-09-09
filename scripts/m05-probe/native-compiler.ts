/**
 * Loads the native TypeScript compiler for the §3.5 gate probes, from an
 * install that is deliberately *outside* this repository's dependency tree.
 *
 * Why not a devDependency: `typescript@7` declares `bin: { tsc }`, exactly as
 * `typescript@5.9.3` does. Adding it — even under an alias — makes
 * `node_modules/.bin/tsc` resolve to whichever package the manager links last,
 * so `pnpm exec tsc --noEmit` silently changes compiler. That was observed, not
 * predicted: with the alias installed, `pnpm exec tsc --version` reported 7.0.2
 * and this repository's own type check produced 198 errors it does not have
 * under 5.9.3. DESIGN.md §12「ビルド用コンパイラと解析エンジンの分離」names
 * that coupling, and a comparison whose conclusion is "do not adopt" is the
 * wrong reason to introduce it.
 *
 * So the compiler lives in `.m05-native/` (gitignored), installed by
 * `node scripts/m05-native-install.ts`. Nothing under `src/` or `test/` can
 * reach it, `pnpm exec tsc` keeps meaning 5.9.3, and the procedure is still one
 * command.
 *
 * The probes that use this are untyped against the compiler's own `.d.ts` —
 * `scripts/` is outside `tsconfig.json`'s `include`, and a package that is not
 * installed by default cannot be type-checked anyway. That is a cost of keeping
 * the toolchain honest, and it is why nothing here is shipped: these files
 * measure, they do not run in `ambit check`.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Where `scripts/m05-native-install.ts` puts the compiler. */
export const NATIVE_ROOT = path.resolve(HERE, "..", "..", ".m05-native");

const requireFromNativeRoot = createRequire(path.join(NATIVE_ROOT, "noop.cjs"));

function ensureInstalled(): void {
  if (existsSync(path.join(NATIVE_ROOT, "node_modules", "typescript", "package.json"))) return;
  throw new Error(
    `native TypeScript is not installed.\n` +
      `Run: node scripts/m05-native-install.ts\n` +
      `(expected ${path.join(NATIVE_ROOT, "node_modules", "typescript")})`,
  );
}

/**
 * The installed compiler's version, read from the install rather than assumed:
 * a measurement must never record a version it did not run.
 */
export function nativeVersion(): string {
  ensureInstalled();
  const manifest = requireFromNativeRoot.resolve("typescript/package.json");
  const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version: string };
  return `typescript@${version}`;
}

// biome-ignore lint/suspicious/noExplicitAny: the compiler is not installed at type-check time
type Loaded = any;

function load(subpath: string): Promise<Loaded> {
  ensureInstalled();
  return import(pathToFileURL(requireFromNativeRoot.resolve(subpath)).href);
}

/** `typescript/unstable/sync` — `API`, `SymbolFlags`, and the project types. */
export const loadSyncApi = (): Promise<Loaded> => load("typescript/unstable/sync");

/** `typescript/unstable/ast` — `getJSDocTags` and the node shapes. */
export const loadAst = (): Promise<Loaded> => load("typescript/unstable/ast");

/** `typescript/unstable/ast/is` — the node predicates. */
export const loadAstIs = (): Promise<Loaded> => load("typescript/unstable/ast/is");
