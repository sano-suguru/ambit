// Object-literal members the backend deliberately does NOT index, so
// `object-literal-method` stays a live `SkippedFunctionKind` after
// identifier-named members of module-scope literals became indexable.
//
// Computed, string and numeric keys have no stable declaration-path spelling
// (the path is "."-joined, so `{ "a.b": … }` would be indistinguishable from
// nesting — DESIGN.md §5.3). Literals that are not a module-scope `const`'s
// own initializer have no declaration path to hang a member off at all.

export const computedKey = {
  // biome-ignore lint/complexity/useLiteralKeys: a computed name is the point
  ["computed"]: (): number => 1,
};

export const stringKey = {
  "a-b"(): number {
    return 1;
  },
};

export const numericKey = {
  0: (): number => 1,
};

export const nestedLiteral = {
  inner: {
    method(): number {
      return 1;
    },
  },
};

export function literalInFunctionBody(): number {
  const local = {
    method(): number {
      return 1;
    },
  };
  return local.method();
}

export function literalInArgumentPosition(): number {
  return apply({
    method(): number {
      return 1;
    },
  });
}

export function literalInReturnPosition(): { method(): number } {
  return {
    method(): number {
      return 1;
    },
  };
}

function apply(handler: { method(): number }): number {
  return handler.method();
}
