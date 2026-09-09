// The representative scenario from the release-candidate criteria: a contract
// violation is introduced, `ambit check` detects it, the code is fixed
// *without loosening the contract*, and the re-check passes.
//
// The starting state is the violation: `applyPricing` is declared `pure` but
// reaches the network through `currentRate`. `test/fix.test.ts` rewrites this
// file two ways — once by applying the emitted `widen` fix, once by moving the
// effect out to the caller that is allowed to have it — and re-checks both.

/** @effects network */
export async function currentRate(): Promise<number> {
  const response = await fetch("https://rates.example.test");
  return response.status;
}

/** @effects pure */
export async function applyPricing(amount: number): Promise<number> {
  return amount * (await currentRate());
}

/** @entrypoint
 * @effects network
 * @capabilities http:get:rates.example.test
 */
export async function handle(amount: number): Promise<number> {
  return applyPricing(amount);
}
