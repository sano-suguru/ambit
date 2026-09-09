import childProcess from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseBudgetTag } from "../src/core/index.ts";
import {
  AmbitBudgetError,
  AmbitCapabilityError,
  currentContext,
  fetchCapability,
  fsCapabilities,
  installChildProcessHook,
  installFetchHook,
  installFsHook,
  requireCapability,
  setUnscopedPolicy,
  spawnCapability,
  withAmbit,
} from "../src/runtime/index.ts";

/**
 * Mock-level tests: `globalThis.fetch` is replaced with a stub, so these prove
 * the enforcement logic, not that it works against a real socket. The
 * real-connection test lives in `test/e2e.runtime.test.ts`, against a local
 * HTTP server through the installed package.
 */
function withStubbedFetch<T>(fn: (calls: string[]) => T): T {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    return new Response("ok");
  }) as typeof globalThis.fetch;
  try {
    return fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

describe("fetchCapability", () => {
  it("derives http:<method>:<host>, keeping the port", () => {
    expect(fetchCapability("https://api.example.test/v1")).toBe("http:get:api.example.test");
    expect(fetchCapability("http://127.0.0.1:8080/x")).toBe("http:get:127.0.0.1:8080");
    expect(fetchCapability("https://api.example.test", { method: "POST" })).toBe(
      "http:post:api.example.test",
    );
  });
});

describe("withAmbit + installFetchHook (mock-level)", () => {
  it("allows a fetch the entrypoint's capabilities grant", async () => {
    await withStubbedFetch(async (calls) => {
      const restore = installFetchHook();
      try {
        const handler = withAmbit(
          { capabilities: ["http:get:api.example.test"] },
          async () => (await fetch("https://api.example.test/v1")).ok,
        );
        await expect(handler()).resolves.toBe(true);
        expect(calls).toEqual(["https://api.example.test/v1"]);
      } finally {
        restore();
      }
    });
  });

  it("blocks a fetch to a host outside the grant, before the request is made", async () => {
    await withStubbedFetch(async (calls) => {
      const restore = installFetchHook();
      try {
        const handler = withAmbit({ capabilities: ["http:get:api.example.test"] }, async () =>
          fetch("https://evil.example.test/steal"),
        );
        await expect(handler()).rejects.toBeInstanceOf(AmbitCapabilityError);
        // The point of blocking rather than auditing: the request never left.
        expect(calls).toEqual([]);
      } finally {
        restore();
      }
    });
  });

  it("matches a target glob", async () => {
    await withStubbedFetch(async () => {
      const restore = installFetchHook();
      try {
        const handler = withAmbit({ capabilities: ["http:get:*.example.test"] }, async () =>
          fetch("https://api.example.test/v1"),
        );
        await expect(handler()).resolves.toBeDefined();
      } finally {
        restore();
      }
    });
  });

  it("distinguishes methods", async () => {
    await withStubbedFetch(async () => {
      const restore = installFetchHook();
      try {
        const handler = withAmbit({ capabilities: ["http:get:api.example.test"] }, async () =>
          fetch("https://api.example.test", { method: "POST" }),
        );
        await expect(handler()).rejects.toBeInstanceOf(AmbitCapabilityError);
      } finally {
        restore();
      }
    });
  });

  it("records every check in the context's audit trail", async () => {
    await withStubbedFetch(async () => {
      const restore = installFetchHook();
      try {
        let audit: readonly { capability: string; allowed: boolean }[] = [];
        const handler = withAmbit({ capabilities: ["http:get:api.example.test"] }, async () => {
          await fetch("https://api.example.test/v1");
          audit = currentContext()?.audit ?? [];
        });
        await handler();
        expect(audit).toEqual([
          { capability: "http:get:api.example.test", allowed: true, reason: "granted" },
        ]);
      } finally {
        restore();
      }
    });
  });

  it("rejects a malformed capability at wrap time rather than granting nothing", () => {
    expect(() => withAmbit({ capabilities: ["db:read"] }, async () => 1)).toThrow(TypeError);
  });

  it("restores the previous fetch on teardown (P5: 撤退できること)", () => {
    withStubbedFetch(() => {
      const before = globalThis.fetch;
      const restore = installFetchHook();
      expect(globalThis.fetch).not.toBe(before);
      restore();
      expect(globalThis.fetch).toBe(before);
    });
  });
});

describe("runtime.unscoped (DESIGN.md §4.4)", () => {
  it("allows by default when no entrypoint context is active", () => {
    expect(() => requireCapability("http:get:api.example.test")).not.toThrow();
  });

  it("denies when the policy says deny", () => {
    setUnscopedPolicy("deny");
    try {
      expect(() => requireCapability("http:get:api.example.test")).toThrow(AmbitCapabilityError);
    } finally {
      setUnscopedPolicy("allow");
    }
  });
});

describe("budget enforcement (DESIGN.md §4.5)", () => {
  it("throws when a timeMs budget is exceeded", async () => {
    const budget = parseBudgetTag("timeMs=10");
    expect(budget).toBeDefined();
    const handler = withAmbit(
      { ...(budget ? { budget } : {}) },
      () => new Promise((resolve) => setTimeout(resolve, 60)),
    );
    await expect(handler()).rejects.toBeInstanceOf(AmbitBudgetError);
  });

  it("warns instead of throwing with onExceed=warn", async () => {
    const budget = parseBudgetTag("timeMs=10 onExceed=warn");
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.message);
    process.on("warning", onWarning);
    try {
      const handler = withAmbit(
        { ...(budget ? { budget } : {}) },
        () => new Promise((resolve) => setTimeout(resolve, 60)),
      );
      await expect(handler()).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(warnings.some((message) => message.includes("timeMs=10"))).toBe(true);
    } finally {
      process.off("warning", onWarning);
    }
  });

  it("aborts the context's signal with onExceed=abort", async () => {
    const budget = parseBudgetTag("timeMs=10 onExceed=abort");
    const handler = withAmbit({ ...(budget ? { budget } : {}) }, async () => {
      const signal = currentContext()?.signal;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return signal?.aborted ?? false;
    });
    await expect(handler()).resolves.toBe(true);
  });

  it("does not pretend to enforce costUsd or llmCalls", async () => {
    // There is no LLM hook, so nothing increments those counters. They are
    // carried for an adapter and are otherwise inert — a counter nobody
    // increments must not be reported as an enforced limit.
    const budget = parseBudgetTag("costUsd=0.001 llmCalls=1");
    const handler = withAmbit({ ...(budget ? { budget } : {}) }, async () => "done");
    await expect(handler()).resolves.toBe("done");
  });
});

/**
 * `node:fs`, `node:child_process` and `pg` hooks (DESIGN.md §4.4 (a)–(c)).
 *
 * In-process and therefore property-access-form only, which is exactly what
 * §4.4's "graph-internal install" row promises: these files `import fs from
 * "node:fs"`, so they see the patched member. The real-file, real-child-
 * process and real-socket versions live in `test/e2e.runtime.test.ts`.
 *
 * The fs hook is installed and restored inside each test rather than in a
 * `beforeEach`: Node's own module loader reads files through the public
 * `fs.readFileSync`, so leaving it installed across a `deny` policy would
 * block Vitest's own module loading.
 */
describe("installFsHook (DESIGN.md §4.4 (b))", () => {
  const here = fileURLToPath(import.meta.url);

  it("derives fs:read / fs:write from the resolved absolute path", () => {
    expect(fsCapabilities({ reads: [0] }, ["relative/file.txt"])).toEqual([
      `fs:read:${path.resolve("relative/file.txt")}`,
    ]);
    expect(fsCapabilities({ reads: [0], writes: [1] }, ["/a/from", "/a/to"])).toEqual([
      "fs:read:/a/from",
      "fs:write:/a/to",
    ]);
    // A file descriptor names no path; the check happened at `open`.
    expect(fsCapabilities({ reads: [0] }, [7])).toEqual([]);
  });

  it("reads a granted file and records the check in the audit trail", async () => {
    const restore = installFsHook();
    try {
      const handler = withAmbit({ capabilities: [`fs:read:${here}`] }, async () => {
        const bytes = fs.readFileSync(here).length;
        return { bytes, audit: [...(currentContext()?.audit ?? [])] };
      });
      const { bytes, audit } = await handler();
      expect(bytes).toBeGreaterThan(0);
      expect(audit).toContainEqual({
        capability: `fs:read:${here}`,
        allowed: true,
        reason: "granted",
      });
    } finally {
      restore();
    }
  });

  it("blocks an ungranted read, write and open, each in its own family", async () => {
    const restore = installFsHook();
    try {
      const handler = withAmbit({ capabilities: [] }, async () => {
        const results: string[] = [];
        // sync: throws
        try {
          fs.readFileSync(here);
          results.push("sync:reached");
        } catch (error) {
          results.push(`sync:${(error as Error).name}`);
        }
        // sync, and `false` would be a lie: "not there" is not "not allowed".
        try {
          fs.existsSync(here);
          results.push("exists:reached");
        } catch (error) {
          results.push(`exists:${(error as Error).name}`);
        }
        // callback: the error arrives through the callback
        results.push(
          await new Promise<string>((resolve) =>
            fs.readFile(here, (error) => resolve(`cb:${error?.name ?? "reached"}`)),
          ),
        );
        // promises: rejects
        results.push(
          await fsPromises
            .writeFile(`${here}.should-not-exist`, "x")
            .then(() => "promise:reached")
            .catch((error: Error) => `promise:${error.name}`),
        );
        // `open` decides direction from its flags
        results.push(
          await new Promise<string>((resolve) =>
            fs.open(here, "w", (error) => resolve(`open:${error?.name ?? "reached"}`)),
          ),
        );
        return { results, audit: [...(currentContext()?.audit ?? [])] };
      });

      const { results, audit } = await handler();
      expect(results).toEqual([
        "sync:AmbitCapabilityError",
        "exists:AmbitCapabilityError",
        "cb:AmbitCapabilityError",
        "promise:AmbitCapabilityError",
        "open:AmbitCapabilityError",
      ]);
      expect(audit.every((entry) => !entry.allowed)).toBe(true);
      expect(audit).toContainEqual({
        capability: `fs:write:${here}.should-not-exist`,
        allowed: false,
        reason: "denied",
      });
      expect(fs.existsSync(`${here}.should-not-exist`)).toBe(false);
    } finally {
      restore();
    }
  });

  it("restores every patched member (P5: 撤退できること)", async () => {
    const before = { readFileSync: fs.readFileSync, readFile: fs.readFile, open: fs.open };
    const beforePromise = fsPromises.readFile;
    const restore = installFsHook();
    expect(fs.readFileSync).not.toBe(before.readFileSync);
    restore();
    expect(fs.readFileSync).toBe(before.readFileSync);
    expect(fs.readFile).toBe(before.readFile);
    expect(fs.open).toBe(before.open);
    expect(fsPromises.readFile).toBe(beforePromise);

    // And the original behaviour is back: an empty grant no longer blocks.
    const handler = withAmbit({ capabilities: [] }, async () => fs.readFileSync(here).length);
    expect(await handler()).toBeGreaterThan(0);
  });
});

describe("installChildProcessHook (DESIGN.md §4.4 (b))", () => {
  it("names argv[0] as written, and the shell for a shell form", () => {
    expect(spawnCapability("spawn", ["git", ["status"]])).toEqual({
      capability: "proc:spawn:git",
    });
    expect(spawnCapability("exec", ["git status"])).toMatchObject({
      capability: `proc:spawn:${process.platform === "win32" ? "cmd.exe" : "/bin/sh"}`,
    });
    // `shell: true` turns a spawn into a shell spawn, and the target follows.
    expect(spawnCapability("spawn", ["git", ["status"], { shell: "/bin/bash" }])).toMatchObject({
      capability: "proc:spawn:/bin/bash",
    });
    expect(spawnCapability("fork", ["./worker.js"])).toEqual({
      capability: `proc:spawn:${process.execPath}`,
    });
  });

  it("says, in the exception, that a granted shell can run any program", async () => {
    const restore = installChildProcessHook();
    try {
      const handler = withAmbit({ capabilities: [] }, async () => childProcess.execSync("echo hi"));
      await expect(handler()).rejects.toThrow(/names the shell, not the program/);
    } finally {
      restore();
    }
  });

  it("runs a granted command, blocks an ungranted one, and audits both", async () => {
    const restore = installChildProcessHook();
    try {
      const handler = withAmbit({ capabilities: ["proc:spawn:/bin/echo"] }, async () => {
        const allowed = childProcess.execFileSync("/bin/echo", ["ambit"]).toString().trim();
        let blocked = "reached";
        try {
          childProcess.execFileSync("/bin/ls", ["/"]);
        } catch (error) {
          blocked = (error as Error).name;
        }
        return { allowed, blocked, audit: [...(currentContext()?.audit ?? [])] };
      });
      const { allowed, blocked, audit } = await handler();
      expect(allowed).toBe("ambit");
      expect(blocked).toBe("AmbitCapabilityError");
      expect(audit).toEqual([
        { capability: "proc:spawn:/bin/echo", allowed: true, reason: "granted" },
        { capability: "proc:spawn:/bin/ls", allowed: false, reason: "denied" },
      ]);
    } finally {
      restore();
    }
  });

  it("restores every patched member (P5: 撤退できること)", async () => {
    const before = childProcess.execFileSync;
    const restore = installChildProcessHook();
    expect(childProcess.execFileSync).not.toBe(before);
    restore();
    expect(childProcess.execFileSync).toBe(before);

    const handler = withAmbit({ capabilities: [] }, async () =>
      childProcess.execFileSync("/bin/echo", ["back"]).toString().trim(),
    );
    expect(await handler()).toBe("back");
  });
});
