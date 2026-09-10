import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { ambitHandler } from "../src/runtime/hono.ts";
import {
  AmbitBudgetError,
  AmbitCapabilityError,
  currentContext,
  installFetchHook,
  setUnscopedPolicy,
} from "../src/runtime/index.ts";

/**
 * In-process tests for the Hono adapter (DESIGN.md §4.4, "Mapping contracts
 * to handlers"). `app.fetch(new Request(...))` drives Hono without a socket;
 * `test/e2e.runtime.test.ts` does the same through a real server and the
 * installed package.
 */

const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
  setUnscopedPolicy("allow");
});

function hookFetch(): void {
  restores.push(installFetchHook());
}

describe("ambitHandler", () => {
  it("establishes the entrypoint's capabilities for the handler it registers", async () => {
    const app = new Hono();
    app.get(
      "/caps",
      ambitHandler(
        { capabilities: ["db:read:orders"] },
        (marker: string) => ({
          marker,
          granted: (currentContext()?.capabilities ?? []).length,
        }),
        (c) => [c.req.query("m") ?? ""] as const,
      ),
    );

    const response = await app.request("/caps?m=x");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ marker: "x", granted: 1 });
  });

  it("lets a granted fetch through and records it on the audit trail", async () => {
    // Stub first, hook second: the hook captures whatever `globalThis.fetch` is
    // when it installs, so replacing it afterwards would remove the hook.
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}")) as typeof globalThis.fetch;
    hookFetch();
    let audit = 0;
    const app = new Hono();
    app.get(
      "/allowed",
      ambitHandler(
        { capabilities: ["http:get:api.example.test"] },
        async () => {
          await fetch("https://api.example.test/rates");
          audit = currentContext()?.audit.length ?? 0;
          return { ok: true };
        },
        () => [] as const,
      ),
    );

    // The hook is installed, so this replaces what the hook delegates to.
    try {
      const response = await app.request("/allowed");
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      globalThis.fetch = original;
    }
    expect(audit).toBe(1);
  });

  it("blocks an ungranted fetch and hands the error to Hono, untranslated", async () => {
    hookFetch();
    let seen: unknown;
    const app = new Hono();
    app.onError((error, c) => {
      seen = error;
      return c.text("handled", 500);
    });
    app.get(
      "/denied",
      ambitHandler(
        { capabilities: ["http:get:api.example.test"] },
        () => fetch("https://elsewhere.example.test/steal"),
        () => [] as const,
      ),
    );

    const response = await app.request("/denied");
    // Not 403: §4.4 — the client asked for nothing forbidden, this server's own
    // code exceeded its grant, and the message names the granted set.
    expect(response.status).toBe(500);
    expect(seen).toBeInstanceOf(AmbitCapabilityError);
    expect((seen as AmbitCapabilityError).capability).toBe("http:get:elsewhere.example.test");
  });

  it("runs decode inside the context, so a request read is scoped too", async () => {
    let inside: number | undefined;
    const app = new Hono();
    app.get(
      "/decode",
      ambitHandler(
        { capabilities: ["db:read:orders"] },
        (n: number) => ({ n }),
        (c) => {
          inside = currentContext()?.capabilities.length;
          return [Number(c.req.query("n") ?? 0)] as const;
        },
      ),
    );

    expect(await (await app.request("/decode?n=2")).json()).toEqual({ n: 2 });
    expect(inside).toBe(1);
  });

  it("passes a handler's own Response through untouched", async () => {
    const app = new Hono();
    app.get(
      "/raw",
      ambitHandler(
        { capabilities: [] },
        () => new Response("raw", { status: 201 }),
        () => [] as const,
      ),
    );

    const response = await app.request("/raw");
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("raw");
  });

  it("applies @budget timeMs, throwing into Hono's error handler", async () => {
    let seen: unknown;
    const app = new Hono();
    app.onError((error, c) => {
      seen = error;
      return c.text("late", 500);
    });
    app.get(
      "/slow",
      ambitHandler(
        { capabilities: [], budget: { timeMs: 5, onExceed: "throw" } },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return { done: true };
        },
        () => [] as const,
      ),
    );

    await app.request("/slow");
    expect(seen).toBeInstanceOf(AmbitBudgetError);
  });

  it("establishes no context for a route registered without it, leaving runtime.unscoped in charge", async () => {
    hookFetch();
    setUnscopedPolicy("deny");
    let seen: unknown;
    const app = new Hono();
    app.onError((error, c) => {
      seen = error;
      return c.text("handled", 500);
    });
    // Registered the plain Hono way: no spec, so no contract and no context.
    app.get("/unscoped", async () => {
      await fetch("https://api.example.test/rates");
      return new Response("ok");
    });

    await app.request("/unscoped");
    expect(seen).toBeInstanceOf(AmbitCapabilityError);
    expect((seen as Error).message).toContain("no @entrypoint context is active");
  });
});
