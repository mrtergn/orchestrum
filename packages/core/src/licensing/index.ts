import path from "node:path";
import { getAppHome } from "../appHome.js";

export type LicenseTier = "Free" | "Pro" | "Studio";
export type LicenseFeature =
  | "multi_workspace"
  | "arbitration"
  | "roadmap"
  | "analytics"
  | "cluster"
  | "plugins"
  | "strategy_evolution"
  | "tournament"
  | "advanced_sandbox";

export type LicensePayload = {
  key: string;
  tier: LicenseTier;
  issuedAt: string;
  expiresAt?: string | null;
};

export type LicenseFile = {
  payload: LicensePayload;
  signature: string;
};

export type LicenseStatus = {
  key: string | null;
  tier: LicenseTier;
  valid: boolean;
  expired: boolean;
  expiresAt?: string | null;
  reason?: string;
};

const LICENSE_PATH = path.join(getAppHome(), "license.json");
const OPEN_STATUS: LicenseStatus = {
  key: null,
  tier: "Free",
  valid: true,
  expired: false,
  expiresAt: null
};

export function getLicensePath(): string {
  return LICENSE_PATH;
}

export async function loadLicense(): Promise<LicenseFile | null> {
  return null;
}

export function verifyLicense(_license: LicenseFile): LicenseStatus {
  return { ...OPEN_STATUS };
}

export async function activateLicense(): Promise<LicenseStatus> {
  return { ...OPEN_STATUS };
}

export async function deactivateLicense(): Promise<void> {
  return;
}

export async function getLicenseStatus(): Promise<LicenseStatus> {
  return { ...OPEN_STATUS };
}

export function isFeatureAllowed(_tier: LicenseTier, _feature: LicenseFeature): boolean {
  return true;
}

export function enforceFeature(_tier: LicenseTier, _feature: LicenseFeature): void {
  return;
}
