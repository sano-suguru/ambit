import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diagnose } from "../src/checker/diagnose.ts";
import { propagate } from "../src/checker/propagate.ts";
import { summarizeExtractedFiles } from "../src/checker/summarize.ts";
import type { Call, Diagnostic, LiteralArgument } from "../src/core/index.ts";
import { constructorStubKey, lookupConstructorEffect } from "../src/stubs/constructors.ts";
import { lookupHttpCapability } from "../src/stubs/http-capabilities.ts";
import { lookupStubEffect, withNodePrefix } from "../src/stubs/node-builtins.ts";
import { extractFixture } from "./support/extract.ts";
import { observedEffects } from "./support/summary.ts";

/**
 * The builtin effect table (`src/stubs/node-builtins.ts`) and the two tables
 * keyed beside it (`http-capabilities.ts`, `constructors.ts`), under the
 * spelling question the tables do not decide: `node:fs` and `fs` are the same
 * module, so they must reach the same verdict.
 *
 * Every case is a pair — the operation written both ways — because the
 * assertion is the *equality*, not either answer on its own. A row that
 * answered only the prefixed spelling would let the same edit fail the check
 * one way and pass the other, which is what E3b measured
 * (`docs/measurements/2026-09-11-third-party-diff-validation.md`).
 */

const FIXTURE_ROOT = path.join(import.meta.dirname, "fixtures", "node-builtin-specifier");
const HTTP_CLIENT_ROOT = path.join(import.meta.dirname, "fixtures", "http-clients");
const STUBS_DIR = path.join(import.meta.dirname, "..", "src", "stubs");
const ENGINE = { name: "test", version: "0" };

function url(text: string, complete = true): readonly LiteralArgument[] {
  return [{ text, complete }];
}

async function diagnoseFixture(): Promise<readonly Diagnostic[]> {
  const { files } = await extractFixture(FIXTURE_ROOT);
  const state = propagate(summarizeExtractedFiles(files));
  return diagnose(state, ENGINE);
}

function forFunction(diagnostics: readonly Diagnostic[], name: string): Diagnostic | undefined {
  return diagnostics.find((d) => d.message.startsWith(`${name} `));
}

async function callsOf(root: string, name: string): Promise<readonly Call[]> {
  const { files } = await extractFixture(root);
  const summary = summarizeExtractedFiles(files).find((s) => s.id.endsWith(`#${name}`));
  if (!summary) throw new Error(`no summary for ${name}`);
  return summary.calls;
}

describe("the `node:` prefix is a spelling, not a verdict", () => {
  it("answers a builtin effect under both spellings", () => {
    expect(lookupStubEffect("fs.writeFileSync")).toBe("fs_write");
    expect(lookupStubEffect("node:fs.writeFileSync")).toBe("fs_write");
    expect(lookupStubEffect("child_process.execSync")).toBe("process");
    expect(lookupStubEffect("node:child_process.execSync")).toBe("process");
    // The specifier of a subpath export carries a `/` and no `.`, so it is one
    // segment like any other.
    expect(lookupStubEffect("fs/promises.readFile")).toBe("fs_read");
    expect(lookupStubEffect("node:fs/promises.readFile")).toBe("fs_read");
  });

  it("answers a capability requirement under both spellings", () => {
    const expected = { capability: { resource: "http", action: "get", target: "example.test" } };
    expect(lookupHttpCapability("https.get", url("https://example.test/x"))).toEqual(expected);
    expect(lookupHttpCapability("node:https.get", url("https://example.test/x"))).toEqual(expected);
  });

  it("answers a construction under both spellings", () => {
    expect(lookupConstructorEffect(constructorStubKey("net.Socket"), true)).toBe("network");
    expect(lookupConstructorEffect(constructorStubKey("node:net.Socket"), true)).toBe("network");
  });

  it("leaves a name no table answers exactly as the source spelled it", () => {
    // Canonicalizing a specifier nothing is keyed on would rename it in the
    // coverage histogram and answer no question. Both stay unanswered.
    expect(withNodePrefix("os.hostname")).toBe("os.hostname");
    expect(lookupStubEffect("os.hostname")).toBeUndefined();
    expect(lookupStubEffect("node:os.hostname")).toBeUndefined();
    // A bare identifier has no specifier at all.
    expect(withNodePrefix("fetch")).toBe("fetch");
    // A package that merely starts with a builtin's name is not that builtin.
    expect(withNodePrefix("fs-extra.writeFileSync")).toBe("fs-extra.writeFileSync");
    expect(lookupStubEffect("fs-extra.writeFileSync")).toBeUndefined();
  });

  it("covers every `node:` key the bundled tables hold", async () => {
    // The prefixable set is enumerated, so a table that grows a row for a
    // builtin outside it would be answerable under one spelling only. This is
    // the check that makes the enumeration safe to keep.
    const sources = await Promise.all(
      ["node-builtins.ts", "http-capabilities.ts", "constructors.ts"].map((file) =>
        fs.readFile(path.join(STUBS_DIR, file), "utf8"),
      ),
    );
    const keys = new Set(
      sources.flatMap((s) => [...s.matchAll(/\["(?:new )?node:([^"]+)"/g)]).map((m) => m[1] ?? ""),
    );
    expect(keys.size).toBeGreaterThan(0);
    for (const key of keys) {
      expect(withNodePrefix(key)).toBe(`node:${key}`);
    }
  });
});

describe("ky", () => {
  it("carries `network` on the request methods and on the bare call", () => {
    for (const name of [
      "ky.default",
      "ky.get",
      "ky.post",
      "ky.put",
      "ky.patch",
      "ky.delete",
      "ky.head",
    ]) {
      expect(lookupStubEffect(name)).toBe("network");
    }
  });

  it("says nothing about the methods that build an instance instead of sending", () => {
    // `create` / `extend` return a new `KyInstance`. No row, so `unknown` —
    // never "no effect" (DESIGN.md §3.4).
    expect(lookupStubEffect("ky.create")).toBeUndefined();
    expect(lookupStubEffect("ky.extend")).toBeUndefined();
    expect(lookupHttpCapability("ky.extend", url("https://example.test"))).toBeUndefined();
  });

  it("takes the method from the verb, not from the options object", () => {
    // ky merges `{method}` last, so `ky.post(url, {method: "get"})` still
    // POSTs — reading the option here would grant a capability the call does
    // not require.
    expect(lookupHttpCapability("ky.post", [{ text: "https://example.test/x", complete: true }])) //
      .toEqual({ capability: { resource: "http", action: "post", target: "example.test" } });
    expect(
      lookupHttpCapability("ky.post", [
        { text: "https://example.test/x", complete: true },
        { properties: new Map([["method", "get"]]) },
      ]),
    ).toEqual({ capability: { resource: "http", action: "post", target: "example.test" } });
  });

  it("takes the method from the options object for the bare call, as `fetch` does", () => {
    expect(
      lookupHttpCapability("ky.default", [
        { text: "https://example.test/x", complete: true },
        { properties: new Map([["method", "PUT"]]) },
      ]),
    ).toEqual({ capability: { resource: "http", action: "put", target: "example.test" } });
    expect(lookupHttpCapability("ky.default", url("https://example.test/x"))).toEqual({
      capability: { resource: "http", action: "get", target: "example.test" },
    });
  });

  it("reports a target only the runtime can match rather than no requirement", () => {
    expect(lookupHttpCapability("ky.get", undefined)).toEqual({ targetUnknown: true });
  });
});

describe("end to end on test/fixtures/node-builtin-specifier", () => {
  it("reports the same effect for each pair of spellings", async () => {
    const diagnostics = await diagnoseFixture();
    const pairs = [
      ["writesThroughUnprefixedImport", "writesThroughPrefixedImport", "fs_write"],
      ["readsThroughUnprefixedDefaultImport", "readsThroughPrefixedDefaultImport", "fs_read"],
      ["readsThroughUnprefixedSubpath", "readsThroughPrefixedSubpath", "fs_read"],
      ["spawnsThroughUnprefixedImport", "spawnsThroughPrefixedImport", "process"],
      ["constructsThroughUnprefixedImport", "constructsThroughPrefixedImport", "network"],
    ] as const;
    for (const [unprefixed, prefixed, effect] of pairs) {
      const one = forFunction(diagnostics, unprefixed);
      const other = forFunction(diagnostics, prefixed);
      expect(one?.id, unprefixed).toBe("AMB-E001");
      expect(observedEffects(one), unprefixed).toEqual([effect]);
      expect(observedEffects(one), unprefixed).toEqual(observedEffects(other));
    }
  });

  it("still reports a builtin no table covers as unknown under either spelling", async () => {
    // `node:os` has no row, so the verdict does not change with the spelling —
    // it is `unknown` both ways, which AMB-W001 reports against the `pure`
    // declaration.
    const diagnostics = await diagnoseFixture();
    expect(forFunction(diagnostics, "readsEnvironmentThroughUnprefixedImport")?.id).toBe(
      "AMB-W001",
    );
  });
});

describe("end to end on test/fixtures/http-clients", () => {
  // `ky` is declared locally there rather than installed: a call is keyed on
  // the module specifier and the export name, so the two spell the same key.
  it("names a request method and reads its verb, not its options", async () => {
    expect(await callsOf(HTTP_CLIENT_ROOT, "postsThroughRequestMethod")).toContainEqual(
      expect.objectContaining({
        kind: "stub",
        qualifiedName: "ky.post",
        effects: ["network"],
        requiredCapability: { resource: "http", action: "post", target: "api.example.test" },
      }),
    );
  });

  it("names the bare call by the default export it is, and reads its options", async () => {
    // A default export has no name of its own, so the key is `<specifier>.default`.
    expect(await callsOf(HTTP_CLIENT_ROOT, "postsThroughBareCall")).toContainEqual(
      expect.objectContaining({
        kind: "stub",
        qualifiedName: "ky.default",
        effects: ["network"],
        requiredCapability: { resource: "http", action: "post", target: "api.example.test" },
      }),
    );
  });

  it("leaves the instance-building method unresolved rather than effect-free", async () => {
    expect(await callsOf(HTTP_CLIENT_ROOT, "buildsInstance")).toContainEqual(
      expect.objectContaining({ kind: "unresolved", qualifiedName: "ky.extend" }),
    );
  });
});
