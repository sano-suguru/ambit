import type { CreateOrderInput, ValidationIssue } from "./model.ts";

export function validateEmail(email: string): ValidationIssue | undefined {
  const trimmed = email.trim();
  if (trimmed.length === 0) return { field: "email", message: "must not be empty" };
  if (!trimmed.includes("@")) return { field: "email", message: "must contain @" };
  return undefined;
}

/** @effects pure */
export function validateOrder(input: CreateOrderInput): readonly ValidationIssue[] {
  const emailIssue = validateEmail(input.customerEmail);
  const lineIssue: ValidationIssue | undefined =
    input.lines.length === 0
      ? { field: "lines", message: "at least one line is required" }
      : undefined;
  return [emailIssue, lineIssue].filter((issue): issue is ValidationIssue => issue !== undefined);
}
