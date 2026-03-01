import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { gitChangedFiles } from "./git.js";

const PolicySchema = z.object({
  max_files_changed: z.number().int().min(1).optional(),
  forbidden_paths: z.array(z.string()).optional(),
  max_cost_usd: z.number().min(0).optional(),
  risk_tolerance: z.enum(["low", "medium", "high"]).optional()
});

export type PolicyConfig = z.infer<typeof PolicySchema>;

export async function loadPolicy(repoPath: string): Promise<PolicyConfig | null> {
  const primaryPath = path.join(repoPath, "orchestrum.policy.json");
  try {
    const raw = await fs.readFile(primaryPath, "utf8");
    const parsed = PolicySchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join("; ");
      throw new Error(`Invalid orchestrum.policy.json: ${message}`);
    }
    return parsed.data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function checkPatchPolicy(repoPath: string, policy: PolicyConfig | null): Promise<string | null> {
  if (!policy) return null;
  const changed = await gitChangedFiles(repoPath).catch(() => [] as string[]);
  if (policy.max_files_changed && changed.length > policy.max_files_changed) {
    return `Policy violation: ${changed.length} files changed (max ${policy.max_files_changed}).`;
  }
  if (policy.forbidden_paths && policy.forbidden_paths.length > 0) {
    const forbidden = policy.forbidden_paths.map((p) => normalizePath(p));
    const hit = changed.find((file) => forbidden.some((forbiddenPath) => file.startsWith(forbiddenPath)));
    if (hit) {
      return `Policy violation: forbidden path touched (${hit}).`;
    }
  }
  return null;
}

export function checkCostPolicy(totalCost: number, policy: PolicyConfig | null): string | null {
  if (!policy?.max_cost_usd) return null;
  if (totalCost > policy.max_cost_usd) {
    return `Policy violation: cost ${totalCost.toFixed(4)} exceeds max ${policy.max_cost_usd.toFixed(4)}.`;
  }
  return null;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\\\/g, "/").replace(/^\\.\//, "");
}
