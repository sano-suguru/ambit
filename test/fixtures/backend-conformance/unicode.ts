// Position reporting across non-ASCII text (§3.5 gate 1, 「Unicode の位置」).
//
// Three widths disagree here, and a diagnostic that quotes the wrong one points
// at the wrong column: "日本語" is 3 UTF-16 code units and 9 UTF-8 bytes; "🎯"
// is 1 code point, 2 UTF-16 code units and 4 UTF-8 bytes. `SourceLocation` is
// UTF-16 units, 1-based, end-exclusive — the same convention the compiler
// reports — so every assertion on this file is really an assertion that the
// backend did not hand back byte offsets or code-point counts.

/** @effects fs_read */
export function 日本語関数(): number {
  return 1;
}

const 絵文字 = "🎯🎯🎯";

/** @effects pure */
export function callsAfterNonAscii(): number {
  const label = `${絵文字}—ラベル`;
  return label.length + 日本語関数();
}

// The astral characters and the call are one statement, so no formatter can
// move them onto separate lines: the column of `日本語関数` here is only
// correct if the backend counted UTF-16 code units.
export function callsAfterAstralInSameLine(): number {
  return `🎯🎯`.length + 日本語関数();
}
