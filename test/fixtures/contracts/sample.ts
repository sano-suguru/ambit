// Fixtures for the contract tags beyond @effects: @capabilities (DESIGN.md
// §4.4), @entrypoint (§4.1/§4.4), @boundary (§4.6), @budget (§4.5).

/** @capabilities db:read:users */
export async function readUser(): Promise<void> {}

/** @capabilities db:write:users */
export async function writeUser(): Promise<void> {}

/** A grant that does not cover what the callee declares is an escalation. */
/** @capabilities db:read:users */
export async function readsThenWrites(): Promise<void> {
  await readUser();
  await writeUser();
}

/** A glob on the target segment covers a concrete target. */
/** @capabilities db:read:* */
export async function readsUnderGlob(): Promise<void> {
  await readUser();
}

/** Capabilities narrow through an undeclared middle function. */
async function undeclaredMiddle(): Promise<void> {
  await writeUser();
}

/** @capabilities db:read:users */
export async function callsThroughMiddle(): Promise<void> {
  await undeclaredMiddle();
}

/** @capabilities db:read */
export async function malformedCapability(): Promise<void> {}

/** @capabilities *:read:users */
export async function globInResourceSegment(): Promise<void> {}

/**
 * @entrypoint
 * @capabilities db:read:users
 * @budget timeMs=500 costUsd=0.01 llmCalls=2 onExceed=warn
 */
export async function declaredEntrypoint(): Promise<void> {
  await readUser();
}

/** @entrypoint */
export async function entrypointWithoutCapabilities(): Promise<void> {}

/** @budget timeMs=notANumber */
export async function malformedBudget(): Promise<void> {}

/** @budget onExceed=explode timeMs=1 */
export async function malformedOnExceed(): Promise<void> {}

/**
 * A boundary's body is not checked; the declared contract is trusted instead.
 * @boundary reason="legacy SDK, not annotated"
 * @effects network
 */
export function trustedBoundary(): Promise<Response> {
  return fetch("https://example.test");
}

/** @effects network */
export function callsBoundary(): Promise<Response> {
  return trustedBoundary();
}

/**
 * A boundary hides an effect it did not declare — the caller sees only what
 * was declared, which is the point of the tag and its risk.
 * @boundary reason="third-party client"
 * @effects pure
 */
export function understatedBoundary(): Promise<Response> {
  return fetch("https://example.test");
}

/**
 * @boundary
 * @effects network
 */
export function boundaryWithoutReason(): Promise<Response> {
  return fetch("https://example.test");
}

/** @boundary reason="nothing declared in its place" */
export function boundaryWithoutEffects(): Promise<Response> {
  return fetch("https://example.test");
}
