import type { Capability, LiteralArgument } from "../core/index.ts";

/**
 * The static half of DESIGN.md §4.4's dual enforcement: which bundled
 * operations carry
 * an `http:<method>:<host>` capability requirement, and how to read it off the
 * call site.
 *
 * "Violations that can be decided statically, such as literal URLs and known
 * clients, are stopped by the checker. Dynamic URLs, table names and the like
 * are matched by the corresponding runtime hook" —
 * so a literal URL (or a template literal whose static head already fixes the
 * host) becomes a requirement the checker compares against the grant, and
 * anything else becomes {@link HttpCapabilityRequirement.targetUnknown}, which
 * says the target exists but only the runtime can match it. Neither branch may
 * quietly report "no requirement": that would turn a dynamic URL into a
 * guarantee it was allowed.
 *
 * Trust level: bundled with Ambit (DESIGN.md §8).
 */
interface HttpCapabilityRule {
  /** Which argument holds the URL. */
  readonly urlArgument: number;
  /** Which argument holds an options object whose `method` names the action, if any. */
  readonly optionsArgument?: number;
  /** The action when the options object does not name a method. */
  readonly defaultAction: string;
}

const HTTP_CAPABILITY_RULES: ReadonlyMap<string, HttpCapabilityRule> = new Map([
  ["fetch", { urlArgument: 0, optionsArgument: 1, defaultAction: "get" }],
  ["globalThis.fetch", { urlArgument: 0, optionsArgument: 1, defaultAction: "get" }],
  ["undici.fetch", { urlArgument: 0, optionsArgument: 1, defaultAction: "get" }],
  ["node:http.get", { urlArgument: 0, defaultAction: "get" }],
  ["node:https.get", { urlArgument: 0, defaultAction: "get" }],
  ["node:http.request", { urlArgument: 0, optionsArgument: 1, defaultAction: "get" }],
  ["node:https.request", { urlArgument: 0, optionsArgument: 1, defaultAction: "get" }],
]);

export interface HttpCapabilityRequirement {
  /** The capability the call requires, when the host could be read from the source. */
  readonly capability?: Capability;
  /** Set when this operation has a target but the source does not fix it. */
  readonly targetUnknown?: true;
}

/**
 * The capability requirement of one call, or `undefined` when this table knows
 * of no target for it — which is not the same as "requires nothing": every
 * other operation simply has no rule here yet (`node:fs`, DB clients, LLM
 * SDKs), and §4.4's caveat forbids inferring one for a DB client from a SQL
 * string.
 */
export function lookupHttpCapability(
  qualifiedName: string,
  literalArguments: readonly (LiteralArgument | undefined)[] | undefined,
): HttpCapabilityRequirement | undefined {
  const rule = HTTP_CAPABILITY_RULES.get(qualifiedName);
  if (!rule) return undefined;

  const host = hostOf(literalArguments?.[rule.urlArgument]);
  if (host === undefined) return { targetUnknown: true };

  const options =
    rule.optionsArgument === undefined ? undefined : literalArguments?.[rule.optionsArgument];
  const method = options?.properties?.get("method");
  return {
    capability: {
      resource: "http",
      action: (method ?? rule.defaultAction).toLowerCase(),
      target: host,
    },
  };
}

/**
 * The host a URL argument fixes, or `undefined` when the source does not fix
 * one.
 *
 * A template literal's static head is enough *only if the authority ends
 * inside it*: `` `https://api.example.com/rates/${c}` `` fixes
 * `api.example.com`, while `` `https://api.${env}.example.com/` `` fixes
 * nothing and must not be read as `api.` — a prefix match would be a target
 * the author never granted.
 *
 * The host is taken as written (minus userinfo), port included: §4.4's own
 * example spells a target `http:get:localhost:8080`, and inventing or dropping
 * a default port would make a grant and a requirement disagree over text
 * neither one wrote.
 */
function hostOf(argument: LiteralArgument | undefined): string | undefined {
  const text = argument?.text;
  if (text === undefined) return undefined;

  const schemeEnd = text.indexOf("://");
  // A relative URL ("/v1/rates") names no host; the host comes from wherever
  // the request is sent, which is not in this call.
  if (schemeEnd < 0) return undefined;

  const rest = text.slice(schemeEnd + 3);
  const terminator = rest.search(/[/?#]/);
  if (terminator < 0) {
    // The authority runs to the end of the text we have. Only a complete
    // literal proves nothing more follows.
    return argument?.complete === true ? normalizeAuthority(rest) : undefined;
  }
  return normalizeAuthority(rest.slice(0, terminator));
}

function normalizeAuthority(authority: string): string | undefined {
  const afterUserInfo = authority.slice(authority.lastIndexOf("@") + 1);
  return afterUserInfo.length === 0 ? undefined : afterUserInfo.toLowerCase();
}
