import { Command } from "commander";
import path from "path";
import { spawn } from "node:child_process";
import net from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fsSync from "node:fs";
import {
  runMissionDetailed,
  resumeMissionRun,
  importMissionNodeInput,
  loadMissionRun,
  cancelRun,
  createBackup,
  restoreBackup,
  setSecret,
  unsetSecret,
  listSecrets,
  approveToken,
  applySecretsToEnv,
  writeCrashReport,
  exportDiagnostics,
  runDoctor,
  loadGlobalConfig,
  saveGlobalConfig,
  checkForUpdates,
  installUpdate,
  rollbackUpdate,
  listInstalledPlugins,
  installPlugin,
  removePlugin,
  setPluginEnabled,
  exportRunBundle,
  importRunBundle,
  runBrowserRunDetailed,
  loadLearnings,
  syncWorkspaceDocs,
  discoverDeliverySetup,
  initTeamPreset,
  exportDeliveryPacket,
  analyzeDeliveryImport,
  importDeliveryPacketResponse,
  loadDeliveryFindings,
  summarizeDeliverySessions,
  normalizeMissionProvider,
  type DeliveryTargetTool,
  type MissionAgent,
  getLicenseStatus,
  isFeatureAllowed,
  enforceFeature
} from "../index.js";
import { addWorkspace, loadWorkspaces } from "../runner/workspaces.js";
import { ensureWorkspaceManifest, getWorkspaceAgentsPath } from "../runner/control.js";
import { OrchestrumError } from "../errors.js";
import { DEFAULT_SERVICE_PORT, DEFAULT_UI_PORT } from "../constants.js";

const registeredPrograms = new WeakSet<Command>();

export function registerCommandRegistryOnce(program: Command): void {
  if (registeredPrograms.has(program)) return;
  registeredPrograms.add(program);
  registerCommandRegistry(program);
}

export function registerCommandRegistry(program: Command): void {
const missionCmd = program.command("mission").description("Manage mission runs");

missionCmd
  .command("start")
  .requiredOption("--template <id>", "Mission template id")
  .requiredOption("--workspace <id>", "Workspace ID")
  .requiredOption("--goal <text>", "Mission goal")
  .option("--repo <path>", "Workspace repo path (default: cwd)")
  .option("--runs-dir <path>", "Runs directory (default: ./runs)")
  .option("--run-id <id>", "Mission run id")
  .action(async (options) => {
    try {
      const rootDir = process.cwd();
      const repoPath = options.repo ? path.resolve(String(options.repo)) : rootDir;
      const runsDir = options.runsDir
        ? path.resolve(options.runsDir)
        : path.resolve(rootDir, "runs");
      const workspace = await ensureWorkspaceManifest(repoPath);
      if (workspace.id !== String(options.workspace)) {
        throw new Error(`Workspace ${options.workspace} does not match repo manifest ${workspace.id} for ${repoPath}.`);
      }
      const agents = await loadWorkspaceMissionAgents(workspace.path);
      await applySecretsToEnv({
        names: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
        scope: "workspace",
        repoPath: workspace.path,
        useKeychain: process.env.ORCHESTRUM_USE_KEYCHAIN === "1"
      });
      const result = await runMissionDetailed({
        templateId: String(options.template),
        repoPath: workspace.path,
        runsDir,
        workspaceId: workspace.id,
        runId: options.runId ? String(options.runId) : undefined,
        goal: String(options.goal),
        agents
      });
      console.log(JSON.stringify({
        ok: result.ok,
        runId: result.runId,
        status: result.run.status,
        paused: result.paused ?? false
      }, null, 2));
      if (!result.ok && result.run.status !== "running") {
        process.exitCode = 1;
      }
    } catch (err) {
      await handleFatal(err);
    }
  });

missionCmd
  .command("import")
  .requiredOption("--run <id>", "Mission run id")
  .requiredOption("--node <id>", "Mission node id")
  .requiredOption("--workspace <id>", "Workspace ID")
  .option("--repo <path>", "Workspace repo path (default: cwd)")
  .option("--runs-dir <path>", "Runs directory (default: ./runs)")
  .option("--file <path>", "Response file path")
  .option("--stdin", "Read response from stdin")
  .option("--target-tool <tool>", "Target tool label")
  .action(async (options) => {
    try {
      const rootDir = process.cwd();
      const repoPath = options.repo ? path.resolve(String(options.repo)) : rootDir;
      const runsDir = options.runsDir
        ? path.resolve(options.runsDir)
        : path.resolve(rootDir, "runs");
      const workspace = await ensureWorkspaceManifest(repoPath);
      if (workspace.id !== String(options.workspace)) {
        throw new Error(`Workspace ${options.workspace} does not match repo manifest ${workspace.id} for ${repoPath}.`);
      }
      const text = options.file
        ? fsSync.readFileSync(path.resolve(String(options.file)), "utf8")
        : options.stdin
          ? await readStdinIfAny()
          : await readStdinIfAny();
      if (!text.trim()) {
        throw new Error("No import text provided. Use --file <path> or pipe text via stdin.");
      }
      const run = await importMissionNodeInput({
        runsDir,
        workspaceId: workspace.id,
        runId: String(options.run),
        nodeId: String(options.node),
        text,
        targetTool: options.targetTool ? String(options.targetTool) : undefined
      });
      let resumed = false;
      if (run.status === "running") {
        const agents = await loadWorkspaceMissionAgents(workspace.path);
        await resumeMissionRun({
          runsDir,
          workspaceId: workspace.id,
          runId: run.runId,
          agents
        });
        resumed = true;
      }
      const latest = await loadMissionRun(path.join(runsDir, workspace.id, String(options.run)));
      console.log(JSON.stringify({
        ok: true,
        runId: run.runId,
        nodeId: String(options.node),
        status: latest?.status ?? run.status,
        resumed
      }, null, 2));
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
  .command("ui")
  .option("--port <n>", "UI port", (value) => Number(value), DEFAULT_UI_PORT)
  .option("--service-port <n>", "Service port", (value) => Number(value), DEFAULT_SERVICE_PORT)
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

program
  .command("doctor")
  .option("--root <path>", "Root directory (default: cwd)")
  .option("--runs-dir <path>", "Runs directory (default: <root>/runs)")
  .option("--repo <path>", "Workspace repo path for profile/config validation")
  .option("--workspace <id>", "Workspace ID")
  .action(async (options) => {
    try {
      const rootDir = options.root ? path.resolve(options.root) : process.cwd();
      const runsDir = options.runsDir ? path.resolve(options.runsDir) : path.join(rootDir, "runs");
      const repoPath = options.repo ? path.resolve(options.repo) : undefined;
      const report = await runDoctor({
        rootDir,
        runsDir,
        workspaceId: options.workspace,
        repoPath
      });
      console.log(JSON.stringify(report, null, 2));
      if (!report.summary.ok) {
        process.exitCode = 1;
      }
    } catch (err) {
      await handleFatal(err);
    }
  });

function registerBrowserCommand(name: "qa" | "benchmark" | "canary", description: string) {
  program
    .command(name)
    .description(description)
    .requiredOption("--repo <path>", "Target repo path")
    .option("--workspace <id>", "Workspace ID")
    .option("--runs-dir <path>", "Runs directory (default: ./runs)")
    .option("--base-url <url>", "Base URL to inspect")
    .option("--path <path>", "Relative path to visit")
    .option("--iterations <n>", "Canary iterations", (value) => Number(value))
    .option("--interval-ms <n>", "Canary interval in ms", (value) => Number(value))
    .action(async (options) => {
      try {
        const repoPath = path.resolve(options.repo);
        const runsDir = options.runsDir ? path.resolve(options.runsDir) : path.resolve(process.cwd(), "runs");
        const workspaceId = await resolveWorkspaceId(repoPath, options.workspace);
        const result = await runBrowserRunDetailed({
          kind: name,
          repoPath,
          runsDir,
          workspaceId,
          baseUrl: options.baseUrl,
          targetPath: options.path,
          options: {
            baseUrl: options.baseUrl,
            targetPath: options.path,
            iterations: Number.isFinite(options.iterations) ? options.iterations : undefined,
            intervalMs: Number.isFinite(options.intervalMs) ? options.intervalMs : undefined
          }
        });
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
      } catch (err) {
        await handleFatal(err);
      }
    });
}

registerBrowserCommand("qa", "Run headless browser smoke with artifacts");
registerBrowserCommand("benchmark", "Run browser benchmark capture");
registerBrowserCommand("canary", "Run repeated browser canary checks");

const deliveryCmd = program.command("delivery").description("AI delivery work packet lifecycle");

deliveryCmd
  .command("doctor")
  .requiredOption("--repo <path>", "Target repo path")
  .option("--workspace <id>", "Workspace ID")
  .action(async (options) => {
    try {
      const repoPath = path.resolve(options.repo);
      const workspaceId = await resolveWorkspaceId(repoPath, options.workspace).catch(() => options.workspace ?? "default");
      const result = await discoverDeliverySetup({
        repoPath,
        workspaceId
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      await handleFatal(err);
    }
  });

deliveryCmd
  .command("init-preset")
  .requiredOption("--repo <path>", "Target repo path")
  .option("--workspace <id>", "Workspace ID")
  .option("--force", "Overwrite with a newly scaffolded preset")
  .action(async (options) => {
    try {
      const repoPath = path.resolve(options.repo);
      const workspaceId = await resolveWorkspaceId(repoPath, options.workspace).catch(() => options.workspace ?? "default");
      const result = await initTeamPreset({
        repoPath,
        workspaceId,
        force: Boolean(options.force)
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      await handleFatal(err);
    }
  });

deliveryCmd
  .command("run")
  .requiredOption("--repo <path>", "Target repo path")
  .requiredOption("--goal <text>", "Delivery goal or sprint title")
  .option("--workspace <id>", "Workspace ID")
  .option("--runs-dir <path>", "Runs directory (default: ./runs)")
  .option("--sprint <name>", "Optional sprint name")
  .option("--notes <text>", "Optional session notes")
  .option("--path <value...>", "Relevant repo paths to include")
  .action(async (options) => {
    try {
      const repoPath = path.resolve(options.repo);
      const workspaceId = await resolveWorkspaceId(repoPath, options.workspace);
      const runsDir = options.runsDir ? path.resolve(options.runsDir) : path.resolve(process.cwd(), "runs");
      const workspace = await ensureWorkspaceManifest(repoPath, { id: workspaceId });
      const agents = await loadWorkspaceMissionAgents(workspace.path);
      const goal = [
        String(options.goal),
        options.sprint ? `Sprint: ${String(options.sprint)}` : "",
        options.notes ? `Notes: ${String(options.notes)}` : "",
        Array.isArray(options.path) && options.path.length > 0 ? `Selected paths: ${options.path.map((item: string) => String(item)).join(", ")}` : ""
      ].filter(Boolean).join("\n");
      const result = await runMissionDetailed({
        templateId: "delivery-sprint",
        repoPath,
        runsDir,
        workspaceId,
        goal,
        agents
      });
      console.log(JSON.stringify({
        ok: result.ok,
        runId: result.runId,
        status: result.run.status,
        paused: result.paused ?? false,
        verdict: result.run.verdict ?? null
      }, null, 2));
    } catch (err) {
      await handleFatal(err);
    }
  });

deliveryCmd
  .command("export")
  .argument("<packetId>", "Packet ID")
  .requiredOption("--run <id>", "Delivery run ID")
  .requiredOption("--target <tool>", "Handoff target: chatgpt|cursor|codex|copilot|claude")
  .option("--workspace <id>", "Workspace ID")
  .option("--runs-dir <path>", "Runs directory (default: ./runs)")
  .option("--format <format>", "text|markdown|json", "text")
  .action(async (packetId, options) => {
    try {
      const runsDir = options.runsDir ? path.resolve(options.runsDir) : path.resolve(process.cwd(), "runs");
      const result = await exportDeliveryPacket({
        runsDir,
        runId: String(options.run),
        workspaceId: options.workspace ? String(options.workspace) : undefined,
        packetId: String(packetId),
        targetTool: String(options.target) as DeliveryTargetTool
      });
      if (options.format === "json") {
        console.log(JSON.stringify(result.sidecar, null, 2));
      } else if (options.format === "markdown") {
        console.log(result.markdown);
      } else {
        console.log(result.renderedText);
      }
    } catch (err) {
      await handleFatal(err);
    }
  });

deliveryCmd
  .command("import")
  .requiredOption("--run <id>", "Delivery run ID")
  .option("--packet <id>", "Packet ID")
  .requiredOption("--target <tool>", "Import source: chatgpt|cursor|codex|copilot|claude")
  .option("--workspace <id>", "Workspace ID")
  .option("--runs-dir <path>", "Runs directory (default: ./runs)")
  .option("--file <path>", "Import content file")
  .option("--text <text>", "Import content text")
  .action(async (options) => {
    try {
      const runsDir = options.runsDir ? path.resolve(options.runsDir) : path.resolve(process.cwd(), "runs");
      const inlineText = options.text ? String(options.text) : "";
      const text = inlineText || (options.file ? await fsSync.promises.readFile(path.resolve(options.file), "utf8") : await readStdinIfAny());
      const analysis = await analyzeDeliveryImport({
        runsDir,
        runId: String(options.run),
        workspaceId: options.workspace ? String(options.workspace) : undefined,
        packetId: options.packet ? String(options.packet) : undefined,
        text,
        filePath: options.file ? path.resolve(options.file) : undefined,
        fileName: options.file ? path.basename(String(options.file)) : undefined,
        targetTool: String(options.target) as DeliveryTargetTool,
        source: options.file ? "file" : "paste"
      });
      if (analysis.matchStatus !== "matched" || !analysis.matchedPacketId) {
        console.log(JSON.stringify(analysis, null, 2));
        process.exitCode = 1;
        return;
      }
      const result = await importDeliveryPacketResponse({
        runsDir,
        runId: String(options.run),
        workspaceId: options.workspace ? String(options.workspace) : undefined,
        packetId: analysis.matchedPacketId,
        text,
        filePath: options.file ? path.resolve(options.file) : undefined,
        fileName: options.file ? path.basename(String(options.file)) : undefined,
        targetTool: String(options.target) as DeliveryTargetTool,
        source: options.file ? "file" : "paste"
      });
      console.log(JSON.stringify({
        packetId: result.packet.id,
        status: result.packet.status,
        findings: result.findings.length,
        remediations: result.remediations.length
      }, null, 2));
    } catch (err) {
      await handleFatal(err);
    }
  });

deliveryCmd
  .command("summary")
  .option("--workspace <id>", "Workspace ID")
  .option("--runs-dir <path>", "Runs directory (default: ./runs)")
  .action(async (options) => {
    try {
      const runsDir = options.runsDir ? path.resolve(options.runsDir) : path.resolve(process.cwd(), "runs");
      const summary = await summarizeDeliverySessions({
        runsDir,
        workspaceId: options.workspace ? String(options.workspace) : undefined
      });
      console.log(JSON.stringify(summary, null, 2));
    } catch (err) {
      await handleFatal(err);
    }
  });

deliveryCmd
  .command("findings")
  .requiredOption("--run <id>", "Delivery run ID")
  .option("--workspace <id>", "Workspace ID")
  .option("--runs-dir <path>", "Runs directory (default: ./runs)")
  .action(async (options) => {
    try {
      const runsDir = options.runsDir ? path.resolve(options.runsDir) : path.resolve(process.cwd(), "runs");
      const findings = await loadDeliveryFindings({
        runsDir,
        runId: String(options.run),
        workspaceId: options.workspace ? String(options.workspace) : undefined
      });
      console.log(JSON.stringify(findings, null, 2));
    } catch (err) {
      await handleFatal(err);
    }
  });

const learningsCmd = program.command("learnings").description("Workspace learnings");
learningsCmd
  .command("list")
  .requiredOption("--repo <path>", "Target repo path")
  .option("--limit <n>", "Entry limit", (value) => Number(value), 20)
  .action(async (options) => {
    try {
      const repoPath = path.resolve(options.repo);
      const entries = await loadLearnings(repoPath);
      const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 20;
      console.log(JSON.stringify(entries.slice(0, limit), null, 2));
    } catch (err) {
      await handleFatal(err);
    }
  });

const docsCmd = program.command("docs").description("Documentation utilities");
docsCmd
  .command("sync")
  .requiredOption("--repo <path>", "Target repo path")
  .action(async (options) => {
    try {
      const repoPath = path.resolve(options.repo);
      const result = await syncWorkspaceDocs(repoPath);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
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

updateCmd
  .command("rollback")
  .argument("<journal>", "Path to the update install journal.json")
  .action(async (journalPath) => {
    try {
      const result = await rollbackUpdate({
        journalPath: path.resolve(journalPath)
      });
      console.log(`Rolled back update using ${result.journalPath}. Restored: ${result.restoredFiles}, removed: ${result.removedFiles}`);
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
      const workspacePath = process.cwd();
      await ensureWorkspaceManifest(workspacePath);
      const plugin = await installPlugin(workspacePath, pluginPath);
      console.log(`Installed plugin ${plugin.name} (${plugin.version}). Disabled by default.`);
    } catch (err) {
      await handleFatal(err);
    }
  });

pluginCmd
  .command("list")
  .action(async () => {
    try {
      const workspacePath = process.cwd();
      await ensureWorkspaceManifest(workspacePath);
      const plugins = await listInstalledPlugins(workspacePath);
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
      const workspacePath = process.cwd();
      await ensureWorkspaceManifest(workspacePath);
      await setPluginEnabled(workspacePath, name, true);
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
      const workspacePath = process.cwd();
      await ensureWorkspaceManifest(workspacePath);
      await setPluginEnabled(workspacePath, name, false);
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
      const workspacePath = process.cwd();
      await ensureWorkspaceManifest(workspacePath);
      await removePlugin(workspacePath, name);
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

}

async function resolveWorkspaceId(repoPath: string, workspaceId?: string): Promise<string> {
  const manifest = await ensureWorkspaceManifest(repoPath);
  if (workspaceId && manifest.id !== workspaceId) {
    throw new Error(`Workspace ${workspaceId} does not match repo manifest ${manifest.id} for ${repoPath}.`);
  }
  return manifest.id;
}

async function loadWorkspaceMissionAgents(workspacePath: string): Promise<MissionAgent[]> {
  const agentsPath = getWorkspaceAgentsPath(workspacePath);
  const raw = await fsSync.promises.readFile(agentsPath, "utf8").catch(() => "[]");
  const parsed = JSON.parse(raw) as Array<{
    id?: string;
    workspaceId?: string;
    name?: string;
    role?: string;
    tags?: string[];
    profile?: {
      specialization?: string;
      seniority?: string;
      maxParallelWork?: number;
    };
    provider?: { type?: string; model?: string; apiKeyRef?: string };
    capabilities?: { shell?: boolean; fs?: boolean; network?: boolean };
    status?: {
      state?: string;
      currentTaskId?: string;
      currentTaskIds?: string[];
    };
  }>;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`No workspace agents configured in ${agentsPath}.`);
  }
  return parsed.map((agent) => ({
    id: String(agent.id ?? ""),
    workspaceId: agent.workspaceId,
    name: String(agent.name ?? "Agent"),
    role: String(agent.role ?? "general"),
    tags: Array.isArray(agent.tags) ? agent.tags.map((tag) => String(tag)) : [],
    specialization: typeof agent.profile?.specialization === "string" ? agent.profile.specialization : undefined,
    seniority: typeof agent.profile?.seniority === "string" ? agent.profile.seniority : undefined,
    capacity: {
      maxParallelWork:
        typeof agent.profile?.maxParallelWork === "number" && agent.profile.maxParallelWork > 0
          ? Math.floor(agent.profile.maxParallelWork)
          : undefined
    },
    runtime: {
      state: typeof agent.status?.state === "string" ? agent.status.state : undefined,
      currentTaskId: typeof agent.status?.currentTaskId === "string" ? agent.status.currentTaskId : undefined,
      currentTaskIds: Array.isArray(agent.status?.currentTaskIds)
        ? agent.status.currentTaskIds.map((taskId) => String(taskId)).filter(Boolean)
        : typeof agent.status?.currentTaskId === "string" && agent.status.currentTaskId
          ? [agent.status.currentTaskId]
          : [],
      activeLoad: Array.isArray(agent.status?.currentTaskIds)
        ? agent.status.currentTaskIds.filter(Boolean).length
        : typeof agent.status?.currentTaskId === "string" && agent.status.currentTaskId
          ? 1
          : 0
    },
    provider: normalizeMissionProvider(agent.provider ?? {}, String(agent.role ?? "general")),
    capabilities: {
      shell: Boolean(agent.capabilities?.shell),
      fs: agent.capabilities?.fs !== false,
      network: agent.capabilities?.network !== false
    }
  }));
}

async function requireFeature(feature: Parameters<typeof isFeatureAllowed>[1]) {
  const status = await getLicenseStatus();
  const tier = status.valid ? status.tier : "Free";
  enforceFeature(tier, feature);
}

async function readStdinIfAny(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });
}

async function findAvailablePort(startPort: number): Promise<number> {
  let candidate = Math.max(1, Math.floor(startPort));
  while (candidate < startPort + 50) {
    const free = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(candidate, "127.0.0.1");
    });
    if (free) return candidate;
    candidate += 1;
  }
  throw new Error(`No available port found near ${startPort}.`);
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

  const servicePort = await findAvailablePort(options.servicePort);
  const uiPort = await findAvailablePort(options.port === servicePort ? servicePort + 1 : options.port);

  const serviceArgs = [resolveTsxBin(serviceRoot ?? path.dirname(serviceEntry)), serviceEntry];
  const service = spawn(process.execPath, serviceArgs, {
    stdio: "inherit",
    cwd: invocationRoot,
    env: {
      ...process.env,
      ORCHESTRUM_SERVICE_PORT: String(servicePort)
    }
  });

  const uiRoot = resolveUiRoot();
  const uiArgs = options.prod
    ? [resolveNextBin(uiRoot), "start", "-p", String(uiPort)]
    : [resolveNextBin(uiRoot), "dev", "-p", String(uiPort)];
  const ui = spawn(process.execPath, uiArgs, {
    stdio: "inherit",
    cwd: uiRoot,
    env: {
      ...process.env,
      PORT: String(uiPort),
      NEXT_PUBLIC_ORCHESTRUM_SERVICE_URL: `http://localhost:${servicePort}`
    }
  });

  console.log(`[orchestrum] UI http://localhost:${uiPort} · service http://localhost:${servicePort}`);

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
  const repoUi = path.resolve(coreDir, "..", "..", "..", "..", "apps", "ui");
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
  const repoRoot = path.resolve(coreDir, "..", "..", "..", "..");
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
  if (err instanceof OrchestrumError) {
    console.error(`Error [${err.code}]: ${err.message}`);
    if (err.context && Object.keys(err.context).length > 0) {
      console.error(`Context: ${JSON.stringify(err.context)}`);
    }
  } else {
    console.error(`Error: ${message}`);
  }
  const tokenMatch = typeof message === "string" ? message.match(/Token:\\s*([A-Za-z0-9._-]+)/) : null;
  if (tokenMatch) {
    console.error(`Approval required. Run: orchestrum approve ${tokenMatch[1]}`);
  }
  await writeCrashReport(process.cwd(), err).catch(() => undefined);
  process.exit(1);
}
