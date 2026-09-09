// Regression fixture for DESIGN.md §3.4: before constructions were recorded,
// `new X(...)` was dropped from the call graph entirely — a `pure` function
// that constructed a networking client reported no call at all, not even
// `unknown`. Every case below must produce a call site.

class HttpClient {
  constructor(url: string) {
    void fetch(url);
  }
}

/** A derived class runs its base constructor even with no constructor of its own. */
class DerivedClient extends HttpClient {}

/** A class with no constructor still runs its property initializers. */
class EagerFields {
  readonly response = fetch("https://example.test");
}

/** An explicit constructor's `super(...)` reaches the base's effects. */
class ExplicitSuper extends HttpClient {
  constructor() {
    super("https://example.test");
  }
}

/** @effects pure */
export function constructsDirectly(): HttpClient {
  return new HttpClient("https://example.test");
}

/** @effects pure */
export function constructsDerived(): DerivedClient {
  return new DerivedClient("https://example.test");
}

/** @effects pure */
export function constructsFieldInitializer(): EagerFields {
  return new EagerFields();
}

/** @effects pure */
export function constructsExplicitSuper(): ExplicitSuper {
  return new ExplicitSuper();
}

/** @effects network */
export function declaresNetworkForConstruction(): HttpClient {
  return new HttpClient("https://example.test");
}

/** @effects pure */
export function constructsPureBuiltin(): Map<string, number> {
  return new Map<string, number>();
}

/** `new Date()` reads the clock; `env` in DESIGN.md §4.2. */
/** @effects pure */
export function readsClock(): Date {
  return new Date();
}

/** `new Date(y, m, d)` only converts its arguments. */
/** @effects pure */
export function fixedDate(): Date {
  return new Date(2020, 0, 1);
}

/** An anonymous class has no stable declaration path, so it stays `unknown`. */
/** @effects pure */
export function constructsAnonymousClass(): object {
  return new (class {})();
}

/** A constructor can carry its own contract. */
class Declared {
  /** @effects network */
  constructor() {
    void fetch("https://example.test");
  }
}

/** @effects pure */
export function constructsDeclared(): Declared {
  return new Declared();
}

/**
 * A class of arrow-shaped methods. Constructing it creates the closures; it
 * does not run them. Attributing their bodies to the constructor would make
 * every `new Controller()` in an Express/Nest-style codebase look like it hit
 * the network.
 */
class Controller {
  handle = async (): Promise<Response> => fetch("https://example.test");
  readonly label = "controller";
}

/** @effects pure */
export function constructsController(): Controller {
  return new Controller();
}

/** @effects pure */
export async function callsArrowMethod(): Promise<Response> {
  return new Controller().handle();
}
