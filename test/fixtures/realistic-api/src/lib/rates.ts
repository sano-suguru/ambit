/**
 * @effects network
 * @capabilities http:get:api.example.com
 */
export async function fetchRate(currency: string): Promise<number> {
  const response = await fetch(`https://api.example.com/rates/${currency}`);
  const body = (await response.json()) as { readonly rate: number };
  return body.rate;
}
