import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { DoctorCheck, DoctorReport } from "../contracts/service.js";
import { isDockerAvailable } from "../runner/sandbox.js";
import { scanStaleWorktrees } from "../runner/worktrees.js";
import { loadWorkspaceProfile } from "../profiles/index.js";
import { loadConfig } from "../runner/config.js";
import { listInstalledPlugins } from "../plugins/registry.js";
import { getGlobalSecretsPath } from "../runner/secrets.js";
import { validateWorkspacePath } from "../runner/workspaces.js";
import { StateIndex } from "../state/index.js";

export async function runDoctor(options: {
  rootDir: string;
  runsDir: string;
  workspaceId?: string;
  repoPath?: string;
}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  const dockerAvailable = await isDockerAvailable();
  checks.push({
    id: "docker",
    label: "Docker Runtime",
    ok: dockerAvailable,
    severity: dockerAvailable ? "info" : "warn",
    summary: dockerAvailable ? "Docker is available for sandboxed runs." : "Docker not available; sandboxed runs will fall back to local execution."
  });

  const playwrightCheck = await inspectPlaywright();
  checks.push(playwrightCheck);

  const staleWorktrees = await scanStaleWorktrees(options.runsDir);
  checks.push({
    id: "worktrees",
    label: "Worktree Hygiene",
    ok: staleWorktrees.length === 0,
    severity: staleWorktrees.length === 0 ? "info" : "warn",
    summary: staleWorktrees.length === 0 ? "No stale worktrees detected." : `${staleWorktrees.length} stale worktree(s) detected.`,
    details: staleWorktrees.slice(0, 10).map((entry) => `${entry.workspaceId}/${entry.runId}: ${entry.reason}`)
  });

  const corruptedRuns = await inspectRunMetadata(options.runsDir);
  checks.push({
    id: "runs",
    label: "Run Metadata",
    ok: corruptedRuns.length === 0,
    severity: corruptedRuns.length === 0 ? "info" : "error",
    summary: corruptedRuns.length === 0 ? "All scanned run metadata parsed successfully." : `${corruptedRuns.length} run metadata file(s) are corrupted.`,
    details: corruptedRuns.slice(0, 10)
  });

  const plugins = await listInstalledPlugins().catch(() => []);
  const brokenPlugins = plugins.filter((plugin) => !fsSync.existsSync(plugin.path));
  checks.push({
    id: "plugins",
    label: "Plugin Registry",
    ok: brokenPlugins.length === 0,
    severity: brokenPlugins.length === 0 ? "info" : "warn",
    summary: brokenPlugins.length === 0 ? "Installed plugins resolve cleanly." : `${brokenPlugins.length} plugin path(s) are missing.`,
    details: brokenPlugins.map((plugin) => plugin.name)
  });

  const keytarAvailable = await import("keytar").then(() => true).catch(() => false);
  const encryptedStore = fsSync.existsSync(getGlobalSecretsPath());
  checks.push({
    id: "secrets",
    label: "Secrets Backend",
    ok: keytarAvailable || encryptedStore,
    severity: keytarAvailable || encryptedStore ? "info" : "warn",
    summary: keytarAvailable
      ? "OS keychain backend is available."
      : encryptedStore
        ? "Encrypted secrets store detected; passphrase-backed secrets are available."
        : "Neither keytar nor an encrypted secrets store is available yet.",
    details: encryptedStore ? [getGlobalSecretsPath()] : undefined
  });

  if (options.repoPath) {
    checks.push(await inspectWorkspaceConfig(options.repoPath));
  }

  const stateIndex = new StateIndex({
    rootDir: options.rootDir,
    runsDir: options.runsDir
  });
  const indexHealth = await stateIndex.init();
  checks.push({
    id: "state-index",
    label: "SQLite Secondary Index",
    ok: indexHealth.ok,
    severity: indexHealth.ok ? (indexHealth.rebuilt ? "warn" : "info") : "error",
    summary: indexHealth.ok
      ? (indexHealth.rebuilt ? "State index was rebuilt successfully." : "State index is healthy.")
      : "State index failed to initialize.",
    details: [indexHealth.path, ...(indexHealth.error ? [indexHealth.error] : [])]
  });

  const errorCount = checks.filter((check) => check.severity === "error" && !check.ok).length;
  const warnCount = checks.filter((check) => check.severity === "warn" && !check.ok).length;
  return {
    generatedAt: new Date().toISOString(),
    rootDir: options.rootDir,
    runsDir: options.runsDir,
    workspaceId: options.workspaceId,
    checks,
    summary: {
      ok: errorCount === 0,
      warnCount,
      errorCount
    }
  };
}

async function inspectPlaywright(): Promise<DoctorCheck> {
  try {
    const mod = await import("playwright");
    const resolved = (mod as any).default ?? mod;
    const executable = resolved?.chromium?.executablePath?.();
    const hasExecutable = typeof executable === "string" && executable.length > 0 && fsSync.existsSync(executable);
    return {
      id: "playwright",
      label: "Playwright Browsers",
      ok: hasExecutable,
      severity: hasExecutable ? "info" : "warn",
      summary: hasExecutable ? "Playwright chromium binary is installed." : "Playwright is present but chromium binaries are missing.",
      details: executable ? [executable] : undefined
    };
  } catch {
    return {
      id: "playwright",
      label: "Playwright Browsers",
      ok: false,
      severity: "warn",
      summary: "Playwright is not installed.",
      details: ["Install browsers with: npx playwright install chromium"]
    };
  }
}

async function inspectRunMetadata(runsDir: string): Promise<string[]> {
  const corrupted: string[] = [];
  const workspaceDirs = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  for (const workspaceDir of workspaceDirs) {
    if (!workspaceDir.isDirectory()) continue;
    const workspacePath = path.join(runsDir, workspaceDir.name);
    const entries = await fs.readdir(workspacePath, { withFileTypes: true }).catch(() => []);
    if (fsSync.existsSync(path.join(workspacePath, "run.json"))) {
      const ok = await parseRunJson(path.join(workspacePath, "run.json"));
      if (!ok) corrupted.push(path.join(workspacePath, "run.json"));
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runMetaPath = path.join(workspacePath, entry.name, "run.json");
      if (!(await parseRunJson(runMetaPath))) corrupted.push(runMetaPath);
    }
  }
  return corrupted;
}

async function inspectWorkspaceConfig(repoPath: string): Promise<DoctorCheck> {
  const validation = await validateWorkspacePath(repoPath);
  const profile = await loadWorkspaceProfile(repoPath).catch(() => null);
  const config = await loadConfig(repoPath).catch(() => null);
  const details: string[] = [];
  let ok = true;
  let severity: DoctorCheck["severity"] = "info";
  let summary = "Workspace profile and config look compatible.";

  if (!validation.exists || !validation.isDirectory || !validation.readable) {
    ok = false;
    severity = "error";
    summary = validation.error ?? "Workspace path is invalid.";
  }

  if (profile?.execution_mode === "worktree" && !validation.isGitRepo) {
    ok = false;
    severity = "error";
    summary = "Worktree execution is enabled for a non-git workspace.";
  }

  if (profile?.browser_base_url && !/^https?:\/\//i.test(profile.browser_base_url)) {
    ok = false;
    severity = "error";
    summary = "browser_base_url must be an absolute http(s) URL.";
  }

  if (config?.governance?.enabled && !config.governance.quality_gate) {
    details.push("Governance is enabled without quality gate. This is allowed but less strict.");
    if (ok) {
      severity = "warn";
      summary = "Governance is enabled with partial protections.";
    }
  }

  return {
    id: "workspace-config",
    label: "Workspace Config",
    ok,
    severity,
    summary,
    details: details.length > 0 ? details : undefined
  };
}

async function parseRunJson(filePath: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}
