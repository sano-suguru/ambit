// Regression fixture: a parenthesis-less `new` — `new function () {}`, with
// no trailing `Arguments` list — leaves `NewExpression.arguments` `undefined`
// (unlike `CallExpression.arguments`, which is never optional). Must not
// crash `ambit check` while classifying skipped function-like nodes.

/** @effects pure */
export function makeThing(): unknown {
  // biome-ignore format: the formatter normalizes parenthesis-less `new` into
  // `new (fn)()`, which defeats this fixture's purpose (`arguments` becomes
  // `[]` instead of `undefined`) — see AGENTS.md on not weakening tests.
  const obj = new function (this: { value: number }) {
    this.value = 1;
  };
  return obj;
}
