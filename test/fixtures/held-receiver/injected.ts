import type { Client } from "widget-store";

/** The dependency-injection shape: the client arrives from outside. */
export class InjectedHolder {
  private client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  read(): string | undefined {
    return this.client.read("k");
  }
}
