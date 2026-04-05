import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import crypto from "node:crypto";
import type express from "express";
import {
  appendWorkItemTrace,
  appendWorkspaceSignal,
  defaultProviderForRole,
  discoverMissionProviders,
  initTeamPreset,
  normalizeMissionProvider,
  readJsonIfExists,
  loadWorkspaces,
  loadWorkspaceTraces,
  findWorkspaceById,
  runMissionDetailed,
  runBrowserRunDetailed,
  resumeMissionRun,
  importMissionNodeInput,
  loadMissionRun,
  loadMissionTemplate,
  type MissionAgent,
  type ProviderDiscoveryRecord,
  type ProviderDiscoveryTransport,
  type ProviderProfile,
  type MissionRun,
  type MissionProviderSpec,
  type BrowserScenarioStep,
  type ChangeState,
  type PauseReason,
  type RunStartOptions,
  type RunVerdict,
  type ValidationState,
  type WorkItemPlanningDetail,
  type WorkItemRecord,
  type WorkItemTraceRecord,
  type WorkPlanTask,
  getWorkspaceAgentsPath as getWorkspaceAgentsFilePath,
  getWorkspaceOrgPath as getWorkspaceOrgFilePath,
  getWorkspaceTasksPath as getWorkspaceTasksFilePath,
  getWorkspaceTaskArtifactsRoot,
  getWorkspaceMessagesPath as getWorkspaceMessagesFilePath,
  getOperatorControlDir,
  writeJson
} from "@orchestrum/core";

type AgentState = "idle" | "active" | "sleeping" | "error";
type TaskStatus = "queued" | "running" | "paused" | "blocked" | "succeeded" | "failed" | "cancelled";
type TaskType = "spec" | "implement" | "validate" | "qa" | "audit";
type ProviderReadiness = "usable_now" | "detected_needs_setup" | "fallback_default";

type AgentRecord = {
  id: string;
  workspaceId?: string;
  name: string;
  role: string;
  tags: string[];
  profile: {
    specialization: string;
    seniority: string;
    maxParallelWork: number;
  };
  provider: MissionProviderSpec;
  capabilities: {
    shell: boolean;
    fs: boolean;
    network: boolean;
  };
  status: {
    state: AgentState;
    currentTaskId?: string;
    currentTaskIds: string[];
    lastHeartbeatAt: string;
  };
  createdAt: string;
  updatedAt: string;
};

type OrgNode = {
  id: string;
  workspaceId?: string;
  agentId: string;
  parentId?: string;
  department?: string;
  position?: string;
  x?: number;
  y?: number;
};

type MissionRecord = {
  runId: string;
  workspaceId: string;
  templateId: string;
  title: string;
  goal: string;
  status: string;
  updatedAt: string;
  activeNodeIds: string[];
};

const TASK_MISSION_TEMPLATES = {
  spec: "spec-only",
  implement: "implement-only",
  validate: "validation-only",
  audit: "audit-only"
} as const;

const MISSION_GOAL_OMITTED_PAYLOAD_KEYS = new Set([
  "workItemId",
  "plannerTaskId",
  "cycleId",
  "workstreamId",
  "gateRefs",
  "laneId",
  "ownerAgentId",
  "ownerAgentName",
  "ownerRole",
  "reviewStatus",
  "reviewedAt"
]);
const MISSION_GOAL_ARRAY_LIMIT = 6;
const MISSION_GOAL_STRING_LIMIT = 600;

type TaskRecord = {
  id: string;
  workspaceId?: string;
  title: string;
  description: string;
  type: TaskType;
  payload: Record<string, unknown>;
  assignedToAgentId: string;
  dependsOnTaskIds: string[];
  linkedWorkItemId?: string;
  linkedWorkItemTitle?: string;
  plannerTaskId?: string;
  cycleId?: string;
  workstreamId?: string;
  workstreamType?: string;
  gateRefs?: string[];
  ownerAgentId?: string;
  ownerAgentName?: string;
  ownerRole?: string;
  qaMode?: "smoke" | "scenario";
  laneId?: string;
  laneLabel?: string;
  waitingOnTaskIds: string[];
  blockedByTaskIds: string[];
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  attempts: number;
  maxAttempts: number;
  artifactsPath: string;
  logsPath: string;
  linkedRunId?: string;
  linkedTemplateId?: string;
  pauseReason?: PauseReason | null;
  change?: ChangeState | null;
  validation?: ValidationState | null;
  verdict?: RunVerdict | null;
  resultSummary?: string;
};

type MessageRecord = {
  id: string;
  workspaceId?: string;
  fromAgentId: string;
  toAgentId: string;
  topic: string;
  payload: Record<string, unknown>;
  ts: string;
};

type RuntimeEvent = {
  t: string;
  ts: number;
  [key: string]: unknown;
};

type AgentPlatformOptions = {
  rootDir: string;
  listWorkspacePaths?: () => Promise<string[]>;
};

type LoggerLike = {
  info: (event: string, payload?: Record<string, unknown>) => Promise<void> | void;
  warn: (event: string, payload?: Record<string, unknown>) => Promise<void> | void;
  error: (event: string, payload?: Record<string, unknown>) => Promise<void> | void;
};

export class AgentPlatform {
  private static readonly PROVIDER_DISCOVERY_CACHE_TTL_MS = 15_000;
  private dataDir: string;
  private eventsPath: string;
  private agents: AgentRecord[] = [];
  private orgNodes: OrgNode[] = [];
  private tasks: TaskRecord[] = [];
  private messages: MessageRecord[] = [];
  private missions: MissionRecord[] = [];
  private runningTaskIds = new Set<string>();
  private schedulerTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private logger: LoggerLike | null = null;
  private bootstrapLocks = new Map<string, Promise<AgentRecord[]>>();
  private providerDiscoveryCache = new Map<string, {
    expiresAt: number;
    records: ProviderDiscoveryRecord[];
  }>();
  private providerDiscoveryPending = new Map<string, Promise<ProviderDiscoveryRecord[]>>();

  constructor(private options: AgentPlatformOptions) {
    this.dataDir = getOperatorControlDir(options.rootDir);
    this.eventsPath = path.join(this.dataDir, "agent-events.ndjson");
  }

  async init(logger?: LoggerLike) {
    this.logger = logger ?? null;
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.mkdir(path.dirname(this.eventsPath), { recursive: true });
    await this.refreshWorkspaceState();
    this.startRuntime();
    await this.emit({ t: "platform.ready", ts: Date.now(), dataDir: this.dataDir });
  }

  shutdown() {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.schedulerTimer = null;
    this.heartbeatTimer = null;
  }

  async reload() {
    await this.refreshWorkspaceState();
  }

  registerRoutes(app: express.Express) {
    const agentRoutes = ["/agents", "/api/agents"] as const;
    for (const route of agentRoutes) {
      app.get(route, async (req, res) => {
        const workspaceId = typeof req.query.workspace === "string" ? req.query.workspace : undefined;
        const workspacePath = workspaceId ? await this.resolveWorkspacePath(workspaceId) : null;
        const agents = workspaceId
          ? await this.loadAgentsForWorkspaceId(workspaceId)
          : this.agents;
        const enrichedAgents = await this.enrichAgentsForRuntime(agents, workspaceId, workspacePath);
        res.json({ agents: enrichedAgents });
      });
      app.post(route, async (req, res) => {
        const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId : undefined;
        if (!workspaceId) return res.status(400).json({ error: "workspaceId is required" });
        const workspacePath = await this.resolveWorkspacePath(workspaceId);
        if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
        const now = new Date().toISOString();
        const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
        const role = String(body.role ?? "general");
        const profile = this.normalizeAgentProfile(body.profile, role);
        const agent: AgentRecord = {
          id: crypto.randomUUID(),
          workspaceId,
          name: String(body.name ?? "Agent"),
          role,
          tags: this.normalizeStringArray(body.tags),
          profile,
          provider: normalizeMissionProvider(body.provider ?? defaultProviderForRole(role), role),
          capabilities: {
            shell: this.readBoolean(body.capabilities, "shell", false),
            fs: this.readBoolean(body.capabilities, "fs", true),
            network: this.readBoolean(body.capabilities, "network", true)
          },
          status: { state: "idle", currentTaskIds: [], lastHeartbeatAt: now },
          createdAt: now,
          updatedAt: now
        };
        const agents = await this.loadAgentsForWorkspacePath(workspacePath);
        agents.push(agent);
        await this.saveAgentsForWorkspacePath(workspacePath, agents);
        await this.refreshWorkspaceState();
        await this.emit({ t: "agent.created", ts: Date.now(), agent });
        res.status(201).json({ agent });
      });
    }

    const agentItemRoutes = ["/agents/:id", "/api/agents/:id"] as const;
    for (const route of agentItemRoutes) {
      app.patch(route, async (req, res) => {
        const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId : undefined;
        const workspacePath = workspaceId ? await this.resolveWorkspacePath(workspaceId) : null;
        if (workspaceId && !workspacePath) return res.status(404).json({ error: "Workspace not found" });
        const agent = workspaceId
          ? (await this.loadAgentsForWorkspacePath(workspacePath!)).find((item) => item.id === req.params.id)
          : this.agents.find((item) => item.id === req.params.id);
        if (!agent) return res.status(404).json({ error: "Agent not found" });
        const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
        if (typeof body.name === "string") agent.name = body.name;
        if (typeof body.role === "string") agent.role = body.role;
        if (Array.isArray(body.tags)) agent.tags = this.normalizeStringArray(body.tags);
        if (body.profile && typeof body.profile === "object") {
          agent.profile = this.normalizeAgentProfile(body.profile, agent.role);
        } else if (!agent.profile) {
          agent.profile = this.normalizeAgentProfile(null, agent.role);
        }
        if (body.provider && typeof body.provider === "object") {
          agent.provider = normalizeMissionProvider(body.provider, agent.role);
        }
        if (body.capabilities && typeof body.capabilities === "object") {
          const caps = body.capabilities as Record<string, unknown>;
          if (typeof caps.shell === "boolean") agent.capabilities.shell = caps.shell;
          if (typeof caps.fs === "boolean") agent.capabilities.fs = caps.fs;
          if (typeof caps.network === "boolean") agent.capabilities.network = caps.network;
        }
        agent.updatedAt = new Date().toISOString();
        if (workspacePath) {
          const agents = await this.loadAgentsForWorkspacePath(workspacePath);
          const index = agents.findIndex((item) => item.id === req.params.id);
          if (index >= 0) agents[index] = agent;
          await this.saveAgentsForWorkspacePath(workspacePath, agents);
          await this.refreshWorkspaceState();
        } else {
          await this.persistAgents();
        }
        await this.emit({ t: "agent.updated", ts: Date.now(), agent });
        res.json({ agent });
      });

      app.delete(route, async (req, res) => {
        const workspaceId =
          typeof req.query.workspace === "string"
            ? req.query.workspace
            : typeof req.body?.workspaceId === "string"
              ? req.body.workspaceId
              : undefined;
        if (!workspaceId) return res.status(400).json({ error: "workspaceId is required" });
        const workspacePath = await this.resolveWorkspacePath(workspaceId);
        if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
        const agents = await this.loadAgentsForWorkspacePath(workspacePath);
        const before = agents.length;
        const nextAgents = agents.filter((item) => item.id !== req.params.id);
        if (nextAgents.length === before) return res.status(404).json({ error: "Agent not found" });
        await this.saveAgentsForWorkspacePath(workspacePath, nextAgents);
        const org = await this.loadOrgForWorkspacePath(workspacePath);
        await this.saveOrgForWorkspacePath(
          workspacePath,
          org.filter((node) => node.agentId !== req.params.id && node.id !== req.params.id && node.parentId !== req.params.id)
        );
        await this.refreshWorkspaceState();
        await this.emit({ t: "agent.deleted", ts: Date.now(), agentId: req.params.id });
        res.json({ ok: true });
      });
    }

    const orgRoutes = ["/org", "/api/org"] as const;
    for (const route of orgRoutes) {
      app.get(route, async (req, res) => {
        const workspaceId = typeof req.query.workspace === "string" ? req.query.workspace : undefined;
        const nodes = workspaceId
          ? await this.loadOrgForWorkspaceId(workspaceId)
          : this.orgNodes;
        res.json({ nodes });
      });
      app.put(route, async (req, res) => {
        const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId : undefined;
        if (!workspaceId) return res.status(400).json({ error: "workspaceId is required" });
        const workspacePath = await this.resolveWorkspacePath(workspaceId);
        if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
        const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
        const nodesRaw = Array.isArray(body.nodes) ? body.nodes : [];
        const nodes = nodesRaw
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
          .map((item) => this.normalizeOrgNode(item, workspaceId))
          .filter((item): item is OrgNode => item !== null);
        await this.saveOrgForWorkspacePath(workspacePath, nodes);
        await this.refreshWorkspaceState();
        await this.emit({ t: "org.updated", ts: Date.now(), workspaceId, nodes });
        res.json({ ok: true, nodes });
      });
    }

    const orgNodeRoutes = ["/org/nodes", "/api/org/nodes"] as const;
    for (const route of orgNodeRoutes) {
      app.post(route, async (req, res) => {
        const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId : undefined;
        if (!workspaceId) return res.status(400).json({ error: "workspaceId is required" });
        const workspacePath = await this.resolveWorkspacePath(workspaceId);
        if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
        const node = this.normalizeOrgNode(req.body as Record<string, unknown>, workspaceId);
        if (!node) return res.status(400).json({ error: "Invalid node payload" });
        const nodes = await this.loadOrgForWorkspacePath(workspacePath);
        nodes.push(node);
        await this.saveOrgForWorkspacePath(workspacePath, nodes);
        await this.refreshWorkspaceState();
        await this.emit({ t: "org.updated", ts: Date.now(), workspaceId, nodes });
        res.status(201).json({ node });
      });
    }

    const orgNodeItemRoutes = ["/org/nodes/:id", "/api/org/nodes/:id"] as const;
    for (const route of orgNodeItemRoutes) {
      app.delete(route, async (req, res) => {
        const workspaceId = typeof req.query.workspace === "string" ? req.query.workspace : undefined;
        if (!workspaceId) return res.status(400).json({ error: "workspaceId is required" });
        const workspacePath = await this.resolveWorkspacePath(workspaceId);
        if (!workspacePath) return res.status(404).json({ error: "Workspace not found" });
        const nodes = await this.loadOrgForWorkspacePath(workspacePath);
        const before = nodes.length;
        const nextNodes = nodes.filter((node) => node.id !== req.params.id && node.parentId !== req.params.id);
        if (nextNodes.length === before) return res.status(404).json({ error: "Node not found" });
        await this.saveOrgForWorkspacePath(workspacePath, nextNodes);
        await this.refreshWorkspaceState();
        await this.emit({ t: "org.updated", ts: Date.now(), workspaceId, nodes: nextNodes });
        res.json({ ok: true });
      });
    }

    const taskRoutes = ["/tasks", "/api/tasks"] as const;
    for (const route of taskRoutes) {
      app.get(route, async (req, res) => {
        const workspaceId = typeof req.query.workspace === "string" ? req.query.workspace : undefined;
        const workItemId = typeof req.query.workItem === "string" ? req.query.workItem : undefined;
        const items = this.listTasks({ workspaceId, workItemId });
        res.json({ tasks: items });
      });
      app.post(route, async (req, res) => {
        const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
        const assignedToAgentId = String(body.assignedToAgentId ?? "");
        if (!assignedToAgentId) return res.status(400).json({ error: "assignedToAgentId is required" });
        const agent = this.agents.find((item) => item.id === assignedToAgentId);
        if (!agent) return res.status(404).json({ error: "Assigned agent not found" });
        const taskType = this.readTaskType(body.type);
        if (!taskType) return res.status(400).json({ error: "Unsupported task type" });
        const task = await this.createQueuedTask({
          workspaceId: typeof body.workspaceId === "string" ? body.workspaceId : agent.workspaceId,
          title: String(body.title ?? "Untitled Task"),
          description: String(body.description ?? ""),
          type: taskType,
          payload: body.payload && typeof body.payload === "object" ? (body.payload as Record<string, unknown>) : {},
          assignedToAgentId,
          dependsOnTaskIds: this.normalizeStringArray(body.dependsOnTaskIds),
          linkedWorkItemId: typeof body.linkedWorkItemId === "string" ? body.linkedWorkItemId : undefined,
          linkedWorkItemTitle: typeof body.linkedWorkItemTitle === "string" ? body.linkedWorkItemTitle : undefined,
          plannerTaskId: typeof body.plannerTaskId === "string" ? body.plannerTaskId : undefined,
          cycleId: typeof body.cycleId === "string" ? body.cycleId : undefined,
          workstreamId: typeof body.workstreamId === "string" ? body.workstreamId : undefined,
          workstreamType: typeof body.workstreamType === "string" ? body.workstreamType : undefined,
          gateRefs: this.normalizeStringArray(body.gateRefs),
          ownerAgentId: typeof body.ownerAgentId === "string" ? body.ownerAgentId : undefined,
          ownerAgentName: typeof body.ownerAgentName === "string" ? body.ownerAgentName : undefined,
          ownerRole: typeof body.ownerRole === "string" ? body.ownerRole : undefined,
          qaMode: body.qaMode === "scenario" ? "scenario" : body.qaMode === "smoke" ? "smoke" : undefined,
          laneId: typeof body.laneId === "string" ? body.laneId : undefined,
          laneLabel: typeof body.laneLabel === "string" ? body.laneLabel : undefined,
          maxAttempts: typeof body.maxAttempts === "number" && body.maxAttempts > 0 ? Math.floor(body.maxAttempts) : 2
        });
        await this.persistTasks();
        await this.appendLog(task, `Task queued for ${agent.name}`);
        await this.emitTaskQueued(task);
        res.status(201).json({ task });
      });
    }

    const taskItemRoutes = ["/tasks/:id", "/api/tasks/:id"] as const;
    for (const route of taskItemRoutes) {
      app.get(route, async (req, res) => {
        const task = this.tasks.find((item) => item.id === req.params.id);
        if (!task) return res.status(404).json({ error: "Task not found" });
        const logs = await fs.readFile(task.logsPath, "utf8").catch(() => "");
        const artifactEntries = await fs.readdir(task.artifactsPath, { withFileTypes: true }).catch(() => []);
        const artifacts = artifactEntries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
        res.json({ task, logs, artifacts });
      });
    }

    const taskCancelRoutes = ["/tasks/:id/cancel", "/api/tasks/:id/cancel"] as const;
    for (const route of taskCancelRoutes) {
      app.post(route, async (req, res) => {
        const task = this.tasks.find((item) => item.id === req.params.id);
        if (!task) return res.status(404).json({ error: "Task not found" });
        if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") {
          return res.status(400).json({ error: "Task already completed" });
        }
        task.status = "cancelled";
        task.finishedAt = new Date().toISOString();
        task.verdict = "failed";
        task.waitingOnTaskIds = [];
        task.blockedByTaskIds = [];
        await this.persistTasks();
        await this.appendLog(task, "Task cancelled by user");
        await this.emit({ t: "task.cancelled", ts: Date.now(), taskId: task.id });
        await this.reconcileDependencyStates();
        res.json({ task });
      });
    }

    const taskRetryRoutes = ["/tasks/:id/retry", "/api/tasks/:id/retry"] as const;
    for (const route of taskRetryRoutes) {
      app.post(route, async (req, res) => {
        const task = this.tasks.find((item) => item.id === req.params.id);
        if (!task) return res.status(404).json({ error: "Task not found" });
        if (task.attempts >= task.maxAttempts) return res.status(400).json({ error: "Max retry attempts reached" });
        task.status = "queued";
        task.startedAt = undefined;
        task.finishedAt = undefined;
        task.pauseReason = null;
        task.change = null;
        task.validation = null;
        task.verdict = null;
        task.linkedRunId = undefined;
        task.linkedTemplateId = undefined;
        task.waitingOnTaskIds = [];
        task.blockedByTaskIds = [];
        task.resultSummary = undefined;
        await this.persistTasks();
        await this.appendLog(task, "Task moved back to queue");
        await this.emit({ t: "task.queued", ts: Date.now(), task });
        await this.reconcileDependencyStates();
        res.json({ task });
      });
    }

    const messageRoutes = ["/messages", "/api/messages"] as const;
    for (const route of messageRoutes) {
      app.get(route, async (req, res) => {
        const to = typeof req.query.to === "string" ? req.query.to : "";
        const from = typeof req.query.from === "string" ? req.query.from : "";
        const items = this.messages.filter((item) => {
          if (to && item.toAgentId !== to) return false;
          if (from && item.fromAgentId !== from) return false;
          return true;
        });
        res.json({ messages: items });
      });
      app.post(route, async (req, res) => {
        const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
        const fromAgentId = String(body.fromAgentId ?? "");
        const toAgentId = String(body.toAgentId ?? "");
        const topic = String(body.topic ?? "general");
        if (!fromAgentId || !toAgentId) return res.status(400).json({ error: "fromAgentId and toAgentId are required" });
        const fromAgent = this.agents.find((agent) => agent.id === fromAgentId);
        const toAgent = this.agents.find((agent) => agent.id === toAgentId);
        const record: MessageRecord = {
          id: crypto.randomUUID(),
          workspaceId: fromAgent?.workspaceId ?? toAgent?.workspaceId,
          fromAgentId,
          toAgentId,
          topic,
          payload: body.payload && typeof body.payload === "object" ? (body.payload as Record<string, unknown>) : {},
          ts: new Date().toISOString()
        };
        this.messages.push(record);
        await this.persistMessages();
        await this.emit({ t: "message.created", ts: Date.now(), message: record });
        await this.emit({ t: "message.sent", ts: Date.now(), message: record });
        res.status(201).json({ message: record });
      });
    }

  }

  async startMission(options: {
    runsDir: string;
    workspaceId: string;
    repoPath: string;
    templateId: string;
    goal: string;
    runId?: string;
    runOptions?: Omit<RunStartOptions, "sandbox" | "passphrase">;
    traceContext?: {
      workItemId?: string;
      cycleId?: string;
      workstreamId?: string;
      taskId?: string;
      ownerAgentId?: string;
      ownerAgentName?: string;
      ownerRole?: string;
    };
  }): Promise<{ ok: boolean; runId: string }> {
    const agents = await this.ensureWorkspaceLaunchAgents({
      workspaceId: options.workspaceId,
      templateId: options.templateId
    });
    if (agents.length === 0) {
      throw new Error(`No agents configured for workspace ${options.workspaceId}.`);
    }
    const runId = options.runId ?? `mission-${Date.now()}`;
    const workspaceId = options.workspaceId;
    const title = options.templateId;
    const missionRecord: MissionRecord = {
      runId,
      workspaceId,
      templateId: options.templateId,
      title,
      goal: options.goal,
      status: "running",
      updatedAt: new Date().toISOString(),
      activeNodeIds: []
    };
    this.upsertMissionRecord(missionRecord);
    await this.emit({
      t: "mission.queued",
      ts: Date.now(),
      runId,
      workspaceId,
      templateId: options.templateId
    });

    void runMissionDetailed({
      templateId: options.templateId,
      repoPath: options.repoPath,
      runsDir: options.runsDir,
      workspaceId,
      goal: options.goal,
      runId,
      agents: agents.map((agent) => this.toMissionAgent(agent)),
      runOptions: options.runOptions,
      traceContext: options.traceContext,
      onEvent: (event) => this.handleMissionEvent(event)
    })
      .then(async (result) => {
        this.upsertMissionFromRun(result.run);
        await this.emit({
          t: "mission.completed",
          ts: Date.now(),
          runId,
          workspaceId,
          status: result.run.status
        });
      })
      .catch(async (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.upsertMissionRecord({
          ...missionRecord,
          status: "failed",
          updatedAt: new Date().toISOString()
        });
        await this.emit({
          t: "mission.failed",
          ts: Date.now(),
          runId,
          workspaceId,
          error: message
        });
      });

    return { ok: true, runId };
  }

  async resumeMission(options: {
    runsDir: string;
    workspaceId: string;
    runId: string;
  }): Promise<{ ok: boolean; runId: string }> {
    const agents = await this.loadAgentsForWorkspaceId(options.workspaceId);
    try {
      const result = await resumeMissionRun({
        runsDir: options.runsDir,
        workspaceId: options.workspaceId,
        runId: options.runId,
        agents: agents.map((agent) => this.toMissionAgent(agent)),
        onEvent: (event) => this.handleMissionEvent(event)
      });
      this.upsertMissionFromRun(result.run);
      if (result.run.status !== "running") {
        const linkedTasks = this.tasks.filter((task) => task.linkedRunId === result.run.runId);
        for (const task of linkedTasks) {
          await this.syncTaskFromMissionRun(task, result.run);
        }
      }
      return { ok: result.ok || result.run.status === "running" || result.run.status === "paused", runId: options.runId };
    } catch (err: unknown) {
      await this.emit({
        t: "mission.failed",
        ts: Date.now(),
        runId: options.runId,
        workspaceId: options.workspaceId,
        error: err instanceof Error ? err.message : String(err)
      });
      return { ok: false, runId: options.runId };
    }
  }

  async importMissionNode(options: {
    runsDir: string;
    workspaceId: string;
    runId: string;
    nodeId: string;
    text: string;
    targetTool?: string;
  }): Promise<MissionRun> {
    const run = await importMissionNodeInput({
      runsDir: options.runsDir,
      workspaceId: options.workspaceId,
      runId: options.runId,
      nodeId: options.nodeId,
      text: options.text,
      targetTool: options.targetTool,
      onEvent: (event) => this.handleMissionEvent(event)
    });
    this.upsertMissionFromRun(run);
    if (run.status === "running") {
      await this.resumeMission({
        runsDir: options.runsDir,
        workspaceId: options.workspaceId,
        runId: options.runId
      });
    }
    return run;
  }

  async getMissionRun(options: { runsDir: string; workspaceId?: string; runId: string }): Promise<MissionRun | null> {
    const runDir = path.join(options.runsDir, options.workspaceId ?? "default", options.runId);
    return loadMissionRun(runDir);
  }

  async sendBackPausedTaskRun(options: {
    workspaceId: string;
    workItemId?: string;
    taskId?: string;
    runId?: string;
    note?: string | null;
    fallbackTask?: {
      title?: string;
      laneId?: string;
      laneLabel?: string;
      workstreamId?: string | null;
      workstreamType?: string | null;
    };
  }): Promise<{
    ok: boolean;
    taskId: string;
    runId: string;
    taskStatus: TaskStatus;
    runStatus: MissionRun["status"];
  }> {
    let task = this.tasks.find((candidate) => {
      if (candidate.workspaceId !== options.workspaceId) return false;
      if (options.workItemId && candidate.linkedWorkItemId !== options.workItemId) return false;
      if (options.taskId && candidate.id !== options.taskId) return false;
      if (options.runId && candidate.linkedRunId !== options.runId) return false;
      if (!options.taskId && !options.runId) return false;
      return true;
    }) ?? null;
    if (!task) {
      task = await this.recoverPersistedTaskRecord(options);
    }
    if (!task) {
      throw new Error("Selected live task could not be found.");
    }
    if (task.status !== "paused") {
      throw new Error("Selected live task is no longer paused.");
    }

    const runId = task.linkedRunId ?? options.runId ?? null;
    if (!runId) {
      throw new Error("Selected live task does not have a linked run.");
    }

    const runDir = path.join(this.runsDir(), options.workspaceId, runId);
    const run = await loadMissionRun(runDir).catch(() => null);
    if (!run) {
      throw new Error("Selected live run could not be found.");
    }
    if (run.status !== "paused") {
      throw new Error("Selected live run is no longer paused.");
    }

    const cancelledAt = new Date().toISOString();
    const summary = options.note?.trim()
      ? `Operator requested changes: ${options.note.trim()}`
      : "Operator requested changes.";
    const updatedRun = this.buildSendBackMissionRun(run, summary, cancelledAt);

    await writeJson(path.join(runDir, "run.json"), updatedRun);
    this.upsertMissionFromRun(updatedRun);
    this.applyMissionRunToTask(task, updatedRun);
    await this.persistTasks();
    await this.appendLog(task, summary);
    await this.emitTaskStateEvent(task);
    await this.reconcileDependencyStates();

    return {
      ok: true,
      taskId: task.id,
      runId: updatedRun.runId,
      taskStatus: task.status,
      runStatus: updatedRun.status
    };
  }

  listTasks(options?: { workspaceId?: string; workItemId?: string }): TaskRecord[] {
    const workspaceId = options?.workspaceId?.trim();
    const workItemId = options?.workItemId?.trim();
    return this.tasks
      .map((task) => this.backfillLinkedRunMetadata(task))
      .filter((task) => {
        if (workspaceId && task.workspaceId !== workspaceId) return false;
        if (workItemId && task.linkedWorkItemId !== workItemId) return false;
        return true;
      })
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  private backfillLinkedRunMetadata(task: TaskRecord): TaskRecord {
    if (typeof task.linkedRunId === "string" && task.linkedRunId.trim()) {
      return task;
    }
    const artifactPath = path.join(task.artifactsPath, "linked-run.json");
    if (!fsSync.existsSync(artifactPath)) {
      return task;
    }
    try {
      const raw = JSON.parse(fsSync.readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
      const linkedRunId = typeof raw.runId === "string" && raw.runId.trim() ? raw.runId.trim() : "";
      if (!linkedRunId) {
        return task;
      }
      task.linkedRunId = linkedRunId;
      if (!(typeof task.linkedTemplateId === "string" && task.linkedTemplateId.trim())) {
        task.linkedTemplateId = typeof raw.templateId === "string" && raw.templateId.trim() ? raw.templateId.trim() : undefined;
      }
    } catch {
      return task;
    }
    return task;
  }

  async queueWorkItemExecution(options: {
    workspaceId: string;
    workItem: WorkItemRecord;
    detail: WorkItemPlanningDetail;
    cycleId: string;
    cycleSequence: number;
    cycleKind: "initial" | "remediation";
  }): Promise<{ taskIds: string[]; detail: WorkItemPlanningDetail }> {
    const workspaceAgents = await this.loadAgentsForWorkspaceId(options.workspaceId);
    if (workspaceAgents.length === 0) {
      throw new Error(`No agents configured for workspace ${options.workspaceId}.`);
    }
    const workspacePath = await this.resolveWorkspacePath(options.workspaceId);
    if (!workspacePath) {
      throw new Error(`Workspace ${options.workspaceId} is missing or unreadable.`);
    }

    const assignmentByLane = new Map(options.detail.teamAssignments.map((assignment) => [assignment.laneId, assignment]));
    const laneErrors = new Set<string>();
    const taskIdByPlannerId = new Map<string, string>();
    const batchAssignedCount = new Map<string, number>();
    const ownerByWorkstreamId = new Map<string, {
      id: string;
      name: string;
      role: string;
    }>();

    for (const workstream of options.detail.workstreams) {
      const assignment = assignmentByLane.get(workstream.laneId);
      if (!assignment?.matches?.[0]) {
        laneErrors.add(workstream.laneLabel || workstream.laneId);
        continue;
      }
      const selectedMatch = this.selectLaneAgentMatch({
        matches: assignment.matches,
        workspaceAgents,
        batchAssignedCount
      });
      if (!selectedMatch) {
        throw new Error(`Assigned lane ${workstream.laneLabel} no longer has an available specialist.`);
      }
      const assignedAgent = workspaceAgents.find((agent) => agent.id === selectedMatch.id);
      if (!assignedAgent) {
        throw new Error(`Assigned agent ${selectedMatch.name} is no longer available for lane ${workstream.laneLabel}.`);
      }
      batchAssignedCount.set(assignedAgent.id, (batchAssignedCount.get(assignedAgent.id) ?? 0) + 1);
      ownerByWorkstreamId.set(workstream.id, {
        id: assignedAgent.id,
        name: assignedAgent.name,
        role: assignedAgent.role
      });
    }

    for (const plannedTask of options.detail.tasks) {
      taskIdByPlannerId.set(plannedTask.id, crypto.randomUUID());
      if (plannedTask.workstreamId && ownerByWorkstreamId.has(plannedTask.workstreamId)) continue;
      const assignment = assignmentByLane.get(plannedTask.laneId);
      if (!assignment?.matches?.[0]) laneErrors.add(plannedTask.laneLabel || plannedTask.laneId);
    }
    if (laneErrors.size > 0) {
      throw new Error(`No agent coverage for planned lanes: ${Array.from(laneErrors).join(", ")}`);
    }

    const annotatedWorkstreams = options.detail.workstreams.map((workstream) => {
      const owner = ownerByWorkstreamId.get(workstream.id) ?? null;
      return {
        ...workstream,
        cycleId: options.cycleId,
        ownerAgentId: owner?.id ?? null,
        ownerAgentName: owner?.name ?? null,
        ownerRole: owner?.role ?? null
      };
    });
    const annotatedWorkstreamById = new Map(annotatedWorkstreams.map((workstream) => [workstream.id, workstream]));
    const annotatedTasks = options.detail.tasks.map((plannedTask) => {
      const workstream = plannedTask.workstreamId
        ? annotatedWorkstreamById.get(plannedTask.workstreamId) ?? null
        : null;
      return {
        ...plannedTask,
        cycleId: options.cycleId,
        gateRefs: [...(plannedTask.gateRefs ?? workstream?.gateRefs ?? [])],
        ownerAgentId: workstream?.ownerAgentId ?? null,
        ownerAgentName: workstream?.ownerAgentName ?? null,
        ownerRole: workstream?.ownerRole ?? null
      };
    });

    const createdTasks: TaskRecord[] = [];
    for (const plannedTask of annotatedTasks) {
      const assignedOwner =
        (plannedTask.workstreamId ? ownerByWorkstreamId.get(plannedTask.workstreamId) : null) ??
        null;
      if (!assignedOwner) {
        throw new Error(`Workstream ownership is missing for planned task ${plannedTask.title}.`);
      }
      const task = await this.createQueuedTask({
        id: taskIdByPlannerId.get(plannedTask.id),
        workspaceId: options.workspaceId,
        title: plannedTask.title,
        description: [
          plannedTask.description ?? "",
          options.workItem.reviewStatus === "changes_requested" && options.workItem.reviewNote
            ? `Remediation context: ${options.workItem.reviewNote}`
            : ""
        ].filter(Boolean).join("\n\n"),
        type: this.taskTypeForPlannedTask(plannedTask),
        payload: {
          workItemId: options.workItem.id,
          workItemTitle: options.workItem.brief.title,
          sourceType: options.workItem.brief.sourceType,
          request: options.workItem.brief.request,
          sourceRef: options.workItem.brief.sourceRef ?? null,
          planningSummary: options.detail.summary,
          acceptanceCriteria: options.detail.acceptanceCriteria,
          constraints: options.detail.constraints,
          plannerTaskId: plannedTask.id,
          plannerTaskKind: plannedTask.kind,
          cycleId: options.cycleId,
          workstreamId: plannedTask.workstreamId ?? null,
          workstreamType: plannedTask.workstreamType ?? null,
          gateRefs: plannedTask.gateRefs ?? [],
          qaMode: plannedTask.qaMode ?? null,
          laneId: plannedTask.laneId,
          laneLabel: plannedTask.laneLabel,
          roleHint: plannedTask.roleHint ?? null,
          ownerAgentId: assignedOwner.id,
          ownerAgentName: assignedOwner.name,
          ownerRole: assignedOwner.role,
          cycleSequence: options.cycleSequence,
          cycleKind: options.cycleKind,
          reviewStatus: options.workItem.reviewStatus ?? null,
          reviewNote: options.workItem.reviewNote ?? null,
          reviewedAt: options.workItem.reviewedAt ?? null
        },
        assignedToAgentId: assignedOwner.id,
        dependsOnTaskIds: plannedTask.dependsOn
          .map((dependency) => taskIdByPlannerId.get(dependency))
          .filter((dependency): dependency is string => Boolean(dependency)),
        linkedWorkItemId: options.workItem.id,
        linkedWorkItemTitle: options.workItem.brief.title,
        plannerTaskId: plannedTask.id,
        cycleId: options.cycleId,
        workstreamId: plannedTask.workstreamId ?? undefined,
        workstreamType: plannedTask.workstreamType ?? undefined,
        gateRefs: plannedTask.gateRefs ?? [],
        ownerAgentId: assignedOwner.id,
        ownerAgentName: assignedOwner.name,
        ownerRole: assignedOwner.role,
        qaMode: plannedTask.qaMode ?? undefined,
        laneId: plannedTask.laneId,
        laneLabel: plannedTask.laneLabel,
        maxAttempts: plannedTask.kind === "qa" ? 1 : 2
      });
      createdTasks.push(task);
    }

    for (const [index, task] of createdTasks.entries()) {
      const plannedTask = annotatedTasks[index]!;
      const workstream = task.workstreamId ? annotatedWorkstreamById.get(task.workstreamId) ?? null : null;
      const selection = options.detail.teamSelection.find((entry) => entry.laneId === plannedTask.laneId) ?? null;
      await this.recordTaskAssignmentTrace({
        workspacePath,
        workspaceId: options.workspaceId,
        workItem: options.workItem,
        cycleId: options.cycleId,
        task,
        plannedTask,
        workstream,
        selection
      });
    }

      await this.persistTasks();
      for (const task of createdTasks) {
        const agent = workspaceAgents.find((item) => item.id === task.assignedToAgentId);
        await this.appendLog(task, `Task queued for ${agent?.name ?? task.assignedToAgentId}`);
        if (task.dependsOnTaskIds.length > 0) {
          await this.appendLog(task, `Waiting on dependencies: ${task.dependsOnTaskIds.join(", ")}`);
        }
        await this.emitTaskQueued(task);
      }
      await this.reconcileDependencyStates();

    return {
      taskIds: createdTasks.map((task) => task.id),
      detail: {
        ...options.detail,
        tasks: annotatedTasks,
        workstreams: annotatedWorkstreams
      }
    };
  }

  async ensureWorkspaceLaunchAgents(options: {
    workspaceId: string;
    templateId?: string;
  }): Promise<AgentRecord[]> {
    const existingLock = this.bootstrapLocks.get(options.workspaceId);
    if (existingLock) return existingLock;
    const bootstrapPromise = this.ensureWorkspaceLaunchAgentsInternal(options).finally(() => {
      if (this.bootstrapLocks.get(options.workspaceId) === bootstrapPromise) {
        this.bootstrapLocks.delete(options.workspaceId);
      }
    });
    this.bootstrapLocks.set(options.workspaceId, bootstrapPromise);
    return bootstrapPromise;
  }

  private selectLaneAgentMatch(options: {
    matches: Array<{
      id: string;
      name: string;
      score: number;
      maxParallelWork: number;
      state: string;
    }>;
    workspaceAgents: AgentRecord[];
    batchAssignedCount: Map<string, number>;
  }) {
    type RankedMatch = {
      match: {
        id: string;
        name: string;
        score: number;
        maxParallelWork: number;
        state: string;
      };
      score: number;
    };
    return options.matches
      .map((match) => {
        const agent = options.workspaceAgents.find((candidate) => candidate.id === match.id);
        if (!agent) return null;
        const activeLoad = this.agentActiveLoad(agent);
        const batchLoad = options.batchAssignedCount.get(agent.id) ?? 0;
        const remainingCapacity = Math.max(0, match.maxParallelWork - activeLoad - batchLoad);
        const stateBonus = match.state === "idle" ? 4 : match.state === "active" ? 0 : -6;
        const score = match.score * 10 + remainingCapacity * 12 - (activeLoad + batchLoad) * 9 + stateBonus;
        return {
          match,
          score
        };
      })
      .filter((entry): entry is RankedMatch => entry !== null)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return left.match.name.localeCompare(right.match.name);
      })[0]?.match ?? null;
  }

  private startRuntime() {
    if (!this.schedulerTimer) {
      this.schedulerTimer = setInterval(() => {
        void this.schedulerTick();
      }, 1000);
    }
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        void this.heartbeatTick();
      }, 3000);
    }
  }

  private async schedulerTick() {
    await this.reconcileDependencyStates();
    const queued = this.tasks.filter((task) => task.status === "queued");
    for (const task of queued) {
      if (this.runningTaskIds.has(task.id)) continue;
      const dependencyState = this.evaluateTaskDependencies(task);
      if (dependencyState.state !== "ready") continue;
      const agent = this.agents.find((item) => item.id === task.assignedToAgentId);
      if (!agent) {
        task.status = "failed";
        task.finishedAt = new Date().toISOString();
        task.resultSummary = "Assigned agent does not exist";
        task.waitingOnTaskIds = [];
        task.blockedByTaskIds = [];
        await this.persistTasks();
        await this.emit({ t: "task.failed", ts: Date.now(), taskId: task.id, reason: "agent_missing" });
        await this.reconcileDependencyStates();
        continue;
      }
      const maxParallelWork = Math.max(1, Math.floor(agent.profile.maxParallelWork || 1));
      if (this.agentActiveLoad(agent) >= maxParallelWork) continue;
      this.runningTaskIds.add(task.id);
      agent.status.state = "active";
      agent.status.currentTaskIds = Array.from(new Set([...(agent.status.currentTaskIds ?? []), task.id]));
      agent.status.currentTaskId = agent.status.currentTaskIds[0];
      agent.status.lastHeartbeatAt = new Date().toISOString();
      task.status = "running";
      task.startedAt = new Date().toISOString();
      task.attempts += 1;
      task.waitingOnTaskIds = [];
      task.blockedByTaskIds = [];
      task.resultSummary = undefined;
      await Promise.all([this.persistAgents(), this.persistTasks()]);
      await this.emit({
        t: "agent.status",
        ts: Date.now(),
        agentId: agent.id,
        state: agent.status.state,
        currentTaskId: agent.status.currentTaskId,
        currentTaskIds: agent.status.currentTaskIds,
        activeLoad: this.agentActiveLoad(agent)
      });
      await this.emit({ t: "task.started", ts: Date.now(), taskId: task.id, agentId: agent.id });
      void this.executeTask(task, agent)
        .catch(async (err: unknown) => {
          const message = err instanceof Error ? err.message : "Task execution failed";
          task.status = "failed";
          task.finishedAt = new Date().toISOString();
          task.verdict = "failed";
          task.waitingOnTaskIds = [];
          task.blockedByTaskIds = [];
          task.resultSummary = message;
          await this.appendLog(task, `Task failed: ${message}`);
          await this.persistTasks();
          await this.emitTaskStateEvent(task);
          await this.reconcileDependencyStates();
        })
        .finally(async () => {
          agent.status.currentTaskIds = (agent.status.currentTaskIds ?? []).filter((activeTaskId) => activeTaskId !== task.id);
          agent.status.currentTaskId = agent.status.currentTaskIds[0];
          agent.status.state = this.agentActiveLoad(agent) > 0 ? "active" : "idle";
          agent.status.lastHeartbeatAt = new Date().toISOString();
          this.runningTaskIds.delete(task.id);
          await Promise.all([this.persistAgents(), this.persistTasks()]);
          await this.emit({
            t: "agent.status",
            ts: Date.now(),
            agentId: agent.id,
            state: agent.status.state,
            currentTaskId: agent.status.currentTaskId,
            currentTaskIds: agent.status.currentTaskIds,
            activeLoad: this.agentActiveLoad(agent)
          });
        });
    }
  }

  private async heartbeatTick() {
    const now = new Date().toISOString();
    const nowMs = Date.now();
    let changed = false;
    for (const agent of this.agents) {
      if (this.agentActiveLoad(agent) > 0 || agent.status.state === "active") {
        agent.status.state = "active";
        agent.status.lastHeartbeatAt = now;
        changed = true;
        await this.emit({
          t: "agent.status",
          ts: Date.now(),
          agentId: agent.id,
          state: agent.status.state,
          currentTaskId: agent.status.currentTaskId,
          currentTaskIds: agent.status.currentTaskIds,
          activeLoad: this.agentActiveLoad(agent),
          lastHeartbeatAt: now
        });
        continue;
      }

      if (agent.status.state === "idle") {
        const last = Date.parse(agent.status.lastHeartbeatAt);
        const elapsed = Number.isNaN(last) ? 0 : nowMs - last;
        if (elapsed >= 6000) {
          agent.status.state = "sleeping";
          changed = true;
          await this.emit({ t: "agent.status", ts: Date.now(), agentId: agent.id, state: agent.status.state, lastHeartbeatAt: agent.status.lastHeartbeatAt });
        }
      }
    }
    if (changed) {
      await this.persistAgents();
    }
  }

  private async executeTask(task: TaskRecord, agent: AgentRecord) {
    await this.appendLog(task, `Executing ${task.type} task with ${this.describeProvider(agent.provider)}`);
    if (task.type === "qa") {
      await this.executeBrowserQaTask(task, agent);
      return;
    }
    await this.executeMissionBackedTask(task, agent);
  }

  private async executeMissionBackedTask(task: TaskRecord, agent: AgentRecord) {
    if (task.type === "qa") {
      throw new Error(`${task.type} tasks cannot use mission-backed execution.`);
    }
    const templateId = TASK_MISSION_TEMPLATES[task.type];
    const workspaceId = agent.workspaceId;
    if (!workspaceId) {
      throw new Error("Assigned agent must belong to a workspace for mission-backed execution.");
    }
    const workspacePath = await this.resolveWorkspacePath(workspaceId);
    if (!workspacePath || !fsSync.existsSync(workspacePath)) {
      throw new Error(`Workspace ${workspaceId} is missing or unreadable.`);
    }

    const missionAgents = await this.buildTaskMissionAgents(templateId, agent, workspacePath);
    const runId = `task-${task.id.slice(0, 8)}-${Date.now()}`;
    task.linkedRunId = runId;
    task.linkedTemplateId = templateId;
    task.resultSummary = `Mission ${templateId} launched.`;
    task.waitingOnTaskIds = [];
    task.blockedByTaskIds = [];
    await this.persistTasks();
    await this.writeTaskArtifact(task, "linked-run.json", {
      taskId: task.id,
      workspaceId,
      templateId,
      runId,
      repoPath: workspacePath,
      startedAt: new Date().toISOString()
    });
    await this.appendLog(task, `Launching mission ${templateId} in ${workspacePath}`);

    const result = await runMissionDetailed({
      templateId,
      repoPath: workspacePath,
      runsDir: this.runsDir(),
      workspaceId,
      goal: this.buildMissionGoal(task),
      runId,
      agents: missionAgents,
      traceContext: {
        workItemId: task.linkedWorkItemId,
        cycleId: task.cycleId,
        workstreamId: task.workstreamId,
        taskId: task.id,
        ownerAgentId: task.ownerAgentId ?? agent.id,
        ownerAgentName: task.ownerAgentName ?? agent.name,
        ownerRole: task.ownerRole ?? agent.role
      },
      onEvent: (event) => this.handleMissionEvent(event)
    });

    this.upsertMissionFromRun(result.run);
    await this.syncTaskFromMissionRun(task, result.run);
    await this.writeTaskArtifact(task, "run-result.json", {
      runId: result.run.runId,
      status: result.run.status,
      verdict: result.run.verdict ?? null,
      pauseReason: result.run.pauseReason ?? null,
      change: result.run.change ?? null,
      validation: result.run.validation ?? null
    });
    await this.emitTaskStateEvent(task);
  }

  private async executeBrowserQaTask(task: TaskRecord, agent: AgentRecord) {
    const workspaceId = agent.workspaceId;
    if (!workspaceId) {
      throw new Error("Assigned QA agent must belong to a workspace.");
    }
    const workspacePath = await this.resolveWorkspacePath(workspaceId);
    if (!workspacePath || !fsSync.existsSync(workspacePath)) {
      throw new Error(`Workspace ${workspaceId} is missing or unreadable.`);
    }

    const runId = `task-${task.id.slice(0, 8)}-${Date.now()}`;
    task.linkedRunId = runId;
    task.linkedTemplateId = "browser:qa";
    task.resultSummary = task.qaMode === "scenario"
      ? "Browser scenario run launched."
      : "Browser smoke run launched.";
    task.waitingOnTaskIds = [];
    task.blockedByTaskIds = [];
    await this.persistTasks();
    await this.appendLog(task, `Launching browser ${task.qaMode === "scenario" ? "scenario" : "smoke"} in ${workspacePath}`);

    const targetPath =
      typeof task.payload.targetPath === "string" && task.payload.targetPath.trim()
        ? task.payload.targetPath.trim()
        : undefined;
    const baseUrl =
      typeof task.payload.baseUrl === "string" && task.payload.baseUrl.trim()
        ? task.payload.baseUrl.trim()
        : undefined;
    const scenario = Array.isArray(task.payload.scenario)
      ? task.payload.scenario as BrowserScenarioStep[]
      : task.qaMode === "scenario"
        ? this.buildDefaultBrowserScenario(task)
        : undefined;

    const result = await runBrowserRunDetailed({
      kind: "qa",
      repoPath: workspacePath,
      runsDir: this.runsDir(),
      workspaceId,
      runId,
      baseUrl,
      targetPath,
      options: scenario ? { scenario, targetPath } : { targetPath }
    });

    task.finishedAt = new Date().toISOString();
    task.status = result.ok ? "succeeded" : "failed";
    task.verdict = result.ok ? "ready_for_review" : "failed";
    task.waitingOnTaskIds = [];
    task.blockedByTaskIds = [];
    task.resultSummary = result.ok
      ? task.qaMode === "scenario"
        ? "Browser scenario gate passed."
        : "Browser smoke run completed successfully."
      : task.qaMode === "scenario"
        ? "Browser scenario gate failed. Inspect browser run artifacts for step verdicts."
        : "Browser smoke run failed. Inspect browser run artifacts for details.";
    await this.persistTasks();
    await this.writeTaskArtifact(task, "browser-run.json", {
      runId: result.runId,
      runDir: result.runDir,
      ok: result.ok,
      targetPath: targetPath ?? null,
      baseUrl: baseUrl ?? null
    });
    await this.emitTaskStateEvent(task);
    await this.reconcileDependencyStates();
  }

  private buildDefaultBrowserScenario(task: TaskRecord): BrowserScenarioStep[] {
    const targetPath =
      typeof task.payload.targetPath === "string" && task.payload.targetPath.trim()
        ? task.payload.targetPath.trim()
        : "/";
    return [
      { action: "goto", targetPath, waitUntil: "networkidle" },
      { action: "waitFor", selector: "body", timeoutMs: 10000 },
      { action: "assertVisible", selector: "body" },
      { action: "screenshot", name: "scenario-gate", fullPage: true }
    ];
  }

  private async buildTaskMissionAgents(templateId: string, assignedAgent: AgentRecord, workspacePath: string): Promise<MissionAgent[]> {
    const workspaceAgents = await this.loadAgentsForWorkspacePath(workspacePath);
    const missionAgents = workspaceAgents.map((agent) => this.toMissionAgent(agent));
    const template = loadMissionTemplate(templateId);
    for (const role of template.recommendedRoles ?? []) {
      if (missionAgents.some((agent) => this.roleMatches(agent.role, role))) continue;
      missionAgents.push({
        ...this.toMissionAgent(assignedAgent),
        id: `${assignedAgent.id}:${role}`,
        name: `${assignedAgent.name} (${role})`,
        role
      });
    }
    return missionAgents;
  }

  private async syncTaskFromMissionRun(task: TaskRecord, run: MissionRun) {
    this.applyMissionRunToTask(task, run);
    await this.persistTasks();
    await this.appendLog(task, `Mission ${run.runId} ${run.status}: ${task.resultSummary}`);
    await this.reconcileDependencyStates();
  }

  private buildSendBackMissionRun(run: MissionRun, summary: string, cancelledAt: string): MissionRun {
    const nodes = run.graph.nodes.map((node) => {
      if (node.status !== "awaiting_approval" && node.status !== "waiting_input") {
        return node;
      }
      return {
        ...node,
        status: "cancelled" as const,
        pauseReason: null,
        end: node.end ?? cancelledAt,
        error: summary,
        verdict: "blocked" as const
      };
    });

    const latestValidationNode = [...nodes]
      .reverse()
      .find((node) => node.validation && node.validation.status !== "not_requested");
    const latestChangedNode = [...nodes]
      .reverse()
      .find((node) => node.change && node.change.status !== "none");

    return {
      ...run,
      status: "cancelled",
      end: run.end ?? cancelledAt,
      pauseReason: null,
      recovery: null,
      error: summary,
      verdict: "blocked",
      meta: {
        ...(run.meta ?? {}),
        finishedAt: run.meta?.finishedAt ?? cancelledAt
      },
      validation: latestValidationNode?.validation ?? run.validation ?? { status: "not_requested", commands: [], results: [] },
      change: latestChangedNode?.change ?? run.change ?? { status: "none" },
      graph: {
        ...run.graph,
        nodes
      }
    };
  }

  private async recoverPersistedTaskRecord(options: {
    workspaceId: string;
    workItemId?: string;
    taskId?: string;
    runId?: string;
    fallbackTask?: {
      title?: string;
      laneId?: string;
      laneLabel?: string;
      workstreamId?: string | null;
      workstreamType?: string | null;
    };
  }): Promise<TaskRecord | null> {
    if (!options.taskId) {
      return null;
    }
    const taskDir = path.join(this.dataDir, "tasks", options.taskId);
    const linkedRun = await readJsonIfExists<{
      taskId?: string;
      workspaceId?: string;
      templateId?: string;
      runId?: string;
      startedAt?: string;
    }>(path.join(taskDir, "artifacts", "linked-run.json")).catch(() => null);
    const runResult = await readJsonIfExists<{
      status?: string;
      verdict?: string | null;
      pauseReason?: PauseReason | null;
      change?: ChangeState | null;
      validation?: ValidationState | null;
    }>(path.join(taskDir, "artifacts", "run-result.json")).catch(() => null);
    const recoveredWorkspaceId = linkedRun?.workspaceId ?? options.workspaceId;
    const recoveredRunId = linkedRun?.runId ?? options.runId ?? null;
    if (recoveredWorkspaceId !== options.workspaceId || !recoveredRunId) {
      return null;
    }

    const now = new Date().toISOString();
    const recoveredTask = this.normalizeTaskRecord({
      id: options.taskId,
      workspaceId: recoveredWorkspaceId,
      title: options.fallbackTask?.title ?? `Recovered task ${options.taskId.slice(0, 8)}`,
      description: options.fallbackTask?.title ?? "Recovered persisted task.",
      type: this.recoveredTaskType(options.fallbackTask?.laneId ?? null),
      payload: {
        workItemId: options.workItemId ?? null,
        laneId: options.fallbackTask?.laneId ?? null,
        laneLabel: options.fallbackTask?.laneLabel ?? null,
        workstreamId: options.fallbackTask?.workstreamId ?? null,
        workstreamType: options.fallbackTask?.workstreamType ?? null
      },
      assignedToAgentId: "recovered-agent",
      dependsOnTaskIds: [],
      linkedWorkItemId: options.workItemId,
      laneId: options.fallbackTask?.laneId ?? undefined,
      laneLabel: options.fallbackTask?.laneLabel ?? undefined,
      workstreamId: options.fallbackTask?.workstreamId ?? undefined,
      workstreamType: options.fallbackTask?.workstreamType ?? undefined,
      waitingOnTaskIds: [],
      blockedByTaskIds: [],
      status: runResult?.status ?? "paused",
      createdAt: linkedRun?.startedAt ?? now,
      startedAt: linkedRun?.startedAt ?? undefined,
      attempts: 1,
      maxAttempts: 1,
      artifactsPath: path.join(taskDir, "artifacts"),
      logsPath: path.join(taskDir, "logs.ndjson"),
      linkedRunId: recoveredRunId,
      linkedTemplateId: linkedRun?.templateId,
      pauseReason: runResult?.pauseReason ?? null,
      change: runResult?.change ?? null,
      validation: runResult?.validation ?? null,
      verdict: typeof runResult?.verdict === "string" ? runResult.verdict : null,
      resultSummary:
        runResult?.status === "paused"
          ? runResult?.pauseReason === "awaiting_approval"
            ? "Mission paused awaiting approval."
            : "Mission paused awaiting external input."
          : undefined
    });
    this.tasks = [recoveredTask, ...this.tasks.filter((entry) => entry.id !== recoveredTask.id)];
    return recoveredTask;
  }

  private recoveredTaskType(laneId: string | null): TaskType {
    const normalized = laneId?.trim().toLowerCase() ?? "";
    if (normalized === "pm") return "spec";
    if (normalized === "tester") return "validate";
    if (normalized === "qa") return "qa";
    if (normalized === "audit") return "audit";
    return "implement";
  }

  private applyMissionRunToTask(task: TaskRecord, run: MissionRun) {
    task.linkedRunId = run.runId;
    task.linkedTemplateId = run.missionTemplateId;
    task.pauseReason = run.pauseReason ?? null;
    task.change = run.change ?? null;
    task.validation = run.validation ?? null;
    task.verdict = run.verdict ?? null;
    task.finishedAt = run.end ?? new Date().toISOString();
    task.status = this.mapRunStatusToTaskStatus(run.status);
    task.waitingOnTaskIds = [];
    task.blockedByTaskIds = [];
    task.resultSummary = this.summarizeMissionOutcome(run);
  }

  private mapRunStatusToTaskStatus(status: MissionRun["status"]): TaskStatus {
    // Intentional mapping: a mission run that ends as "blocked" indicates
    // unrecoverable findings (e.g., gating/validation blocks) rather than a
    // dependency wait in the task graph. Mapping to "failed" prevents the
    // scheduler from treating downstream tasks as perpetually dependency-blocked.
    if (status === "completed") return "succeeded";
    if (status === "paused") return "paused";
    if (status === "blocked") return "failed";
    if (status === "cancelled") return "cancelled";
    if (status === "failed" || status === "interrupted") return "failed";
    return "running";
  }

  private summarizeMissionOutcome(run: MissionRun): string {
    if (run.status === "completed") {
      const validation = run.validation?.status ?? "not_requested";
      const change = run.change?.status ?? "none";
      return `Mission completed with change=${change} and validation=${validation}.`;
    }
    if (run.status === "paused") {
      return run.pauseReason === "awaiting_approval"
        ? "Mission paused awaiting approval."
        : "Mission paused awaiting external input.";
    }
    if (run.status === "blocked") {
      return run.recovery?.summary ?? run.error ?? "Mission finished with blocking findings.";
    }
    if (run.status === "failed") {
      return run.recovery?.summary ?? run.error ?? "Mission failed.";
    }
    if (run.status === "cancelled") {
      return run.error ?? "Mission cancelled.";
    }
    return `Mission ended with status ${run.status}.`;
  }

  private buildMissionGoal(task: TaskRecord): string {
    const payloadText = JSON.stringify(buildMissionGoalPayload(task.payload ?? {}), null, 2);
    return [
      `Task title: ${task.title}`,
      "",
      task.description.trim(),
      "",
      "Payload:",
      payloadText
    ].join("\n").trim();
  }

  private async recordTaskAssignmentTrace(options: {
    workspacePath: string;
    workspaceId: string;
    workItem: WorkItemRecord;
    cycleId: string;
    task: TaskRecord;
    plannedTask: WorkPlanTask;
    workstream: WorkItemPlanningDetail["workstreams"][number] | null;
    selection: WorkItemPlanningDetail["teamSelection"][number] | null;
  }) {
    const assignmentPrompt = this.buildMissionGoal(options.task);
    const summary = `${options.task.ownerAgentName ?? options.task.assignedToAgentId} assigned ${options.task.title}.`;
    const trace = await appendWorkItemTrace(options.workspacePath, {
      workspaceId: options.workspaceId,
      workItemId: options.workItem.id,
      cycleId: options.cycleId,
      workstreamId: options.task.workstreamId ?? null,
      taskId: options.task.id,
      traceType: "assignment",
      ownerAgentId: options.task.ownerAgentId ?? options.task.assignedToAgentId,
      ownerAgentName: options.task.ownerAgentName ?? null,
      ownerRole: options.task.ownerRole ?? null,
      assignmentToAgentId: options.task.assignedToAgentId,
      assignmentToAgentName: options.task.ownerAgentName ?? null,
      gateRefs: options.task.gateRefs ?? [],
      workstreamTitle: options.workstream?.title ?? null,
      laneLabel: options.task.laneLabel ?? null,
      promptCountDelta: 1,
      summary,
      selectionReason: options.selection?.selectionReason ?? null,
      expectedOutput: options.task.title,
      assignmentPrompt,
      promptSummary: options.plannedTask.description?.trim() || options.task.title,
      payload: {
        taskType: options.task.type,
        plannerTaskKind: options.plannedTask.kind,
        qaMode: options.task.qaMode ?? null,
        dependsOnTaskIds: options.task.dependsOnTaskIds,
        expectedGates: options.selection?.expectedGates ?? [],
        expectedWorkstreams: options.selection?.expectedWorkstreams ?? []
      }
    });
    await this.emit({
      t: "assignment.created",
      ts: Date.now(),
      workspaceId: options.workspaceId,
      workItemId: options.workItem.id,
      cycleId: options.cycleId,
      workstreamId: options.task.workstreamId,
      taskId: options.task.id,
      traceType: trace.traceType,
      ownerAgentId: options.task.ownerAgentId ?? options.task.assignedToAgentId,
      ownerAgentName: options.task.ownerAgentName ?? null,
      assignmentToAgentId: options.task.assignedToAgentId,
      assignmentToAgentName: options.task.ownerAgentName ?? null,
      summary,
      laneLabel: options.task.laneLabel,
      workstreamTitle: options.workstream?.title ?? null,
      taskTitle: options.task.title
    });
  }

  private async recordGateUpdateTraces(workspacePath: string, task: TaskRecord) {
    if (!task.linkedWorkItemId || !task.workspaceId || (task.gateRefs?.length ?? 0) === 0) return;
    for (const gateRef of task.gateRefs ?? []) {
      const summary =
        task.status === "succeeded"
          ? `${gateRef} passed via ${task.title}.`
          : task.status === "failed"
            ? `${gateRef} failed via ${task.title}.`
            : task.status === "blocked" || task.status === "paused"
              ? `${gateRef} is blocked by ${task.title}.`
              : `${gateRef} is pending via ${task.title}.`;
      const trace = await appendWorkItemTrace(workspacePath, {
        workspaceId: task.workspaceId,
        workItemId: task.linkedWorkItemId,
        cycleId: task.cycleId ?? null,
        workstreamId: task.workstreamId ?? null,
        taskId: task.id,
        runId: task.linkedRunId ?? null,
        traceType: "gate_update",
        ownerAgentId: task.ownerAgentId ?? task.assignedToAgentId,
        ownerAgentName: task.ownerAgentName ?? null,
        ownerRole: task.ownerRole ?? null,
        assignmentToAgentId: task.assignedToAgentId,
        gateRefs: [gateRef],
        workstreamTitle: null,
        laneLabel: task.laneLabel ?? null,
        exchangeCountDelta: task.type === "qa" ? 1 : 0,
        summary,
        outputSummary: task.resultSummary ?? null,
        payload: {
          gateId: gateRef,
          status: task.status,
          qaMode: task.qaMode ?? null
        }
      });
      await this.emit({
        t: "gate.updated",
        ts: Date.now(),
        workspaceId: task.workspaceId,
        workItemId: task.linkedWorkItemId,
        cycleId: task.cycleId,
        workstreamId: task.workstreamId,
        taskId: task.id,
        traceType: trace.traceType,
        ownerAgentId: task.ownerAgentId ?? task.assignedToAgentId,
        ownerAgentName: task.ownerAgentName ?? null,
        assignmentToAgentId: task.assignedToAgentId,
        assignmentToAgentName: task.ownerAgentName ?? null,
        gateId: gateRef,
        status: task.status,
        summary,
        laneLabel: task.laneLabel ?? null,
        taskTitle: task.title
      });
    }
  }

  private async recordHandoffTraces(workspacePath: string, task: TaskRecord) {
    if (!task.linkedWorkItemId || !task.workspaceId) return;
    const downstreamTasks = this.tasks.filter((candidate) =>
      candidate.linkedWorkItemId === task.linkedWorkItemId
      && candidate.cycleId === task.cycleId
      && candidate.dependsOnTaskIds.includes(task.id)
    );
    for (const downstream of downstreamTasks) {
      const summary = `${task.title} handed off to ${downstream.title}.`;
      const trace = await appendWorkItemTrace(workspacePath, {
        workspaceId: task.workspaceId,
        workItemId: task.linkedWorkItemId,
        cycleId: task.cycleId ?? null,
        workstreamId: task.workstreamId ?? null,
        taskId: task.id,
        traceType: "handoff",
        ownerAgentId: task.ownerAgentId ?? task.assignedToAgentId,
        ownerAgentName: task.ownerAgentName ?? null,
        ownerRole: task.ownerRole ?? null,
        assignmentToAgentId: downstream.ownerAgentId ?? downstream.assignedToAgentId,
        assignmentToAgentName: downstream.ownerAgentName ?? null,
        gateRefs: downstream.gateRefs ?? [],
        handoffToWorkstreamId: downstream.workstreamId ?? null,
        laneLabel: task.laneLabel ?? null,
        summary,
        outputSummary: task.resultSummary ?? null,
        payload: {
          fromTaskId: task.id,
          toTaskId: downstream.id
        }
      });
      await this.emit({
        t: "handoff.created",
        ts: Date.now(),
        workspaceId: task.workspaceId,
        workItemId: task.linkedWorkItemId,
        cycleId: task.cycleId,
        workstreamId: task.workstreamId,
        taskId: task.id,
        traceType: trace.traceType,
        ownerAgentId: task.ownerAgentId ?? task.assignedToAgentId,
        ownerAgentName: task.ownerAgentName ?? null,
        assignmentToAgentId: downstream.ownerAgentId ?? downstream.assignedToAgentId,
        assignmentToAgentName: downstream.ownerAgentName ?? null,
        handoffToWorkstreamId: downstream.workstreamId,
        summary,
        laneLabel: task.laneLabel ?? null,
        workstreamTitle: task.laneLabel ?? task.workstreamId ?? null,
        taskTitle: task.title
      });
    }
  }

  private async enrichAgentsForRuntime(
    agents: AgentRecord[],
    workspaceId?: string,
    workspacePath?: string | null
  ): Promise<Array<AgentRecord & {
    runtime: {
      providerSummary: string;
      currentModel: string | null;
      providerReadiness: ProviderReadiness;
      providerReadinessReason: string | null;
      promptCount: number;
      exchangeCount: number;
      estimatedCostUsd: number | null;
      assignedWorkItems: string[];
      activeWorkstreams: Array<{
        workstreamId: string;
        laneLabel?: string;
        status: string;
        workItemId?: string;
        taskTitle?: string;
      }>;
      recentAssignmentSummary: string | null;
    };
  }>> {
    const tracesByWorkspace = new Map<string, WorkItemTraceRecord[]>();
    const discoveryByWorkspace = new Map<string, ProviderDiscoveryRecord[]>();
    const workspaceIds = Array.from(new Set(agents.map((agent) => agent.workspaceId).filter((value): value is string => Boolean(value))));
    for (const id of workspaceIds) {
      const resolvedPath = workspaceId && id === workspaceId
        ? workspacePath ?? await this.resolveWorkspacePath(id)
        : await this.resolveWorkspacePath(id);
      if (!resolvedPath) continue;
      tracesByWorkspace.set(id, await loadWorkspaceTraces(resolvedPath).catch(() => []));
      discoveryByWorkspace.set(id, await this.loadProviderDiscoveryForWorkspace(id, resolvedPath));
    }

    return agents.map((agent) => {
      const agentTasks = this.tasks.filter((task) =>
        (!workspaceId || task.workspaceId === workspaceId)
        && (task.assignedToAgentId === agent.id || task.ownerAgentId === agent.id)
      );
      const agentTraces = (agent.workspaceId ? tracesByWorkspace.get(agent.workspaceId) ?? [] : []).filter((trace) =>
        trace.ownerAgentId === agent.id || trace.assignmentToAgentId === agent.id
      );
      const activeWorkstreams = Array.from(new Map(
        agentTasks
          .filter((task) => task.workstreamId && ["queued", "running", "blocked", "paused"].includes(task.status))
          .map((task) => [task.workstreamId!, {
            workstreamId: task.workstreamId!,
            laneLabel: task.laneLabel,
            status: task.status,
            workItemId: task.linkedWorkItemId,
            taskTitle: task.title
          }])
      ).values());
      const assignedWorkItems = Array.from(new Set(agentTasks.map((task) => task.linkedWorkItemId).filter((value): value is string => Boolean(value))));
      const promptCount = agentTraces.reduce((total, trace) => total + Math.max(0, trace.promptCountDelta ?? 0), 0);
      const exchangeCount = agentTraces.reduce((total, trace) => total + Math.max(0, trace.exchangeCountDelta ?? 0), 0);
      const costValues = agentTraces.filter((trace) => typeof trace.estimatedCostUsd === "number").map((trace) => trace.estimatedCostUsd as number);
      const latestModel = [...agentTraces].reverse().find((trace) => trace.providerModel)?.providerModel
        ?? agent.provider.modelOverride
        ?? agent.provider.profileId
        ?? null;
      const recentAssignmentSummary = [...agentTraces].reverse().find((trace) => trace.traceType === "assignment")?.summary ?? null;
      const providerReadiness = this.resolveProviderReadiness(
        agent.provider,
        discoveryByWorkspace.get(agent.workspaceId ?? "") ?? []
      );
      return {
        ...agent,
        runtime: {
          providerSummary: this.describeProvider(agent.provider),
          currentModel: latestModel,
          providerReadiness: providerReadiness.readiness,
          providerReadinessReason: providerReadiness.reason,
          promptCount,
          exchangeCount,
          estimatedCostUsd: costValues.length > 0 ? Number(costValues.reduce((total, value) => total + value, 0).toFixed(6)) : null,
          assignedWorkItems,
          activeWorkstreams,
          recentAssignmentSummary
        }
      };
    });
  }

  private taskTypeForPlannedTask(task: WorkPlanTask): TaskType {
    if (task.kind === "planning" || task.laneId === "pm") return "spec";
    if (task.kind === "validation" || task.laneId === "tester") return "validate";
    if (task.kind === "qa" || task.laneId === "qa") return "qa";
    if (task.kind === "review" || task.laneId === "audit") return "audit";
    if (task.kind === "implementation") return "implement";
    throw new Error(`Unsupported planned task kind: ${task.kind}`);
  }

  private async createQueuedTask(input: {
    id?: string;
    workspaceId?: string;
    title: string;
    description: string;
    type: TaskType;
    payload: Record<string, unknown>;
    assignedToAgentId: string;
    dependsOnTaskIds?: string[];
    linkedWorkItemId?: string;
    linkedWorkItemTitle?: string;
    plannerTaskId?: string;
    cycleId?: string;
    workstreamId?: string;
    workstreamType?: string;
    gateRefs?: string[];
    ownerAgentId?: string;
    ownerAgentName?: string;
    ownerRole?: string;
    qaMode?: "smoke" | "scenario";
    laneId?: string;
    laneLabel?: string;
    maxAttempts?: number;
  }): Promise<TaskRecord> {
    const taskId = input.id ?? crypto.randomUUID();
    const workspacePath = input.workspaceId
      ? await this.resolveWorkspacePath(input.workspaceId)
      : path.resolve(this.options.rootDir);
    const taskRoot = getWorkspaceTaskArtifactsRoot(workspacePath ?? this.options.rootDir);
    const taskDir = path.join(taskRoot, taskId);
    await fs.mkdir(taskDir, { recursive: true });
    const logsPath = path.join(taskDir, "logs.ndjson");
    const artifactsPath = path.join(taskDir, "artifacts");
    await fs.mkdir(artifactsPath, { recursive: true });
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: taskId,
      workspaceId: input.workspaceId,
      title: input.title,
      description: input.description,
      type: input.type,
      payload: input.payload,
      assignedToAgentId: input.assignedToAgentId,
      dependsOnTaskIds: Array.from(new Set(input.dependsOnTaskIds ?? [])),
      linkedWorkItemId: input.linkedWorkItemId,
      linkedWorkItemTitle: input.linkedWorkItemTitle,
      plannerTaskId: input.plannerTaskId,
      cycleId: input.cycleId,
      workstreamId: input.workstreamId,
      workstreamType: input.workstreamType,
      gateRefs: [...(input.gateRefs ?? [])],
      ownerAgentId: input.ownerAgentId ?? input.assignedToAgentId,
      ownerAgentName: input.ownerAgentName,
      ownerRole: input.ownerRole,
      qaMode: input.qaMode,
      laneId: input.laneId,
      laneLabel: input.laneLabel,
      waitingOnTaskIds: [],
      blockedByTaskIds: [],
      status: "queued",
      createdAt: now,
      attempts: 0,
      maxAttempts: typeof input.maxAttempts === "number" && input.maxAttempts > 0 ? Math.floor(input.maxAttempts) : 2,
      artifactsPath,
      logsPath
    };
    this.tasks.push(task);
    return task;
  }

  private async emitTaskQueued(task: TaskRecord) {
    await this.emit({ t: "task.created", ts: Date.now(), task });
    await this.emit({ t: "task.queued", ts: Date.now(), task });
  }

  private async writeTaskArtifact(task: TaskRecord, fileName: string, payload: unknown) {
    const artifactPath = path.join(task.artifactsPath, fileName);
    const content = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    await fs.writeFile(artifactPath, content, "utf8");
  }

  private async emitTaskStateEvent(task: TaskRecord) {
    const eventType = task.status === "succeeded"
      ? "task.succeeded"
      : task.status === "paused"
        ? "task.paused"
        : task.status === "blocked"
          ? "task.blocked"
          : task.status === "cancelled"
            ? "task.cancelled"
            : task.status === "failed"
            ? "task.failed"
            : "task.updated";
    if (task.workspaceId && task.linkedWorkItemId) {
      const workspacePath = await this.resolveWorkspacePath(task.workspaceId);
      if (workspacePath) {
        await this.recordGateUpdateTraces(workspacePath, task);
        if (task.status === "succeeded") {
          await this.recordHandoffTraces(workspacePath, task);
        }
      }
    }
    await this.emit({
      t: eventType,
      ts: Date.now(),
      taskId: task.id,
      workspaceId: task.workspaceId,
      workItemId: task.linkedWorkItemId,
      cycleId: task.cycleId,
      workstreamId: task.workstreamId,
      ownerAgentId: task.ownerAgentId ?? task.assignedToAgentId,
      assignmentToAgentId: task.assignedToAgentId,
      linkedRunId: task.linkedRunId,
      status: task.status,
      resultSummary: task.resultSummary,
      pauseReason: task.pauseReason ?? undefined,
      verdict: task.verdict ?? undefined
    });
  }

  private evaluateTaskDependencies(task: TaskRecord): {
    state: "ready" | "waiting" | "blocked";
    waitingOnTaskIds: string[];
    blockedByTaskIds: string[];
    reason?: string;
  } {
    if (task.dependsOnTaskIds.length === 0) {
      return {
        state: "ready",
        waitingOnTaskIds: [],
        blockedByTaskIds: []
      };
    }

    const waitingOnTaskIds: string[] = [];
    const blockedByTaskIds: string[] = [];
    const missingDependencyIds: string[] = [];

    for (const dependencyId of task.dependsOnTaskIds) {
      const dependency = this.tasks.find((candidate) => candidate.id === dependencyId);
      if (!dependency) {
        missingDependencyIds.push(dependencyId);
        continue;
      }
      if (dependency.status === "succeeded") continue;
      if (dependency.status === "failed" || dependency.status === "cancelled" || dependency.status === "blocked" || dependency.status === "paused") {
        blockedByTaskIds.push(dependencyId);
        continue;
      }
      waitingOnTaskIds.push(dependencyId);
    }

    if (missingDependencyIds.length > 0) {
      return {
        state: "blocked",
        waitingOnTaskIds: [],
        blockedByTaskIds: Array.from(new Set([...blockedByTaskIds, ...missingDependencyIds])),
        reason: `Blocked because dependency records are missing: ${missingDependencyIds.join(", ")}`
      };
    }

    if (blockedByTaskIds.length > 0) {
      return {
        state: "blocked",
        waitingOnTaskIds: [],
        blockedByTaskIds: Array.from(new Set(blockedByTaskIds)),
        reason: `Blocked by upstream tasks: ${Array.from(new Set(blockedByTaskIds)).join(", ")}`
      };
    }

    if (waitingOnTaskIds.length > 0) {
      return {
        state: "waiting",
        waitingOnTaskIds: Array.from(new Set(waitingOnTaskIds)),
        blockedByTaskIds: [],
        reason: `Waiting on dependencies: ${Array.from(new Set(waitingOnTaskIds)).join(", ")}`
      };
    }

    return {
      state: "ready",
      waitingOnTaskIds: [],
      blockedByTaskIds: []
    };
  }

  private async reconcileDependencyStates() {
    const changedTasks: TaskRecord[] = [];

    for (const task of this.tasks) {
      // Recovery: tasks that already ran (linkedRunId present) but ended with mission-blocked
      // status are in a bad state regardless of dependency count. Map to "failed" immediately.
      if (task.status === "blocked" && task.linkedRunId) {
        task.status = "failed";
        task.resultSummary = task.resultSummary ?? "Mission finished with blocking findings.";
        task.waitingOnTaskIds = [];
        task.blockedByTaskIds = [];
        changedTasks.push(task);
        await this.appendLog(task, "Mission ended 'blocked'; marking task as failed to avoid dependency deadlock.");
        continue;
      }

      // Recovery: tasks stuck in "running" after service restart. If a task has been running
      // with a linkedRunId but the run has completed on disk, sync the final state.
      if (task.status === "running" && task.linkedRunId) {
        const runDir = path.join(this.runsDir(), task.workspaceId ?? "unknown", task.linkedRunId);
        const runJsonPath = path.join(runDir, "run.json");
        if (fsSync.existsSync(runJsonPath)) {
          try {
            const diskRun = JSON.parse(fsSync.readFileSync(runJsonPath, "utf8")) as MissionRun;
            if (diskRun.status !== "running" && diskRun.status !== "paused") {
              await this.syncTaskFromMissionRun(task, diskRun);
              changedTasks.push(task);
              await this.appendLog(task, `Recovered orphaned running task from disk run (status=${diskRun.status}).`);
            }
          } catch { /* disk read failure - skip recovery */ }
        }
        continue;
      }

      if (task.dependsOnTaskIds.length === 0) continue;
      if (task.status === "running" || task.status === "succeeded" || task.status === "failed" || task.status === "cancelled" || task.status === "paused") {
        continue;
      }

      const evaluation = this.evaluateTaskDependencies(task);
      const dependencyManaged = task.blockedByTaskIds.length > 0 || task.waitingOnTaskIds.length > 0;
      let nextStatus: TaskStatus = task.status;
      let nextSummary = task.resultSummary;
      let nextWaiting = task.waitingOnTaskIds;
      let nextBlocked = task.blockedByTaskIds;
      if (evaluation.state === "blocked") {
        nextStatus = "blocked";
        nextSummary = evaluation.reason;
        nextWaiting = [];
        nextBlocked = evaluation.blockedByTaskIds;
      } else if (evaluation.state === "waiting") {
        nextStatus = "queued";
        nextSummary = evaluation.reason;
        nextWaiting = evaluation.waitingOnTaskIds;
        nextBlocked = [];
      } else if (dependencyManaged) {
        nextStatus = "queued";
        nextSummary = undefined;
        nextWaiting = [];
        nextBlocked = [];
      }

      const changed =
        nextStatus !== task.status ||
        nextSummary !== task.resultSummary ||
        !this.sameStringArray(nextWaiting, task.waitingOnTaskIds) ||
        !this.sameStringArray(nextBlocked, task.blockedByTaskIds);
      if (!changed) continue;

      const previousStatus = task.status;
      task.status = nextStatus;
      task.resultSummary = nextSummary;
      task.waitingOnTaskIds = nextWaiting;
      task.blockedByTaskIds = nextBlocked;
      changedTasks.push(task);

      if (nextStatus === "blocked" && previousStatus !== "blocked") {
        await this.appendLog(task, nextSummary ?? "Task blocked by dependency state.");
      } else if (nextStatus === "queued" && previousStatus === "blocked") {
        await this.appendLog(task, "Dependencies changed; task returned to queue.");
      }
    }

    if (changedTasks.length === 0) return;
    await this.persistTasks();
    for (const task of changedTasks) {
      await this.emitTaskStateEvent(task);
    }
  }

  private sameStringArray(left: string[], right: string[]): boolean {
    if (left.length !== right.length) return false;
    return left.every((item, index) => item === right[index]);
  }

  private agentActiveLoad(agent: AgentRecord): number {
    return Array.isArray(agent.status.currentTaskIds) && agent.status.currentTaskIds.length > 0
      ? agent.status.currentTaskIds.length
      : agent.status.currentTaskId
        ? 1
        : 0;
  }

  private roleMatches(role: string, requiredRole: string): boolean {
    const normalizedRole = role.trim().toLowerCase();
    const normalizedRequired = requiredRole.trim().toLowerCase();
    return normalizedRole === normalizedRequired || normalizedRole.includes(normalizedRequired) || normalizedRequired.includes(normalizedRole);
  }

  private readTaskType(input: unknown): TaskType | null {
    if (input === "spec" || input === "implement" || input === "validate" || input === "qa" || input === "audit") {
      return input;
    }
    return null;
  }

  private normalizeTaskType(input: unknown): TaskType {
    return this.readTaskType(input) ?? "spec";
  }

  private normalizeOrgNode(input: Record<string, unknown> | null, workspaceId?: string): OrgNode | null {
    if (!input) return null;
    const agentId = typeof input.agentId === "string" ? input.agentId : "";
    if (!agentId) return null;
    const node: OrgNode = {
      id: typeof input.id === "string" && input.id ? input.id : crypto.randomUUID(),
      workspaceId,
      agentId,
      parentId: typeof input.parentId === "string" && input.parentId ? input.parentId : undefined,
      department: typeof input.department === "string" ? input.department : undefined,
      position: typeof input.position === "string" ? input.position : undefined,
      x: typeof input.x === "number" ? input.x : undefined,
      y: typeof input.y === "number" ? input.y : undefined
    };
    return node;
  }

  private normalizeStringArray(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    return input
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => Boolean(item));
  }

  private readBoolean(parent: unknown, key: string, defaultValue: boolean): boolean {
    if (!parent || typeof parent !== "object") return defaultValue;
    const value = (parent as Record<string, unknown>)[key];
    return typeof value === "boolean" ? value : defaultValue;
  }

  private async appendLog(task: TaskRecord, message: string) {
    const line = JSON.stringify({ ts: new Date().toISOString(), message });
    await fs.writeFile(task.logsPath, `${line}\n`, { encoding: "utf8", flag: "a" });
  }

  private async emit(event: RuntimeEvent) {
    const line = `${JSON.stringify(event)}\n`;
    await fs.writeFile(this.eventsPath, line, { encoding: "utf8", flag: "a" }).catch(() => undefined);
    const workspaceId = this.extractWorkspaceIdFromEvent(event);
    if (workspaceId) {
      const workspacePath = await this.resolveWorkspacePath(workspaceId).catch(() => null);
      if (workspacePath) {
        await appendWorkspaceSignal(workspacePath, {
          workspaceId,
          source: this.signalSourceForEvent(event),
          type: String(event.t ?? "execution.event"),
          entityId:
            typeof event.taskId === "string"
              ? event.taskId
              : typeof event.workstreamId === "string"
                ? event.workstreamId
                : typeof event.workItemId === "string"
                  ? event.workItemId
                  : typeof event.traceId === "string"
                    ? event.traceId
                    : typeof event.handoffToWorkstreamId === "string"
                      ? event.handoffToWorkstreamId
                      : typeof event.gateId === "string"
                        ? event.gateId
              : typeof event.linkedRunId === "string"
                ? event.linkedRunId
                : undefined,
          status: typeof event.status === "string" ? event.status : undefined,
          summary: this.summarizeRuntimeEvent(event),
          payload: event as Record<string, unknown>
        }).catch(() => undefined);
      }
    }
    if (this.logger) {
      await this.logger.info("agent.event", event as Record<string, unknown>);
    }
  }

  private extractWorkspaceIdFromEvent(event: RuntimeEvent): string | null {
    if (typeof event.workspaceId === "string" && event.workspaceId.trim()) return event.workspaceId;
    const taskId = typeof event.taskId === "string" ? event.taskId : null;
    if (taskId) {
      const task = this.tasks.find((entry) => entry.id === taskId);
      if (task?.workspaceId) return task.workspaceId;
    }
    const agent = event.agent && typeof event.agent === "object" ? event.agent as { workspaceId?: unknown } : null;
    if (typeof agent?.workspaceId === "string" && agent.workspaceId.trim()) return agent.workspaceId;
    const message = event.message && typeof event.message === "object" ? event.message as { workspaceId?: unknown } : null;
    if (typeof message?.workspaceId === "string" && message.workspaceId.trim()) return message.workspaceId;
    return null;
  }

  private signalSourceForEvent(event: RuntimeEvent): "mission" | "execution" | "browser" | "review" | "work" | "supervisor" | "plugin" {
    const type = String(event.t ?? "execution.event");
    if (type.startsWith("mission.")) return "mission";
    if (type.startsWith("selection.") || type.startsWith("assignment.") || type.startsWith("handoff.") || type.startsWith("gate.") || type.startsWith("cost.")) {
      return "work";
    }
    return "execution";
  }

  private summarizeRuntimeEvent(event: RuntimeEvent): string {
    const type = String(event.t ?? "execution.event");
    if (typeof event.summary === "string" && event.summary.trim()) {
      return event.summary;
    }
    if (type === "assignment.created") {
      const assignee = typeof event.assignmentToAgentId === "string" ? event.assignmentToAgentId : "specialist";
      const title = typeof event.workstreamTitle === "string" ? event.workstreamTitle : typeof event.taskId === "string" ? event.taskId : "workstream";
      return `${assignee} assigned ${title}`;
    }
    if (type === "handoff.created") {
      const target = typeof event.handoffToWorkstreamId === "string" ? event.handoffToWorkstreamId : "next lane";
      return `Handoff prepared for ${target}`;
    }
    if (type === "gate.updated") {
      const gateId = typeof event.gateId === "string" ? event.gateId : "gate";
      const status = typeof event.status === "string" ? event.status : "updated";
      return `${gateId} ${status}`;
    }
    if (type === "cost.updated") {
      const model = typeof event.providerModel === "string" ? event.providerModel : "provider";
      return `Estimated cost updated for ${model}`;
    }
    if (type === "prompt.sent") {
      const model = typeof event.providerModel === "string" ? event.providerModel : "provider";
      return `Prompt sent via ${model}`;
    }
    if (type === "response.received") {
      const model = typeof event.providerModel === "string" ? event.providerModel : "provider";
      return `Response received from ${model}`;
    }
    return type;
  }

  private async readJson<T>(filePath: string, fallback: T): Promise<T> {
    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    if (!raw.trim()) {
      await fs.writeFile(filePath, JSON.stringify(fallback, null, 2), "utf8").catch(() => undefined);
      return fallback;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private async persistAgents() {
    return;
  }

  private async persistOrg() {
    return;
  }

  private async persistTasks() {
    const workspaces = await this.listKnownWorkspaces();
    const fallbackRoot = path.resolve(this.options.rootDir);
    const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace.path]));
    const grouped = new Map<string, TaskRecord[]>();
    for (const task of this.tasks) {
      const workspacePath = task.workspaceId ? workspaceById.get(task.workspaceId) ?? fallbackRoot : fallbackRoot;
      const bucket = grouped.get(workspacePath) ?? [];
      bucket.push(task);
      grouped.set(workspacePath, bucket);
    }
    for (const [workspacePath, tasks] of grouped.entries()) {
      await fs.mkdir(path.dirname(getWorkspaceTasksFilePath(workspacePath)), { recursive: true });
      await fs.writeFile(getWorkspaceTasksFilePath(workspacePath), JSON.stringify(tasks, null, 2), "utf8");
    }
  }

  private async persistMessages() {
    const workspaces = await this.listKnownWorkspaces();
    const fallbackRoot = path.resolve(this.options.rootDir);
    const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace.path]));
    const grouped = new Map<string, MessageRecord[]>();
    for (const message of this.messages) {
      const workspacePath = message.workspaceId ? workspaceById.get(message.workspaceId) ?? fallbackRoot : fallbackRoot;
      const bucket = grouped.get(workspacePath) ?? [];
      bucket.push(message);
      grouped.set(workspacePath, bucket);
    }
    for (const [workspacePath, messages] of grouped.entries()) {
      await fs.mkdir(path.dirname(getWorkspaceMessagesFilePath(workspacePath)), { recursive: true });
      await fs.writeFile(getWorkspaceMessagesFilePath(workspacePath), JSON.stringify(messages, null, 2), "utf8");
    }
  }

  private async refreshWorkspaceState() {
    const workspaces = await this.listKnownWorkspaces();
    const agents: AgentRecord[] = [];
    const orgNodes: OrgNode[] = [];
    const tasks: TaskRecord[] = [];
    const messages: MessageRecord[] = [];
    for (const workspace of workspaces) {
      const workspaceAgents = await this.loadAgentsForWorkspacePath(workspace.path);
      const workspaceOrg = await this.loadOrgForWorkspacePath(workspace.path);
      const workspaceTasks = await this.loadTasksForWorkspacePath(workspace.path);
      const workspaceMessages = await this.loadMessagesForWorkspacePath(workspace.path);
      agents.push(...workspaceAgents);
      orgNodes.push(...workspaceOrg);
      tasks.push(...workspaceTasks);
      messages.push(...workspaceMessages);
    }
    this.agents = agents;
    this.orgNodes = orgNodes;
    this.tasks = tasks.map((task) => this.normalizeTaskRecord(task));
    this.messages = messages;
    const reconciled = await this.reconcilePersistedTaskRuns();
    if (reconciled) {
      await this.reconcileDependencyStates();
    }
  }

  private async reconcilePersistedTaskRuns(): Promise<boolean> {
    let changed = false;
    for (const task of this.tasks) {
      if (!task.workspaceId || !task.linkedRunId) continue;
      if (!["queued", "running", "paused", "blocked"].includes(task.status)) continue;
      const runDir = path.join(this.runsDir(), task.workspaceId, task.linkedRunId);
      const run = await loadMissionRun(runDir).catch(() => null);
      if (!run || run.status === "running") continue;
      this.applyMissionRunToTask(task, run);
      changed = true;
    }
    if (changed) {
      await this.persistTasks();
    }
    return changed;
  }

  private async resolveWorkspacePath(workspaceId: string): Promise<string | null> {
    const workspaces = await this.listKnownWorkspaces();
    return findWorkspaceById(workspaces, workspaceId)?.path ?? null;
  }

  private async listKnownWorkspaces() {
    const repoPaths = this.options.listWorkspacePaths ? await this.options.listWorkspacePaths().catch(() => []) : [];
    return loadWorkspaces(this.options.rootDir, { repoPaths }).catch(() => []);
  }

  private runsDir(): string {
    return process.env.ORCHESTRUM_RUNS_DIR?.trim() || path.join(this.options.rootDir, "runs");
  }

  private getWorkspaceAgentsPath(workspacePath: string): string {
    return getWorkspaceAgentsFilePath(workspacePath);
  }

  private getWorkspaceOrgPath(workspacePath: string): string {
    return getWorkspaceOrgFilePath(workspacePath);
  }

  private async loadAgentsForWorkspaceId(workspaceId: string): Promise<AgentRecord[]> {
    const workspacePath = await this.resolveWorkspacePath(workspaceId);
    if (!workspacePath) return [];
    return this.loadAgentsForWorkspacePath(workspacePath);
  }

  private async loadAgentsForWorkspacePath(workspacePath: string): Promise<AgentRecord[]> {
    const raw = await this.readJson<unknown[]>(this.getWorkspaceAgentsPath(workspacePath), []);
    if (!Array.isArray(raw)) return [];
    return raw.map((entry) => this.normalizeAgentRecord(entry));
  }

  private async saveAgentsForWorkspacePath(workspacePath: string, agents: AgentRecord[]) {
    await fs.mkdir(path.dirname(this.getWorkspaceAgentsPath(workspacePath)), { recursive: true });
    const normalized = agents.map((agent) => ({
      ...agent,
      provider: normalizeMissionProvider(agent.provider, agent.role)
    }));
    await fs.writeFile(this.getWorkspaceAgentsPath(workspacePath), JSON.stringify(normalized, null, 2), "utf8");
  }

  private async ensureWorkspaceLaunchAgentsInternal(options: {
    workspaceId: string;
    templateId?: string;
  }): Promise<AgentRecord[]> {
    const workspacePath = await this.resolveWorkspacePath(options.workspaceId);
    if (!workspacePath) return [];

    await initTeamPreset({
      repoPath: workspacePath,
      workspaceId: options.workspaceId
    }).catch(() => null);

    const existing = await this.loadAgentsForWorkspacePath(workspacePath);
    const normalizedExisting = this.normalizeLegacyBootstrapAgents(existing);
    if (normalizedExisting.changed) {
      await this.saveAgentsForWorkspacePath(workspacePath, normalizedExisting.agents);
      await this.refreshWorkspaceState();
    }
    const requirements = this.bootstrapRequirementsForTemplate(options.templateId);
    const missing = requirements.filter((requirement) =>
      !normalizedExisting.agents.some((agent) => this.agentSatisfiesBootstrapRequirement(agent, requirement))
    );
    if (missing.length === 0) return normalizedExisting.agents;

    const now = new Date().toISOString();
    const created = await Promise.all(missing.map((requirement) => this.createBootstrapAgent({
      workspacePath,
      workspaceId: options.workspaceId,
      role: requirement.role,
      specialization: requirement.specialization,
      name: requirement.name,
      maxParallelWork: requirement.maxParallelWork,
      createdAt: now
    })));
    const next = [...normalizedExisting.agents, ...created];
    await this.saveAgentsForWorkspacePath(workspacePath, next);
    await this.refreshWorkspaceState();
    for (const agent of created) {
      await this.emit({
        t: "agent.bootstrap_created",
        ts: Date.now(),
        workspaceId: options.workspaceId,
        agent,
        summary: `${agent.name} was created automatically so work can launch without manual specialist setup.`
      });
    }
    return next;
  }

  private bootstrapRequirementsForTemplate(templateId?: string): Array<{
    role: string;
    specialization: string;
    name: string;
    maxParallelWork: number;
  }> {
    const requestedTemplateId =
      typeof templateId === "string" && templateId.trim()
        ? templateId.trim()
        : "feature-dev";
    const recommendedRoles = new Set(loadMissionTemplate(requestedTemplateId).recommendedRoles ?? []);
    if (requestedTemplateId === "audit-only") {
      recommendedRoles.add("pm");
    }
    const requirements: Array<{
      role: string;
      specialization: string;
      name: string;
      maxParallelWork: number;
    }> = [];
    if (recommendedRoles.has("pm")) {
      requirements.push({
        role: "pm",
        specialization: "pm",
        name: "PM Agent",
        maxParallelWork: 1
      });
    }
    if (recommendedRoles.has("dev")) {
      requirements.push(
        {
          role: "dev",
          specialization: "frontend",
          name: "Frontend Agent",
          maxParallelWork: 1
        },
        {
          role: "dev",
          specialization: "backend",
          name: "Backend Agent",
          maxParallelWork: 1
        },
        {
          role: "dev",
          specialization: "fullstack",
          name: "Developer Agent",
          maxParallelWork: 2
        },
        {
          role: "dev",
          specialization: "tester",
          name: "Tester Agent",
          maxParallelWork: 1
        },
        {
          role: "dev",
          specialization: "qa",
          name: "QA Agent",
          maxParallelWork: 1
        }
      );
    }
    if (recommendedRoles.has("audit") || recommendedRoles.has("security")) {
      requirements.push({
        role: "audit",
        specialization: "audit",
        name: recommendedRoles.has("security") ? "Security Audit Agent" : "Audit Agent",
        maxParallelWork: 1
      });
    }
    if (requirements.length === 0) {
      requirements.push({
        role: "dev",
        specialization: "fullstack",
        name: "Developer Agent",
        maxParallelWork: 2
      });
    }
    return requirements;
  }

  private agentSatisfiesBootstrapRequirement(
    agent: AgentRecord,
    requirement: {
      role: string;
      specialization: string;
    }
  ): boolean {
    if (!this.roleMatches(agent.role, requirement.role)) return false;
    const specialization = agent.profile.specialization.trim().toLowerCase();
    const required = requirement.specialization.trim().toLowerCase();
    return specialization === required;
  }

  private normalizeLegacyBootstrapAgents(agents: AgentRecord[]): { changed: boolean; agents: AgentRecord[] } {
    let changed = false;
    const normalized = agents.map((agent) => {
      const specialization = agent.profile.specialization.trim().toLowerCase();
      const isAutoBootstrap = agent.tags.includes("auto-bootstrap") || agent.tags.includes("preset");
      if (!isAutoBootstrap) return agent;
      if (specialization === "fullstack" && agent.name === "Delivery Agent") {
        changed = true;
        return {
          ...agent,
          name: "Developer Agent",
          updatedAt: new Date().toISOString()
        };
      }
      return agent;
    });
    return { changed, agents: normalized };
  }

  private createBootstrapAgent(options: {
    workspacePath: string;
    workspaceId: string;
    role: string;
    specialization: string;
    name: string;
    maxParallelWork: number;
    createdAt: string;
  }): Promise<AgentRecord> {
    return this.buildBootstrapAgent(options);
  }

  private async buildBootstrapAgent(options: {
    workspacePath: string;
    workspaceId: string;
    role: string;
    specialization: string;
    name: string;
    maxParallelWork: number;
    createdAt: string;
  }): Promise<AgentRecord> {
    const provider = await this.selectBootstrapProvider({
      workspacePath: options.workspacePath,
      role: options.role
    });
    return {
      id: crypto.randomUUID(),
      workspaceId: options.workspaceId,
      name: options.name,
      role: options.role,
      tags: ["preset", "auto-bootstrap"],
      profile: {
        specialization: options.specialization,
        seniority: options.role === "pm" ? "lead" : "senior",
        maxParallelWork: options.maxParallelWork
      },
      provider: provider.provider,
      capabilities: {
        shell: false,
        fs: true,
        network: true
      },
      status: {
        state: "idle",
        currentTaskIds: [],
        lastHeartbeatAt: options.createdAt
      },
      createdAt: options.createdAt,
      updatedAt: options.createdAt
    };
  }

  private async selectBootstrapProvider(options: {
    workspacePath: string;
    role: string;
  }): Promise<{ provider: MissionProviderSpec; readiness: ProviderReadiness; reason: string }> {
    const workspaceId = (await this.listKnownWorkspaces())
      .find((workspace) => workspace.path === options.workspacePath)
      ?.id;
    const discovery = await this.loadProviderDiscoveryForWorkspace(
      workspaceId ?? options.workspacePath,
      options.workspacePath
    );

    const configuredLocal = this.selectDiscoveryProviderCandidate(
      discovery,
      options.role,
      (transport) => transport.configured && this.isLocalTransport(transport.transport)
    );
    if (configuredLocal) {
      return {
        provider: configuredLocal,
        readiness: "usable_now",
        reason: `Bootstrap chose ${this.describeProvider(configuredLocal)} because it is configured on this machine right now.`
      };
    }

    const detectedLocal = this.selectDiscoveryProviderCandidate(
      discovery,
      options.role,
      (transport) => transport.available && this.isLocalTransport(transport.transport)
    );
    if (detectedLocal) {
      return {
        provider: detectedLocal,
        readiness: "detected_needs_setup",
        reason: `Bootstrap chose ${this.describeProvider(detectedLocal)} because it was detected locally, but still needs sign-in or setup.`
      };
    }

    const configuredRemote = this.selectDiscoveryProviderCandidate(
      discovery,
      options.role,
      (transport) => transport.configured
    );
    if (configuredRemote) {
      return {
        provider: configuredRemote,
        readiness: "usable_now",
        reason: `Bootstrap chose ${this.describeProvider(configuredRemote)} because it is already configured.`
      };
    }

    const fallback = normalizeMissionProvider(defaultProviderForRole(options.role), options.role);
    return {
      provider: fallback,
      readiness: "fallback_default",
      reason: `Bootstrap fell back to ${this.describeProvider(fallback)} because discovery did not find a role-aligned configured route.`
    };
  }

  private resolveProviderReadiness(
    provider: MissionProviderSpec,
    discovery: ProviderDiscoveryRecord[]
  ): { readiness: ProviderReadiness; reason: string } {
    const record = discovery.find((entry) => entry.vendor === provider.vendor) ?? null;
    const transport = record?.transports.find((entry) => entry.transport === provider.transport) ?? null;
    if (transport?.configured) {
      return {
        readiness: "usable_now",
        reason: `${this.describeProvider(provider)} is configured and can be used immediately.`
      };
    }
    if (transport?.available) {
      return {
        readiness: "detected_needs_setup",
        reason: `${this.describeProvider(provider)} was detected locally, but still needs sign-in or setup.`
      };
    }
    return {
      readiness: "fallback_default",
      reason: `${this.describeProvider(provider)} is a fallback route because discovery did not confirm a matching configured transport.`
    };
  }

  private selectDiscoveryProviderCandidate(
    discovery: ProviderDiscoveryRecord[],
    role: string,
    predicate: (transport: ProviderDiscoveryTransport) => boolean
  ): MissionProviderSpec | null {
    for (const record of discovery) {
      for (const transport of record.transports) {
        if (!predicate(transport)) continue;
        const profile = this.selectProviderProfileForRole(transport.profiles, role);
        if (!profile) continue;
        return normalizeMissionProvider({
          vendor: record.vendor,
          transport: transport.transport,
          profileId: profile.id
        }, role);
      }
    }
    return null;
  }

  private selectProviderProfileForRole(profiles: ProviderProfile[], role: string): ProviderProfile | null {
    if (!profiles.length) return null;
    const normalizedRole = role.trim().toLowerCase();
    const roleMatch = profiles.find((profile) =>
      Array.isArray(profile.roleHints)
      && profile.roleHints.some((hint) => hint === normalizedRole || (normalizedRole === "pm" && hint === "plan"))
    );
    return roleMatch ?? profiles.find((profile) => profile.recommended) ?? profiles[0] ?? null;
  }

  private isLocalTransport(transport: string): boolean {
    return transport === "cli" || transport === "local_http";
  }

  private async loadProviderDiscoveryForWorkspace(
    cacheKey: string,
    workspacePath: string
  ): Promise<ProviderDiscoveryRecord[]> {
    const cached = this.providerDiscoveryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.records;
    }
    const pending = this.providerDiscoveryPending.get(cacheKey);
    if (pending) {
      return pending;
    }
    const loadPromise = (async () => {
      try {
        const records = await discoverMissionProviders({
          cwd: workspacePath,
          env: process.env
        });
        return Array.isArray(records) ? records : [];
      } catch {
        return [];
      }
    })();
    this.providerDiscoveryPending.set(cacheKey, loadPromise);
    const records = await loadPromise.finally(() => {
      this.providerDiscoveryPending.delete(cacheKey);
    });
    this.providerDiscoveryCache.set(cacheKey, {
      expiresAt: Date.now() + AgentPlatform.PROVIDER_DISCOVERY_CACHE_TTL_MS,
      records
    });
    return records;
  }

  private async loadOrgForWorkspaceId(workspaceId: string): Promise<OrgNode[]> {
    const workspacePath = await this.resolveWorkspacePath(workspaceId);
    if (!workspacePath) return [];
    return this.loadOrgForWorkspacePath(workspacePath);
  }

  private async loadOrgForWorkspacePath(workspacePath: string): Promise<OrgNode[]> {
    const raw = await this.readJson<OrgNode[]>(this.getWorkspaceOrgPath(workspacePath), []);
    return Array.isArray(raw) ? raw : [];
  }

  private async saveOrgForWorkspacePath(workspacePath: string, nodes: OrgNode[]) {
    await fs.mkdir(path.dirname(this.getWorkspaceOrgPath(workspacePath)), { recursive: true });
    await fs.writeFile(this.getWorkspaceOrgPath(workspacePath), JSON.stringify(nodes, null, 2), "utf8");
  }

  private async loadTasksForWorkspacePath(workspacePath: string): Promise<TaskRecord[]> {
    const raw = await this.readJson<unknown[]>(getWorkspaceTasksFilePath(workspacePath), []);
    if (!Array.isArray(raw)) return [];
    return raw.map((task) => this.normalizeTaskRecord(task));
  }

  private async loadMessagesForWorkspacePath(workspacePath: string): Promise<MessageRecord[]> {
    const raw = await this.readJson<MessageRecord[]>(getWorkspaceMessagesFilePath(workspacePath), []);
    return Array.isArray(raw) ? raw : [];
  }

  private toMissionAgent(agent: AgentRecord): MissionAgent {
    return {
      id: agent.id,
      workspaceId: agent.workspaceId,
      name: agent.name,
      role: agent.role,
      tags: Array.from(new Set([
        ...agent.tags,
        agent.profile.specialization,
        agent.profile.seniority
      ].filter(Boolean))),
      specialization: agent.profile.specialization,
      seniority: agent.profile.seniority,
      capacity: {
        maxParallelWork: agent.profile.maxParallelWork
      },
      runtime: {
        state: agent.status.state,
        currentTaskId: agent.status.currentTaskId,
        currentTaskIds: agent.status.currentTaskIds,
        activeLoad: this.agentActiveLoad(agent)
      },
      provider: normalizeMissionProvider(agent.provider, agent.role),
      capabilities: agent.capabilities
    };
  }

  private normalizeAgentRecord(input: unknown): AgentRecord {
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const now = new Date().toISOString();
    const role = typeof record.role === "string" ? record.role : "general";
    const currentTaskIds =
      record.status && typeof record.status === "object" && Array.isArray((record.status as Record<string, unknown>).currentTaskIds)
        ? ((record.status as Record<string, unknown>).currentTaskIds as unknown[]).map((taskId) => String(taskId)).filter(Boolean)
        : record.status && typeof record.status === "object" && typeof (record.status as Record<string, unknown>).currentTaskId === "string"
          ? [String((record.status as Record<string, unknown>).currentTaskId)]
          : [];
    return {
      id: typeof record.id === "string" && record.id.trim() ? record.id : crypto.randomUUID(),
      workspaceId: typeof record.workspaceId === "string" ? record.workspaceId : undefined,
      name: typeof record.name === "string" && record.name.trim() ? record.name : "Agent",
      role,
      tags: this.normalizeStringArray(record.tags),
      profile: this.normalizeAgentProfile(record.profile, role),
      provider: normalizeMissionProvider(record.provider ?? defaultProviderForRole(role), role),
      capabilities: {
        shell: this.readBoolean(record.capabilities, "shell", false),
        fs: this.readBoolean(record.capabilities, "fs", true),
        network: this.readBoolean(record.capabilities, "network", true)
      },
      status: {
        state: this.normalizeAgentState(record.status),
        currentTaskIds,
        currentTaskId:
          record.status && typeof record.status === "object" && typeof (record.status as Record<string, unknown>).currentTaskId === "string"
            ? String((record.status as Record<string, unknown>).currentTaskId)
            : currentTaskIds[0],
        lastHeartbeatAt:
          record.status && typeof record.status === "object" && typeof (record.status as Record<string, unknown>).lastHeartbeatAt === "string"
            ? String((record.status as Record<string, unknown>).lastHeartbeatAt)
            : now
      },
      createdAt: typeof record.createdAt === "string" ? record.createdAt : now,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now
    };
  }

  private normalizeAgentProfile(input: unknown, role: string): AgentRecord["profile"] {
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const defaults = this.defaultAgentProfile(role);
    const specialization =
      typeof record.specialization === "string" && record.specialization.trim()
        ? record.specialization.trim()
        : defaults.specialization;
    const seniorityRaw =
      typeof record.seniority === "string" && record.seniority.trim()
        ? record.seniority.trim().toLowerCase()
        : defaults.seniority;
    const seniority = ["junior", "mid", "senior", "lead"].includes(seniorityRaw)
      ? seniorityRaw
      : defaults.seniority;
    const maxParallelRaw =
      typeof record.maxParallelWork === "number"
        ? record.maxParallelWork
        : Number(record.maxParallelWork ?? NaN);
    const maxParallelWork = Number.isFinite(maxParallelRaw) && maxParallelRaw > 0
      ? Math.max(1, Math.floor(maxParallelRaw))
      : defaults.maxParallelWork;
    return {
      specialization,
      seniority,
      maxParallelWork
    };
  }

  private defaultAgentProfile(role: string): AgentRecord["profile"] {
    const normalized = role.trim().toLowerCase();
    if (normalized === "pm") {
      return {
        specialization: "pm",
        seniority: "lead",
        maxParallelWork: 1
      };
    }
    if (normalized === "audit") {
      return {
        specialization: "audit",
        seniority: "senior",
        maxParallelWork: 1
      };
    }
    return {
      specialization: "fullstack",
      seniority: "senior",
      maxParallelWork: 2
    };
  }

  private normalizeAgentState(input: unknown): AgentState {
    const state =
      input && typeof input === "object" && typeof (input as Record<string, unknown>).state === "string"
        ? String((input as Record<string, unknown>).state)
        : "";
    if (state === "active" || state === "sleeping" || state === "error") return state;
    return "idle";
  }

  private describeProvider(provider: MissionProviderSpec): string {
    const normalized = normalizeMissionProvider(provider);
    const model = normalized.modelOverride?.trim() || normalized.profileId || "default";
    return `${normalized.vendor}/${normalized.transport}/${model}`;
  }

  private async handleMissionEvent(event: Record<string, unknown>) {
    await this.emit({
      ...event,
      ts: typeof event.ts === "number" ? event.ts : Date.now()
    } as RuntimeEvent);
    const runId = typeof event.runId === "string" ? event.runId : "";
    if (!runId) return;
    const workspaceId = typeof event.workspaceId === "string" ? event.workspaceId : undefined;
    if (!workspaceId) return;
    const runDir = path.join(this.runsDir(), workspaceId, runId);
    const run = await loadMissionRun(runDir).catch(() => null);
    if (run) {
      this.upsertMissionFromRun(run);
      const linkedTasks = this.tasks.filter((task) => task.linkedRunId === run.runId);
      if (linkedTasks.length > 0) {
        for (const task of linkedTasks) {
          task.pauseReason = run.pauseReason ?? null;
          task.change = run.change ?? null;
          task.validation = run.validation ?? null;
          task.verdict = run.verdict ?? null;
          if (run.status !== "running") {
            this.applyMissionRunToTask(task, run);
          }
        }
        await this.persistTasks();
      }
    }
  }

  private normalizeTaskRecord(input: unknown): TaskRecord {
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const now = new Date().toISOString();
    const statusRaw = typeof record.status === "string" ? record.status.trim().toLowerCase() : "";
    const status: TaskStatus = statusRaw === "running" || statusRaw === "paused" || statusRaw === "blocked" || statusRaw === "succeeded" || statusRaw === "failed" || statusRaw === "cancelled"
      ? statusRaw
      : "queued";
    return {
      id: typeof record.id === "string" && record.id.trim() ? record.id : crypto.randomUUID(),
      workspaceId: typeof record.workspaceId === "string" && record.workspaceId.trim() ? record.workspaceId : undefined,
      title: typeof record.title === "string" ? record.title : "Untitled Task",
      description: typeof record.description === "string" ? record.description : "",
      type: this.normalizeTaskType(record.type),
      payload: record.payload && typeof record.payload === "object" ? record.payload as Record<string, unknown> : {},
      assignedToAgentId: typeof record.assignedToAgentId === "string" ? record.assignedToAgentId : "",
      dependsOnTaskIds: this.normalizeStringArray(record.dependsOnTaskIds),
      linkedWorkItemId: typeof record.linkedWorkItemId === "string" && record.linkedWorkItemId.trim() ? record.linkedWorkItemId : undefined,
      linkedWorkItemTitle: typeof record.linkedWorkItemTitle === "string" && record.linkedWorkItemTitle.trim() ? record.linkedWorkItemTitle : undefined,
      plannerTaskId: typeof record.plannerTaskId === "string" && record.plannerTaskId.trim() ? record.plannerTaskId : undefined,
      cycleId: typeof record.cycleId === "string" && record.cycleId.trim() ? record.cycleId : undefined,
      workstreamId: typeof record.workstreamId === "string" && record.workstreamId.trim() ? record.workstreamId : undefined,
      workstreamType: typeof record.workstreamType === "string" && record.workstreamType.trim() ? record.workstreamType : undefined,
      gateRefs: this.normalizeStringArray(record.gateRefs),
      ownerAgentId: typeof record.ownerAgentId === "string" && record.ownerAgentId.trim() ? record.ownerAgentId : undefined,
      ownerAgentName: typeof record.ownerAgentName === "string" && record.ownerAgentName.trim() ? record.ownerAgentName : undefined,
      ownerRole: typeof record.ownerRole === "string" && record.ownerRole.trim() ? record.ownerRole : undefined,
      qaMode: record.qaMode === "scenario" ? "scenario" : record.qaMode === "smoke" ? "smoke" : undefined,
      laneId: typeof record.laneId === "string" && record.laneId.trim() ? record.laneId : undefined,
      laneLabel: typeof record.laneLabel === "string" && record.laneLabel.trim() ? record.laneLabel : undefined,
      waitingOnTaskIds: this.normalizeStringArray(record.waitingOnTaskIds),
      blockedByTaskIds: this.normalizeStringArray(record.blockedByTaskIds),
      status,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : now,
      startedAt: typeof record.startedAt === "string" ? record.startedAt : undefined,
      finishedAt: typeof record.finishedAt === "string" ? record.finishedAt : undefined,
      attempts: typeof record.attempts === "number" && record.attempts >= 0 ? Math.floor(record.attempts) : 0,
      maxAttempts: typeof record.maxAttempts === "number" && record.maxAttempts > 0 ? Math.floor(record.maxAttempts) : 2,
      artifactsPath: typeof record.artifactsPath === "string" ? record.artifactsPath : path.join(this.dataDir, "tasks", crypto.randomUUID(), "artifacts"),
      logsPath: typeof record.logsPath === "string" ? record.logsPath : path.join(this.dataDir, "tasks", crypto.randomUUID(), "logs.ndjson"),
      linkedRunId: typeof record.linkedRunId === "string" ? record.linkedRunId : undefined,
      linkedTemplateId: typeof record.linkedTemplateId === "string" ? record.linkedTemplateId : undefined,
      pauseReason: record.pauseReason === "awaiting_input" || record.pauseReason === "awaiting_approval" ? record.pauseReason : null,
      change: record.change && typeof record.change === "object" ? record.change as ChangeState : null,
      validation: record.validation && typeof record.validation === "object" ? record.validation as ValidationState : null,
      verdict: typeof record.verdict === "string" ? record.verdict as RunVerdict : null,
      resultSummary: typeof record.resultSummary === "string" ? record.resultSummary : undefined
    };
  }

  private upsertMissionRecord(record: MissionRecord) {
    const index = this.missions.findIndex((item) => item.runId === record.runId && item.workspaceId === record.workspaceId);
    if (index >= 0) this.missions[index] = record;
    else this.missions.unshift(record);
    this.missions = this.missions.slice(0, 100);
  }

  private upsertMissionFromRun(run: MissionRun) {
    this.upsertMissionRecord({
      runId: run.runId,
      workspaceId: run.workspaceId ?? "default",
      templateId: run.missionTemplateId,
      title: run.graph.name,
      goal: run.goal ?? "",
      status: run.status,
      updatedAt: run.end ?? new Date().toISOString(),
      activeNodeIds: run.graph.nodes
        .filter((node) => node.status === "running" || node.status === "waiting_input" || node.status === "awaiting_approval")
        .map((node) => node.id)
    });
  }
}

function buildMissionGoalPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const normalized = Object.fromEntries(
    Object.entries(payload)
      .filter(([key]) => !MISSION_GOAL_OMITTED_PAYLOAD_KEYS.has(key))
      .map(([key, value]) => [key, normalizeMissionGoalValue(value)])
      .filter(([, value]) => !isEmptyMissionGoalValue(value))
  );
  return normalized;
}

function normalizeMissionGoalValue(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (trimmed.length <= MISSION_GOAL_STRING_LIMIT) return trimmed;
    return `${trimmed.slice(0, MISSION_GOAL_STRING_LIMIT)}... (truncated for mission goal clarity)`;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeMissionGoalValue(entry))
      .filter((entry) => !isEmptyMissionGoalValue(entry))
      .slice(0, MISSION_GOAL_ARRAY_LIMIT);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => [key, normalizeMissionGoalValue(entry)])
        .filter(([, entry]) => !isEmptyMissionGoalValue(entry))
    );
  }
  return value;
}

function isEmptyMissionGoalValue(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
}
