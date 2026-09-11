import type { Client } from "widget-store";

/** The receiver of `del` is the result of two earlier calls, not a binding. */
export class ChainHolder {
  private client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  async purge(): Promise<void> {
    await this.client.table("widgets").where("stale").del();
  }
}
