// Fixture for DESIGN.md §4.2, "Local mutation and `pure`": which in-place
// changes `pure` allows, and which are `state_write`.

const moduleTotals: number[] = [];

/** @effects pure */
export function localArrayPush(items: readonly number[]): number[] {
  const out: number[] = [];
  for (const item of items) out.push(item * 2);
  return out;
}

/** @effects pure */
export function localCollectionsInCallback(items: readonly number[]): Map<number, number> {
  const seen = new Map<number, number>();
  const unique = new Set<number>();
  items.map((item) => {
    seen.set(item, item);
    unique.add(item);
    return item;
  });
  const shaped: { count: number } = { count: 0 };
  shaped.count = seen.size + unique.size;
  return seen;
}

/** @effects pure */
export function mutatesParameter(items: number[]): void {
  items.push(1);
}

/** @effects pure */
export function assignsToParameter(target: { value: number }): void {
  target.value = 1;
}

/** @effects pure */
export function mutatesModuleScope(): void {
  moduleTotals.push(1);
}

export class Counter {
  private readonly hits: number[] = [];
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: the write through `this` is the fixture
  private count = 0;

  /** @effects pure */
  record(): void {
    this.hits.push(1);
    this.count++;
  }
}

/** @effects pure */
export function reassignsLooseLocal(): number[] {
  // §4.2 treats a `let` binding as escaping even when nothing reassigns it;
  // rewriting this as `const` would delete the case the test asserts.
  // biome-ignore lint/style/useConst: the `let` is the fixture
  let loose: number[] = [];
  loose.push(1);
  return loose;
}

/** @effects state_write */
export function declaresStateWrite(items: number[]): void {
  items.push(1);
}

/** @effects pure */
export function sortsLocalWithOpaqueComparator(
  items: readonly number[],
  compare: (a: number, b: number) => number,
): number[] {
  const copy = [...items];
  copy.sort(compare);
  return copy;
}

export class Point {
  readonly x: number;

  /** @effects pure */
  constructor(x: number) {
    this.x = x;
  }
}

export class Shifted extends Point {
  readonly offset: number;

  /** @effects pure */
  constructor(x: number, offset: number) {
    super(x);
    this.offset = offset;
  }
}

/** @effects pure */
export function destructuresIntoLocals(pair: readonly [number, number]): number {
  let first = 0;
  let second = 0;
  [first, second] = pair;
  return first + second;
}

/** @effects pure */
export function destructuresIntoParameter(target: { value: number }, pair: [number]): void {
  [target.value] = pair;
}
