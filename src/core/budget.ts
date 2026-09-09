/**
 * A per-invocation budget (DESIGN.md §4.5). Budgets are 宣言・計測・遮断,
 * never a static guarantee: the checker's job here is to make sure the
 * declaration itself is well-formed and to carry it to the runtime, not to
 * prove the limit holds.
 */
export interface Budget {
  readonly timeMs?: number;
  readonly costUsd?: number;
  readonly llmCalls?: number;
  readonly onExceed: OnExceed;
}

/** §4.5: `throw` (default) / `warn` / `abort`. */
export type OnExceed = "throw" | "warn" | "abort";

const ON_EXCEED = ["throw", "warn", "abort"] as const;

export const DEFAULT_ON_EXCEED: OnExceed = "throw";

/** Whether a string is one of §4.5's three `onExceed` policies. */
export function isOnExceed(value: string): value is OnExceed {
  return (ON_EXCEED as readonly string[]).includes(value);
}

const NUMERIC_KEYS = ["timeMs", "costUsd", "llmCalls"] as const;
type NumericKey = (typeof NUMERIC_KEYS)[number];

function isNumericKey(key: string): key is NumericKey {
  return (NUMERIC_KEYS as readonly string[]).includes(key);
}

/**
 * Parse a `@budget timeMs=500 costUsd=0.01 llmCalls=2 onExceed=throw` tag.
 *
 * `undefined` when any part is malformed — an unknown key, a non-numeric
 * limit, a negative limit, an `onExceed` outside the three §4.5 names, a
 * repeated key, or no limit at all. A budget that does not parse is rejected
 * rather than partly applied, for the reason AMB-E002 rejects a misspelled
 * effect: a declaration read as narrower than written is a manufactured
 * guarantee.
 */
export function parseBudgetTag(text: string): Budget | undefined {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return undefined;

  const limits = new Map<NumericKey, number>();
  let onExceed: OnExceed | undefined;

  for (const token of tokens) {
    const separator = token.indexOf("=");
    if (separator <= 0) return undefined;
    const key = token.slice(0, separator);
    const raw = token.slice(separator + 1);
    if (raw.length === 0) return undefined;

    if (key === "onExceed") {
      if (onExceed !== undefined) return undefined;
      if (!(ON_EXCEED as readonly string[]).includes(raw)) return undefined;
      onExceed = raw as OnExceed;
      continue;
    }
    if (!isNumericKey(key)) return undefined;
    if (limits.has(key)) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return undefined;
    if (key === "llmCalls" && !Number.isInteger(value)) return undefined;
    limits.set(key, value);
  }

  // `@budget onExceed=warn` alone declares a policy with nothing to exceed.
  if (limits.size === 0) return undefined;

  return {
    ...(limits.has("timeMs") ? { timeMs: limits.get("timeMs") } : {}),
    ...(limits.has("costUsd") ? { costUsd: limits.get("costUsd") } : {}),
    ...(limits.has("llmCalls") ? { llmCalls: limits.get("llmCalls") } : {}),
    onExceed: onExceed ?? DEFAULT_ON_EXCEED,
  };
}

export function formatBudget(budget: Budget): string {
  const parts: string[] = [];
  if (budget.timeMs !== undefined) parts.push(`timeMs=${budget.timeMs}`);
  if (budget.costUsd !== undefined) parts.push(`costUsd=${budget.costUsd}`);
  if (budget.llmCalls !== undefined) parts.push(`llmCalls=${budget.llmCalls}`);
  parts.push(`onExceed=${budget.onExceed}`);
  return parts.join(" ");
}
