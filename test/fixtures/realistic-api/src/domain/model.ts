/** The shapes the handlers and the domain functions share. Types only — no runtime code. */

export interface OrderLine {
  readonly sku: string;
  readonly unitCents: number;
  readonly quantity: number;
}

export interface CreateOrderInput {
  readonly customerId: string;
  readonly customerEmail: string;
  readonly lines: readonly OrderLine[];
}

export interface ValidationIssue {
  readonly field: string;
  readonly message: string;
}
