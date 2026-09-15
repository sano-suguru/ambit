import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packedTarball } from "./support/pack.ts";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.join(import.meta.dirname, "..");

/**
 * The removal procedure README.md documents, run against an application.
 *
 * Backing out of Ambit at any time is a design principle, and the claim that
 * backs it is a procedure in README.md. This file does not restate that
 * procedure: it reads the numbered steps out of the "Removing Ambit" section and
 * runs each shell block as written, so a README edit that breaks the procedure
 * breaks this test, and a test that still passes after the README drifted is not
 * possible.
 *
 * The subject is shaped like an application rather than a fixture: its
 * dependencies are installed by npm from the registry and from the packed
 * tarball, it serves HTTP through `@hono/node-server`, it mounts a Next.js
 * Route Handler, and it has tests of its own. It imports every subpath the
 * package exports, because a step for a subpath the application never uses
 * could be deleted from README without anything noticing.
 */

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  timeout = 120_000,
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      cwd,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
}

interface RemovalStep {
  /** The list item's prose, which names the entry point the step removes. */
  readonly prose: string;
  readonly command: string;
}

/** The numbered steps under README's "Removing Ambit", in document order. */
async function readRemovalSteps(): Promise<readonly RemovalStep[]> {
  const readme = await fs.readFile(path.join(REPO_ROOT, "README.md"), "utf8");
  const start = readme.indexOf("\n## Removing Ambit\n");
  if (start < 0) throw new Error('README.md has no "## Removing Ambit" section');
  const end = readme.indexOf("\n## ", start + 1);
  const section = readme.slice(start, end < 0 ? undefined : end);

  const steps: RemovalStep[] = [];
  for (const item of section.split(/\n(?=\d+\. )/).slice(1)) {
    const block = /\n( *)```sh\n([\s\S]*?)\n *```/.exec(item);
    if (!block) throw new Error(`README removal step has no sh block:\n${item}`);
    const indent = block[1] ?? "";
    const command = (block[2] ?? "")
      .split("\n")
      .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
      .join("\n");
    steps.push({ prose: item.slice(0, block.index), command });
  }
  return steps;
}

/** `"."` → `ambit-ts`, `"./runtime"` → `ambit-ts/runtime`. */
async function exportedSpecifiers(): Promise<readonly string[]> {
  const manifest = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  return Object.keys(manifest.exports as Record<string, unknown>).map((key) =>
    key === "." ? manifest.name : `${manifest.name}/${key.slice(2)}`,
  );
}

/**
 * The part of `scripts/report.ts` that uses Ambit's diagnostic types. README
 * removes only the import and leaves this code to the reader, because a file
 * importing the types can hold code of the application's own — here
 * `formatDuration`, which the application's tests use. Deleting this block is
 * the one edit the test makes by hand, standing in for that reader.
 */
const REPORT_DIAGNOSTIC_CODE = `
export function errorCount(ndjson: string): number {
  return ndjson
    .split("\\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Diagnostic)
    .filter((record) => record.severity === "error").length;
}
`;

const RATES = `{ "base": "USD", "rates": { "EUR": 0.92, "JPY": 151.3 } }\n`;

/**
 * The application, file by file. `data/rates.json` is the one file its routes
 * are granted; `package.json` is the one a route reads without a grant, which is
 * how the run before removal proves the hooks were enforcing anything.
 */
const APP_FILES: Readonly<Record<string, string>> = {
  "data/rates.json": RATES,

  "src/rates.ts": `import fs from "node:fs";
import { withAmbit } from "ambit-ts/runtime";

export interface Rates {
  readonly base: string;
  readonly rates: Readonly<Record<string, number>>;
}

/**
 * @entrypoint
 * @effects fs_read
 */
export async function currentRates(file: string): Promise<Rates> {
  return JSON.parse(await fs.promises.readFile(file, "utf8")) as Rates;
}

/**
 * @entrypoint
 * @effects fs_read
 */
export async function manifestName(file: string): Promise<{ readonly name: string }> {
  const manifest = JSON.parse(await fs.promises.readFile(file, "utf8")) as { name: string };
  return { name: manifest.name };
}

/** @effects fs_read */
async function convert(amount: number, currency: string): Promise<{ readonly total: number }> {
  const { rates } = await currentRates("data/rates.json");
  return { total: Math.round(amount * (rates[currency] ?? 0) * 100) / 100 };
}

export const quote = withAmbit({ capabilities: ["fs:read:*/data/rates.json"] }, convert);
`,

  "src/app.ts": `import { Hono } from "hono";
import type { NextRequest } from "next/server";
import { ambitHandler } from "ambit-ts/runtime/hono";
import { GET as nextRates } from "../app/rates/route.ts";
import { currentRates, manifestName, quote } from "./rates.ts";

export const app = new Hono();

app.onError((error, c) => c.json({ error: error.name }, 500));

app.get(
  "/rates",
  ambitHandler(
    { capabilities: ["fs:read:*/data/rates.json"], budget: { timeMs: 2000 } },
    currentRates,
    () => ["data/rates.json"] as const,
  ),
);

app.get(
  "/manifest",
  ambitHandler(
    { capabilities: ["fs:read:*/data/rates.json"] },
    manifestName,
    () => ["package.json"] as const,
  ),
);

app.get("/quote", async (c) => c.json(await quote(Number(c.req.query("amount") ?? "1"), "JPY")));

app.get("/next/rates", (c) =>
  nextRates(c.req.raw as NextRequest, { params: Promise.resolve({}) }),
);
`,

  "src/server.ts": `import { serve } from "@hono/node-server";
import { installFsHook, setUnscopedPolicy } from "ambit-ts/runtime";
import { app } from "./app.ts";

installFsHook();
setUnscopedPolicy("allow");

serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
  console.log(\`listening on \${info.port}\`);
});
`,

  "app/rates/route.ts": `import { ambitRoute } from "ambit-ts/runtime/next";
import { currentRates, type Rates } from "../../src/rates.ts";

/**
 * @entrypoint
 * @effects fs_read
 */
async function ratesFor(currency: string): Promise<Rates> {
  const all = await currentRates("data/rates.json");
  return { base: all.base, rates: { [currency]: all.rates[currency] ?? 0 } };
}

export const GET = ambitRoute(
  { capabilities: ["fs:read:*/data/rates.json"], budget: { timeMs: 2000 } },
  ratesFor,
  (request) => [new URL(request.url).searchParams.get("currency") ?? "EUR"] as const,
);
`,

  "scripts/report.ts": `import type { Diagnostic } from "ambit-ts";
${REPORT_DIAGNOSTIC_CODE}
export function formatDuration(ms: number): string {
  return ms < 1000 ? \`\${ms}ms\` : \`\${(ms / 1000).toFixed(1)}s\`;
}
`,

  "ambit.config.ts": `import { defineConfig } from "ambit-ts/config";

export default defineConfig({
  strict: ["src/**"],
});
`,

  ".github/workflows/ambit.yml": `name: Ambit
on: pull_request
jobs:
  ambit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: npm ci
      - run: npx ambit diff HEAD~1 src --format github
`,

  "ambit.approvals.md": "# Approvals\n",

  "test/app.test.ts": `import assert from "node:assert/strict";
import { test } from "node:test";
import type { NextRequest } from "next/server";
import { GET } from "../app/rates/route.ts";
import { formatDuration } from "../scripts/report.ts";
import { app } from "../src/app.ts";

test("formats a duration", () => {
  assert.equal(formatDuration(1500), "1.5s");
});

test("serves the rate table", async () => {
  const response = await app.request("/rates");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    base: "USD",
    rates: { EUR: 0.92, JPY: 151.3 },
  });
});

test("quotes an amount", async () => {
  const response = await app.request("/quote?amount=2");
  assert.deepEqual(await response.json(), { total: 302.6 });
});

test("answers one currency from the route handler", async () => {
  const request = new Request("http://localhost/rates?currency=JPY") as NextRequest;
  const response = await GET(request, { params: Promise.resolve({}) });
  assert.deepEqual(await response.json(), { base: "USD", rates: { JPY: 151.3 } });
});
`,

  "tsconfig.json": `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2023",
        module: "ESNext",
        moduleResolution: "bundler",
        allowImportingTsExtensions: true,
        lib: ["ES2023", "DOM"],
        types: ["node"],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["src", "app", "scripts", "test", "*.ts"],
    },
    null,
    2,
  )}\n`,
};

/** The routes the application grants, with the responses compared across removal. */
const ALLOWED_PATHS = ["/rates", "/quote?amount=3", "/next/rates?currency=JPY"] as const;

interface HttpResponse {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
}

async function withServer<T>(
  appDir: string,
  body: (get: (pathname: string) => Promise<HttpResponse>) => Promise<T>,
): Promise<T> {
  const child: ChildProcess = spawn("node", ["src/server.ts"], {
    cwd: appDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let output = "";
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        const match = /listening on (\d+)/.exec(output);
        if (match) resolve(Number(match[1]));
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("exit", (code) => reject(new Error(`server exited ${code}: ${output}`)));
      setTimeout(() => reject(new Error(`server did not start: ${output}`)), 30_000);
    });
    return await body(async (pathname) => {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        body: await response.text(),
      };
    });
  } finally {
    child.kill();
  }
}

async function listFiles(dir: string, relative = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(path.join(dir, relative), { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(dir, child)));
    else files.push(child);
  }
  return files;
}

const AMBIT_IMPORT = /from\s+["']ambit-ts(?:\/[^"']*)?["']/g;

async function ambitImports(appDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const file of await listFiles(appDir)) {
    if (!file.endsWith(".ts")) continue;
    const text = await fs.readFile(path.join(appDir, file), "utf8");
    for (const match of text.matchAll(AMBIT_IMPORT)) found.push(`${file}: ${match[0]}`);
  }
  return found;
}

/**
 * Every way the application can still be carrying Ambit, or be broken by its
 * removal. Empty means removed; each entry names the check that failed, so a
 * step left out has to fail for a reason, not merely somewhere.
 */
async function removalFailures(
  appDir: string,
  baseline: ReadonlyMap<string, HttpResponse>,
): Promise<string[]> {
  const failures: string[] = [];

  const imports = await ambitImports(appDir);
  if (imports.length > 0) failures.push(`imports: ${imports.join(", ")}`);

  const manifest = JSON.parse(await fs.readFile(path.join(appDir, "package.json"), "utf8"));
  if ({ ...manifest.dependencies, ...manifest.devDependencies }["ambit-ts"] !== undefined) {
    failures.push("manifest: package.json still depends on ambit-ts");
  }

  // Anything left that names Ambit is a leftover the procedure missed — the
  // CI workflow that runs `npx ambit`, or the approval ledger.
  for (const file of await listFiles(appDir)) {
    const text = await fs.readFile(path.join(appDir, file), "utf8");
    if (text.includes("ambit")) failures.push(`leftover: ${file} mentions ambit`);
  }

  const typecheck = await run(path.join("node_modules", ".bin", "tsc"), ["--noEmit"], appDir);
  if (typecheck.exitCode !== 0)
    failures.push(`tsc: exit ${typecheck.exitCode}\n${typecheck.stdout}`);

  const ownTests = await run("npm", ["test"], appDir);
  if (ownTests.exitCode !== 0) {
    failures.push(`own tests: exit ${ownTests.exitCode}\n${ownTests.stdout}${ownTests.stderr}`);
  }

  try {
    await withServer(appDir, async (get) => {
      for (const pathname of ALLOWED_PATHS) {
        const response = await get(pathname);
        const before = baseline.get(pathname);
        if (JSON.stringify(response) !== JSON.stringify(before)) {
          failures.push(
            `http: ${pathname} answered ${JSON.stringify(response)}, before removal ${JSON.stringify(before)}`,
          );
        }
      }
    });
  } catch (error) {
    failures.push(`http: ${String(error)}`);
  }

  return failures;
}

async function writeFiles(appDir: string, files: ReadonlyMap<string, string>): Promise<void> {
  for (const file of await listFiles(appDir)) await fs.rm(path.join(appDir, file));
  for (const [file, text] of files) {
    await fs.mkdir(path.dirname(path.join(appDir, file)), { recursive: true });
    await fs.writeFile(path.join(appDir, file), text);
  }
}

async function runSteps(appDir: string, steps: readonly RemovalStep[]): Promise<void> {
  for (const step of steps) {
    const result = await run("sh", ["-c", step.command], appDir);
    expect(result.exitCode, `${step.command}\n${result.stdout}${result.stderr}`).toBe(0);
  }
}

/** The reader's hand edit README asks for after the import is gone. */
async function removeDiagnosticCode(appDir: string): Promise<void> {
  const file = path.join(appDir, "scripts", "report.ts");
  await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace(REPORT_DIAGNOSTIC_CODE, ""));
}

describe("removal: README's procedure takes Ambit out of an application", () => {
  let workspace: string;
  let appDir: string;
  let steps: readonly RemovalStep[];
  /** Every file outside `node_modules` as installed, before any step ran. */
  let installed: ReadonlyMap<string, string>;
  const baseline = new Map<string, HttpResponse>();
  let fullProcedurePassed = false;

  beforeAll(async () => {
    steps = await readRemovalSteps();
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ambit-removal-"));
    appDir = path.join(workspace, "rates-service");
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, "package.json"),
      `${JSON.stringify(
        {
          name: "rates-service",
          version: "1.0.0",
          private: true,
          type: "module",
          scripts: { start: "node src/server.ts", test: "node --test test/*.test.ts" },
        },
        null,
        2,
      )}\n`,
    );
    await writeFiles(
      appDir,
      new Map([
        ["package.json", await fs.readFile(path.join(appDir, "package.json"), "utf8")],
        ...Object.entries(APP_FILES),
      ]),
    );

    const tarball = await packedTarball();
    const production = await run(
      "npm",
      ["install", "--no-audit", "--no-fund", tarball, "hono@4", "@hono/node-server@1"],
      appDir,
    );
    expect(production.exitCode, production.stderr).toBe(0);
    // Pinned to README's version, so README's `npx --package` resolves it from
    // here instead of from the registry on every step.
    const development = await run(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "-D",
        "typescript@6.0.3",
        "@types/node@24",
        "next@16",
        "@ast-grep/cli@0.45.3",
      ],
      appDir,
    );
    expect(development.exitCode, development.stderr).toBe(0);

    installed = new Map(
      await Promise.all(
        (await listFiles(appDir)).map(
          async (file) => [file, await fs.readFile(path.join(appDir, file), "utf8")] as const,
        ),
      ),
    );
  }, 300_000);

  afterAll(async () => {
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
  });

  it("has a step for every subpath package.json exports, and the application imports each", async () => {
    const specifiers = await exportedSpecifiers();
    expect(specifiers).toEqual([
      "ambit-ts",
      "ambit-ts/config",
      "ambit-ts/runtime",
      "ambit-ts/runtime/hono",
      "ambit-ts/runtime/next",
    ]);
    expect(steps.length).toBeGreaterThan(0);

    // A step handles a subpath when its prose or its command names it. The
    // root specifier is a prefix of every other one, so a name only counts
    // where no further path segment follows it.
    for (const specifier of specifiers) {
      const named = new RegExp(`(?<![\\w/-])${specifier}(?![\\w/-])`);
      expect(
        steps.some((step) => named.test(step.prose) || named.test(step.command)),
        specifier,
      ).toBe(true);
    }

    // Without this, "zero imports afterwards" could hold for a subpath the
    // application never imported in the first place.
    const before = (await ambitImports(appDir)).join("\n");
    for (const specifier of specifiers) expect(before).toContain(`"${specifier}"`);
  });

  it("serves the allowed routes, and refuses an ungranted read, while Ambit is installed", async () => {
    await withServer(appDir, async (get) => {
      for (const pathname of ALLOWED_PATHS) {
        const response = await get(pathname);
        expect(response.status, `${pathname}: ${response.body}`).toBe(200);
        baseline.set(pathname, response);
      }
      // The hooks are live: this is what makes the runs below a removal of
      // enforcement, not of dead code.
      const denied = await get("/manifest");
      expect(denied.status).toBe(500);
      expect(denied.body).toBe('{"error":"AmbitCapabilityError"}');
    });

    const typecheck = await run(path.join("node_modules", ".bin", "tsc"), ["--noEmit"], appDir);
    expect(typecheck.exitCode, typecheck.stdout).toBe(0);
    const ownTests = await run("npm", ["test"], appDir);
    expect(ownTests.exitCode, ownTests.stdout + ownTests.stderr).toBe(0);
  }, 120_000);

  it("removes every import, and leaves an application that type-checks, passes its tests, and answers as before", async () => {
    await writeFiles(appDir, installed);
    await runSteps(appDir, steps);
    expect(await ambitImports(appDir)).toEqual([]);

    // README removed the import and left the code that used it. The file is
    // still there with the application's own function in it, and the type
    // errors README tells the reader to expect are confined to that file.
    const report = await fs.readFile(path.join(appDir, "scripts", "report.ts"), "utf8");
    expect(report).toContain("export function formatDuration");
    const typecheck = await run(path.join("node_modules", ".bin", "tsc"), ["--noEmit"], appDir);
    expect(typecheck.exitCode).not.toBe(0);
    const erroredFiles = new Set(
      [...typecheck.stdout.matchAll(/^(\S+)\(\d+,\d+\): error/gm)].map((m) => m[1]),
    );
    expect([...erroredFiles]).toEqual(["scripts/report.ts"]);

    await removeDiagnosticCode(appDir);
    expect(await removalFailures(appDir, baseline)).toEqual([]);
    fullProcedurePassed = true;
  }, 120_000);

  it("fails removal when any one step is left out", async () => {
    // Every check below must be one the whole procedure passes; otherwise a
    // variant could fail for a reason that has nothing to do with its step.
    expect(fullProcedurePassed).toBe(true);
    for (const [index, step] of steps.entries()) {
      await writeFiles(appDir, installed);
      await runSteps(
        appDir,
        steps.filter((_, i) => i !== index),
      );
      await removeDiagnosticCode(appDir);
      const failures = await removalFailures(appDir, baseline);
      expect(failures, `step ${index + 1} left out:\n${step.command}`).not.toEqual([]);
      console.log(
        `step ${index + 1} left out -> ${failures.map((f) => f.split("\n")[0]).join(" | ")}`,
      );
    }
  }, 120_000);
});
