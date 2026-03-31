import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

export const APP_HOME = path.join(os.homedir(), ".orchestrum");

export function getAppHome(): string {
  if (fsSync.existsSync(APP_HOME)) return APP_HOME;
  return APP_HOME;
}
