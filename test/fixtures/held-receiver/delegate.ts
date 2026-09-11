import type { Hub } from "widget-store";

/** The root-most named receiver wins, so the key keeps the client's own shape. */
export class DelegateHolder {
  private hub: Hub;

  constructor(hub: Hub) {
    this.hub = hub;
  }

  async list(): Promise<string[]> {
    return this.hub.users.findMany();
  }
}
