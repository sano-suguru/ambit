import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../src/core/index.ts";

/**
 * `ambit.config.ts` end to end (DESIGN.md §4.1「コード外宣言」).
 *
 * Every case is a scratch project built in a temp directory, checked through
 * the CLI as a subprocess: a config is loaded by *importing* it, and the only
 * honest test of that is a real file on disk that a real process resolves.
 *
 * The configs here export a bare object rather than calling `defineConfig`.
 * `defineConfig` is the identity function, so the two are the same value —
 * and a scratch directory outside this repository cannot resolve
 * `ambit/config` unless the package is installed, which is
 * `test/e2e.install.test.ts`'s job, not this file's.
 */

const execFileAsync = promisify(execFile);
const CLI_PATH = path.join(import.meta.dirname, "..", "src", "cli", "main.ts");

const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ES2023",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2023"],
      types: [],
      strict: true,
      noEmit: true,
    },
    include: ["src/**/*.ts"],
  },
  null,
  2,
)}\n`;

interface RunResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

async function run(
  dir: string,
  args: readonly string[] = ["check", "src", "--format", "json"],
): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    ({ stdout, stderr } = await execFileAsync("node", [CLI_PATH, ...args], { cwd: dir }));
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
    exitCode = e.code ?? 1;
  }
  const diagnostics = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const record = JSON.parse(line) as Diagnostic & { kind?: string };
        return record.kind === undefined ? [record] : [];
      } catch {
        return [];
      }
    });
  return { diagnostics, stdout, stderr, exitCode };
}

/** A scratch project: `src/` with the given files, plus a tsconfig and an optional config. */
async function project(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ambit-config-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "tsconfig.json"), TSCONFIG);
  // A package.json is what stops the config search from walking out of the
  // scratch directory into whatever is above the temp dir (§4.1 (c)).
  await fs.writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "scratch", private: true, type: "module" }, null, 2)}\n`,
  );
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  }
  return dir;
}

describe("ambit.config.ts: contracts declared outside the code", () => {
  it("(a) treats a config-only contract as a contract: the violation is AMB-E001", async () => {
    // `charge` carries no JSDoc at all. Without the config it is simply
    // undeclared — a coverage figure, not a violation (§4.2). With it, the
    // declaration is `pure`, and the `fetch` in the body breaks it.
    const dir = await project({
      "src/billing.ts": `export async function charge(id: string): Promise<number> {
  const response = await fetch("https://payments.example.test/" + id);
  return response.status;
}
`,
      "ambit.config.ts": `export default {
  contracts: {
    "src/billing.ts#charge": { effects: [] },
  },
};
`,
    });

    const result = await run(dir);
    expect(result.exitCode).toBe(1);
    const violation = result.diagnostics.find((d) => d.id === "AMB-E001");
    expect(violation).toBeDefined();
    expect(violation?.message).toContain("charge");
    expect(violation?.contract).toMatchObject({ declared: ["pure"], observed: ["network"] });

    // …and the same source without the config is clean, so the diagnostic is
    // the config's doing and not something the file would have produced anyway.
    await fs.rm(path.join(dir, "ambit.config.ts"));
    const without = await run(dir);
    expect(without.exitCode).toBe(0);
    expect(without.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("(a) declares capabilities, budget, entrypoint and boundary the same way", async () => {
    const dir = await project({
      "src/routes.ts": `export async function GET(): Promise<number> {
  const response = await fetch("https://api.example.test/users");
  return response.status;
}

export function opaque(input: string): unknown {
  return (0, eval)(input);
}
`,
      "ambit.config.ts": `export default {
  contracts: {
    "src/routes.ts#GET": {
      entrypoint: true,
      effects: ["network"],
      capabilities: ["http:get:api.example.test"],
      budget: { timeMs: 500 },
    },
    "src/routes.ts#opaque": {
      boundary: "hand-audited eval trampoline",
      effects: ["process"],
    },
  },
};
`,
    });

    const result = await run(dir, ["check", "src", "--format", "json", "--coverage"]);
    expect(result.exitCode).toBe(0);
    // An entrypoint with no capabilities is AMB-W002; the config supplied
    // them, so it is absent. A boundary keeps `opaque` out of the unknown
    // count, which is what `--coverage` reports.
    expect(result.diagnostics.map((d) => d.id)).not.toContain("AMB-W002");
    expect(result.stdout).toContain('"functionsEntrypoint":1');
    expect(result.stdout).toContain('"functionsBoundary":1');
  });

  it("(b) reports the JSDoc/config difference as AMB-W005 and keeps the JSDoc contract", async () => {
    const dir = await project({
      "src/tax.ts": `/** @effects pure */
export function addTax(amount: number, rate: number): number {
  return amount * (1 + rate);
}
`,
      "ambit.config.ts": `export default {
  contracts: {
    "src/tax.ts#addTax": { effects: ["db_read"] },
  },
};
`,
    });

    const result = await run(dir);
    const divergence = result.diagnostics.find((d) => d.id === "AMB-W005");
    expect(divergence).toBeDefined();
    expect(divergence?.severity).toBe("warning");
    expect(divergence?.message).toContain("addTax");
    expect(divergence?.message).toContain("[pure]");
    expect(divergence?.message).toContain("[db_read]");
    expect(divergence?.message).toContain("the JSDoc declaration is the one in force");

    // JSDoc wins, and the proof is that the run stays clean: had the config's
    // `db_read` been adopted, nothing would break either — so the check that
    // actually distinguishes them is `--coverage`'s declared-by breakdown.
    expect(result.exitCode).toBe(0);
    const coverage = await run(dir, ["check", "src", "--coverage"]);
    expect(coverage.stdout).toContain("declared-by: jsdoc=1 config=0");
  });

  it("(b) fills only the tags JSDoc left out, which is not a divergence", async () => {
    const dir = await project({
      "src/routes.ts": `/**
 * @entrypoint
 * @effects network
 */
export async function GET(): Promise<number> {
  const response = await fetch("https://api.example.test/users");
  return response.status;
}
`,
      "ambit.config.ts": `export default {
  contracts: {
    "src/routes.ts#GET": { capabilities: ["http:get:api.example.test"] },
  },
};
`,
    });

    const result = await run(dir);
    expect(result.diagnostics.map((d) => d.id)).not.toContain("AMB-W005");
    expect(result.diagnostics.map((d) => d.id)).not.toContain("AMB-W002");
    expect(result.exitCode).toBe(0);
  });

  it("(e) exits 2 with the reason for a config that does not parse", async () => {
    const dir = await project({
      "src/a.ts": "export function f(): number {\n  return 1;\n}\n",
      "ambit.config.ts": "export default { contracts: { \n",
    });

    const result = await run(dir);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("analysis failed");
    expect(result.stderr).toContain("ambit.config.ts");
    // The run must not also print a summary line: a config that could not be
    // read has to stop the check, not produce a partial one (§3.4).
    expect(result.stdout).toBe("");
  });

  it("(e) exits 2 with the key path for an unknown config key", async () => {
    const dir = await project({
      "src/a.ts": "export function f(): number {\n  return 1;\n}\n",
      "ambit.config.ts": `export default {
  contracts: {
    "src/a.ts#f": { effect: ["network"] },
  },
};
`,
    });

    const result = await run(dir);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown key");
    expect(result.stderr).toContain("effect");
  });

  it("(e) exits 2 for a misspelled effect name in a config contract", async () => {
    const dir = await project({
      "src/a.ts": "export function f(): number {\n  return 1;\n}\n",
      "ambit.config.ts": `export default {
  contracts: {
    "src/a.ts#f": { effects: ["netwrok"] },
  },
};
`,
    });

    const result = await run(dir);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("netwrok");
  });

  it("(f) leaves a project with no config exactly as it was", async () => {
    const source = `/** @effects pure */
export async function fetchRate(): Promise<number> {
  const response = await fetch("https://rates.example.test");
  return response.status;
}
`;
    const dir = await project({ "src/a.ts": source });
    const result = await run(dir, ["check", "src", "--coverage"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("fetchRate declares pure but performs [network] directly");
    expect(result.stdout).toContain("files=1 functions=1 declared=1");
    expect(result.stdout).toContain("declared-by: jsdoc=1 config=0");
    // Nothing config-specific appears when there is no config to be specific
    // about.
    expect(result.stdout).not.toContain("AMB-W005");
    expect(result.stdout).not.toContain("AMB-W006");
  });

  it("reports an exact key that matches nothing (AMB-W006), and stays quiet about a glob that does", async () => {
    const dir = await project({
      "src/a.ts": "export function f(): number {\n  return 1;\n}\n",
      "ambit.config.ts": `export default {
  contracts: {
    "src/a.ts#typo": { effects: ["network"] },
    "src/legacy/**/*.ts#anything": { effects: ["network"] },
  },
};
`,
    });

    const result = await run(dir);
    const unmatched = result.diagnostics.filter((d) => d.id === "AMB-W006");
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]?.message).toContain("src/a.ts#typo");
    expect(unmatched[0]?.location.file).toContain("ambit.config.ts");
    // The location points at the key's own line, not at the file's first.
    expect(unmatched[0]?.location.line).toBe(3);
  });

  it("prefers an exact key over a glob, and refuses two globs on one symbol", async () => {
    const dir = await project({
      "src/api/route.ts": `export async function GET(): Promise<number> {
  const response = await fetch("https://api.example.test");
  return response.status;
}
`,
      "ambit.config.ts": `export default {
  contracts: {
    "src/**/route.ts#GET": { effects: [] },
    "src/api/route.ts#GET": { effects: ["network"] },
  },
};
`,
    });

    // The exact key wins, so `network` is declared and there is no violation.
    expect((await run(dir)).exitCode).toBe(0);

    await fs.writeFile(
      path.join(dir, "ambit.config.ts"),
      `export default {
  contracts: {
    "src/**/route.ts#GET": { effects: [] },
    "src/api/*.ts#GET": { effects: ["network"] },
  },
};
`,
    );
    const ambiguous = await run(dir);
    expect(ambiguous.exitCode).toBe(2);
    expect(ambiguous.stderr).toContain("both match");
  });

  it("resolves keys against the config file's directory, not the checked directory", async () => {
    // §4.1 (c): the same config has to name the same symbol whether the run
    // is `check src` or `check src/billing`.
    const dir = await project({
      "src/billing/charge.ts": `export async function charge(): Promise<number> {
  const response = await fetch("https://payments.example.test");
  return response.status;
}
`,
      "ambit.config.ts": `export default {
  contracts: {
    "src/billing/charge.ts#charge": { effects: [] },
  },
};
`,
    });

    for (const target of ["src", "src/billing"]) {
      const result = await run(dir, ["check", target, "--format", "json"]);
      expect(
        result.diagnostics.map((d) => d.id),
        target,
      ).toContain("AMB-E001");
    }
  });
});
