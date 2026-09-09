import { ambitHandler } from "ambit/runtime/hono";
import type { Context } from "hono";
import { validateEmail } from "../domain/validate.ts";
import { fetchRate, listUsers, prisma, summarize } from "../lib/index.ts";

export interface UserSummary {
  readonly email: string;
  readonly blurb: string;
}

/**
 * @entrypoint
 * @effects db_read, llm, network
 */
export async function summarizeUsers(currency: string): Promise<readonly UserSummary[]> {
  const users = await listUsers();
  const rate = await fetchRate(currency);
  const blurb = await summarize(`${users.length} users, rate ${rate}`);
  return users.map((user) => ({ email: user.email, blurb }));
}

export const SUMMARY = ambitHandler(
  {
    capabilities: ["db:read:users", "http:get:api.example.com"],
    budget: { timeMs: 3000, llmCalls: 1, onExceed: "throw" },
  },
  summarizeUsers,
  (c: Context) => [c.req.query("currency") ?? "USD"] as const,
);

/**
 * @entrypoint
 * @effects db_read
 */
export async function getUser(email: string): Promise<UserSummary | undefined> {
  if (validateEmail(email)) return undefined;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return undefined;
  return { email: user.email, blurb: user.name };
}

export const USER = ambitHandler(
  { capabilities: ["db:read:users"], budget: { timeMs: 400 } },
  getUser,
  (c: Context) => [c.req.param("email") ?? ""] as const,
);
