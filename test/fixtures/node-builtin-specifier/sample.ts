// Node's builtins can be imported with or without the `node:` prefix, and both
// spellings reach the same module — a bare builtin specifier is resolved to the
// builtin before `node_modules` is consulted. Every case below is a pair: the
// same operation written both ways, which must reach the same verdict. Before
// `withNodePrefix` the un-prefixed half of each pair was `unknown`, so the same
// edit failed the check written one way and passed written the other (measured,
// E3b: docs/measurements/2026-09-11-third-party-diff-validation.md).
//
// `useNodejsImportProtocol` is off for this directory in `biome.json`: the
// un-prefixed spelling is the subject here, and formatting it away would
// delete what the test asserts.

import { execSync as prefixedExecSync } from "node:child_process";
import prefixedFs, { writeFileSync as prefixedWriteFileSync } from "node:fs";
import { readFile as prefixedReadFile } from "node:fs/promises";
import prefixedNet from "node:net";
import { execSync } from "child_process";
import unprefixedFs, { writeFileSync } from "fs";
import { readFile } from "fs/promises";
import unprefixedNet from "net";
import unprefixedOs from "os";

/** @effects pure */
export function writesThroughUnprefixedImport(): void {
  writeFileSync("out.txt", "x");
}

/** @effects pure */
export function writesThroughPrefixedImport(): void {
  prefixedWriteFileSync("out.txt", "x");
}

/** @effects pure */
export function readsThroughUnprefixedDefaultImport(): boolean {
  return unprefixedFs.existsSync("out.txt");
}

/** @effects pure */
export function readsThroughPrefixedDefaultImport(): boolean {
  return prefixedFs.existsSync("out.txt");
}

/** @effects pure */
export async function readsThroughUnprefixedSubpath(): Promise<Buffer> {
  return readFile("out.txt");
}

/** @effects pure */
export async function readsThroughPrefixedSubpath(): Promise<Buffer> {
  return prefixedReadFile("out.txt");
}

/** @effects pure */
export function spawnsThroughUnprefixedImport(): void {
  execSync("ls");
}

/** @effects pure */
export function spawnsThroughPrefixedImport(): void {
  prefixedExecSync("ls");
}

/** @effects pure */
export function constructsThroughUnprefixedImport(): unprefixedNet.Socket {
  return new unprefixedNet.Socket();
}

/** @effects pure */
export function constructsThroughPrefixedImport(): prefixedNet.Socket {
  return new prefixedNet.Socket();
}

/**
 * A builtin no bundled table has a row for stays `unknown` either way: the
 * prefix decides nothing, and neither does adding a canonical form for a
 * specifier nothing answers.
 */
/** @effects pure */
export function readsEnvironmentThroughUnprefixedImport(): string {
  return unprefixedOs.hostname();
}
