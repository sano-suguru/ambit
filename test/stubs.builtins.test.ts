import path from "node:path";
import { describe, expect, it } from "vitest";
import { diagnose } from "../src/checker/diagnose.ts";
import { propagate } from "../src/checker/propagate.ts";
import { summarizeExtractedFiles } from "../src/checker/summarize.ts";
import type { Call, FunctionSummary } from "../src/core/index.ts";
import { lookupBuiltinEffect } from "../src/stubs/builtin-effects.ts";
import { isKnownPureConstructor } from "../src/stubs/constructors.ts";
import { isMutatingBuiltin } from "../src/stubs/mutating-builtins.ts";
import {
  isHigherOrderBuiltin,
  isKnownPureBuiltin,
  isKnownPureGlobalCall,
} from "../src/stubs/pure-builtins.ts";
import { extractFixture } from "./support/extract.ts";
import { observedEffects } from "./support/summary.ts";

/**
 * The default-lib tables (`src/stubs/pure-builtins.ts`,
 * `mutating-builtins.ts`, `builtin-effects.ts`, and the Fetch API rows of
 * `constructors.ts`).
 *
 * Every case here is a pair: a call the tables now answer, and one beside it
 * that must stay `unknown` or must carry an effect. The pairing is the
 * assertion. A table that grew until it answered both would have stopped
 * measuring what Ambit can see and started asserting that everything is fine
 * (DESIGN.md §3.4).
 */

const FIXTURE_ROOT = path.join(import.meta.dirname, "fixtures", "builtins");
const ENGINE = { name: "test", version: "0" };

async function analyze() {
  const project = await extractFixture(FIXTURE_ROOT);
  const summaries = summarizeExtractedFiles(project.files);
  const state = propagate(summaries);
  return { summaries, state, diagnostics: diagnose(state, ENGINE) };
}

function summaryOf(summaries: readonly FunctionSummary[], name: string): FunctionSummary {
  const found = summaries.find((s) => s.id.endsWith(`#${name}`));
  if (!found) throw new Error(`no summary for ${name}`);
  return found;
}

async function unknownOf(name: string): Promise<boolean> {
  const { summaries, state } = await analyze();
  return state.get(summaryOf(summaries, name).id)?.observed.unknown === true;
}

async function callsOf(name: string): Promise<readonly Call[]> {
  const { summaries } = await analyze();
  return summaryOf(summaries, name).calls;
}

describe("the pure default-lib table", () => {
  it("answers the members measurement surfaced, keyed by builtin type", () => {
    expect(isKnownPureBuiltin("ObjectConstructor.entries")).toBe(true);
    expect(isKnownPureBuiltin("String.replace")).toBe(true);
    expect(isKnownPureBuiltin("ArrayConstructor.isArray")).toBe(true);
    expect(isKnownPureBuiltin("Promise.then")).toBe(true);
    expect(isKnownPureBuiltin("Headers.get")).toBe(true);
    expect(isKnownPureBuiltin("Date.toISOString")).toBe(true);
  });

  it("leaves out the names that mutate an argument rather than the receiver", () => {
    // The locality rule reads the receiver, which for these is the `Object` /
    // `Reflect` global — it would answer about the wrong value, so neither
    // table may claim them.
    for (const name of [
      "ObjectConstructor.assign",
      "ObjectConstructor.freeze",
      "ObjectConstructor.defineProperty",
      "Reflect.set",
      "Reflect.deleteProperty",
    ]) {
      expect(isKnownPureBuiltin(name)).toBe(false);
      expect(isMutatingBuiltin(name)).toBe(false);
    }
  });

  it("leaves out names whose effect depends on what the object is backed by", () => {
    for (const name of [
      "Body.json",
      "Response.json",
      "ReadableStreamDefaultController.enqueue",
      "ReadableStreamDefaultReader.read",
      "Console.log",
      "CallableFunction.call",
      "CallableFunction.apply",
    ]) {
      expect(isKnownPureBuiltin(name)).toBe(false);
    }
  });

  it("does not claim the clock or randomness are effect-free", () => {
    expect(isKnownPureBuiltin("DateConstructor.now")).toBe(false);
    expect(isKnownPureBuiltin("Math.random")).toBe(false);
    expect(lookupBuiltinEffect("DateConstructor.now")).toBe("env");
    expect(lookupBuiltinEffect("Math.random")).toBe("env");
    // Its siblings on the same type are readers of their arguments.
    expect(lookupBuiltinEffect("Math.floor")).toBeUndefined();
    expect(isKnownPureBuiltin("Math.floor")).toBe(true);
  });
});

describe("the bare-global table", () => {
  it("answers the conversion and parsing globals", () => {
    expect(isKnownPureGlobalCall("Number")).toBe(true);
    expect(isKnownPureGlobalCall("parseInt")).toBe(true);
    expect(isKnownPureGlobalCall("encodeURIComponent")).toBe(true);
    expect(isKnownPureGlobalCall("TypeError")).toBe(true);
  });

  it("refuses the ones that run code the analysis never sees", () => {
    // `Function(source)` compiles a string — DESIGN.md §4.2 rule 6.
    expect(isKnownPureGlobalCall("Function")).toBe(false);
    expect(isKnownPureGlobalCall("eval")).toBe(false);
    expect(isKnownPureGlobalCall("setTimeout")).toBe(false);
    expect(isKnownPureGlobalCall("queueMicrotask")).toBe(false);
  });
});

describe("the Fetch API constructors", () => {
  it("treats constructing a value type as effect-free", () => {
    for (const key of ["new Headers", "new Request", "new Response", "new FormData"]) {
      expect(isKnownPureConstructor(key, false)).toBe(true);
    }
  });

  it("still refuses `new Proxy`, whose traps run where Ambit sees no call", () => {
    expect(isKnownPureConstructor("new Proxy", false)).toBe(false);
  });
});

describe("end to end on test/fixtures/builtins", () => {
  it("resolves a function built only from allowlisted default-lib reads", async () => {
    expect(await unknownOf("readsObjectAndString")).toBe(false);
    expect(await unknownOf("convertsWithGlobals")).toBe(false);
    expect(await unknownOf("readsADateInstance")).toBe(false);
    expect(await unknownOf("readsAHeaderAndDecodes")).toBe(false);
  });

  it("keeps the neighbouring cases unknown", async () => {
    expect(await unknownOf("assignsOntoAnArgument")).toBe(true);
    expect(await unknownOf("readsAResponseBody")).toBe(true);
    expect(await unknownOf("logs")).toBe(true);
    expect(await unknownOf("compilesAString")).toBe(true);
  });

  it("infers a by-reference callback from the function it names (DESIGN.md §4.2 rule 4)", async () => {
    expect(isKnownPureBuiltin("ReadonlyArray.map")).toBe(true);
    expect(isHigherOrderBuiltin("ReadonlyArray.map")).toBe(true);
    // The referenced function is pure, so the whole call is.
    expect(await unknownOf("mapsAReferencedProjectFunction")).toBe(false);
    // The same shape with an effectful reference stays unknown — through the
    // reference's own body, not through a blanket refusal.
    expect(await unknownOf("mapsAReferencedEffectfulFunction")).toBe(true);
    // A reference this tree did not extract still falls to `unknown`.
    expect(await unknownOf("mapsAnOpaqueCallback")).toBe(true);
  });

  it("does not let a callable argument cost a method that cannot call it", async () => {
    expect(isHigherOrderBuiltin("ArrayConstructor.isArray")).toBe(false);
    expect(await unknownOf("inspectsAFunctionValue")).toBe(false);
  });

  it("reports the clock and randomness as env against a pure declaration", async () => {
    const { diagnostics } = await analyze();
    for (const name of ["readsTheClock", "rolls"]) {
      const diagnostic = diagnostics.find((d) => d.message.startsWith(`${name} `));
      expect(diagnostic?.id).toBe("AMB-E001");
      expect(observedEffects(diagnostic)).toContain("env");
    }
  });

  it("reads a receiver-mutating WHATWG method through the locality rule", async () => {
    // The same call, twice: on an argument it is `state_write`, on a value the
    // function allocated itself it carries nothing (DESIGN.md §4.2, "Local
    // mutation and `pure`").
    const escaping = (await callsOf("writesAnArgumentsHeaders")).filter(
      (call) => call.kind === "mutation",
    );
    expect(escaping.map((call) => call.kind === "mutation" && call.escaping)).toEqual([true]);

    const local = (await callsOf("writesItsOwnHeaders")).filter((call) => call.kind === "mutation");
    expect(local.map((call) => call.kind === "mutation" && call.escaping)).toEqual([false, false]);
    expect(await unknownOf("writesItsOwnHeaders")).toBe(false);
  });
});
