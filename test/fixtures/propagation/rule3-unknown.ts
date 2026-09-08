/** @effects pure */
export function pureReachesUnknown(): void {
  callsSomethingUnresolved();
}

function callsSomethingUnresolved(): void {
  // biome-ignore lint/security/noGlobalEval: fixture data for the checker's "eval" detection rule; never executed.
  eval("1 + 1");
}

/** @effects pure */
export function pureReachesDynamicImport(): void {
  void import("node:fs");
}
