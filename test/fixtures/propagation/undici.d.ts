// Ambient stand-in for the real `undici` package's types. undici is not a
// dependency of this repo and is not in node_modules — this lets the alias
// resolve (unlike the "module not installed" case) without adding a real
// devDependency, so `qualifiedNameOf` qualifies the named import by module
// specifier instead of falling back to the bare identifier text.
declare module "undici" {
  export function fetch(input: string): Promise<unknown>;
}
