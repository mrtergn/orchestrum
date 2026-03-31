import os from "node:os";
import path from "node:path";

export const APP_HOME = path.join(os.homedir(), ".orchestrum");

export function getAppHome(): string {
  const override = process.env.ORCHESTRUM_HOME?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".orchestrum");
}
