import { createAnonymous } from "widget-store";

// An anonymous return type has no declared name, so there is nothing to key on.
const anonymous = createAnonymous();

export function callsAnonymousResult(): void {
  anonymous.run();
}
