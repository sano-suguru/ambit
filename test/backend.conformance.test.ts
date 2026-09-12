import path from "node:path";
import { describe, expect, it } from "vitest";
import { legacyTsBackend } from "../src/checker/backend/legacy-ts.ts";
import { propagate } from "../src/checker/propagate.ts";
import { summarizeExtractedFiles } from "../src/checker/summarize.ts";
import type { ExtractedProject } from "../src/core/index.ts";

/**
 * DESIGN.md §3.5 gate 1 — the backend adoption gate's API-conformance suite.
 *
 * §3.5 names the shapes: "aliased imports / re-exports, generics, overloads,
 * callbacks, unions, `any`, recursion, JSDoc, and Unicode positions". The
 * first two and `callback` are
 * covered against `backend-smoke` / `cross-module` in
 * `test/backend.legacy-ts.test.ts`; the rest live here, in
 * `test/fixtures/backend-conformance`.
 *
 * Two things separate this file from that one. It asserts against the
 * `TsBackend` *interface* — nothing here reaches for a `ts.Node`, so a second
 * implementation is judged by the same assertions. And it states the
 * requirement §3.2 makes explicit: "That a value has a type, or that
 * `getResolvedSignature` succeeds, does not mean the implementation reached at
 * runtime is uniquely determined."
 * Every case below is a shape where the compiler has the type and the *call
 * target* is still the open question.
 */

const ROOT = path.join(import.meta.dirname, "fixtures", "backend-conformance");

let cached: Promise<ExtractedProject> | undefined;
function extract(): Promise<ExtractedProject> {
  cached ??= legacyTsBackend.extractProject(ROOT);
  return cached;
}

async function fileOf(name: string) {
  const { files } = await extract();
  const file = files.find((f) => f.filePath === name);
  if (!file) throw new Error(`fixture file not extracted: ${name}`);
  return file;
}

async function fn(fileName: string, id: string) {
  const file = await fileOf(fileName);
  return file.functions.find((f) => f.id === id);
}

async function callsOf(fileName: string, id: string) {
  return (await fn(fileName, id))?.calls ?? [];
}

describe("backend conformance: SymbolId uniqueness (§3.5 gate 1)", () => {
  /**
   * `propagate` reaches a fixed point by iterating until no function's effect
   * set changes, and argues termination from the union being monotonic. That
   * argument holds only if each `SymbolId` names exactly one summary: two
   * entries sharing an id overwrite each other's state every pass, `changed`
   * never goes false, and `ambit check` hangs rather than finishing.
   *
   * So this is not a tidiness check — it is the invariant the checker's
   * termination rests on, and therefore a requirement on every backend.
   */
  it("gives every extracted function a unique id within its file", async () => {
    const { files } = await extract();
    for (const file of files) {
      const ids = file.functions.map((f) => f.id);
      expect(new Set(ids).size, `duplicate ids in ${file.filePath}: ${ids.join(", ")}`).toBe(
        ids.length,
      );
    }
  });

  /**
   * The invariant above, stated as the behaviour it protects: the analysis
   * finishes. A duplicate id does not produce a wrong answer — it produces no
   * answer, and `ambit check` never returns. A short timeout is deliberate: a
   * failure here should read as "this does not terminate", not as a slow
   * machine, and this path never touches the CLI or the compiler twice.
   */
  it("reaches a fixed point on every conformance fixture", { timeout: 20_000 }, async () => {
    const { files } = await extract();
    const state = propagate(summarizeExtractedFiles(files));
    expect(state.size).toBeGreaterThan(0);
  });
});

describe("backend conformance: static and instance members (§4.1 (a))", () => {
  /**
   * `Cache.load` and `Cache.static load` are two functions with two bodies, so
   * they must be two declaration paths. Sharing one is the shape §4.1 calls "a
   * termination requirement as well as a notation": the two summaries disagree
   * (one is `network`, one is `pure`), so `propagate` would overwrite one with
   * the other on every pass and never converge. The uniqueness and fixed-point
   * tests above are what catch that; this one states the notation the fix
   * chose, so that a second backend has to produce the same ids.
   */
  it("indexes a static member under its own declaration path", async () => {
    const file = await fileOf("static-and-instance.ts");
    const ids = file.functions.map((f) => f.id);
    expect(ids).toContain("static-and-instance.ts#Cache.load");
    expect(ids).toContain("static-and-instance.ts#Cache.static load");
    expect(ids).toContain("static-and-instance.ts#Cache.get size");
    expect(ids).toContain("static-and-instance.ts#Cache.static get size");
  });

  /**
   * The behaviour the ids protect: an effect declared on one of the two does
   * not reach a caller of the other. Under a shared id, whichever summary won
   * the last write would answer for both.
   */
  /**
   * A namespace is a named container, so its members hang off the name. Found
   * on `drizzle-orm`'s `src/sql/sql.ts`, where a top-level `param` and
   * `namespace sql { export function param }` shared one id.
   */
  it("indexes a namespace member under the namespace's name", async () => {
    const file = await fileOf("static-and-instance.ts");
    const ids = file.functions.map((f) => f.id);
    expect(ids).toContain("static-and-instance.ts#param");
    expect(ids).toContain("static-and-instance.ts#sql.param");
  });

  it("keeps the two members' effects apart", async () => {
    const { files } = await extract();
    const state = propagate(summarizeExtractedFiles(files));
    const instance = state.get(
      "static-and-instance.ts#callsInstanceLoad" as never as Parameters<typeof state.get>[0],
    );
    const staticSide = state.get(
      "static-and-instance.ts#callsStaticLoad" as never as Parameters<typeof state.get>[0],
    );
    expect([...(instance?.observed.effects ?? [])]).toContain("network");
    expect([...(staticSide?.observed.effects ?? [])]).not.toContain("network");
  });
});

describe("backend conformance: overloads (§3.5 gate 1)", () => {
  /**
   * An overload set is one runtime function. The signatures are types; the
   * implementation is the code. Indexing the signatures as functions of their
   * own produces several entries under one declaration path — and the first of
   * them has no body, so its inferred effect set is empty and every caller
   * reads as `pure` no matter what the implementation does.
   */
  it("extracts an overloaded function once, at its implementation", async () => {
    const file = await fileOf("overloads.ts");
    const widen = file.functions.filter((f) => f.id === "overloads.ts#widen");
    expect(widen).toHaveLength(1);
    // The implementation, not either signature: `widen`'s signatures are on
    // lines 6 and 8, its implementation on line 9.
    expect(widen[0]?.location.line).toBe(9);
  });

  it("resolves a call to an overloaded function to its implementation", async () => {
    const calls = await callsOf("overloads.ts", "overloads.ts#callsOverloadFirst");
    expect(calls.map((c) => c.resolvedCallee)).toEqual(["overloads.ts#widen"]);
  });

  it("resolves a call matching a later overload signature to the same implementation", async () => {
    const calls = await callsOf("overloads.ts", "overloads.ts#callsOverloadSecond");
    expect(calls.map((c) => c.resolvedCallee)).toEqual(["overloads.ts#widen"]);
  });

  it("propagates the implementation's effects, not the signature's absence of a body", async () => {
    const calls = await callsOf("overloads.ts", "overloads.ts#claimsPureThroughOverload");
    expect(calls.map((c) => c.resolvedCallee)).toEqual(["overloads.ts#loadOverloaded"]);
    const impl = await fn("overloads.ts", "overloads.ts#loadOverloaded");
    expect(impl?.calls.some((c) => c.calleeQualifiedName === "fetch")).toBe(true);
  });

  /**
   * An overload set with no implementation in the project — `declare function`
   * — has nothing to propagate from. Resolving the call to the bodyless
   * declaration would infer an empty effect set and report a `network` call as
   * `pure`; DESIGN.md §3.4 forbids turning "could not be analyzed" into "no
   * violation", so it is `unknown` with a reason instead.
   */
  it("leaves a call to a declaration with no implementation unresolved", async () => {
    const calls = await callsOf("overloads.ts", "overloads.ts#callsAmbientOverload");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.resolvedCallee).toBeUndefined();
    expect(calls[0]?.unresolvedReason).toBe("overload-without-body");
  });

  it("does not extract a declaration with no body as a function of its own", async () => {
    const file = await fileOf("overloads.ts");
    expect(file.functions.map((f) => f.id)).not.toContain("overloads.ts#ambientOverload");
  });

  /**
   * A contract written on a bodyless signature is not adopted — it would have
   * to be attributed to a declaration Ambit does not model — so it is reported
   * rather than dropped, on the same principle as every other AMB-E003.
   */
  it("reports a contract written on a bodyless signature instead of dropping it", async () => {
    const { uncarriedContracts } = await extract();
    const onWiden = uncarriedContracts.filter(
      (c) => c.location.file === "overloads.ts" && c.kind === "bodyless-declaration",
    );
    expect(onWiden.map((c) => c.tag)).toEqual(["effects", "effects"]);
    expect(onWiden.every((c) => c.raw === "pure")).toBe(true);
  });

  /**
   * A class method's overload signatures and an `abstract` member reach the
   * extraction through a different branch than a free function does
   * (`collectFunctionLikeDeclarations` walks class members separately), so the
   * rule is asserted here rather than assumed to carry over.
   */
  it("extracts an overloaded method once, at its implementation", async () => {
    const file = await fileOf("overloads.ts");
    const save = file.functions.filter((f) => f.id === "overloads.ts#Store.save");
    expect(save).toHaveLength(1);
    expect(save[0]?.location.line).toBe(57);
  });

  it("resolves a call to an overloaded method to its implementation", async () => {
    const calls = await callsOf("overloads.ts", "overloads.ts#callsOverloadedMethod");
    expect(calls.map((c) => c.resolvedCallee)).toEqual(["overloads.ts#Store.save"]);
  });

  it("does not extract an abstract member, which declares a signature and no code", async () => {
    const file = await fileOf("overloads.ts");
    expect(file.functions.map((f) => f.id)).not.toContain("overloads.ts#Repo.load");
    // The abstract class still has a construction entry: a subclass's `super()`
    // runs it, so it has somewhere to propagate from.
    expect(file.functions.map((f) => f.id)).toContain("overloads.ts#Repo.constructor");
  });

  it("counts a bodyless declaration among the function-like nodes it did not extract", async () => {
    const { skippedFunctions } = await extract();
    // `widen` ×2, `ambientOverload` ×2, `loadOverloaded` ×2, `Store.save` ×2,
    // and `Repo.load`.
    expect(skippedFunctions.get("bodyless-declaration")).toBe(9);
  });
});

describe("backend conformance: generics (§3.5 gate 1)", () => {
  it("resolves a call to a generic function with an explicit type argument", async () => {
    const calls = await callsOf("generics.ts", "generics.ts#callsGeneric");
    expect(calls.map((c) => c.resolvedCallee)).toEqual(["generics.ts#identity"]);
  });

  it("resolves a call to a generic function whose type argument is inferred", async () => {
    const calls = await callsOf("generics.ts", "generics.ts#callsGenericInferred");
    expect(calls.map((c) => c.resolvedCallee)).toEqual(["generics.ts#identity"]);
  });

  /**
   * §4.2 rule 4 does not soften because the callee is generic: a callback
   * passed by reference is never walked, so the allowlisted method it is
   * handed to cannot be trusted as pure.
   */
  it("still refuses a pure verdict for a callback passed by reference to a generic", async () => {
    const calls = await callsOf("generics.ts", "generics.ts#genericHigherOrder");
    const map = calls.find((c) => c.pureBuiltinName === "ReadonlyArray.map");
    expect(map?.callbackByReference).toBe(true);
    expect(map?.unresolvedReason).toBe("builtin-method");
  });
});

/**
 * §4.2 rule 4 at the shape callback APIs actually declare. `cb?: (v: T) => R`
 * types both the parameter and the argument as
 * `((v: T) => R) | null | undefined`, and a union reports no call signatures of
 * its own however callable its constituents are. A backend that asks the union
 * directly answers "not callable", skips the reference, and lets the opaque
 * callback past the guard — measured on `drizzle-orm`, six sites where
 * `promise.then(onFulfilled, onRejected)` summarized as `known-pure`
 * (`docs/measurements/2026-09-12-optional-callback-opacity.md`).
 */
describe("backend conformance: optional callback slots (§3.5 gate 1)", () => {
  it("marks an optional callback passed by reference as opaque", async () => {
    const calls = await callsOf(
      "optional-callbacks.ts",
      "optional-callbacks.ts#forwardsOptionalCallbacks",
    );
    const then = calls.find((c) => c.pureBuiltinName === "Promise.then");
    expect(then?.callbackByReference).toBe(true);
    expect(then?.unresolvedReason).toBe("builtin-method");
  });

  /**
   * The direction §3.4 forbids, asserted where it would be lost: a site whose
   * callbacks cannot be walked must not summarize as a proven-pure builtin.
   */
  it("refuses a known-pure verdict for that site", async () => {
    const { files } = await extract();
    const summaries = summarizeExtractedFiles(files);
    const summary = summaries.find(
      (s) => s.id === "optional-callbacks.ts#forwardsOptionalCallbacks",
    );
    const then = summary?.calls.find(
      (c) => "qualifiedName" in c && c.qualifiedName === "Promise.then",
    );
    expect(then?.kind).toBe("unresolved");
  });

  /**
   * The narrowing has to stay narrow: `null` and `undefined` in a callback
   * slot are not callables, and counting them would make every
   * `promise.then(null, handler)` read as opaque twice over.
   */
  it("does not count a null or undefined argument as a callable", async () => {
    const calls = await callsOf("optional-callbacks.ts", "optional-callbacks.ts#passesNoCallback");
    const then = calls.find((c) => c.pureBuiltinName === "Promise.then");
    expect(then?.callbackByReference).toBeUndefined();
  });

  /**
   * An optional slot handed a reference this project extracted is a target,
   * not opacity — the effects come from the callback's own summary.
   */
  it("follows an optional callback that names an extracted function", async () => {
    const calls = await callsOf(
      "optional-callbacks.ts",
      "optional-callbacks.ts#passesExtractedCallback",
    );
    const then = calls.find((c) => c.pureBuiltinName === "Promise.then");
    expect(then?.callbackTargets).toEqual(["optional-callbacks.ts#double"]);
    expect(then?.callbackByReference).toBeUndefined();
  });

  /**
   * The narrowing's other half, and the one a backend loses *silently*: the
   * declared parameter list decides whether a position is a callback slot at
   * all. `Object.keys(o: {})` and `new Proxy(…, handler: ProxyHandler<T>)`
   * are not callback slots, so an argument the argument-side test calls
   * "may be callable" — `any` — must not make either site opaque.
   *
   * A backend that cannot read the parameter list falls open at every index
   * and reports `callbackByReference` on both. That is the conservative
   * direction, so no verdict is unsafe; what it costs is the `unknown` rate,
   * on every call in the project at once. Measured as eleven of the fifteen
   * `drizzle-orm` divergences in
   * `docs/measurements/2026-09-12-callable-slot-handle.md`.
   */
  it("does not count an any-typed argument in a non-callback slot as opaque", async () => {
    const calls = await callsOf(
      "optional-callbacks.ts",
      "optional-callbacks.ts#passesAnyToNonCallbackSlot",
    );
    const keys = calls.find((c) => c.pureBuiltinName === "ObjectConstructor.keys");
    expect(keys).toBeDefined();
    expect(keys?.callbackByReference).toBeUndefined();
  });

  it("does not count an any-typed constructor argument in a non-callback slot as opaque", async () => {
    const calls = await callsOf(
      "optional-callbacks.ts",
      "optional-callbacks.ts#passesAnyToNonCallbackConstructorSlot",
    );
    const proxy = calls.find((c) => c.calleeQualifiedName === "new Proxy");
    expect(proxy).toBeDefined();
    expect(proxy?.callbackByReference).toBeUndefined();
  });

  /**
   * The union case, where the argument test genuinely answers "may be
   * callable" and is right to — one constituent is a function. The slot is
   * still not a callback slot, and that is what decides.
   */
  it("does not count a callable union in a non-callback slot as opaque", async () => {
    const calls = await callsOf(
      "optional-callbacks.ts",
      "optional-callbacks.ts#passesCallableUnionToNonCallbackSlot",
    );
    const boolean = calls.find((c) => c.calleeQualifiedName === "Boolean");
    expect(boolean).toBeDefined();
    expect(boolean?.callbackByReference).toBeUndefined();
  });
});

describe("backend conformance: unions (§3.5 gate 1)", () => {
  /**
   * Both union members declare `run`, so the call type-checks and
   * `getResolvedSignature` succeeds — and the implementation that runs is
   * still not fixed. Reporting either member as `resolvedCallee` would attach
   * one branch's contract to a call that may take the other.
   */
  it("leaves a call on a union-typed receiver unresolved", async () => {
    const calls = await callsOf("unions.ts", "unions.ts#callsUnionMember");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.resolvedCallee).toBeUndefined();
    expect(calls[0]?.unresolvedReason).toBe("unresolved-symbol");
  });

  it("leaves a call on a discriminated-union parameter unresolved", async () => {
    const calls = await callsOf("unions.ts", "unions.ts#callsUnionParameter");
    expect(calls[0]?.resolvedCallee).toBeUndefined();
  });

  it("reports an optional call through a function-or-undefined parameter as a callback parameter", async () => {
    const calls = await callsOf("unions.ts", "unions.ts#callsOptionalUnion");
    expect(calls.map((c) => c.unresolvedReason)).toEqual(["callback-parameter"]);
  });
});

describe("backend conformance: any and the non-null assertion (§3.5 gate 1, §4.7)", () => {
  /**
   * §12 requires that `as any` and `!` are not treated alike. They differ in
   * what they do to the *declaration*: a cast to `any` destroys it, a non-null
   * assertion keeps it. The two cases below are the discriminator, and they
   * must not report the same reason.
   */
  it("reports a call through an `as any` cast as any-typed", async () => {
    const calls = await callsOf("any-typed.ts", "any-typed.ts#callsThroughAnyCast");
    expect(calls.map((c) => c.unresolvedReason)).toEqual(["any-typed"]);
  });

  it("keeps the declaration behind a non-null assertion, so `f!()` is still a callback parameter", async () => {
    const calls = await callsOf("any-typed.ts", "any-typed.ts#callsNonNullAsserted");
    expect(calls.map((c) => c.unresolvedReason)).toEqual(["callback-parameter"]);
  });

  it("names an any-typed callee for stub matching rather than resolving it", async () => {
    const calls = await callsOf("any-typed.ts", "any-typed.ts#callsAnyTyped");
    expect(calls[0]?.resolvedCallee).toBeUndefined();
    expect(calls[0]?.calleeQualifiedName).toBe("anyTarget");
  });
});

describe("backend conformance: the object-literal receiver (§4.2 rule 7)", () => {
  /**
   * `X.p()` where `X` is a `const` bound to one object literal. §4.2 rule 7
   * lets the *value* decide the target, which is the only way this resolves:
   * the checker answers with the annotation's member signature, so a backend
   * that asks it the question gets `Dispatcher.run` and no declaration in this
   * project. Ambit's own `legacyTsBackend: TsBackend = { extractProject }` is
   * this shape, so a backend that cannot do it loses a resolved edge on
   * Ambit's own source.
   *
   * The negatives below are the boundary. Each is a receiver or a member a
   * broader version of the rule would resolve and a correct one must not,
   * because more than one function can stand behind it — resolving any of
   * them would be a false positive in the direction that matters, claiming
   * authority the analysis did not actually follow.
   */
  it("follows the value through an annotation the checker would answer with", async () => {
    const calls = await callsOf("literal-receiver.ts", "literal-receiver.ts#callsAnnotated");
    expect(calls.map((c) => c.resolvedCallee)).toEqual(["literal-receiver.ts#target"]);
  });

  it("unwraps `as const`, which asserts a type without moving the member", async () => {
    const calls = await callsOf("literal-receiver.ts", "literal-receiver.ts#callsAsConst");
    expect(calls.map((c) => c.resolvedCallee)).toEqual(["literal-receiver.ts#target"]);
  });

  it("takes one hop to the named function and no more", async () => {
    const calls = await callsOf("literal-receiver.ts", "literal-receiver.ts#callsRebind");
    expect(calls[0]?.resolvedCallee).toBeUndefined();
  });

  it("does not resolve a member whose value is a call result", async () => {
    const calls = await callsOf("literal-receiver.ts", "literal-receiver.ts#callsCallResult");
    expect(calls[0]?.resolvedCallee).toBeUndefined();
  });

  it("does not resolve a member whose value is read out of another object", async () => {
    const calls = await callsOf("literal-receiver.ts", "literal-receiver.ts#callsIndexedAccess");
    expect(calls[0]?.resolvedCallee).toBeUndefined();
  });

  /**
   * `const anyReceiver: any = { run: pureTarget }` — the `any` is on the
   * annotation, and rule 7 does not read the annotation. The value is still
   * exactly one literal, so the call is resolved rather than `any-typed`:
   * §4.7's "an `any` cast destroys the declaration" is about the *callee*
   * expression (`callsThroughAnyCast` above), not about a receiver whose
   * initializer is right there.
   */
  it("resolves through an any-annotated receiver, because the value is still one literal", async () => {
    const calls = await callsOf("any-typed.ts", "any-typed.ts#callsAnyTypedMember");
    expect(calls.map((c) => c.resolvedCallee)).toEqual(["any-typed.ts#pureTarget"]);
  });
});

describe("backend conformance: the constructed-instance receiver (§4.2 rule 7)", () => {
  /**
   * `X.p()` where `X` is a `const` bound to one `new`. §4.2 rule 7 names this
   * and the object-literal receiver in the same breath, and the premise is the
   * same one: `const` fixes the binding, not the object.
   *
   * Every receiver below carries a type annotation, and that is what makes
   * these tests of the rule rather than of the checker. Without one the
   * checker answers with the class's own member and the receiver is never
   * consulted — so an unannotated `let` would pass a test it does not
   * exercise.
   */
  it("follows the value through an annotation the checker would answer with", async () => {
    const calls = await callsOf("instance-receiver.ts", "instance-receiver.ts#callsAnnotated");
    expect(calls.map((c) => c.resolvedCallee)).toEqual(["instance-receiver.ts#Engine.run"]);
  });

  /**
   * Both classes declare `run`. An override is the implementation reached at
   * runtime, so the chain is walked derived-first; a walk that took the base's
   * member would name a body that never runs and hand the call that body's
   * declared authority.
   */
  it("prefers the override over the base member of the same name", async () => {
    const calls = await callsOf("instance-receiver.ts", "instance-receiver.ts#callsOverride");
    expect(calls.map((c) => c.resolvedCallee)).toEqual(["instance-receiver.ts#Tuned.run"]);
  });

  it("reaches the base for a member only the base declares", async () => {
    const calls = await callsOf("instance-receiver.ts", "instance-receiver.ts#callsInherited");
    expect(calls.map((c) => c.resolvedCallee)).toEqual(["instance-receiver.ts#Engine.idle"]);
  });

  it("does not follow a `let` receiver, which may hold another object by then", async () => {
    const calls = await callsOf("instance-receiver.ts", "instance-receiver.ts#callsMutable");
    expect(calls[0]?.resolvedCallee).toBeUndefined();
  });

  /**
   * An ambient class is excluded by having no indexed member, not by a check
   * on the declaring file: the walk reaches `Set` and finds nothing there.
   * `Set.add` stays what it is — a mutation of an escaping receiver — rather
   * than becoming a resolved project target.
   */
  it("finds nothing on an ambient class, leaving the builtin classified as one", async () => {
    const calls = await callsOf(
      "instance-receiver.ts",
      "instance-receiver.ts#callsBuiltinInstance",
    );
    expect(calls[0]?.resolvedCallee).toBeUndefined();
    expect(calls[0]?.mutation?.qualifiedName).toBe("Set.add");
  });

  /**
   * A class *expression* bound to a `const` has no extracted members, so there
   * is no id to resolve to. Recorded because it is the shape a reader would
   * expect the rule to cover and it does not — not because it is desirable.
   */
  it("resolves nothing through a class expression, whose members are not extracted", async () => {
    const calls = await callsOf(
      "instance-receiver.ts",
      "instance-receiver.ts#callsClassExpression",
    );
    expect(calls[0]?.resolvedCallee).toBeUndefined();
  });
});

describe("backend conformance: recursion (§3.5 gate 1)", () => {
  /**
   * §4.2 rule 7 iterates the propagation to a fixed point; that needs the
   * cycle's edges to be present as resolved call targets in the first place.
   */
  it("reports a self-call as a resolved edge back to the same function", async () => {
    const calls = await callsOf("recursion.ts", "recursion.ts#selfRecursive");
    expect(calls.map((c) => c.resolvedCallee).sort()).toEqual([
      "recursion.ts#leafReadsFile",
      "recursion.ts#selfRecursive",
    ]);
  });

  it("reports both edges of a mutual recursion", async () => {
    expect(
      (await callsOf("recursion.ts", "recursion.ts#mutualA")).map((c) => c.resolvedCallee),
    ).toContain("recursion.ts#mutualB");
    expect(
      (await callsOf("recursion.ts", "recursion.ts#mutualB")).map((c) => c.resolvedCallee),
    ).toContain("recursion.ts#mutualA");
  });
});

describe("backend conformance: JSDoc tag locations (§3.5 gate 1)", () => {
  /**
   * §5.3 requires `fixes[].edits` to be a concrete, applicable patch, and a
   * patch that replaces a contract tag needs the tag's own range — not the
   * declaration's, and not a line guessed from the comment block.
   */
  it("records where each contract tag was written, not where the declaration is", async () => {
    const declared = await fn("recursion.ts", "recursion.ts#leafReadsFile");
    const tag = declared?.jsDoc?.tagLocations.get("effects");
    expect(declared?.jsDoc?.tags.get("effects")).toBe("fs_read");
    // `/** @effects fs_read */` is line 5; the declaration is line 6.
    expect(tag?.line).toBe(5);
    expect(tag?.endLine).toBe(5);
    expect(declared?.location.line).toBe(6);
    // 1-based, end-exclusive, and covering the tag itself rather than the
    // whole comment: `/** ` is 4 characters, so `@effects` starts at column 5.
    expect(tag?.col).toBe(5);
    expect(tag?.endCol).toBeGreaterThan(tag?.col ?? 0);
  });
});

describe("backend conformance: Unicode positions (§3.5 gate 1)", () => {
  /**
   * `SourceLocation` is 1-based UTF-16 code units. Three widths disagree on
   * the fixture's lines, so a backend that handed back byte offsets or code
   * points produces a different number here rather than an equal one — which
   * is the whole point of measuring the expectation from the source text with
   * `String.length` instead of writing a literal.
   */
  const UNICODE = path.join(ROOT, "unicode.ts");

  async function lineText(line: number): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    return (await readFile(UNICODE, "utf8")).split("\n")[line - 1] ?? "";
  }

  it("names a function whose identifier is non-ASCII", async () => {
    const file = await fileOf("unicode.ts");
    expect(file.functions.map((f) => f.id)).toContain("unicode.ts#日本語関数");
  });

  it("reports a column in UTF-16 code units on a line containing astral characters", async () => {
    const calls = await callsOf("unicode.ts", "unicode.ts#callsAfterAstralInSameLine");
    const call = calls.find((c) => c.resolvedCallee === "unicode.ts#日本語関数");
    expect(call).toBeDefined();

    const text = await lineText(call?.location.line ?? 0);
    const index = text.indexOf("日本語関数(");
    expect(index).toBeGreaterThan(0);
    // `col` is 1-based; `String.prototype.indexOf` counts UTF-16 code units,
    // which is the unit `SourceLocation` promises. The same line measured in
    // UTF-8 bytes or in code points gives a different number.
    expect(call?.location.col).toBe(index + 1);
    expect(Buffer.byteLength(text.slice(0, index), "utf8")).not.toBe(index);
    expect([...text.slice(0, index)].length).not.toBe(index);
  });

  it("reports a contract tag's column in UTF-16 code units too", async () => {
    const declared = await fn("unicode.ts", "unicode.ts#日本語関数");
    const tag = declared?.jsDoc?.tagLocations.get("effects");
    const text = await lineText(tag?.line ?? 0);
    expect(tag?.col).toBe(text.indexOf("@effects") + 1);
  });
});

/**
 * DESIGN.md §4.1 (a), "The inline-callback owner". A backend has to produce
 * this entry, and has to produce the per-body split beside it: without the
 * split, one id standing for several bodies is a merge into silence, and §6.3
 * has nothing to count.
 */
describe("backend conformance: the inline-callback owner (§4.1 (a))", () => {
  const FILE = "inline-callbacks.ts";
  const OWNER = "inline-callbacks.ts#<inline callbacks>";

  it("gives a file's unowned inline callbacks one entry, declarable by nobody", async () => {
    const owner = await fn(FILE, OWNER);
    expect(owner).toBeDefined();
    expect(owner?.undeclarable).toBe(true);
    expect(owner?.jsDoc).toBeUndefined();
    // The bodies are scattered through the file, so the one position true of
    // all of them is the file's own start.
    expect(owner?.location).toMatchObject({ line: 1, col: 1 });
  });

  it("partitions its calls by body, and the partition reproduces the flat list", async () => {
    const owner = await fn(FILE, OWNER);
    // Four owned bodies: two `router.post` handlers and two `router.use`
    // arguments. The one inside `register` is that function's, not the
    // owner's.
    expect(owner?.bodies).toHaveLength(4);
    expect(owner?.bodies?.flat()).toEqual(owner?.calls);
  });

  it("leaves a callback inside a named function to that function", async () => {
    const register = await fn(FILE, "inline-callbacks.ts#register");
    expect(register).toBeDefined();
    expect(register?.bodies).toBeUndefined();
  });

  it("creates no entry for a file with no unowned inline callback", async () => {
    const file = await fileOf("recursion.ts");
    expect(file.functions.map((f) => f.id)).not.toContain("recursion.ts#<inline callbacks>");
  });

  it("splits authority per body, and their union is the entry's own", async () => {
    const { files } = await extract();
    const state = propagate(summarizeExtractedFiles(files));
    const owner = state.get(OWNER as never);
    expect(owner?.bodies).toHaveLength(4);
    // Exactly one of the four reaches the network, through `ping`.
    const holders = owner?.bodies?.filter((body) => body.observed.effects.has("network"));
    expect(holders).toHaveLength(1);
    expect(owner?.observed.effects.has("network")).toBe(true);
  });
});
