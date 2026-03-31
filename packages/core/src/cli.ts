import { Command } from "commander";
import path from "path";
import { spawn, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fsSync from "node:fs";
import {
  runWorkflow,
  resumeWorkflow,
  cancelRun,
  replayRun,
  createBackup,
  restoreBackup,
  setSecret,
  unsetSecret,
  listSecrets,
  approveToken,
  applySecretsToEnv,
  writeCrashReport,
  exportDiagnostics,
  loadGlobalConfig,
  saveGlobalConfig,
  checkForUpdates,
  installUpdate,
  exportTemplate,
  importTemplate,
  listInstalledPlugins,
  installPlugin,
  removePlugin,
  setPluginEnabled,
  exportRunBundle,
  importRunBundle,
  getLicenseStatus,
  isFeatureAllowed,
  enforceFeature
} from "./index.js";
import { loadConfig } from "./runner/config.js";
import { addWorkspace, loadWorkspaces, findWorkspaceById, findWorkspaceByPath } from "./runner/workspaces.js";
import { startCiWatch } from "./orchestration/ci.js";
import { runExperiment } from "./orchestration/experiment.js";
import { simulateWorkflow } from "./orchestration/simulate.js";
import { evaluateWorkflow } from "./orchestration/evaluate.js";
import { runTournament } from "./orchestration/tournament.js";
import { runRoadmap } from "./roadmap/runner.js";
import { startCluster } from "./cluster/manager.js";

const program = new Command();

program
  .name("orchestrum")
  .description("Orchestrum workflow runner")
  .version("0.4.0");

program
  .command("run")
  .argument("[workflow]", "Path to workflow YAML (optional if orchestrum.config.json has defaultWorkflow)")
  .requiredOption("--repo <path>", "Target repo path")
  .option("--runs-dir <path>", "Runs directory (default: ./runs)")
  .option("--goal <text>", "User goal for the PM step")
  .option("--branch <name>", "Create or reset branch before running")
  .option("--workspace <id>", "Workspace ID to associate the run with")
  .option("--sandbox <mode>", "Sandbox mode (docker)")
  .option("--strategy <mode>", "Strategy mode override (aggressive|balanced|conservative)")
  .action(async (workflow, options) => {
    try {
      const repoPath = path.resolve(options.repo);
      const runsDir = options.runsDir
        ? path.resolve(options.runsDir)
        : path.resolve(process.cwd(), "runs");
      const goal = options.goal ?? "";

      let workflowPath: string | null = workflow ? path.resolve(workflow) : null;
      if (!workflowPath) {
        const config = await loadConfig(repoPath);
        if (!config?.defaultWorkflow) {
          throw new Error("No workflow provided and config has no defaultWorkflow");
        }
        workflowPath = path.resolve(repoPath, config.defaultWorkflow);
      }

      const workspaceId = await resolveWorkspaceId(repoPath, options.workspace);
      const sandbox = options.sandbox === "docker" ? "docker" : undefined;
      await applySecretsToEnv({
        names: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
        scope: workspaceId ? "workspace" : "global",
        repoPath,
        useKeychain: process.env.ORCHESTRUM_USE_KEYCHAIN === "1"
      });
      const ok = await runWorkflow({
        workflowPath,
        repoPath,
        runsDir,
        goal,
        branch: options.branch,
        workspaceId,
        sandbox,
        strategyMode: options.strategy
      });
      if (!ok) {
        process.exitCode = 1;
      }
    } catch (err) {
      await handleFatal(err);
    }
  });

program
  .command("resume")
  .argument("<runId>", "Run ID to resume")
  .requiredOption("--from <stepId>", "Step ID to resume from")
  .option("--runs-dir <path>", "Runs directory (default: ./runs)")
  .option("--workspace <id>", "Workspace ID (optional)")
  .action(async (runId, options) => {
    try {
      const runsDir = options.runsDir
        ? path.resolve(options.runsDir)
        : path.resolve(process.cwd(), "runs");
      const ok = await resumeWorkflow({
        runId,
        runsDir,
        fromStepId: options.from,
        workspaceId: options.workspace
      });
      if (!ok) {
        process.exitCode = 1;
      }
    } catch (err) {
      await handleFatal(err);
    }
  });

program
  .command("cancel")
  .argument("<runId>", "Run ID to cancel")
  .option("--runs-dir <path>", "Runs directory (default: ./runs)")
  .option("--workspace <id>", "Workspace ID (optional)")
  .action(async (runId, options) => {
    try {
      const runsDir = options.runsDir
        ? path.resolve(options.runsDir)
        : path.resolve(process.cwd(), "runs");
      await cancelRun(runsDir, runId, options.workspace);
    } catch (err) {
      await handleFatal(err);
    }
  });

program
  .command("replay")
  .argument("<runId>", "Run ID to replay")
  .option("--runs-dir <path>", "Runs directory (default: ./runs)")
  .option("--workspace <id>", "Workspace ID (optional)")
  .action(async (runId, options) => {
    try {
      const runsDir = options.runsDir
        ? path.resolve(options.runsDir)
        : path.resolve(process.cwd(), "runs");
      await replayRun({ runId, runsDir, workspaceId: options.workspace });
    } catch (err) {
      await handleFatal(err);
    }
  });

program
  .command("ui")
  .option("--port <n>", "UI port", (value) => Number(value), 3000)
  .option("--service-port <n>", "Service port", (value) => Number(value), 4137)
  .option("--prod", "Run in production mode")
  .action(async (options) => {
    try {
      await startUiWithService(options);
    } catch (err) {
      await handleFatal(err);
    }
  });

program
  .command("approve")
  .argument("<token>", "Approval token")
  .option("--runs-dir <path>", "Runs directory (default: ./runs)")
  .action(async (token, options) => {
    try {
      const runsDir = options.runsDir
        ? path.resolve(options.runsDir)
        : path.resolve(process.cwd(), "runs");
      const result = await approveToken(runsDir, token);
      if (!result) {
        console.error("Approval token not found.");
        process.exit(1);
      }
      console.log(`Approved ${result.runId}:${result.stepId}`);
    } catch (err) {
      await handleFatal(err);
    }
  });

const backupCmd = program.command("backup").description("Backup runs and memory");
backupCmd
  .command("create")
  .option("--runs-dir <path>", "Runs directory (default: ./runs)")
  .option("--output <path>", "Output directory (default: ./backups)")
  .action(async (options) => {
    try {
      const rootDir = process.cwd();
      const runsDir = options.runsDir ? path.resolve(options.runsDir) : path.resolve(rootDir, "runs");
      const archive = await createBackup({ rootDir, runsDir, outputDir: options.output });
      console.log(`Backup created: ${archive}`);
    } catch (err) {
      await handleFatal(err);
    }
  });

backupCmd
  .command("restore")
  .argument("<file>", "Backup archive")
  .option("--into <dir>", "Target directory", path.resolve)
  .action(async (file, options) => {
    try {
      const targetDir = options.into ? path.resolve(options.into) : process.cwd();
      await restoreBackup({ archivePath: path.resolve(file), targetDir });
      console.log(`Restored into ${targetDir}`);
    } catch (err) {
      await handleFatal(err);
    }
  });

const secretsCmd = program.command("secrets").description("Manage encrypted secrets");
secretsCmd
  .command("set")
  .argument("<name>", "Secret name")
  .option("--value <value>", "Secret value")
  .option("--keychain", "Store in OS keychain when available")
  .option("--scope <scope>", "global|workspace", "global")
  .option("--repo <path>", "Workspace repo path")
  .action(async (name, options) => {
    try {
      if (!options.value) {
        throw new Error("--value is required for secrets set");
      }
      await setSecret({
        name,
        value: options.value,
        scope: options.scope === "workspace" ? "workspace" : "global",
        repoPath: options.repo ? path.resolve(options.repo) : undefined,
        useKeychain: Boolean(options.keychain)
      });
      console.log(`Stored secret ${name}`);
    } catch (err) {
      await handleFatal(err);
    }
  });

secretsCmd
  .command("unset")
  .argument("<name>", "Secret name")
  .option("--keychain", "Remove from OS keychain when available")
  .option("--scope <scope>", "global|workspace", "global")
  .option("--repo <path>", "Workspace repo path")
  .action(async (name, options) => {
    try {
      await unsetSecret({
        name,
        scope: options.scope === "workspace" ? "workspace" : "global",
        repoPath: options.repo ? path.resolve(options.repo) : undefined,
        useKeychain: Boolean(options.keychain)
      });
      console.log(`Removed secret ${name}`);
    } catch (err) {
      await handleFatal(err);
    }
  });

secretsCmd
  .command("list")
  .option("--scope <scope>", "global|workspace", "global")
  .option("--repo <path>", "Workspace repo path")
  .action(async (options) => {
    try {
      const repoPath = options.repo ? path.resolve(options.repo) : undefined;
      const names = await listSecrets(options.scope === "workspace" ? "workspace" : "global", repoPath);
      if (names.length === 0) {
        console.log("No secrets stored.");
      } else {
        names.forEach((name) => console.log(name));
      }
    } catch (err) {
      await handleFatal(err);
    }
  });


const diagCmd = program.command("diagnostics").description("Diagnostics bundle");
diagCmd
  .command("export")
  .option("--run <id>", "Run ID")
  .option("--workspace <id>", "Workspace ID")
  .option("--runs-dir <path>", "Runs directory (default: ./runs)")
  .action(async (options) => {
    try {
      const rootDir = process.cwd();
      const runsDir = options.runsDir ? path.resolve(options.runsDir) : path.resolve(rootDir, "runs");
      const archive = await exportDiagnostics({
        rootDir,
        runsDir,
        workspaceId: options.workspace,
        runId: options.run
      });
      console.log(`Diagnostics bundle: ${archive}`);
    } catch (err) {
      await handleFatal(err);
    }
  });

const updateCmd = program.command("update").description("Manage local updates");

updateCmd
  .command("check")
  .option("--file <path>", "Path to version.json for update metadata")
  .option("--remote", "Check GitHub Releases and refresh the local update cache")
  .option("--repo <owner/name>", "Override the GitHub repository for update metadata")
  .action(async (options) => {
    try {
      const status = await checkForUpdates({
        rootDir: process.cwd(),
        sourcePath: options.file ? path.resolve(options.file) : undefined,
        remote: Boolean(options.remote),
        repo: options.repo ? String(options.repo) : undefined
      });
      if (!status.current) {
        console.log("Current version metadata missing.");
        return;
      }
      if (!status.available) {
        console.log("No update metadata found.");
        return;
      }
      console.log(`Current: ${status.current.version} (${status.current.channel})`);
      console.log(`Available: ${status.available.version} (${status.available.channel})`);
      if (status.available.releaseUrl) {
        console.log(`Release: ${status.available.releaseUrl}`);
      }
      if (status.selectedAsset?.name) {
        console.log(`Asset: ${status.selectedAsset.name}`);
      }
      if (status.updateAvailable) {
        console.log("Update available.");
      } else {
        console.log("Already up to date.");
      }
    } catch (err) {
      await handleFatal(err);
    }
  });

updateCmd
  .command("install")
  .argument("[file]", "Update package (.tar.gz)")
  .option("--remote", "Download the newest compatible release asset from GitHub Releases")
  .option("--repo <owner/name>", "Override the GitHub repository for update metadata")
  .action(async (file, options) => {
    try {
      if (!file && !options.remote) {
        throw new Error("Provide a local update archive or use --remote.");
      }

      if (options.remote) {
        const status = await checkForUpdates({
          rootDir: process.cwd(),
          remote: true,
          repo: options.repo ? String(options.repo) : undefined
        });
        if (!status.available || !status.updateAvailable) {
          console.log(status.reason ?? "No update available.");
          return;
        }
        if (!status.selectedAsset) {
          throw new Error("No installable archive asset found for this platform.");
        }
        const result = await installUpdate({
          downloadUrl: status.selectedAsset.url,
          expectedSha256: status.selectedAsset.sha256,
          assetName: status.selectedAsset.name,
          targetDir: process.cwd()
        });
        console.log(`Installed ${status.available.version}. Files updated: ${result.updatedFiles}`);
        return;
      }

      const result = await installUpdate({
        archivePath: path.resolve(file),
        targetDir: process.cwd()
      });
      console.log(`Installed update. Files updated: ${result.updatedFiles}`);
    } catch (err) {
      await handleFatal(err);
    }
  });

const pluginCmd = program.command("plugin").description("Manage plugins");

pluginCmd
  .command("install")
  .argument("<path>", "Plugin folder")
  .action(async (pluginPath) => {
    try {
      await requireFeature("plugins");
      const plugin = await installPlugin(pluginPath);
      console.log(`Installed plugin ${plugin.name} (${plugin.version}). Disabled by default.`);
    } catch (err) {
      await handleFatal(err);
    }
  });

pluginCmd
  .command("list")
  .action(async () => {
    try {
      const plugins = await listInstalledPlugins();
      if (plugins.length === 0) {
        console.log("No plugins installed.");
        return;
      }
      for (const plugin of plugins) {
        console.log(`${plugin.name}@${plugin.version} ${plugin.enabled ? "[enabled]" : "[disabled]"}`);
      }
    } catch (err) {
      await handleFatal(err);
    }
  });

pluginCmd
  .command("enable")
  .argument("<name>", "Plugin name")
  .action(async (name) => {
    try {
      await requireFeature("plugins");
      await setPluginEnabled(name, true);
      console.log(`Enabled plugin ${name}`);
    } catch (err) {
      await handleFatal(err);
    }
  });

pluginCmd
  .command("disable")
  .argument("<name>", "Plugin name")
  .action(async (name) => {
    try {
      await setPluginEnabled(name, false);
      console.log(`Disabled plugin ${name}`);
    } catch (err) {
      await handleFatal(err);
    }
  });

pluginCmd
  .command("remove")
  .argument("<name>", "Plugin name")
  .action(async (name) => {
    try {
      await requireFeature("plugins");
      await removePlugin(name);
      console.log(`Removed plugin ${name}`);
    } catch (err) {
      await handleFatal(err);
    }
  });

const telemetryCmd = program.command("telemetry").description("Telemetry (opt-in)");

telemetryCmd
  .command("enable")
  .option("--endpoint <url>", "Optional telemetry endpoint")
  .action(async (options) => {
    try {
      const current = (await loadGlobalConfig().catch(() => null)) ?? {};
      const updated = { ...current, telemetry: { enabled: true, endpoint: options.endpoint } };
      await saveGlobalConfig(updated);
      console.log("Telemetry enabled.");
    } catch (err) {
      await handleFatal(err);
    }
  });

telemetryCmd
  .command("disable")
  .action(async () => {
    try {
      const current = (await loadGlobalConfig().catch(() => null)) ?? {};
      const updated = { ...current, telemetry: { ...(current as any).telemetry, enabled: false } };
      await saveGlobalConfig(updated);
      console.log("Telemetry disabled.");
    } catch (err) {
      await handleFatal(err);
    }
  });

const templateCmd = program.command("template").description("Manage workflow templates");

templateCmd
  .command("export")
  .argument("<workflow>", "Workflow YAML path")
  .option("--output <path>", "Output .orct path")
  .action(async (workflowPath, options) => {
    try {
      const output = await exportTemplate({
        workflowPath: path.resolve(workflowPath),
        outputPath: options.output ? path.resolve(options.output) : undefined
      });
      console.log(`Template exported: ${output}`);
    } catch (err) {
      await handleFatal(err);
    }
  });

templateCmd
  .command("import")
  .argument("<file>", "Template .orct file")
  .requiredOption("--repo <path>", "Workspace repo path")
  .action(async (file, options) => {
    try {
      const repoPath = path.resolve(options.repo);
      const targetDir = path.join(repoPath, ".orchestrum", "templates");
      const result = await importTemplate({
        archivePath: path.resolve(file),
        targetDir
      });
      console.log(`Template imported: ${result.path}`);
    } catch (err) {
      await handleFatal(err);
    }
  });

program
  .command("share")
  .argument("<runId>", "Run ID to export")
  .option("--runs-dir <path>", "Runs directory (default: ./runs)")
  .option("--workspace <id>", "Workspace ID (default: default)")
  .option("--output <path>", "Output directory")
  .action(async (runId, options) => {
    try {
      const runsDir = options.runsDir
        ? path.resolve(options.runsDir)
        : path.resolve(process.cwd(), "runs");
      const workspaceId = options.workspace ?? "default";
      const archive = await exportRunBundle({
        runsDir,
        runId,
        workspaceId,
        outputDir: options.output
      });
      console.log(`Shared bundle: ${archive}`);
    } catch (err) {
      await handleFatal(err);
    }
  });

program
  .command("import-run")
  .argument("<file>", "Run bundle .orun")
  .option("--runs-dir <path>", "Runs directory (default: ./runs)")
  .action(async (file, options) => {
    try {
      const runsDir = options.runsDir
        ? path.resolve(options.runsDir)
        : path.resolve(process.cwd(), "runs");
      const result = await importRunBundle({
        archivePath: path.resolve(file),
        runsDir
      });
      console.log(`Imported run ${result.runId} into workspace ${result.workspaceId}`);
    } catch (err) {
      await handleFatal(err);
    }
  });

program
  .command("ci")
  .requiredOption("--repo <path>", "Target repo path")
  .option("--runs-dir <path>", "Runs directory (default: ./runs)")
  .option("--workspace <id>", "Workspace ID (optional)")
  .option("--watch", "Watch repo for new commits")
  .action(async (options) => {
    try {
      const repoPath = path.resolve(options.repo);
      const runsDir = options.runsDir
        ? path.resolve(options.runsDir)
        : path.resolve(process.cwd(), "runs");
      const workspaceId = await resolveWorkspaceId(repoPath, options.workspace);
      if (options.watch) {
        await startCiWatch({
          repoPath,
          runsDir,
          workspaceId
        });
      } else {
        console.error("CI mode requires --watch for now.");
      }
    } catch (err) {
      await handleFatal(err);
    }
  });

program
  .command("experiment")
  .requiredOption("--repo <path>", "Target repo path")
  .option("--workflow <path>", "Workflow path (default from config)")
  .option("--runs-dir <path>", "Runs directory (default: ./runs)")
  .option("--workspace <id>", "Workspace ID (optional)")
  .option("--strategy <mode>", "Primary strategy mode (optional)")
  .action(async (options) => {
    try {
      const repoPath = path.resolve(options.repo);
      const runsDir = options.runsDir
        ? path.resolve(options.runsDir)
        : path.resolve(process.cwd(), "runs");
      let workflowPath: string | null = options.workflow ? path.resolve(options.workflow) : null;
      if (!workflowPath) {
        const config = await loadConfig(repoPath);
        if (!config?.defaultWorkflow) {
          throw new Error("No workflow provided and config has no defaultWorkflow");
        }
        workflowPath = path.resolve(repoPath, config.defaultWorkflow);
      }
      const workspaceId = await resolveWorkspaceId(repoPath, options.workspace);
      await runExperiment({
        workflowPath,
        repoPath,
        runsDir,
        workspaceId,
        primaryMode: options.strategy
      });
    } catch (err) {
      await handleFatal(err);
    }
  });

program
  .command("simulate")
  .requiredOption("--repo <path>", "Target repo path")
  .option("--workflow <path>", "Workflow path (default from config)")
  .option("--workspace <id>", "Workspace ID (optional)")
  .option("--strategy <mode>", "Strategy mode override (optional)")
  .option("--cost-limit <usd>", "Cost limit for simulation", parseFloat)
  .action(async (options) => {
    try {
      const repoPath = path.resolve(options.repo);
      let workflowPath: string | null = options.workflow ? path.resolve(options.workflow) : null;
      if (!workflowPath) {
        const config = await loadConfig(repoPath);
        if (!config?.defaultWorkflow) {
          throw new Error("No workflow provided and config has no defaultWorkflow");
        }
        workflowPath = path.resolve(repoPath, config.defaultWorkflow);
      }
      const workspaceId = await resolveWorkspaceId(repoPath, options.workspace);
      await simulateWorkflow({
        workflowPath,
        repoPath,
        workspaceId,
        strategyMode: options.strategy,
        costLimit: options.costLimit
      });
    } catch (err) {
      await handleFatal(err);
    }
  });

program
  .command("tournament")
  .requiredOption("--repo <path>", "Target repo path")
  .option("--workflow <path>", "Workflow path (default from config)")
  .option("--runs-dir <path>", "Runs directory (default: ./runs)")
  .option("--workspace <id>", "Workspace ID (optional)")
  .action(async (options) => {
    try {
      const repoPath = path.resolve(options.repo);
      const runsDir = options.runsDir
        ? path.resolve(options.runsDir)
        : path.resolve(process.cwd(), "runs");
      let workflowPath: string | null = options.workflow ? path.resolve(options.workflow) : null;
      if (!workflowPath) {
        const config = await loadConfig(repoPath);
        if (!config?.defaultWorkflow) {
          throw new Error("No workflow provided and config has no defaultWorkflow");
        }
        workflowPath = path.resolve(repoPath, config.defaultWorkflow);
      }
      const workspaceId = await resolveWorkspaceId(repoPath, options.workspace);
      await requireFeature("tournament");
      await runTournament({ workflowPath, repoPath, runsDir, workspaceId });
    } catch (err) {
      await handleFatal(err);
    }
  });

program
  .command("evaluate")
  .argument("<workflow>", "Path to workflow YAML")
  .requiredOption("--repo <path>", "Target repo path")
  .option("--runs <n>", "Number of runs", (value) => Number(value), 5)
  .option("--runs-dir <path>", "Runs directory (default: ./runs)")
  .option("--workspace <id>", "Workspace ID (optional)")
  .action(async (workflow, options) => {
    try {
      const repoPath = path.resolve(options.repo);
      const runsDir = options.runsDir
        ? path.resolve(options.runsDir)
        : path.resolve(process.cwd(), "runs");
      const workspaceId = await resolveWorkspaceId(repoPath, options.workspace);
      await evaluateWorkflow({
        workflowPath: path.resolve(workflow),
        repoPath,
        runsDir,
        workspaceId,
        runs: options.runs
      });
    } catch (err) {
      await handleFatal(err);
    }
  });

const roadmapCmd = program.command("roadmap").description("Run roadmap milestones");

roadmapCmd
  .command("run")
  .argument("<roadmap>", "Path to roadmap YAML")
  .requiredOption("--repo <path>", "Target repo path")
  .option("--runs-dir <path>", "Runs directory (default: ./runs)")
  .option("--workspace <id>", "Workspace ID (optional)")
  .action(async (roadmapPath, options) => {
    try {
      const repoPath = path.resolve(options.repo);
      const runsDir = options.runsDir
        ? path.resolve(options.runsDir)
        : path.resolve(process.cwd(), "runs");
      const workspaceId = await resolveWorkspaceId(repoPath, options.workspace);
      await requireFeature("roadmap");
      await runRoadmap({
        roadmapPath: path.resolve(roadmapPath),
        repoPath,
        runsDir,
        workspaceId
      });
    } catch (err) {
      await handleFatal(err);
    }
  });

const clusterCmd = program.command("cluster").description("Local worker cluster");

clusterCmd
  .command("start")
  .option("--workers <n>", "Number of workers", (value) => Number(value), 2)
  .option("--queue-dir <path>", "Queue directory (default: ./runs/.cluster)")
  .option("--workspace <id>", "Workspace ID (default: default)")
  .action(async (options) => {
    try {
      const workspaceId = options.workspace ?? "default";
      const queueDir = options.queueDir
        ? path.resolve(options.queueDir)
        : path.resolve(process.cwd(), "runs", workspaceId, ".cluster");
      await requireFeature("cluster");
      await startCluster({
        workers: options.workers,
        queueRoot: queueDir
      });
    } catch (err) {
      await handleFatal(err);
    }
  });

const workspaceCmd = program.command("workspace").description("Manage workspaces");

workspaceCmd
  .command("add")
  .argument("<path>", "Path to the workspace repo")
  .option("--id <id>", "Optional workspace id")
  .action(async (workspacePath, options) => {
    try {
      const rootDir = process.cwd();
      const workspace = await addWorkspace(rootDir, workspacePath, options.id);
      console.log(`Added workspace ${workspace.id} -> ${workspace.path}`);
    } catch (err) {
      await handleFatal(err);
    }
  });

workspaceCmd
  .command("list")
  .action(async () => {
    try {
      const rootDir = process.cwd();
      const workspaces = await loadWorkspaces(rootDir);
      if (workspaces.length === 0) {
        console.log("No workspaces registered.");
        return;
      }
      for (const workspace of workspaces) {
        console.log(`${workspace.id} -> ${workspace.path}`);
      }
    } catch (err) {
      await handleFatal(err);
    }
  });

program
  .command("self-update")
  .option("--file <path>", "Local tarball path")
  .action(async (options) => {
    try {
      if (!options.file) {
        console.log("Provide --file with a local package tarball to update without cloud.");
        return;
      }
      const npmCommand = resolveNpmCommand();
      const child = spawn(npmCommand, ["install", "-g", path.resolve(options.file)], {
        stdio: "inherit"
      });
      child.on("exit", (code) => process.exit(code ?? 0));
    } catch (err) {
      await handleFatal(err);
    }
  });

async function resolveWorkspaceId(repoPath: string, workspaceId?: string): Promise<string> {
  const rootDir = process.cwd();
  const workspaces = await loadWorkspaces(rootDir);
  if (workspaceId) {
    const match = findWorkspaceById(workspaces, workspaceId);
    if (!match) {
      throw new Error(`Workspace ${workspaceId} not found. Use orchestrum workspace add.`);
    }
    return match.id;
  }
  const match = findWorkspaceByPath(workspaces, repoPath);
  if (match) return match.id;
  return "default";
}

async function requireFeature(feature: Parameters<typeof isFeatureAllowed>[1]) {
  const status = await getLicenseStatus();
  const tier = status.valid ? status.tier : "Free";
  enforceFeature(tier, feature);
}

function killProcessOnPort(port: number): void {
  try {
    if (process.platform === "win32") {
      // On Windows, use netstat + taskkill
      const cmd = `netstat -ano | findstr :${port}`;
      const result = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] });
      const lines = result.split("\n").filter((line) => line.trim());
      const pids = new Set<number>();
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const token = parts[parts.length - 1];
        if (!token) continue;
        const pid = parseInt(token, 10);
        if (!isNaN(pid) && pid > 0) {
          pids.add(pid);
        }
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
        } catch {
          // Process may have already exited
        }
      }
    } else {
      // On Unix-like systems, use lsof + kill
      const cmd = `lsof -i :${port} -t`;
      const result = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] });
      const pids = result.trim().split("\n").filter((pid) => pid.trim());
      for (const pid of pids) {
        try {
          execSync(`kill -9 ${pid}`, { stdio: "ignore" });
        } catch {
          // Process may have already exited
        }
      }
    }
  } catch {
    // Port may not be in use or command failed
  }
}

async function startUiWithService(options: { port: number; servicePort: number; prod?: boolean }) {
  const require = createRequire(import.meta.url);
  const invocationRoot = resolveInvocationRoot();
  let serviceEntry: string | null = null;
  let serviceRoot: string | null = null;
  try {
    const serviceModule = require.resolve("@orchestrum/service");
    serviceRoot = findPackageRoot(serviceModule);
    if (!serviceRoot) {
      throw new Error("Service package root not found.");
    }
    serviceEntry = options.prod
      ? path.join(serviceRoot, "dist", "server.js")
      : path.join(serviceRoot, "src", "server.ts");
  } catch {
    const localServiceBase = path.join(invocationRoot, "packages", "service");
    const localEntry = options.prod
      ? path.join(localServiceBase, "dist", "server.js")
      : path.join(localServiceBase, "src", "server.ts");
    if (fsSync.existsSync(localEntry)) {
      serviceRoot = localServiceBase;
      serviceEntry = localEntry;
    } else {
      throw new Error("@orchestrum/service not found. Install orchestrum with service package.");
    }
  }

  // Kill any existing processes on the ports
  killProcessOnPort(options.port);
  killProcessOnPort(options.servicePort);

  const serviceArgs = [resolveTsxBin(serviceRoot ?? path.dirname(serviceEntry)), serviceEntry];
  const service = spawn(process.execPath, serviceArgs, {
    stdio: "inherit",
    cwd: invocationRoot,
    env: {
      ...process.env,
      ORCHESTRUM_SERVICE_PORT: String(options.servicePort)
    }
  });

  const uiRoot = resolveUiRoot();
  const uiArgs = options.prod
    ? [resolveNextBin(uiRoot), "start", "-p", String(options.port)]
    : [resolveNextBin(uiRoot), "dev", "-p", String(options.port)];
  const ui = spawn(process.execPath, uiArgs, {
    stdio: "inherit",
    cwd: uiRoot,
    env: {
      ...process.env,
      PORT: String(options.port),
      NEXT_PUBLIC_ORCHESTRUM_SERVICE_URL: `http://localhost:${options.servicePort}`
    }
  });

  service.on("error", (err) => {
    console.error(`Service failed to start: ${(err as Error).message}`);
    process.exit(1);
  });

  ui.on("error", (err) => {
    console.error(`UI failed to start: ${(err as Error).message}`);
    service.kill();
    process.exit(1);
  });

  const shutdown = () => {
    service.kill();
    ui.kill();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function findPackageRoot(entryPath: string): string | null {
  let current = path.dirname(entryPath);
  for (let i = 0; i < 10; i += 1) {
    const pkgPath = path.join(current, "package.json");
    if (fsSync.existsSync(pkgPath)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function resolveUiRoot(): string {
  const currentDirUi = path.join(process.cwd(), "apps", "ui");
  if (fsSync.existsSync(path.join(currentDirUi, "package.json"))) {
    return currentDirUi;
  }

  const coreDir = path.dirname(fileURLToPath(import.meta.url));
  const repoUi = path.resolve(coreDir, "..", "..", "..", "apps", "ui");
  if (fsSync.existsSync(path.join(repoUi, "package.json"))) {
    return repoUi;
  }

  throw new Error("UI app not found. Run this command from the orchestrum repository or install a build that includes the UI app.");
}

function resolveInvocationRoot(): string {
  const cwd = process.cwd();
  if (fsSync.existsSync(path.join(cwd, "version.json"))) {
    return cwd;
  }

  const coreDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(coreDir, "..", "..", "..");
  if (fsSync.existsSync(path.join(repoRoot, "version.json"))) {
    return repoRoot;
  }

  return cwd;
}

function resolveTsxBin(packageRoot: string): string {
  const resolver = createRequire(path.join(packageRoot, "package.json"));
  const tsxPkgPath = resolver.resolve("tsx/package.json");
  const tsxPkg = JSON.parse(fsSync.readFileSync(tsxPkgPath, "utf8"));
  const binRel =
    typeof tsxPkg.bin === "string"
      ? tsxPkg.bin
      : tsxPkg.bin?.tsx ?? Object.values(tsxPkg.bin ?? {})[0];
  if (!binRel) {
    throw new Error("tsx binary not found.");
  }
  return path.resolve(path.dirname(tsxPkgPath), String(binRel));
}

function resolveNextBin(uiRoot: string): string {
  const resolver = createRequire(path.join(uiRoot, "package.json"));
  return resolver.resolve("next/dist/bin/next");
}

function resolveNpmCommand(): string {
  // On Windows, use npm.cmd directly; on Unix, use npm
  // The shell: true will safely pass these through the system's PATH
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function handleFatal(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${message}`);
  const tokenMatch = typeof message === "string" ? message.match(/Token:\\s*([A-Za-z0-9._-]+)/) : null;
  if (tokenMatch) {
    console.error(`Approval required. Run: orchestrum approve ${tokenMatch[1]}`);
  }
  await writeCrashReport(process.cwd(), err).catch(() => undefined);
  process.exit(1);
}

await program.parseAsync(process.argv);
