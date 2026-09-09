export interface OrderLine {
  readonly sku: string;
  readonly quantity: number;
  readonly unitCents: number;
}

export interface CreateOrderInput {
  readonly customerId: string;
  readonly lines: readonly OrderLine[];
}
