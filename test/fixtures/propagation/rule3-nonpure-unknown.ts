/**
 * A non-pure declaration reaching `unknown` (generalized rule 3: AMB-W001 is
 * not limited to `@effects pure` — see DESIGN.md §4.2, diagnose.ts).
 * `network` is declared and also observed directly, so no excess-effects
 * violation (AMB-E001) fires here; only the unresolved call should warn.
 */
/** @effects network */
export function networkReachesUnknown(): void {
  fetch("https://example.com");
  callsSomethingUnresolvedFromNonPure();
}

function callsSomethingUnresolvedFromNonPure(): void {
  // biome-ignore lint/security/noGlobalEval: fixture data for the checker's "eval" detection rule; never executed.
  eval("1 + 1");
}
