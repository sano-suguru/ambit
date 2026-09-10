import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  AmbitBudgetError,
  AmbitCapabilityError,
  currentContext,
  installChildProcessHook,
  installFetchHook,
  installFsHook,
  setUnscopedPolicy,
} from "../src/runtime/index.ts";
import type { RouteContext } from "../src/runtime/next.ts";
import { ambitRoute } from "../src/runtime/next.ts";

/**
 * In-process tests for the Next.js App Router adapter (DESIGN.md §4.4,
 * "Mapping contracts to handlers").
 *
 * A Route Handler is a plain function Next.js calls with `(request, context)`,
 * so calling the exported `GET` / `POST` directly is not a stand-in for the
 * framework — it is what the framework does. `test/runtime.hono.test.ts` is
 * the shape this mirrors. What it does **not** cover: a `next` server process,
 * the Edge runtime, Server Actions, `middleware.ts` and the Pages Router —
 * none of which this adapter reaches.
 */

const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
  setUnscopedPolicy("allow");
});

/** Next.js passes no params to a static route; a resolved empty object is it. */
function noParams(): RouteContext {
  return { params: Promise.resolve({}) };
}

function request(url = "https://shop.example.test/orders"): NextRequest {
  return new NextRequest(url);
}

describe("ambitRoute", () => {
  it("establishes the entrypoint's capabilities for the handler it registers", async () => {
    const GET = ambitRoute(
      { capabilities: ["db:read:orders"] },
      (customerId: string) => ({
        customerId,
        granted: (currentContext()?.capabilities ?? []).length,
      }),
      (r) => [r.nextUrl.searchParams.get("customerId") ?? ""] as const,
    );

    const response = await GET(
      request("https://shop.example.test/orders?customerId=c1"),
      noParams(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ customerId: "c1", granted: 1 });
  });

  it("runs decode inside the context, so awaiting params is scoped too", async () => {
    let inside: number | undefined;
    const GET = ambitRoute<readonly [string], { readonly id: string }, { id: string }>(
      { capabilities: ["db:read:orders"] },
      (id: string) => ({ id }),
      async (_r, context) => {
        inside = currentContext()?.capabilities.length;
        return [(await context.params).id] as const;
      },
    );

    const response = await GET(request(), { params: Promise.resolve({ id: "o-9" }) });
    expect(await response.json()).toEqual({ id: "o-9" });
    expect(inside).toBe(1);
  });

  it("passes a handler's own Response through untouched", async () => {
    const GET = ambitRoute(
      { capabilities: [] },
      () => new Response("raw", { status: 201 }),
      () => [] as const,
    );

    const response = await GET(request(), noParams());
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("raw");
  });

  it("lets a granted fetch through and records it on the audit trail", async () => {
    // Stub first, hook second: the hook captures whatever `globalThis.fetch`
    // is when it installs, so replacing it afterwards would remove the hook.
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("{}");
    }) as typeof globalThis.fetch;
    restores.push(installFetchHook());
    let audit = 0;
    const GET = ambitRoute(
      { capabilities: ["http:get:rates.example.test"] },
      async () => {
        await fetch("https://rates.example.test/latest");
        audit = currentContext()?.audit.length ?? 0;
        return { ok: true };
      },
      () => [] as const,
    );

    try {
      expect(await (await GET(request(), noParams())).json()).toEqual({ ok: true });
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toBe(1);
    expect(audit).toBe(1);
  });

  it("blocks an ungranted fetch before the socket, and does not turn it into a status", async () => {
    // The counter is the evidence that the request never left: the hook
    // delegates to this function, and a denial has to happen before it.
    const original = globalThis.fetch;
    let reached = 0;
    globalThis.fetch = (async () => {
      reached += 1;
      return new Response("{}");
    }) as typeof globalThis.fetch;
    restores.push(installFetchHook());
    const GET = ambitRoute(
      { capabilities: ["http:get:rates.example.test"] },
      () => fetch("https://elsewhere.example.test/steal"),
      () => [] as const,
    );

    try {
      // Not a 403 response: §4.4 — the client asked for nothing forbidden,
      // this server's own code exceeded its grant, so the error propagates out
      // of the Route Handler to Next.js instead of being answered with a body.
      await expect(GET(request(), noParams())).rejects.toBeInstanceOf(AmbitCapabilityError);
    } finally {
      globalThis.fetch = original;
    }
    expect(reached).toBe(0);
  });

  it("blocks an ungranted file read before the file is opened", async () => {
    const here = path.join(import.meta.dirname, "runtime.next.test.ts");
    restores.push(installFsHook());
    const GET = ambitRoute(
      { capabilities: ["db:read:orders"] },
      () => ({ bytes: fs.readFileSync(here).length }),
      () => [] as const,
    );

    await expect(GET(request(), noParams())).rejects.toMatchObject({
      name: "AmbitCapabilityError",
      capability: `fs:read:${here}`,
    });
    // The file is readable — the denial is the grant's doing, not the disk's.
    expect(fs.existsSync(here)).toBe(true);
  });

  it("blocks an ungranted child process before it is spawned", async () => {
    // The marker file is what the spawned process would leave behind; it must
    // not exist afterwards. `childProcess.execFileSync` and not a named
    // import: the hook replaces members on the module object, which a named
    // ESM binding does not observe (`docs/limitations.md`).
    const marker = path.join(os.tmpdir(), `ambit-next-spawn-${process.pid}`);
    fs.rmSync(marker, { force: true });
    restores.push(installChildProcessHook());
    const POST = ambitRoute(
      { capabilities: ["db:write:orders"] },
      () => childProcess.execFileSync("/usr/bin/touch", [marker]),
      () => [] as const,
    );

    try {
      await expect(POST(request(), noParams())).rejects.toBeInstanceOf(AmbitCapabilityError);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(marker, { force: true });
    }
  });

  it("measures timeMs and throws AmbitBudgetError out of the Route Handler", async () => {
    const GET = ambitRoute(
      { capabilities: [], budget: { timeMs: 5, onExceed: "throw" } },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { done: true };
      },
      () => [] as const,
    );

    const error = await GET(request(), noParams()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AmbitBudgetError);
    // The message carries the measurement, so the budget is timed rather than
    // merely declared.
    expect((error as Error).message).toMatch(/^budget timeMs=5 exceeded \(took \d+ms\)$/);
    expect(Number(/took (\d+)ms/.exec((error as Error).message)?.[1])).toBeGreaterThanOrEqual(40);
  });

  it("aborts an in-flight request when the budget runs out with onExceed abort", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof globalThis.fetch;
    restores.push(installFetchHook());
    const GET = ambitRoute(
      {
        capabilities: ["http:get:rates.example.test"],
        budget: { timeMs: 10, onExceed: "abort" },
      },
      () => fetch("https://rates.example.test/latest"),
      () => [] as const,
    );

    try {
      await expect(GET(request(), noParams())).rejects.toBeInstanceOf(AmbitBudgetError);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("establishes no context for a route written without it, leaving runtime.unscoped in charge", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}")) as typeof globalThis.fetch;
    restores.push(installFetchHook());
    setUnscopedPolicy("deny");

    // Registered the plain Next.js way: no spec, so no contract and no
    // context. The adapter never invents an empty-capability context for a
    // route it was not given.
    const GET = async (): Promise<Response> => {
      await fetch("https://rates.example.test/latest");
      return new Response("ok");
    };

    try {
      const error = await GET().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AmbitCapabilityError);
      expect((error as Error).message).toContain("no @entrypoint context is active");
    } finally {
      globalThis.fetch = original;
    }
  });
});
