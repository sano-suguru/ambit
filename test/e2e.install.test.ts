import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packedTarball } from "./support/pack.ts";

const execFileAsync = promisify(execFile);

/**
 * DESIGN.md §6 (`npm install -D`) and P5 ("Test the removal procedure
 * automatically").
 *
 * Runs the whole distribution path against a project that has nothing to do
 * with this repository: pack a tarball, install it into a scratch directory,
 * drive the installed `ambit` bin, then uninstall and confirm the consumer is
 * left as it was. Nothing here may reach back into the repo — a step that only
 * works from a clone is not a distribution.
 *
 * Two failures this catches that no in-repo test can:
 *
 * - Node refuses to strip types under `node_modules`
 *   (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so a `bin` pointing at
 *   `.ts` cannot run once installed.
 * - npm installs `bin` as a symlink, so the entry-point guard sees
 *   `process.argv[1]` as the symlink and `import.meta.url` as its target.
 *   When that comparison failed, the installed CLI ran nothing and exited 0
 *   — indistinguishable from "checked, no violations" (DESIGN.md §3.4).
 */

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

async function run(command: string, args: readonly string[], cwd: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], { cwd });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.code ?? 1 };
  }
}

const CONSUMER_SOURCE = `/** @effects pure */
export function totalPrice(unitPrice: number, quantity: number): number {
  return unitPrice * quantity;
}

/** @effects pure */
export async function fetchRate(): Promise<Response> {
  return fetch("https://rates.example.test");
}

export function applyDiscount(total: number, pct: number): number {
  return total * (1 - pct);
}
`;

const CONSUMER_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "nodenext",
      strict: true,
      noEmit: true,
    },
    include: ["src/**/*.ts"],
  },
  null,
  2,
);

describe("distribution: pack, install into a clean project, uninstall", () => {
  let workspace: string;
  let consumer: string;
  let tarball: string;

  beforeAll(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ambit-e2e-"));
    consumer = path.join(workspace, "consumer");
    await fs.mkdir(path.join(consumer, "src"), { recursive: true });
    await fs.writeFile(
      path.join(consumer, "package.json"),
      `${JSON.stringify({ name: "ambit-e2e-consumer", version: "1.0.0", private: true, type: "module" }, null, 2)}\n`,
    );
    await fs.writeFile(path.join(consumer, "tsconfig.json"), `${CONSUMER_TSCONFIG}\n`);
    await fs.writeFile(path.join(consumer, "src", "app.ts"), CONSUMER_SOURCE);

    tarball = await packedTarball();

    // The consumer installs its own compiler, exactly as a real project does.
    // Nothing in this test may resolve a tool out of this repository: a step
    // that only works from a clone is not a distribution.
    const installed = await run(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "-D",
        tarball,
        "typescript@6.0.3",
        "hono@4",
        // README's Next.js snippets are checked against the real `next` types,
        // not against a locally declared shape: `ambit-ts/runtime/next` types its
        // `decode` with `NextRequest`, and `skipLibCheck` would quietly turn an
        // unresolved one into `any` — a snippet that type-checks for the wrong
        // reason. `@types/node` is what `process.env.NEXT_RUNTIME` needs, and
        // TypeScript 6 only picks it up where `types` names it.
        "next@16",
        "@types/node@24",
      ],
      consumer,
    );
    expect(installed.exitCode, installed.stderr).toBe(0);
  }, 300_000);

  afterAll(async () => {
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
  });

  it("installs an executable `ambit` bin", async () => {
    const bin = path.join(consumer, "node_modules", ".bin", "ambit");
    await expect(fs.stat(bin)).resolves.toBeDefined();
  });

  it("ships no .ts source under node_modules (Node cannot strip types there)", async () => {
    const packageDir = path.join(consumer, "node_modules", "ambit-ts");
    const stack = [packageDir];
    const tsFiles: string[] = [];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (dir === undefined) break;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) tsFiles.push(full);
      }
    }
    expect(tsFiles).toEqual([]);
  });

  it("detects a violation through the installed bin and exits 1", async () => {
    const result = await run(
      path.join("node_modules", ".bin", "ambit"),
      ["check", "src"],
      consumer,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("fetchRate declares pure but performs [network] directly");
    // A run that analyzed nothing must never look like a clean run
    // (DESIGN.md §3.4) — the summary line is the evidence it did work.
    expect(result.stdout).toContain("files=1 functions=3 declared=2");
  }, 120_000);

  it("emits NDJSON through the installed bin", async () => {
    const result = await run(
      path.join("node_modules", ".bin", "ambit"),
      ["check", "src", "--format", "json"],
      consumer,
    );
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    const diagnostics = lines.map((line) => JSON.parse(line)).filter((r) => r.kind === undefined);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      id: "AMB-E001",
      severity: "error",
      category: "effects",
      contract: { declared: ["pure"], observed: ["network"] },
      engine: { name: "typescript-legacy" },
    });
    expect(diagnostics[0].location.file).toBe("app.ts");
  }, 120_000);

  it("proposes contracts through the installed bin and exits 0", async () => {
    // `ambit init` is the first command a consumer runs; it has to work from
    // the package, not only from a clone.
    const result = await run(path.join("node_modules", ".bin", "ambit"), ["init", "src"], consumer);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("applyDiscount has no @effects");
    expect(result.stdout).toContain("files=1 functions=3 declared=2");
  }, 120_000);

  it("runs `ambit` through npx, the way a consumer actually invokes it", async () => {
    const result = await run("npx", ["--no-install", "ambit", "check", "src"], consumer);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("fetchRate declares pure but performs [network] directly");
  }, 120_000);

  it("resolves the ambit-ts/runtime/hono subpath and enforces through it (§4.4)", async () => {
    // Deliberately outside `src/`: the uninstall test typechecks `src/`, and a
    // file importing `ambit-ts/runtime/hono` cannot type-check once the package is
    // gone. P5 claims the *contract JSDoc* survives removal, not the imports.
    await fs.writeFile(
      path.join(consumer, "adapter.ts"),
      `import { Hono } from "hono";
import { ambitHandler } from "ambit-ts/runtime/hono";
import { installFetchHook } from "ambit-ts/runtime";

installFetchHook();
const app = new Hono();
app.onError((error, c) => c.json({ error: error.name }, 500));

/**
 * @entrypoint
 * @capabilities http:get:api.example.test
 * @effects network
 * @budget timeMs=5000
 */
async function refreshRates(host: string): Promise<{ readonly host: string }> {
  await fetch(\`https://\${host}/rates\`);
  return { host };
}

app.get(
  "/rates",
  ambitHandler(
    // \`onExceed\` omitted on purpose: \`{ timeMs }\` alone has to be a
    // complete spec against the installed types, and the \`@budget\` above
    // omits it too, so the two agree once both are defaulted (AMB-E011).
    { capabilities: ["http:get:api.example.test"], budget: { timeMs: 5000 } },
    refreshRates,
    (c) => [c.req.query("host") ?? ""] as const,
  ),
);

const denied = await app.request("/rates?host=elsewhere.example.test");
console.log("DENIED:" + JSON.stringify(await denied.json()));
`,
    );
    await fs.writeFile(
      path.join(consumer, "tsconfig.adapter.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2023",
            module: "NodeNext",
            moduleResolution: "nodenext",
            lib: ["ES2023", "DOM"],
            strict: true,
            noEmit: true,
            skipLibCheck: true,
          },
          include: ["adapter.ts"],
        },
        null,
        2,
      )}\n`,
    );

    const typecheck = await run(
      path.join("node_modules", ".bin", "tsc"),
      ["--noEmit", "-p", "tsconfig.adapter.json"],
      consumer,
    );
    expect(typecheck.exitCode, typecheck.stdout).toBe(0);

    // The route is registered through the adapter, so the context comes from
    // the registration: an ungranted host is refused, and the error reaches the
    // framework's handler untranslated (§4.4).
    const executed = await run("node", ["--experimental-strip-types", "adapter.ts"], consumer);
    expect(executed.stderr).toBe("");
    expect(executed.stdout.trim()).toBe('DENIED:{"error":"AmbitCapabilityError"}');
  }, 120_000);

  it("loads an ambit.config.ts that imports defineConfig from ambit-ts/config (§4.1)", async () => {
    // The whole point of the `ambit-ts/config` subpath is that a consumer's
    // config file can import it. Nothing in this repository can test that: in
    // a clone the specifier resolves to `./dist/config.js` by self-reference,
    // and in a scratch copy it resolves to nothing at all. Only an installed
    // package answers the question.
    //
    // `applyDiscount` in the consumer's `src/app.ts` carries no JSDoc, so it
    // is undeclared and silent. The config declares it `pure`, which the
    // multiplication in its body satisfies — and then a second entry declares
    // `fetchRate` as `pure` too, which its `fetch` does not.
    await fs.writeFile(
      path.join(consumer, "ambit.config.ts"),
      `import { defineConfig } from "ambit-ts/config";

export default defineConfig({
  contracts: {
    "src/app.ts#applyDiscount": { effects: [] },
    "src/app.ts#totalPrice": { effects: ["db_read"] },
  },
});
`,
    );

    const result = await run(
      "npx",
      ["--no-install", "ambit", "check", "src", "--format", "json"],
      consumer,
    );
    const diagnostics = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => record.kind === undefined);

    // The config was read: `totalPrice` declares `@effects pure` in its JSDoc
    // and `db_read` in the config, which is exactly AMB-W005. A run that had
    // silently ignored the file would produce no such diagnostic.
    const divergence = diagnostics.find((d) => d.id === "AMB-W005");
    expect(divergence, result.stdout).toBeDefined();
    expect(divergence.message).toContain("totalPrice");
    expect(divergence.message).toContain("ambit.config.ts");

    // …and the config's own contract is in force where JSDoc said nothing:
    // `applyDiscount` is now declared, so the run counts three declarations
    // where the earlier tests in this file counted two.
    expect(result.stdout).toContain('"functionsExtracted":3,"functionsDeclared":3');

    // Removed again so the tests after this one see the consumer as they did
    // before: a config is a project-wide input, not a per-test one.
    await fs.rm(path.join(consumer, "ambit.config.ts"));
  }, 120_000);

  it("reads a spec through every installed runtime specifier (§4.4)", async () => {
    // The wrapper table in `src/checker/backend/legacy-ts.ts` keys on the
    // *written* module specifier, so the package's name is part of the
    // checker's behavior and not only of its manifest: a key that stops
    // matching stops every `spec` from being read as a declaration (§4.4).
    // `test/fixtures/wrappers/` asks the same question of an ambient
    // `declare module`, where the alias resolves in one hop. Here the hops run
    // through a real `node_modules/ambit-ts/dist/**.d.ts`, which is the shape
    // a consumer actually has, and all three table entries are asked at once.
    const dir = path.join(consumer, "registrations");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "routes.ts"),
      `import { withAmbit } from "ambit-ts/runtime";
import { ambitHandler } from "ambit-ts/runtime/hono";
import { ambitRoute } from "ambit-ts/runtime/next";

/**
 * @entrypoint
 * @capabilities db:read:orders
 * @effects pure
 */
export function byHand(id: string): string {
  return id;
}

/**
 * @entrypoint
 * @capabilities db:read:orders
 * @effects pure
 */
export function byHono(id: string): string {
  return id;
}

/**
 * @entrypoint
 * @capabilities db:read:orders
 * @effects pure
 */
export function byNext(id: string): string {
  return id;
}

export const BY_HAND = withAmbit({ capabilities: ["db:write:orders"] }, byHand);
export const BY_HONO = ambitHandler({ capabilities: ["db:write:orders"] }, byHono, () => [""]);
export const BY_NEXT = ambitRoute({ capabilities: ["db:write:orders"] }, byNext, () => [""]);
`,
    );

    // Its own tsconfig: the consumer's includes `src/**/*.ts` only, and
    // `ambit check` reads the nearest one (the target directory upwards), so
    // without this the run would find no files and exit 2.
    await fs.writeFile(
      path.join(dir, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2023",
            module: "NodeNext",
            moduleResolution: "nodenext",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
          },
          include: ["**/*.ts"],
        },
        null,
        2,
      )}\n`,
    );

    const result = await run(
      path.join("node_modules", ".bin", "ambit"),
      ["check", "registrations", "--format", "json"],
      consumer,
    );
    const diagnostics = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => record.kind === undefined);

    // Each registration grants `db:write:orders` where the JSDoc says
    // `db:read:orders`. A specifier the checker no longer recognizes produces
    // no AMB-E010 at all, so the count is the assertion.
    const drift = diagnostics.filter((d) => d.id === "AMB-E010");
    expect(drift, `exit=${result.exitCode} ${result.stderr}${result.stdout}`).toHaveLength(3);
    for (const wrapper of ["withAmbit", "ambitHandler", "ambitRoute"]) {
      expect(
        drift.some((d) => d.message.includes(`${wrapper} grants [db:write:orders]`)),
        `${wrapper}: ${result.stdout}`,
      ).toBe(true);
    }

    // Removed again: the directory is not part of what the uninstall test
    // type-checks, and a file importing the package cannot survive its removal.
    await fs.rm(dir, { recursive: true });
  }, 120_000);

  it("type-checks the documented examples against the installed package", async () => {
    // The claim is the documents', so the documents are the input: copying the
    // examples into this file would let the copy drift from them silently,
    // which is the failure this test exists to remove. Every markdown file that
    // imports from `ambit/` is read, not only README — an example moved into
    // `docs/integrations/` is still a claim about the installed package.
    const root = new URL("../", import.meta.url);
    const docs = [
      "README.md",
      ...(await fs.readdir(new URL("docs/integrations/", root))).map(
        (name) => `docs/integrations/${name}`,
      ),
    ].filter((file) => file.endsWith(".md"));

    const examples: string[] = [];
    for (const file of docs.sort()) {
      const text = await fs.readFile(new URL(file, root), "utf8");
      for (const match of text.matchAll(/```ts\n([\s\S]*?)```/g)) {
        const source = match[1] ?? "";
        if (source.includes('from "ambit-ts/')) examples.push(source);
      }
    }

    // A block whose first line names a file (`// app/rates/route.ts`) is that
    // file: Next.js decides what a module means by where it sits, so a
    // `route.ts` and an `instrumentation.ts` cannot be one program without
    // saying something false about both. Every other block is one program
    // across its blocks — the Hono block calls `refreshRates`, which the block
    // above it declares — concatenated in document order.
    const named = new Map<string, string>();
    const unnamed: string[] = [];
    for (const source of examples) {
      const marker = /^\/\/ ([\w./[\]-]+\.ts)\n/.exec(source);
      if (marker?.[1]) named.set(marker[1], source);
      else unnamed.push(source);
    }
    const program = unnamed.join("\n");

    // A run that extracted nothing must never look like a clean run
    // (DESIGN.md §3.4): an empty program type-checks. Every registration path
    // the documents describe has to be in what was extracted.
    expect(examples.length).toBeGreaterThan(0);
    expect(program).toContain("withAmbit(");
    expect(program).toContain("ambitHandler(");
    expect([...named.keys()]).toEqual(
      expect.arrayContaining(["app/rates/route.ts", "instrumentation.ts"]),
    );
    expect(named.get("app/rates/route.ts")).toContain("ambitRoute(");

    // Outside `src/`, for the reason the adapter test is: the uninstall test
    // type-checks `src/` after the package is gone.
    await fs.writeFile(path.join(consumer, "readme.ts"), program);
    for (const [file, source] of named) {
      const full = path.join(consumer, "readme", file);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, source);
    }
    await fs.writeFile(
      path.join(consumer, "tsconfig.readme.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2023",
            module: "NodeNext",
            moduleResolution: "nodenext",
            lib: ["ES2023", "DOM"],
            types: ["node"],
            strict: true,
            noEmit: true,
            skipLibCheck: true,
          },
          include: ["readme.ts", "readme/**/*.ts"],
        },
        null,
        2,
      )}\n`,
    );

    // Type-checked, not executed: the claim is that the examples compile
    // against the real package's types. `api.example.com` is a real domain,
    // and running them would trade a verified claim for a network dependency.
    const typecheck = await run(
      path.join("node_modules", ".bin", "tsc"),
      ["--noEmit", "-p", "tsconfig.readme.json"],
      consumer,
    );
    expect(typecheck.exitCode, typecheck.stdout).toBe(0);
  }, 120_000);

  it("uninstalls cleanly, leaving the consumer's own code untouched and valid", async () => {
    const removed = await run("npm", ["remove", "ambit-ts"], consumer);
    expect(removed.exitCode, removed.stderr).toBe(0);

    // Nothing of Ambit's is left behind …
    await expect(fs.stat(path.join(consumer, "node_modules", "ambit-ts"))).rejects.toThrow();
    await expect(fs.stat(path.join(consumer, "node_modules", ".bin", "ambit"))).rejects.toThrow();
    const manifest = JSON.parse(await fs.readFile(path.join(consumer, "package.json"), "utf8"));
    expect(manifest.devDependencies?.["ambit-ts"]).toBeUndefined();

    // … and the contract declarations left in the source are inert: they are
    // JSDoc comments, so the project still type-checks and still runs
    // (DESIGN.md P5 — backing out costs a small diff).
    const source = await fs.readFile(path.join(consumer, "src", "app.ts"), "utf8");
    expect(source).toBe(CONSUMER_SOURCE);
    const typecheck = await run(
      path.join("node_modules", ".bin", "tsc"),
      ["--noEmit", "-p", "."],
      consumer,
    );
    expect(typecheck.exitCode, typecheck.stdout).toBe(0);
    const executed = await run(
      "node",
      [
        "--experimental-strip-types",
        "-e",
        "await import('./src/app.ts').then(m => console.log(m.totalPrice(2, 3)))",
      ],
      consumer,
    );
    expect(executed.stdout.trim()).toBe("6");
  }, 300_000);
});
