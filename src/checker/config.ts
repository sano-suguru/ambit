/**
 * Finding, loading, validating and resolving `ambit.config.ts`
 * (DESIGN.md §4.1, "Out-of-code declarations").
 *
 * Imports no compiler. A config file is plain data about symbols the backend
 * already produced ids for, so nothing here needs to know what a
 * `ts.Node` is (§3.4).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AmbitConfig,
  ConfigContract,
  KnownEffect,
  OnExceed,
  SymbolId,
} from "../core/index.ts";
import { isKnownEffect, isOnExceed, KNOWN_EFFECTS, parseCapability } from "../core/index.ts";

/**
 * The file names looked for, in order. §4.1 (c): the first one found in a
 * directory is the one used — a second file in the same directory is never
 * read, so a stale `ambit.config.js` beside a `.ts` cannot silently win.
 */
const CONFIG_FILENAMES = [
  "ambit.config.ts",
  "ambit.config.mts",
  "ambit.config.js",
  "ambit.config.mjs",
] as const;

/** Thrown for every config problem. `main` turns it into exit 2 (§3.4). */
export class ConfigError extends Error {}

export interface LoadedConfig {
  /** Absolute path to the config file. Keys are resolved relative to its directory. */
  readonly configPath: string;
  readonly config: AmbitConfig;
  /** The file's own text, so a diagnostic about a key can point at its line. */
  readonly sourceText: string;
}

/**
 * Walk up from `startDir` looking for a config file, stopping after the first
 * directory that holds a `package.json` or `.git` (§4.1 (c)) — a config
 * outside the project must never be picked up silently.
 */
export function findConfigFile(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    if (isProjectBoundary(dir)) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function isProjectBoundary(dir: string): boolean {
  return fs.existsSync(path.join(dir, "package.json")) || fs.existsSync(path.join(dir, ".git"));
}

/**
 * Load the config that governs `startDir`, or `undefined` when there is none.
 *
 * The file is imported, not parsed: it is TypeScript or JavaScript, and Node
 * strips types for any file outside `node_modules` — which a consumer's
 * config always is, including when the CLI itself is running from `dist/`.
 * A file that throws on import (a syntax error, a bad import) becomes a
 * {@link ConfigError}: a config that could not be read must stop the run, not
 * be treated as "no config" (§3.4).
 */
export async function loadConfig(startDir: string): Promise<LoadedConfig | undefined> {
  const configPath = findConfigFile(startDir);
  if (configPath === undefined) return undefined;

  let sourceText: string;
  try {
    sourceText = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    throw new ConfigError(`cannot read ${configPath}: ${messageOf(error)}`);
  }

  let module: { readonly default?: unknown };
  try {
    // The query is the file's own content hash, and it is load-bearing rather
    // than cosmetic: Node's ESM loader caches a module by URL for the life of
    // the process, so a second `loadConfig` on an edited config file in the
    // same process would return the *first* version's exports. One-shot
    // `ambit check` never noticed, but DESIGN.md §6.2's resident path is a
    // process that loads the config again after it changed — and §6.2's table
    // requires an `ambit.config.ts` change to re-derive every contract. A
    // cached module would satisfy that by re-deriving from stale data, which
    // is the failure §3.4 forbids wearing the shape of a success.
    //
    // Keyed by content rather than by a counter so an *unchanged* config is
    // still imported once: re-evaluating a module has side effects of its
    // own, and repeating them per check would be a cost the cold path never
    // had.
    const url = `${pathToFileURL(configPath).href}?v=${createHash("sha256").update(sourceText).digest("hex").slice(0, 16)}`;
    module = (await import(url)) as { readonly default?: unknown };
  } catch (error) {
    throw new ConfigError(`cannot load ${configPath}: ${messageOf(error)}`);
  }

  if (module.default === undefined) {
    throw new ConfigError(`${configPath} has no default export`);
  }
  return { configPath, config: validateConfig(module.default, configPath), sourceText };
}

const TOP_LEVEL_KEYS = ["effects", "contracts", "strict"] as const;
const CONTRACT_KEYS = ["effects", "capabilities", "budget", "entrypoint", "boundary"] as const;
const BUDGET_KEYS = ["timeMs", "costUsd", "llmCalls", "onExceed"] as const;

/**
 * Check the imported value against {@link AmbitConfig} by hand.
 *
 * An unknown key is rejected rather than ignored, for the reason a misspelled
 * effect name is (AMB-E002): a `contarcts:` block that is silently dropped
 * reads as a set of declarations and is not one.
 */
export function validateConfig(value: unknown, where: string): AmbitConfig {
  const root = asObject(value, where, "default export");
  rejectUnknownKeys(root, TOP_LEVEL_KEYS, where, "");

  const effects =
    root.effects === undefined ? undefined : validateEffectAliases(root.effects, where);
  const strict =
    root.strict === undefined ? undefined : validateStringArray(root.strict, where, "strict");
  const contracts =
    root.contracts === undefined
      ? undefined
      : validateContracts(root.contracts, where, new Set(Object.keys(effects ?? {})));

  return {
    ...(effects ? { effects } : {}),
    ...(contracts ? { contracts } : {}),
    ...(strict ? { strict } : {}),
  };
}

function validateEffectAliases(
  value: unknown,
  where: string,
): Readonly<Record<string, readonly string[]>> {
  const raw = asObject(value, where, "effects");
  const out: Record<string, readonly string[]> = {};
  for (const [name, members] of Object.entries(raw)) {
    if (name.trim().length === 0) throw new ConfigError(`${where}: effects has an empty name`);
    // A definition that shadows a standard effect would make `@effects env`
    // mean something different in two files (§4.1 (d)).
    if (isKnownEffect(name)) {
      throw new ConfigError(
        `${where}: effects.${name} redefines the standard effect "${name}"; user-defined names must not collide with ${KNOWN_EFFECTS.join(", ")}`,
      );
    }
    const list = validateStringArray(members, where, `effects.${name}`);
    for (const member of list) {
      // §4.1 (d): definitions do not expand into other definitions. Allowing
      // it would need a cycle check and would buy nothing a flat list cannot
      // express.
      if (!isKnownEffect(member)) {
        throw new ConfigError(
          `${where}: effects.${name} contains "${member}", which is not a standard effect (${KNOWN_EFFECTS.join(", ")})`,
        );
      }
    }
    if (list.length === 0) throw new ConfigError(`${where}: effects.${name} is empty`);
    out[name] = list;
  }
  return out;
}

function validateContracts(
  value: unknown,
  where: string,
  aliasNames: ReadonlySet<string>,
): Readonly<Record<string, ConfigContract>> {
  const raw = asObject(value, where, "contracts");
  const out: Record<string, ConfigContract> = {};
  for (const [key, contract] of Object.entries(raw)) {
    if (!key.includes("#")) {
      throw new ConfigError(
        `${where}: contracts key ${JSON.stringify(key)} is not "<file>#<symbol>"`,
      );
    }
    const [file = "", symbol = ""] = splitKey(key);
    if (file.length === 0 || symbol.length === 0) {
      throw new ConfigError(
        `${where}: contracts key ${JSON.stringify(key)} is not "<file>#<symbol>"`,
      );
    }
    if (symbol.includes("*")) {
      // §4.1 (b): the symbol half does not glob. A `#*` that quietly matched
      // everything in a file would be a contract nobody wrote.
      throw new ConfigError(
        `${where}: contracts key ${JSON.stringify(key)} globs the symbol half; only the file half may use * or **`,
      );
    }
    out[key] = validateContract(contract, where, key, aliasNames);
  }
  return out;
}

function validateContract(
  value: unknown,
  where: string,
  key: string,
  aliasNames: ReadonlySet<string>,
): ConfigContract {
  const raw = asObject(value, where, `contracts[${JSON.stringify(key)}]`);
  rejectUnknownKeys(raw, CONTRACT_KEYS, where, `contracts[${JSON.stringify(key)}].`);
  const at = `contracts[${JSON.stringify(key)}]`;

  const effects =
    raw.effects === undefined
      ? undefined
      : validateStringArray(raw.effects, where, `${at}.effects`);
  const capabilities =
    raw.capabilities === undefined
      ? undefined
      : validateStringArray(raw.capabilities, where, `${at}.capabilities`);
  if (raw.entrypoint !== undefined && typeof raw.entrypoint !== "boolean") {
    throw new ConfigError(`${where}: ${at}.entrypoint must be a boolean`);
  }
  if (raw.boundary !== undefined && typeof raw.boundary !== "string") {
    throw new ConfigError(`${where}: ${at}.boundary must be a string (the reason §4.6 requires)`);
  }
  if (raw.boundary !== undefined && (raw.boundary as string).trim().length === 0) {
    throw new ConfigError(`${where}: ${at}.boundary must give a non-empty reason (§4.6)`);
  }
  const budget = raw.budget === undefined ? undefined : validateBudget(raw.budget, where, at);

  // A misspelled effect or a malformed capability is rejected here rather
  // than turned into an "invalid" contract downstream: a JSDoc typo has a tag
  // location a diagnostic can point at, a config typo has a file the run has
  // already decided to trust, and §3.4 says a declaration that does not mean
  // what it says must stop the run rather than narrow silently.
  for (const effect of effects ?? []) {
    if (!isKnownEffect(effect) && !aliasNames.has(effect)) {
      throw new ConfigError(
        `${where}: ${at}.effects contains "${effect}", which is neither a standard effect nor defined under effects`,
      );
    }
  }
  for (const capability of capabilities ?? []) {
    if (parseCapability(capability) === undefined) {
      throw new ConfigError(
        `${where}: ${at}.capabilities contains "${capability}", which is not <resource>:<action>:<target>`,
      );
    }
  }

  if (
    effects === undefined &&
    capabilities === undefined &&
    budget === undefined &&
    raw.entrypoint === undefined &&
    raw.boundary === undefined
  ) {
    throw new ConfigError(`${where}: ${at} declares nothing`);
  }

  return {
    ...(effects ? { effects } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(budget ? { budget } : {}),
    ...(raw.entrypoint === undefined ? {} : { entrypoint: raw.entrypoint as boolean }),
    ...(raw.boundary === undefined ? {} : { boundary: (raw.boundary as string).trim() }),
  };
}

function validateBudget(
  value: unknown,
  where: string,
  at: string,
): {
  readonly timeMs?: number;
  readonly costUsd?: number;
  readonly llmCalls?: number;
  readonly onExceed?: OnExceed;
} {
  const raw = asObject(value, where, `${at}.budget`);
  rejectUnknownKeys(raw, BUDGET_KEYS, where, `${at}.budget.`);
  const out: Record<string, number | OnExceed> = {};
  for (const key of ["timeMs", "costUsd", "llmCalls"] as const) {
    const limit = raw[key];
    if (limit === undefined) continue;
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) {
      throw new ConfigError(`${where}: ${at}.budget.${key} must be a non-negative number`);
    }
    if (key === "llmCalls" && !Number.isInteger(limit)) {
      throw new ConfigError(`${where}: ${at}.budget.llmCalls must be an integer`);
    }
    out[key] = limit;
  }
  if (raw.onExceed !== undefined) {
    if (typeof raw.onExceed !== "string" || !isOnExceed(raw.onExceed)) {
      throw new ConfigError(`${where}: ${at}.budget.onExceed must be throw, warn or abort`);
    }
    out.onExceed = raw.onExceed;
  }
  // Same rule as `parseBudgetTag`: a policy with nothing to exceed is not a
  // budget.
  if (out.timeMs === undefined && out.costUsd === undefined && out.llmCalls === undefined) {
    throw new ConfigError(`${where}: ${at}.budget declares no limit`);
  }
  return out;
}

function asObject(value: unknown, where: string, at: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${where}: ${at} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  raw: Record<string, unknown>,
  known: readonly string[],
  where: string,
  prefix: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) {
      throw new ConfigError(
        `${where}: unknown key ${prefix}${key} (known keys: ${known.join(", ")})`,
      );
    }
  }
}

function validateStringArray(value: unknown, where: string, at: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigError(`${where}: ${at} must be an array of strings`);
  }
  return value as readonly string[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `"a/b.ts#Foo.bar"` → `["a/b.ts", "Foo.bar"]`, splitting on the first `#` only. */
function splitKey(key: string): readonly [string, string] {
  const hash = key.indexOf("#");
  return [key.slice(0, hash), key.slice(hash + 1)];
}

/**
 * A config entry after its file half has been made relative to the analysis
 * root, so it can be compared against a {@link SymbolId} directly.
 */
interface ResolvedEntry {
  /** The key as written, for diagnostics. */
  readonly key: string;
  readonly symbol: string;
  readonly matcher: RegExp;
  /** True when the file half contains no `*` — an exact key, which outranks every glob (§4.1 (b)). */
  readonly exact: boolean;
  /** The file half, root-relative, only meaningful when {@link exact}. */
  readonly file: string;
  readonly contract: ConfigContract;
}

/**
 * A config resolved against one analysis root: contract lookup by symbol id,
 * per-directory `strict`, and the user-defined effect table.
 */
export interface ResolvedConfig {
  readonly configPath: string;
  /**
   * The config file as diagnostics and fixes should name it: relative to the
   * analysis root when it sits inside it, absolute when it does not.
   *
   * Every other `location.file` and `edits[].file` in the output is
   * root-relative, and a consumer that resolves them against the checked
   * directory (`test/e2e.realistic.test.ts` does exactly that) would break on
   * one absolute path among them.
   */
  readonly displayPath: string;
  readonly sourceText: string;
  /** User-defined effect names → the standard effects they stand for (§4.1 (d)). */
  readonly effectAliases: ReadonlyMap<string, readonly KnownEffect[]>;
  /** The contract declared for `id`, or `undefined`. Records the match for {@link unmatchedExactKeys}. */
  contractFor(id: SymbolId): ConfigContract | undefined;
  /** Whether `relativeFile`'s diagnostics get `--strict`'s promotion (§4.3). */
  isStrictFile(relativeFile: string): boolean;
  /**
   * Exact keys that named no extracted symbol, after every lookup has run.
   * Glob keys are excluded on purpose: a glob matching nothing under the
   * directory being checked is normal, an exact key naming nothing is a typo.
   */
  unmatchedExactKeys(): readonly string[];
}

/**
 * Bind a loaded config to the directory being analyzed.
 *
 * Keys are written relative to the config file (§4.1 (c)) and symbol ids are
 * relative to the analysis root, so every key is rebased once, here, and
 * nothing downstream has to remember which base it is holding.
 */
export function resolveConfig(loaded: LoadedConfig, rootDir: string): ResolvedConfig {
  const configDir = path.dirname(loaded.configPath);
  const absoluteRoot = path.resolve(rootDir);

  const entries: ResolvedEntry[] = [];
  for (const [key, contract] of Object.entries(loaded.config.contracts ?? {})) {
    const hash = key.indexOf("#");
    const filePattern = key.slice(0, hash);
    const symbol = key.slice(hash + 1);
    const rebased = rebase(filePattern, configDir, absoluteRoot);
    entries.push({
      key,
      symbol,
      matcher: globToRegExp(rebased),
      exact: !filePattern.includes("*"),
      file: rebased,
      contract,
    });
  }

  const strictMatchers = (loaded.config.strict ?? []).map((pattern) =>
    globToRegExp(rebase(pattern, configDir, absoluteRoot)),
  );

  const effectAliases = new Map<string, readonly KnownEffect[]>();
  for (const [name, members] of Object.entries(loaded.config.effects ?? {})) {
    effectAliases.set(name, members.filter(isKnownEffect));
  }

  const matchedKeys = new Set<string>();

  const relative = path.relative(absoluteRoot, loaded.configPath);
  const displayPath =
    relative.startsWith("..") || path.isAbsolute(relative)
      ? loaded.configPath
      : relative.split(path.sep).join("/");

  return {
    configPath: loaded.configPath,
    displayPath,
    sourceText: loaded.sourceText,
    effectAliases,
    contractFor(id: SymbolId): ConfigContract | undefined {
      const hash = id.indexOf("#");
      if (hash < 0) return undefined;
      const file = id.slice(0, hash);
      const symbol = id.slice(hash + 1);

      const candidates = entries.filter(
        (entry) => entry.symbol === symbol && entry.matcher.test(file),
      );
      if (candidates.length === 0) return undefined;

      const exact = candidates.filter((entry) => entry.exact);
      // §4.1 (b): an exact key always wins, and two globs on one symbol is an
      // ambiguity the config author has to resolve — never a silent pick.
      if (exact.length > 0) {
        for (const entry of exact) matchedKeys.add(entry.key);
        if (exact.length > 1) {
          throw new ConfigError(
            `${loaded.configPath}: ${exact.map((e) => JSON.stringify(e.key)).join(" and ")} both name ${id}`,
          );
        }
        return exact[0]?.contract;
      }
      if (candidates.length > 1) {
        throw new ConfigError(
          `${loaded.configPath}: ${candidates
            .map((e) => JSON.stringify(e.key))
            .join(" and ")} both match ${id}; an exact key is needed to say which contract applies`,
        );
      }
      for (const entry of candidates) matchedKeys.add(entry.key);
      return candidates[0]?.contract;
    },
    isStrictFile(relativeFile: string): boolean {
      return strictMatchers.some((matcher) => matcher.test(relativeFile));
    },
    unmatchedExactKeys(): readonly string[] {
      return entries
        .filter((entry) => entry.exact && !matchedKeys.has(entry.key))
        .map((entry) => entry.key);
    },
  };
}

/**
 * A config-relative pattern rewritten relative to the analysis root, using
 * `/` throughout (a {@link SymbolId}'s file half always does, on every
 * platform).
 */
function rebase(pattern: string, configDir: string, absoluteRoot: string): string {
  const absolute = path.resolve(configDir, pattern);
  return path.relative(absoluteRoot, absolute).split(path.sep).join("/");
}

/**
 * §4.1 (b)'s glob: `*` matches within one path segment, `**` crosses
 * directories. Hand-rolled rather than delegated to `path.matchesGlob`, whose
 * semantics are the shell's and are not the two lines the spec commits to.
 *
 * A pattern that escapes the analysis root (`../…` after rebasing) still
 * compiles; it simply matches no root-relative file, which is the honest
 * answer for a key naming something outside the run.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char !== "*") {
      out += escapeRegExp(char ?? "");
      continue;
    }
    if (pattern[i + 1] === "*") {
      // `**/` spans zero or more directories, so `src/**/a.ts` matches
      // `src/a.ts` as well as `src/x/y/a.ts`.
      if (pattern[i + 2] === "/") {
        out += "(?:[^/]*(?:/|$))*";
        i += 2;
        continue;
      }
      out += "[\\s\\S]*";
      i += 1;
      continue;
    }
    out += "[^/]*";
  }
  return new RegExp(`^${out}$`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
