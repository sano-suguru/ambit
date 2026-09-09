import path from "node:path";
import { describe, expect, it } from "vitest";
import { legacyTsBackend } from "../src/checker/backend/legacy-ts.ts";
import { propagate } from "../src/checker/propagate.ts";
import { summarizeExtractedFiles } from "../src/checker/summarize.ts";
import type { ExtractedProject } from "../src/core/index.ts";

/**
 * DESIGN.md §3.5 gate 1 — the backend adoption gate's API-conformance suite.
 *
 * §3.5 names the shapes: 別名 import / re-export、generic、overload、callback、
 * union、`any`、再帰、JSDoc、Unicode の位置. The first two and `callback` are
 * covered against `backend-smoke` / `cross-module` in
 * `test/backend.legacy-ts.test.ts`; the rest live here, in
 * `test/fixtures/backend-conformance`.
 *
 * Two things separate this file from that one. It asserts against the
 * `TsBackend` *interface* — nothing here reaches for a `ts.Node`, so a second
 * implementation is judged by the same assertions. And it states the
 * requirement §3.2 makes explicit: 型が付いていることや `getResolvedSignature`
 * が成功することは、実行時の呼び出し先の実装が一意に確定することを意味しない.
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
