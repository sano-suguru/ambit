import { doesNotExist } from "./no-such-file.ts";

export function callsMissingModuleImport(): void {
  doesNotExist();
}
