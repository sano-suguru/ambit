import { Client } from "widget-store";

/** A client the class constructs into a field of its own. */
export class FieldHolder {
  private client = new Client();

  read(): string | undefined {
    return this.client.read("k");
  }
}
