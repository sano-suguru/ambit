import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packedTarball } from "./support/pack.ts";

const execFileAsync = promisify(execFile);

/**
 * Real-connection test for runtime enforcement, as opposed to
 * `test/runtime.test.ts`, which stubs `globalThis.fetch`.
 *
 * Everything here runs in a scratch project that installed Ambit from a
 * tarball, against a real HTTP server on 127.0.0.1 — so it exercises the
 * published `ambit/runtime` entry point, the real `fetch`, and a real socket.
 * The allowed request has to actually come back with a body; the denied one
 * has to fail without the server ever seeing it.
 */
describe("runtime enforcement against a real server, through the installed package", () => {
  let workspace: string;
  let consumer: string;
  let server: http.Server;
  let port: number;
  const seen: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(req.url ?? "");
      if (req.url === "/slow") {
        // Held open so a budget with onExceed=abort has something to cancel.
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("late");
        }, 3_000).unref();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pong");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;

    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ambit-rt-"));
    consumer = path.join(workspace, "consumer");
    await fs.mkdir(consumer, { recursive: true });
    await fs.writeFile(
      path.join(consumer, "package.json"),
      `${JSON.stringify({ name: "ambit-rt-consumer", version: "1.0.0", private: true, type: "module" }, null, 2)}\n`,
    );

    await execFileAsync("npm", ["install", "--no-audit", "--no-fund", await packedTarball()], {
      cwd: consumer,
    });
  }, 300_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
  });

  async function runScript(body: string): Promise<{ stdout: string; stderr: string }> {
    const file = path.join(consumer, `case-${Math.random().toString(36).slice(2)}.mjs`);
    await fs.writeFile(file, body);
    try {
      return await execFileAsync("node", [file], { cwd: consumer });
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  it("lets a granted request reach the server and return its body", async () => {
    const before = seen.length;
    const { stdout, stderr } = await runScript(`
import { withAmbit, installFetchHook } from "ambit/runtime";
installFetchHook();
const handler = withAmbit(
  { capabilities: ["http:get:127.0.0.1:${port}"] },
  async () => (await fetch("http://127.0.0.1:${port}/allowed")).text(),
);
console.log("BODY:" + (await handler()));
`);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe("BODY:pong");
    expect(seen.slice(before)).toEqual(["/allowed"]);
  }, 60_000);

  it("blocks an ungranted request before it reaches the socket", async () => {
    const before = seen.length;
    const { stdout } = await runScript(`
import { withAmbit, installFetchHook, AmbitCapabilityError } from "ambit/runtime";
installFetchHook();
const handler = withAmbit(
  { capabilities: ["http:get:api.example.test"] },
  async () => (await fetch("http://127.0.0.1:${port}/denied")).text(),
);
try {
  await handler();
  console.log("REACHED");
} catch (error) {
  console.log((error instanceof AmbitCapabilityError ? "BLOCKED:" : "OTHER:") + error.message);
}
`);
    expect(stdout).toContain("BLOCKED:");
    expect(stdout).toContain(`http:get:127.0.0.1:${port}`);
    // The decisive assertion: the server never saw the request.
    expect(seen.slice(before)).toEqual([]);
  }, 60_000);

  it("blocks an ungranted read of a real file, and leaves the file unread", async () => {
    // The inverse of what this file asserted before `installFsHook` existed:
    // `node:fs` was on §4.4's plan and unhooked, so the honest test was that
    // it went through. It is hooked now, so the honest test is that it does
    // not.
    const secret = path.join(consumer, "secret.txt");
    const allowed = path.join(consumer, "allowed.txt");
    await fs.writeFile(secret, "classified");
    await fs.writeFile(allowed, "public");

    const { stdout } = await runScript(`
import nodeFs from "node:fs";
import { withAmbit, installFsHook, AmbitCapabilityError } from "ambit/runtime";
installFsHook();
const handler = withAmbit({ capabilities: ["fs:read:${allowed}"] }, async () => {
  const ok = nodeFs.readFileSync("${allowed}", "utf8");
  try {
    nodeFs.readFileSync("${secret}", "utf8");
    return ok + "|REACHED";
  } catch (error) {
    return ok + "|" + (error instanceof AmbitCapabilityError ? "BLOCKED:" + error.capability : "OTHER");
  }
});
console.log("RESULT:" + (await handler()));
`);
    expect(stdout.trim()).toBe(`RESULT:public|BLOCKED:fs:read:${secret}`);
  }, 60_000);

  it("blocks an ungranted write, so the file is never created", async () => {
    const target = path.join(consumer, "must-not-exist.txt");
    const { stdout } = await runScript(`
import nodeFs from "node:fs";
import { withAmbit, installFsHook } from "ambit/runtime";
installFsHook();
const handler = withAmbit({ capabilities: [] }, async () =>
  nodeFs.promises.writeFile("${target}", "x").then(() => "REACHED", (e) => e.name),
);
console.log("RESULT:" + (await handler()));
`);
    expect(stdout.trim()).toBe("RESULT:AmbitCapabilityError");
    // The decisive assertion, as with the server never seeing the request.
    await expect(fs.stat(target)).rejects.toThrow();
  }, 60_000);

  it("covers named ESM imports when installed from a preload (§4.4 (a))", async () => {
    // §4.4 (a) claims the covered set depends on install order, not on the
    // mechanism. This is the preload row: `import { readFileSync }` — a
    // binding a graph-internal install cannot reach — is checked here.
    const secret = path.join(consumer, "preload-secret.txt");
    await fs.writeFile(secret, "classified");
    const preload = path.join(consumer, "ambit-preload.mjs");
    await fs.writeFile(
      preload,
      'import { installFsHook, setUnscopedPolicy } from "ambit/runtime";\ninstallFsHook();\n',
    );
    const script = path.join(consumer, "named-import.mjs");
    await fs.writeFile(
      script,
      `import { readFileSync } from "node:fs";
import { withAmbit } from "ambit/runtime";
const handler = withAmbit({ capabilities: [] }, async () => {
  try { readFileSync("${secret}", "utf8"); return "REACHED"; } catch (e) { return e.name; }
});
console.log("RESULT:" + (await handler()));
`,
    );
    const { stdout } = await execFileAsync("node", ["--import", preload, script], {
      cwd: consumer,
    }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
    expect(stdout.trim()).toBe("RESULT:AmbitCapabilityError");
  }, 60_000);

  it("cancels an in-flight request when a timeMs budget aborts", async () => {
    // The README says `onExceed: "abort"` cancels via AbortSignal. Without
    // joining the context's signal to the hooked request, the signal would
    // fire and the request would run to completion — the row would be false.
    const { stdout } = await runScript(`
import { withAmbit, installFetchHook } from "ambit/runtime";
installFetchHook();
const handler = withAmbit(
  {
    capabilities: ["http:get:127.0.0.1:${port}"],
    budget: { timeMs: 100, onExceed: "abort" },
  },
  async () => (await fetch("http://127.0.0.1:${port}/slow")).text(),
);
try {
  console.log("COMPLETED:" + (await handler()));
} catch (error) {
  console.log("ABORTED:" + error.name);
}
`);
    expect(stdout).toContain("ABORTED:");
    expect(stdout).not.toContain("COMPLETED:");
  }, 60_000);

  it("stops enforcing once the hook is removed (P5: 撤退できること)", async () => {
    const before = seen.length;
    const { stdout } = await runScript(`
import { withAmbit, installFetchHook } from "ambit/runtime";
const restore = installFetchHook();
restore();
const handler = withAmbit(
  { capabilities: ["http:get:api.example.test"] },
  async () => (await fetch("http://127.0.0.1:${port}/after-removal")).text(),
);
console.log("BODY:" + (await handler()));
`);
    expect(stdout.trim()).toBe("BODY:pong");
    expect(seen.slice(before)).toEqual(["/after-removal"]);
  }, 60_000);
});
