/**
 * A capability: what a function is allowed to act on, as opposed to what it
 * does (DESIGN.md §4.4). Written `<resource>:<action>:<target>` —
 * `db:read:users`, `http:get:api.example.com`.
 *
 * Only `target` may be a glob (`http:get:*.example.com`); `resource` and
 * `action` match literally. §4.4 says exactly that ("`target` はグロブ可")
 * and nothing more, and widening the glob to the other segments would let
 * `*:*:*` be written as a contract that reads like a restriction.
 */
export interface Capability {
  readonly resource: string;
  readonly action: string;
  readonly target: string;
}

/** Parsed `@capabilities`, plus whether the set might be incomplete. */
export interface CapabilitySet {
  readonly capabilities: readonly Capability[];
  /**
   * Set when a call could not be resolved (DESIGN.md §4.2 rule 6), so the
   * true requirement could include anything. Tracked separately for the same
   * reason `EffectSet.unknown` is: "requires nothing more" and "we could not
   * tell" are different claims.
   */
  readonly unknown: boolean;
}

export function emptyCapabilitySet(): CapabilitySet {
  return { capabilities: [], unknown: false };
}

export function unknownCapabilitySet(): CapabilitySet {
  return { capabilities: [], unknown: true };
}

export function formatCapability(capability: Capability): string {
  return `${capability.resource}:${capability.action}:${capability.target}`;
}

const SEGMENT = /^[A-Za-z0-9_.*?[\]{}@/-]+$/;
/** `target` may hold a colon of its own (`http:get:localhost:8080`), so it has a wider character set. */
const TARGET_SEGMENT = /^[A-Za-z0-9_.*?[\]{}@/:-]+$/;

/**
 * Parse one `<resource>:<action>:<target>` token. `undefined` when the token
 * is not three non-empty segments — a malformed capability is rejected rather
 * than partly honoured, on the same principle as a misspelled effect name
 * (AMB-E002): a declaration that does not mean what it says must not be read
 * as a narrower guarantee than the author intended.
 *
 * `target` may itself contain `:` (a host:port, say), so the split takes the
 * first two separators only.
 */
export function parseCapability(token: string): Capability | undefined {
  const trimmed = token.trim();
  const firstColon = trimmed.indexOf(":");
  if (firstColon <= 0) return undefined;
  const secondColon = trimmed.indexOf(":", firstColon + 1);
  if (secondColon <= firstColon + 1) return undefined;

  const resource = trimmed.slice(0, firstColon);
  const action = trimmed.slice(firstColon + 1, secondColon);
  const target = trimmed.slice(secondColon + 1);
  if (target.length === 0) return undefined;
  if (!SEGMENT.test(resource) || !SEGMENT.test(action) || !TARGET_SEGMENT.test(target)) {
    return undefined;
  }
  // A glob belongs to `target` only; a `*` elsewhere would read as a
  // restriction while meaning the opposite.
  if (resource.includes("*") || action.includes("*")) return undefined;
  return { resource, action, target };
}

/** Parse a `@capabilities` tag's comma-separated list. `undefined` if any token is malformed. */
export function parseCapabilitiesTag(text: string): CapabilitySet | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const capabilities: Capability[] = [];
  for (const token of trimmed.split(",")) {
    const capability = parseCapability(token);
    if (!capability) return undefined;
    capabilities.push(capability);
  }
  return { capabilities, unknown: false };
}

/**
 * Whether `granted` permits `required` (DESIGN.md §4.4: capabilities may only
 * narrow from caller to callee). `resource` and `action` must match exactly;
 * `granted.target` is matched as a glob against `required.target`.
 */
export function capabilityCovers(granted: Capability, required: Capability): boolean {
  if (granted.resource !== required.resource) return false;
  if (granted.action !== required.action) return false;
  return globMatches(granted.target, required.target);
}

/** Capabilities in `required` that no capability in `granted` permits. */
export function excessCapabilities(
  granted: readonly Capability[],
  required: readonly Capability[],
): readonly Capability[] {
  return required.filter(
    (capability) => !granted.some((grant) => capabilityCovers(grant, capability)),
  );
}

export function unionCapabilitySets(a: CapabilitySet, b: CapabilitySet): CapabilitySet {
  const merged = [...a.capabilities];
  for (const capability of b.capabilities) {
    if (!merged.some((existing) => capabilitiesEqual(existing, capability)))
      merged.push(capability);
  }
  return { capabilities: merged, unknown: a.unknown || b.unknown };
}

export function capabilitiesEqual(a: Capability, b: Capability): boolean {
  return a.resource === b.resource && a.action === b.action && a.target === b.target;
}

export function capabilitySetsEqual(a: CapabilitySet, b: CapabilitySet): boolean {
  if (a.unknown !== b.unknown) return false;
  if (a.capabilities.length !== b.capabilities.length) return false;
  return a.capabilities.every((capability) =>
    b.capabilities.some((other) => capabilitiesEqual(capability, other)),
  );
}

/**
 * `*` matches any run of characters, `?` exactly one — the shell-glob subset
 * §4.4's `http:get:*.example.com` example needs. Everything else is literal,
 * so a target containing regex metacharacters (`api.example.com`'s dots) is
 * matched as written rather than as a pattern.
 */
function globMatches(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  if (!pattern.includes("*") && !pattern.includes("?")) return false;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = `^${escaped.replaceAll("*", "[\\s\\S]*").replaceAll("?", "[\\s\\S]")}$`;
  return new RegExp(source).test(value);
}
