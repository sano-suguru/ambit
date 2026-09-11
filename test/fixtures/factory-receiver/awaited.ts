import { openHandle } from "widget-store";

const handle = await openHandle();

export function closesAwaitedHandle(): void {
  handle.close();
}
