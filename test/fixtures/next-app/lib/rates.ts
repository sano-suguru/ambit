/**
 * @effects network
 */
export async function fetchRate(currency: string): Promise<number> {
  const response = await fetch(`https://rates.example.test/latest?base=${currency}`);
  const body = (await response.json()) as { readonly rate: number };
  return body.rate;
}
