// A directory that produces exactly one AMB-W001 and zero AMB-E001 — used
// to verify the CLI's exit-code split (warning-only is still exit 0).

/** @effects pure */
export function pureReachesUnknown(): void {
  callsSomethingUnresolved();
}

function callsSomethingUnresolved(): void {
  // biome-ignore lint/security/noGlobalEval: fixture data for the checker's "eval" detection rule; never executed.
  eval("1 + 1");
}
