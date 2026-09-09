import { describe, expect, it } from "vitest";
import { parseBudgetTag } from "../src/core/index.ts";
import {
  AmbitBudgetError,
  AmbitCapabilityError,
  currentContext,
  fetchCapability,
  installFetchHook,
  requireCapability,
  setUnscopedPolicy,
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
