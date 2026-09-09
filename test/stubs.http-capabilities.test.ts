import { describe, expect, it } from "vitest";
import type { LiteralArgument } from "../src/core/index.ts";
import { lookupHttpCapability } from "../src/stubs/http-capabilities.ts";

/**
 * DESIGN.md §4.4's static half: which `http:<method>:<host>` a call requires,
 * read from the source. The rule these tests exist to hold is the negative
 * one — a target the source does not fix must come back `targetUnknown`, never
 * as a host guessed from a prefix.
 */

function url(text: string, complete = true): readonly (LiteralArgument | undefined)[] {
  return [{ text, complete }];
}

describe("lookupHttpCapability", () => {
  it("knows nothing about an operation with no rule", () => {
    expect(lookupHttpCapability("node:fs.readFileSync", url("/etc/passwd"))).toBeUndefined();
    expect(lookupHttpCapability("pg.Pool.query", url("SELECT 1"))).toBeUndefined();
  });

  it("reads the host from a literal URL, defaulting the action to get", () => {
    expect(lookupHttpCapability("fetch", url("https://api.example.com/rates"))).toEqual({
      capability: { resource: "http", action: "get", target: "api.example.com" },
    });
  });

  it("reads the method from an options object literal", () => {
    expect(
      lookupHttpCapability("fetch", [
        { text: "https://api.example.com/orders", complete: true },
        { properties: new Map([["method", "POST"]]) },
      ]),
    ).toEqual({
      capability: { resource: "http", action: "post", target: "api.example.com" },
    });
  });

  it("reads the host from a template literal whose static head ends the authority", () => {
    expect(lookupHttpCapability("fetch", url("https://api.example.com/rates/", false))).toEqual({
      capability: { resource: "http", action: "get", target: "api.example.com" },
    });
  });

  it("refuses a host the static head only starts", () => {
    // `https://api.${env}.example.com/` must not be read as `api.` — a prefix
    // match would name a target the author never granted.
    expect(lookupHttpCapability("fetch", url("https://api.", false))).toEqual({
      targetUnknown: true,
    });
    expect(lookupHttpCapability("fetch", url("https://", false))).toEqual({ targetUnknown: true });
  });

  it("accepts a complete literal with no path", () => {
    expect(lookupHttpCapability("fetch", url("https://api.example.com"))).toEqual({
      capability: { resource: "http", action: "get", target: "api.example.com" },
    });
  });

  it("keeps the port as written, matching §4.4's own `http:get:localhost:8080` spelling", () => {
    expect(lookupHttpCapability("fetch", url("http://localhost:8080/health"))).toEqual({
      capability: { resource: "http", action: "get", target: "localhost:8080" },
    });
  });

  it("drops userinfo and lowercases the host", () => {
    expect(lookupHttpCapability("fetch", url("https://user:pw@API.Example.COM/x"))).toEqual({
      capability: { resource: "http", action: "get", target: "api.example.com" },
    });
  });

  it("reports an unknown target for a URL the source does not fix", () => {
    expect(lookupHttpCapability("fetch", undefined)).toEqual({ targetUnknown: true });
    expect(lookupHttpCapability("fetch", [undefined])).toEqual({ targetUnknown: true });
    // A relative URL names no host at all: where it goes is decided elsewhere.
    expect(lookupHttpCapability("fetch", url("/v1/rates"))).toEqual({ targetUnknown: true });
  });

  it("covers the node:http/https entry points as well as fetch", () => {
    expect(lookupHttpCapability("node:https.get", url("https://api.example.com/x"))).toEqual({
      capability: { resource: "http", action: "get", target: "api.example.com" },
    });
    expect(
      lookupHttpCapability("node:http.request", [
        { text: "http://api.example.com/x", complete: true },
        { properties: new Map([["method", "DELETE"]]) },
      ]),
    ).toEqual({
      capability: { resource: "http", action: "delete", target: "api.example.com" },
    });
  });
});
