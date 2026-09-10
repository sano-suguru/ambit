import { ambitRoute } from "ambit-ts/runtime/next";
import { fetchRate } from "../../lib/rates.ts";

/**
 * The capability the `fetch` hook checks is `http:<method>:<host>`, and the
 * host here is fixed in the source, so `AMB-E009` compares the two.
 */

/**
 * @entrypoint
 * @effects network
 */
async function currentRate(currency: string): Promise<{ readonly rate: number }> {
  return { rate: await fetchRate(currency) };
}

export const GET = ambitRoute(
  { capabilities: ["http:get:rates.example.test"], budget: { timeMs: 2000 } },
  currentRate,
  (request) => [request.nextUrl.searchParams.get("base") ?? "USD"] as const,
);
