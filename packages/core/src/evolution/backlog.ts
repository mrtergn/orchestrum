import fs from "node:fs/promises";
import path from "node:path";
import { writeJson } from "../runner/fs.js";
import { getWorkspaceControlDir } from "../runner/control.js";

export type Opportunity = {
  id: string;
  title: string;
  description: string;
  riskScore: number;
  createdAt: string;
};

export async function generateOpportunities(options: {
  workspacePath: string;
  repoPath: string;
  memorySummaries: string[];
}): Promise<Opportunity[]> {
  const opportunities: Opportunity[] = [];
  const pkgPath = path.join(options.repoPath, "package.json");
  const readmePath = path.join(options.repoPath, "README.md");

  const pkg = await fs.readFile(pkgPath, "utf8").catch(() => "");
  const hasTests = pkg.includes("\"test\"") || pkg.includes("'test'");
  const readmeExists = await fs.stat(readmePath).then((s) => s.isFile()).catch(() => false);

  if (!hasTests) {
    opportunities.push({
      id: "tests-missing",
      title: "Add Automated Tests",
      description: "Introduce a baseline test suite and CI script to improve reliability.",
      riskScore: 0.3,
      createdAt: new Date().toISOString()
    });
  }

  if (!readmeExists) {
    opportunities.push({
      id: "readme-missing",
      title: "Add README",
      description: "Create a README with setup, usage, and contribution guidelines.",
      riskScore: 0.2,
      createdAt: new Date().toISOString()
    });
  }

  if (options.memorySummaries.length > 0) {
    opportunities.push({
      id: "memory-review",
      title: "Review Recent Runs",
      description: "Assess recent run summaries to identify recurring issues or opportunities.",
      riskScore: 0.4,
      createdAt: new Date().toISOString()
    });
  }

  opportunities.push({
    id: "performance-scan",
    title: "Performance Scan",
    description: "Profile hot paths and check for obvious performance bottlenecks.",
    riskScore: 0.5,
    createdAt: new Date().toISOString()
  });

  opportunities.push({
    id: "refactor-candidate",
    title: "Refactor Opportunities",
    description: "Identify areas with high complexity and propose refactors.",
    riskScore: 0.4,
    createdAt: new Date().toISOString()
  });

  await saveOpportunities(options.workspacePath, opportunities);
  return opportunities;
}

export async function loadOpportunities(workspacePath: string): Promise<Opportunity[]> {
  const filePath = path.join(getWorkspaceControlDir(workspacePath), "opportunities.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Opportunity[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function saveOpportunities(workspacePath: string, opportunities: Opportunity[]): Promise<void> {
  const controlDir = getWorkspaceControlDir(workspacePath);
  await fs.mkdir(controlDir, { recursive: true });
  await writeJson(path.join(controlDir, "opportunities.json"), opportunities);
}
