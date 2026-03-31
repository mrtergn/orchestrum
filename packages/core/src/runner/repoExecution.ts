import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { loadConfig, type OrchestrumConfig } from "./config.js";
import { ensureDir, writeJson, writeText } from "./fs.js";
import { runCommands } from "./commands.js";
import type { RepoExecutionProfile, ValidationState } from "./types.js";

export const VALIDATION_COMMAND_ORDER = ["typecheck", "test", "lint", "build", "smoke"] as const;
export type ValidationCommandName = typeof VALIDATION_COMMAND_ORDER[number];

export type RepoExecutionResolved = Required<Pick<RepoExecutionProfile, "package_manager">> & RepoExecutionProfile;

export async function loadRepoExecutionProfile(
  repoPath: string,
  config?: OrchestrumConfig | null
): Promise<RepoExecutionResolved> {
  const effectiveConfig = config ?? await loadConfig(repoPath).catch(() => null);
  const repoExecution = effectiveConfig?.repo_execution ?? {};
  return {
    ...repoExecution,
    package_manager: repoExecution.package_manager ?? detectPackageManager(repoPath)
  };
}

export async function resolveValidationCommands(
  repoPath: string,
  config?: OrchestrumConfig | null,
  includeSmoke = true
): Promise<Array<{ name: ValidationCommandName; command: string }>> {
  const repoExecution = await loadRepoExecutionProfile(repoPath, config);
  const commands = repoExecution.commands ?? {};
  const fallback = buildFallbackCommandMap(repoPath, repoExecution.package_manager);
  const resolved: Array<{ name: ValidationCommandName; command: string }> = [];
  for (const name of VALIDATION_COMMAND_ORDER) {
    if (name === "smoke" && !includeSmoke) continue;
    const command = commands[name] ?? fallback[name];
    if (command?.trim()) {
      resolved.push({ name, command: command.trim() });
    }
  }
  return resolved;
}

export async function runValidationSuite(options: {
  repoPath: string;
  stepDir: string;
  config?: OrchestrumConfig | null;
  includeSmoke?: boolean;
}): Promise<ValidationState> {
  const commands = await resolveValidationCommands(options.repoPath, options.config, options.includeSmoke ?? true);
  if (commands.length === 0) {
    return {
      status: "unavailable",
      commands: [],
      results: [],
      summary: "No validation commands are configured or discoverable for this workspace.",
      attemptedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    };
  }

  const attemptedAt = new Date().toISOString();
  const validationDir = path.join(options.stepDir, "validation");
  await ensureDir(validationDir);
  const results: ValidationState["results"] = [];

  for (const [index, entry] of commands.entries()) {
    const logName = `${index + 1}-${entry.name}.log`;
    const logPath = path.join(validationDir, logName);
    await writeText(logPath, "");
    const [result] = await runCommands({
      commands: [entry.command],
      cwd: options.repoPath,
      logFile: logPath
    });
    const raw = await fs.readFile(logPath, "utf8").catch(() => "");
    const { stdout, stderr } = splitCommandLog(raw);
    const stdoutName = `${index + 1}-${entry.name}.stdout.txt`;
    const stderrName = `${index + 1}-${entry.name}.stderr.txt`;
    await writeText(path.join(validationDir, stdoutName), stdout);
    await writeText(path.join(validationDir, stderrName), stderr);
    results.push({
      command: entry.command,
      ok: result?.ok ?? false,
      exitCode: result?.exitCode ?? null,
      logPath: path.relative(options.stepDir, logPath),
      summary: result?.ok
        ? `${entry.name} passed.`
        : `${entry.name} failed with exit code ${result?.exitCode ?? -1}.`
    });
  }

  const status = results.every((item) => item.ok) ? "passed" : "failed";
  const completedAt = new Date().toISOString();
  const summary = results.map((item) => `${item.ok ? "PASS" : "FAIL"} ${item.command}`).join("\n");
  await writeJson(path.join(validationDir, "summary.json"), {
    status,
    commands: results
  });

  return {
    status,
    commands: results.map((item) => item.command),
    results,
    summary,
    attemptedAt,
    completedAt
  };
}

export function detectPackageManager(repoPath: string): "pnpm" | "yarn" | "npm" {
  if (fsSync.existsSync(path.join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  if (fsSync.existsSync(path.join(repoPath, "yarn.lock"))) return "yarn";
  return "npm";
}

function buildFallbackCommandMap(
  repoPath: string,
  packageManager: "npm" | "pnpm" | "yarn"
): Partial<Record<ValidationCommandName, string>> {
  const packageJsonPath = path.join(repoPath, "package.json");
  const pkg = fsSync.existsSync(packageJsonPath)
    ? JSON.parse(fsSync.readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, string> }
    : {};
  const scripts = pkg.scripts ?? {};
  const commandFor = (name: string) => scripts[name] ? `${packageManager} run ${name}` : undefined;
  return {
    lint: commandFor("lint"),
    typecheck: commandFor("typecheck"),
    test: commandFor("test"),
    build: commandFor("build"),
    smoke: commandFor("smoke")
  };
}

function splitCommandLog(raw: string): { stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("[stderr] ")) stderr.push(line.slice("[stderr] ".length));
    else stdout.push(line);
  }
  return {
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n")
  };
}
