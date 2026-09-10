import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
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

    // `pg` is installed for real: DESIGN.md §4.4 (c) chose it because
    // `Pool.prototype.query` is a stable patch point, and a hand-written
    // double would not prove that the real package still has that shape.
    // `hono` and `@hono/node-server` for the same reason as `pg`: the adapter
    // is only worth testing against the real framework, over a real socket.
    await execFileAsync(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        await packedTarball(),
        "pg@8",
        "hono@4",
        "@hono/node-server@1",
      ],
      { cwd: consumer },
    );
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

  it("blocks an ungranted child process, so no process is started", async () => {
    // A real child process: the granted one has to actually print, and the
    // blocked one has to leave no evidence behind.
    const marker = path.join(consumer, "child-ran.txt");
    const { stdout } = await runScript(`
import { execFileSync } from "node:child_process";
import nodeCp from "node:child_process";
import { withAmbit, installChildProcessHook, AmbitCapabilityError } from "ambit/runtime";
installChildProcessHook();
const handler = withAmbit({ capabilities: ["proc:spawn:/bin/echo"] }, async () => {
  const ok = nodeCp.execFileSync("/bin/echo", ["ambit"]).toString().trim();
  try {
    nodeCp.execFileSync("/bin/sh", ["-c", "touch ${marker}"]);
    return ok + "|REACHED";
  } catch (error) {
    return ok + "|" + (error instanceof AmbitCapabilityError ? "BLOCKED:" + error.capability : "OTHER");
  }
});
console.log("RESULT:" + (await handler()));
`);
    expect(stdout.trim()).toBe("RESULT:ambit|BLOCKED:proc:spawn:/bin/sh");
    await expect(fs.stat(marker)).rejects.toThrow();
  }, 60_000);

  it("blocks an ungranted pg query before the client opens a connection", async () => {
    // The `pg` equivalent of "the server never saw the request": a listener
    // on a real port records every connection, and a blocked query must
    // produce none. The allowed query is expected to fail on the wire — this
    // listener speaks no Postgres — which is why only the connection count is
    // asserted.
    const connections: number[] = [];
    const listener = net.createServer((socket) => {
      connections.push(1);
      socket.destroy();
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const dbPort = (listener.address() as AddressInfo).port;
    try {
      const { stdout } = await runScript(`
import pg from "pg";
import { withAmbit, installPgHook, AmbitCapabilityError } from "ambit/runtime";
installPgHook(pg);
const pool = new pg.Pool({ connectionString: "postgres://u:p@127.0.0.1:${dbPort}/app" });
const handler = withAmbit({ capabilities: ["db:read:app"] }, async () => {
  try {
    await pool.query("INSERT INTO orders (id) VALUES (1)");
    return "REACHED";
  } catch (error) {
    return error instanceof AmbitCapabilityError ? "BLOCKED:" + error.capability : "OTHER:" + error.message;
  }
});
console.log("RESULT:" + (await handler()));
process.exit(0);
`);
      expect(stdout.trim()).toBe("RESULT:BLOCKED:db:write:app");
      expect(connections).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  }, 60_000);

  it("denies outside every entrypoint context when the policy is deny (§4.4)", async () => {
    // All imports happen first: with the fs hook installed, Node's own module
    // loader reads through `fs.readFileSync`, so a lazy `import()` under
    // `deny` would be denied too — which is the documented behaviour, not a
    // surprise to design around here.
    const target = path.join(consumer, "unscoped.txt");
    await fs.writeFile(target, "public");
    const { stdout } = await runScript(`
import nodeFs from "node:fs";
import nodeCp from "node:child_process";
import { installFsHook, installChildProcessHook, setUnscopedPolicy, AmbitCapabilityError } from "ambit/runtime";
installFsHook();
installChildProcessHook();
const results = [];
for (const policy of ["allow", "warn", "deny"]) {
  setUnscopedPolicy(policy);
  try {
    nodeFs.readFileSync("${target}", "utf8");
    results.push(policy + ":through");
  } catch (error) {
    results.push(policy + ":" + (error instanceof AmbitCapabilityError ? "denied" : "other"));
  }
}
setUnscopedPolicy("deny");
try {
  nodeCp.execFileSync("/bin/echo", ["x"]);
  results.push("proc:through");
} catch (error) {
  results.push("proc:" + (error instanceof AmbitCapabilityError ? "denied" : "other"));
}
console.log("RESULT:" + results.join(","));
`);
    expect(stdout.trim()).toBe("RESULT:allow:through,warn:through,deny:denied,proc:denied");
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

  /**
   * The Hono adapter (DESIGN.md §4.4, "Mapping contracts to handlers"),
   * driven by real HTTP requests to a real server. `ambitHandler` registers
   * the route, so the context comes from the registration and not from a
   * hand-written `withAmbit` — which is the whole claim being tested.
   *
   * The app installs `app.onError` and reports `error.name`: §4.4 decided the
   * adapter does not translate a denial into 403/504, so what a route returns
   * on denial is whatever the framework's error handler makes of the throw.
   */
  const HONO_APP = (routes: string) => `
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import pg from "pg";
import { ambitHandler } from "ambit/runtime/hono";
import { installFetchHook, installPgHook } from "ambit/runtime";
installFetchHook();
installPgHook(pg);

const app = new Hono();
app.onError((error, c) => c.json({ error: error.name, message: error.message }, 500));
${routes}

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, async (info) => {
  const results = {};
  for (const [name, url] of CASES(info.port)) {
    const response = await fetch(url);
    results[name] = { status: response.status, body: await response.json() };
  }
  console.log("RESULT:" + JSON.stringify(results));
  server.close(() => process.exit(0));
});
`;

  it("lets a granted fetch through a handler the adapter registered", async () => {
    const before = seen.length;
    const { stdout, stderr } = await runScript(
      HONO_APP(`
app.get("/rates", ambitHandler(
  { capabilities: ["http:get:127.0.0.1:${port}"] },
  async (path) => ({ body: await (await fetch("http://127.0.0.1:${port}" + path)).text() }),
  (c) => [c.req.query("path") ?? "/"],
));
const CASES = (p) => [["granted", "http://127.0.0.1:" + p + "/rates?path=/via-adapter"]];
`),
    );
    expect(stderr).toBe("");
    const results = JSON.parse(stdout.trim().replace("RESULT:", ""));
    expect(results.granted).toEqual({ status: 200, body: { body: "pong" } });
    expect(seen.slice(before)).toEqual(["/via-adapter"]);
  }, 60_000);

  it("blocks an ungranted fetch and an ungranted pg query in an adapter-registered handler", async () => {
    // Same decisive assertions as the `withAmbit` cases: the HTTP server never
    // sees the request, and the listener standing in for Postgres never sees a
    // connection.
    const connections: number[] = [];
    const listener = net.createServer((socket) => {
      connections.push(1);
      socket.destroy();
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const dbPort = (listener.address() as AddressInfo).port;
    const before = seen.length;
    try {
      const { stdout } = await runScript(
        HONO_APP(`
const pool = new pg.Pool({ connectionString: "postgres://u:p@127.0.0.1:${dbPort}/app" });

app.get("/steal", ambitHandler(
  { capabilities: ["http:get:api.example.test"] },
  async () => ({ body: await (await fetch("http://127.0.0.1:${port}/denied-via-adapter")).text() }),
  () => [],
));

app.get("/query", ambitHandler(
  { capabilities: ["db:read:app"] },
  async () => ({ rows: (await pool.query("INSERT INTO orders (id) VALUES (1)")).rowCount }),
  () => [],
));

const CASES = (p) => [
  ["fetch", "http://127.0.0.1:" + p + "/steal"],
  ["query", "http://127.0.0.1:" + p + "/query"],
];
`),
      );
      const results = JSON.parse(stdout.trim().replace("RESULT:", ""));
      expect(results.fetch.body.error).toBe("AmbitCapabilityError");
      expect(results.fetch.body.message).toContain(`http:get:127.0.0.1:${port}`);
      expect(results.query.body.error).toBe("AmbitCapabilityError");
      expect(results.query.body.message).toContain("db:write:app");
      expect(seen.slice(before)).toEqual([]);
      expect(connections).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  }, 60_000);

  it("follows @budget timeMs onExceed for an adapter-registered handler", async () => {
    const { stdout } = await runScript(
      HONO_APP(`
app.get("/throws", ambitHandler(
  { capabilities: [], budget: { timeMs: 10, onExceed: "throw" } },
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return { done: true };
  },
  () => [],
));

app.get("/warns", ambitHandler(
  { capabilities: [], budget: { timeMs: 10, onExceed: "warn" } },
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return { done: true };
  },
  () => [],
));

const CASES = (p) => [
  ["throws", "http://127.0.0.1:" + p + "/throws"],
  ["warns", "http://127.0.0.1:" + p + "/warns"],
];
`),
    );
    const results = JSON.parse(stdout.trim().replace("RESULT:", ""));
    // `throw` reaches the framework's error handler …
    expect(results.throws.body.error).toBe("AmbitBudgetError");
    expect(results.throws.body.message).toContain("timeMs=10");
    // … and `warn` lets the response through, which is the difference.
    expect(results.warns).toEqual({ status: 200, body: { done: true } });
  }, 60_000);

  it("stops enforcing once the hook is removed (P5: backing out)", async () => {
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
