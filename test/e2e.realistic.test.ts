import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../src/core/index.ts";
import { applyEdits } from "./support/apply-edits.ts";

/**
 * The accidents this fixture exists to stop, run end to end against a project
 * shaped like one a coding agent would produce: HTTP handlers with
 * `@entrypoint` contracts, a `pg` pool and a Prisma client, an LLM SDK, a
 * barrel file, and pure domain logic (`docs/goals/realistic-api.md`).
 *
 * The fixture depends on nothing installed: `pg`, `@prisma/client`, `openai`
 * and `ambit/runtime` are declared under `types/` and the tsconfig sets
 * `types: []`, so a scratch copy outside the repository resolves exactly the
 * same way. Every accident is applied to such a copy as a textual patch, which
 * is what an agent's edit actually looks like — one baseline, six edits, not
 * six near-identical fixtures.
 */

const execFileAsync = promisify(execFile);
const CLI_PATH = path.join(import.meta.dirname, "..", "src", "cli", "main.ts");
const FIXTURE_ROOT = path.join(import.meta.dirname, "fixtures", "realistic-api");

interface CheckResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly exitCode: number;
}

async function run(
  command: "check" | "init",
  dir: string,
  extra: readonly string[] = [],
): Promise<CheckResult> {
  let stdout = "";
  let exitCode = 0;
  try {
    ({ stdout } = await execFileAsync("node", [
      CLI_PATH,
      command,
      dir,
      "--format",
      "json",
      ...extra,
    ]));
  } catch (error) {
    const e = error as { stdout?: string; code?: number };
    stdout = e.stdout ?? "";
    exitCode = e.code ?? 1;
  }
  const diagnostics = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Diagnostic & { kind?: string })
    .filter((record) => record.kind === undefined);
  return { diagnostics, exitCode };
}

function errors(result: CheckResult): readonly Diagnostic[] {
  return result.diagnostics.filter((d) => d.severity === "error");
}

/** One textual edit standing in for what an agent would write. */
interface Patch {
  readonly file: string;
  readonly find: string;
  readonly replace: string;
}

async function scratchCopy(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ambit-realistic-"));
  await fs.cp(FIXTURE_ROOT, dir, { recursive: true });
  return dir;
}

/**
 * A scratch copy of the fixture with `patches` applied. `find` must occur
 * exactly once — a patch that silently matched nothing would make the test
 * assert against the baseline and pass for the wrong reason.
 */
async function variant(patches: readonly Patch[]): Promise<string> {
  const dir = await scratchCopy();
  for (const patch of patches) {
    const full = path.join(dir, patch.file);
    const source = await fs.readFile(full, "utf8");
    const occurrences = source.split(patch.find).length - 1;
    if (occurrences !== 1) {
      throw new Error(`patch for ${patch.file} matched ${occurrences} times, expected 1`);
    }
    await fs.writeFile(full, source.replace(patch.find, patch.replace));
  }
  return dir;
}

async function withVariant(
  patches: readonly Patch[],
  assertions: (result: CheckResult) => void,
): Promise<void> {
  const dir = await variant(patches);
  try {
    assertions(await run("check", dir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** The diagnostic of `id` reported at `file:line`, for asserting position as well as code. */
function at(result: CheckResult, id: string, file: string, line: number): Diagnostic | undefined {
  return result.diagnostics.find(
    (d) => d.id === id && d.location.file === file && d.location.line === line,
  );
}

const PURE_TARGET = `/** @effects pure */
export function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}`;

describe("realistic API fixture (docs/goals/realistic-api.md)", () => {
  it("reports no error on the baseline", async () => {
    // The floor every accident is measured against: a project written the way
    // Ambit asks for it must not be noisy.
    const result = await run("check", FIXTURE_ROOT);
    expect(errors(result)).toEqual([]);
    expect(result.exitCode).toBe(0);
  }, 60_000);

  it("accident 1: a `fetch` added to a pure function is AMB-E001", async () => {
    await withVariant(
      [
        {
          file: "src/domain/money.ts",
          find: PURE_TARGET,
          replace: `/** @effects pure */
export async function formatCents(cents: number): Promise<string> {
  await fetch("https://api.example.com/format");
  return (cents / 100).toFixed(2);
}`,
        },
      ],
      (result) => {
        const diagnostic = at(result, "AMB-E001", "src/domain/money.ts", 2);
        expect(diagnostic?.message).toContain("performs [network] directly");
        expect(result.exitCode).toBe(1);
      },
    );
  }, 60_000);

  it("accident 2: a Prisma read added to a pure function is a db_read violation", async () => {
    await withVariant(
      [
        {
          file: "src/domain/money.ts",
          find: PURE_TARGET,
          replace: `import { prisma } from "../lib/index.ts";

/** @effects pure */
export async function formatCents(cents: number): Promise<string> {
  await prisma.user.findMany({});
  return (cents / 100).toFixed(2);
}`,
        },
      ],
      (result) => {
        const diagnostic = at(result, "AMB-E001", "src/domain/money.ts", 4);
        expect(diagnostic?.message).toContain("performs [db_read] directly");
        expect(result.exitCode).toBe(1);
      },
    );
  }, 60_000);

  it("accident 2: a literal INSERT through `pool.query` is a db_write violation", async () => {
    await withVariant(
      [
        {
          file: "src/domain/money.ts",
          find: PURE_TARGET,
          replace: `import { pool } from "../lib/index.ts";

/** @effects pure */
export async function formatCents(cents: number): Promise<string> {
  await pool.query("INSERT INTO audit (cents) VALUES ($1)", [cents]);
  return (cents / 100).toFixed(2);
}`,
        },
      ],
      (result) => {
        const diagnostic = at(result, "AMB-E001", "src/domain/money.ts", 4);
        // The direction came from the statement's leading keyword, not from a
        // blanket "any query touches the database both ways".
        expect(diagnostic?.message).toContain("performs [db_write] directly");
        expect(result.exitCode).toBe(1);
      },
    );
  }, 60_000);

  it("accident 2: a non-literal statement contributes both directions", async () => {
    await withVariant(
      [
        {
          file: "src/domain/money.ts",
          find: PURE_TARGET,
          replace: `import { pool } from "../lib/index.ts";

/** @effects pure */
export async function formatCents(cents: number, sql: string): Promise<string> {
  await pool.query(sql, [cents]);
  return (cents / 100).toFixed(2);
}`,
        },
      ],
      (result) => {
        const diagnostic = at(result, "AMB-E001", "src/domain/money.ts", 4);
        expect(diagnostic?.message).toContain("performs [db_read, db_write] directly");
        expect(result.exitCode).toBe(1);
      },
    );
  }, 60_000);

  it("accident 3: an LLM call added to a pure function is an llm violation", async () => {
    await withVariant(
      [
        {
          file: "src/domain/money.ts",
          find: PURE_TARGET,
          replace: `import { openai } from "../lib/index.ts";

/** @effects pure */
export async function formatCents(cents: number): Promise<string> {
  await openai.chat.completions.create({ model: "gpt-4o-mini", messages: [] });
  return (cents / 100).toFixed(2);
}`,
        },
      ],
      (result) => {
        const diagnostic = at(result, "AMB-E001", "src/domain/money.ts", 4);
        // `llm` implies `network` (DESIGN.md §4.2), so both are excess here.
        expect(diagnostic?.message).toContain("llm");
        expect(diagnostic?.message).toContain("network");
        expect(result.exitCode).toBe(1);
      },
    );
  }, 60_000);

  it("accident 5: a barrel-imported network function called from a pure function is AMB-E001", async () => {
    await withVariant(
      [
        {
          file: "src/domain/money.ts",
          find: PURE_TARGET,
          replace: `import { fetchRate } from "../lib/index.ts";

/** @effects pure */
export async function formatCents(cents: number): Promise<string> {
  const rate = await fetchRate("usd");
  return ((cents * rate) / 100).toFixed(2);
}`,
        },
      ],
      (result) => {
        const diagnostic = at(result, "AMB-E001", "src/domain/money.ts", 4);
        expect(diagnostic?.message).toContain("fetchRate");
        // The point of the case: the callee was reached through `src/lib/index.ts`,
        // and the path names the module that actually declares it.
        const via =
          diagnostic?.contract && "via" in diagnostic.contract ? diagnostic.contract.via : [];
        expect(via.map((entry) => entry.symbol)).toContain("src/lib/rates.ts#fetchRate");
        expect(result.exitCode).toBe(1);
      },
    );
  }, 60_000);

  it("accident 4: a literal URL outside the granted target is AMB-E009 at the call site", async () => {
    await withVariant(
      [
        {
          file: "src/routes/users.ts",
          find: "  const users = await listUsers();",
          replace: `  const users = await listUsers();
  await fetch("https://elsewhere.example/steal");`,
        },
      ],
      (result) => {
        const diagnostic = at(result, "AMB-E009", "src/routes/users.ts", 18);
        expect(diagnostic?.message).toContain("http:get:elsewhere.example");
        // §5.3: no fabricated patch — widening the grant and changing the URL
        // are both plausible and Ambit cannot tell which was meant.
        expect(diagnostic?.fixes).toEqual([]);
        expect(result.exitCode).toBe(1);
      },
    );
  }, 60_000);

  it("accident 4: a granted literal URL is not reported", async () => {
    // The other half of the same claim: the check has to be about the target,
    // not about `fetch` appearing in an entrypoint at all.
    await withVariant(
      [
        {
          file: "src/routes/users.ts",
          find: "  const users = await listUsers();",
          replace: `  const users = await listUsers();
  await fetch("https://api.example.com/ping");`,
        },
      ],
      (result) => {
        expect(errors(result)).toEqual([]);
        expect(result.exitCode).toBe(0);
      },
    );
  }, 60_000);

  it("accident 4: a URL the source does not fix stays a warning, and says why", async () => {
    await withVariant(
      [
        {
          file: "src/routes/users.ts",
          find: "  const users = await listUsers();",
          replace: `  const users = await listUsers();
  await fetch(currency);`,
        },
      ],
      (result) => {
        const warning = result.diagnostics.find(
          (d) => d.id === "AMB-W003" && d.location.file === "src/routes/users.ts",
        );
        expect(warning?.message).toContain("not a literal in the source");
        expect(warning?.message).toContain("only the runtime can match");
        // A dynamic URL is the runtime's job (§4.4), so the static check must
        // not fail the build over it.
        expect(errors(result)).toEqual([]);
        expect(result.exitCode).toBe(0);
      },
    );
  }, 60_000);

  it("round-trips `ambit init`: every proposal applies and `check` stays clean", async () => {
    const dir = await scratchCopy();
    try {
      const proposals = await run("init", dir);
      expect(proposals.exitCode).toBe(0);
      const withPatches = proposals.diagnostics.filter((d) => d.fixes.length > 0);
      expect(withPatches.length).toBeGreaterThan(0);

      const byFile = new Map<string, Diagnostic["fixes"][number]["edits"][number][]>();
      for (const diagnostic of withPatches) {
        for (const edit of diagnostic.fixes[0]?.edits ?? []) {
          const list = byFile.get(edit.file) ?? [];
          list.push(edit);
          byFile.set(edit.file, list);
        }
      }
      for (const [file, edits] of byFile) {
        const full = path.join(dir, file);
        await fs.writeFile(full, applyEdits(await fs.readFile(full, "utf8"), edits));
      }

      const after = await run("check", dir);
      expect(errors(after)).toEqual([]);
      expect(after.exitCode).toBe(0);

      // Every proposal that carried a patch is consumed; the ones that did not
      // are the functions whose effects stayed `unknown`, where proposing
      // `pure` would manufacture a guarantee (§4.3).
      const remaining = await run("init", dir);
      expect(remaining.diagnostics.filter((d) => d.fixes.length > 0)).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
