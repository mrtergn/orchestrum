import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

const NEW_HOME = path.join(os.homedir(), ".orchestrum");
const LEGACY_HOME = path.join(os.homedir(), ".orchestrum");

export function getAppHome(): string {
  if (fsSync.existsSync(NEW_HOME)) return NEW_HOME;
  if (fsSync.existsSync(LEGACY_HOME)) return LEGACY_HOME;
  return NEW_HOME;
}

export function getLegacyHome(): string {
  return LEGACY_HOME;
}

export function getNewHome(): string {
  return NEW_HOME;
}
