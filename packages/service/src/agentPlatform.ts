import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import crypto from "node:crypto";
import type express from "express";
import {
  appendWorkspaceSignal,
  defaultProviderForRole,
  normalizeMissionProvider,
  loadWorkspaces,
  findWorkspaceById,
  runMissionDetailed,
  runBrowserRunDetailed,
  resumeMissionRun,
  importMissionNodeInput,
  loadMissionRun,
  loadMissionTemplate,
  type MissionAgent,
  type MissionRun,
  type MissionProviderSpec,
  type ChangeState,
  type PauseReason,
  type RunStartOptions,
  type RunVerdict,
  type ValidationState,
  type WorkItemPlanningDetail,
  type WorkItemRecord,
  type WorkPlanTask,
  getWorkspaceAgentsPath as getWorkspaceAgentsFilePath,
  getWorkspaceOrgPath as getWorkspaceOrgFilePath,
  getWorkspaceTasksPath as getWorkspaceTasksFilePath,
  getWorkspaceTaskArtifactsRoot,
  getWorkspaceMessagesPath as getWorkspaceMessagesFilePath,
  getOperatorControlDir
} from "@orchestrum/core";

type AgentState = "idle" | "active" | "sleeping" | "error";
type TaskStatus = "queued" | "running" | "paused" | "blocked" | "succeeded" | "failed" | "cancelled";
type TaskType = "spec" | "implement" | "validate" | "qa" | "audit";

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
        const agents = workspaceId
          ? await this.loadAgentsForWorkspaceId(workspaceId)
          : this.agents;
        res.json({ agents });
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
  }): Promise<{ ok: boolean; runId: string }> {
    const agents = await this.loadAgentsForWorkspaceId(options.workspaceId);
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
    void resumeMissionRun({
      runsDir: options.runsDir,
      workspaceId: options.workspaceId,
      runId: options.runId,
      agents: agents.map((agent) => this.toMissionAgent(agent)),
      onEvent: (event) => this.handleMissionEvent(event)
    })
      .then((result) => {
        this.upsertMissionFromRun(result.run);
      })
      .catch(async (err: unknown) => {
        await this.emit({
          t: "mission.failed",
          ts: Date.now(),
          runId: options.runId,
          workspaceId: options.workspaceId,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    return { ok: true, runId: options.runId };
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

  listTasks(options?: { workspaceId?: string; workItemId?: string }): TaskRecord[] {
    const workspaceId = options?.workspaceId?.trim();
    const workItemId = options?.workItemId?.trim();
    return this.tasks
      .filter((task) => {
        if (workspaceId && task.workspaceId !== workspaceId) return false;
        if (workItemId && task.linkedWorkItemId !== workItemId) return false;
        return true;
      })
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async queueWorkItemExecution(options: {
    workspaceId: string;
    workItem: WorkItemRecord;
    detail: WorkItemPlanningDetail;
  }): Promise<{ taskIds: string[] }> {
    const nextCycleSequence = Math.max(1, (options.workItem.cycles?.length ?? 0) + 1);
    const workspaceAgents = await this.loadAgentsForWorkspaceId(options.workspaceId);
    if (workspaceAgents.length === 0) {
      throw new Error(`No agents configured for workspace ${options.workspaceId}.`);
    }

    const assignmentByLane = new Map(options.detail.teamAssignments.map((assignment) => [assignment.laneId, assignment]));
    const laneErrors = new Set<string>();
    const taskIdByPlannerId = new Map<string, string>();
    for (const plannedTask of options.detail.tasks) {
      taskIdByPlannerId.set(plannedTask.id, crypto.randomUUID());
      const assignment = assignmentByLane.get(plannedTask.laneId);
      if (!assignment?.matches?.[0]) {
        laneErrors.add(plannedTask.laneLabel || plannedTask.laneId);
      }
    }
    if (laneErrors.size > 0) {
      throw new Error(`No agent coverage for planned lanes: ${Array.from(laneErrors).join(", ")}`);
    }

    const createdTasks: TaskRecord[] = [];
    const batchAssignedCount = new Map<string, number>();
    for (const plannedTask of options.detail.tasks) {
      const assignment = assignmentByLane.get(plannedTask.laneId)!;
      const selectedMatch = this.selectLaneAgentMatch({
        matches: assignment.matches,
        workspaceAgents,
        batchAssignedCount
      });
      if (!selectedMatch) {
        throw new Error(`Assigned lane ${plannedTask.laneLabel} no longer has an available specialist.`);
      }
      const assignedAgent = workspaceAgents.find((agent) => agent.id === selectedMatch.id);
      if (!assignedAgent) {
        throw new Error(`Assigned agent ${selectedMatch.name} is no longer available for lane ${plannedTask.laneLabel}.`);
      }
      batchAssignedCount.set(assignedAgent.id, (batchAssignedCount.get(assignedAgent.id) ?? 0) + 1);
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
          laneId: plannedTask.laneId,
          laneLabel: plannedTask.laneLabel,
          roleHint: plannedTask.roleHint ?? null,
          cycleSequence: nextCycleSequence,
          cycleKind: options.workItem.reviewStatus === "changes_requested" ? "remediation" : "initial",
          reviewStatus: options.workItem.reviewStatus ?? null,
          reviewNote: options.workItem.reviewNote ?? null,
          reviewedAt: options.workItem.reviewedAt ?? null
        },
        assignedToAgentId: assignedAgent.id,
        dependsOnTaskIds: plannedTask.dependsOn
          .map((dependency) => taskIdByPlannerId.get(dependency))
          .filter((dependency): dependency is string => Boolean(dependency)),
        linkedWorkItemId: options.workItem.id,
        linkedWorkItemTitle: options.workItem.brief.title,
        plannerTaskId: plannedTask.id,
        laneId: plannedTask.laneId,
        laneLabel: plannedTask.laneLabel,
        maxAttempts: plannedTask.kind === "qa" ? 1 : 2
      });
      createdTasks.push(task);
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
      taskIds: createdTasks.map((task) => task.id)
    };
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
      runsDir: path.join(this.options.rootDir, "runs"),
      workspaceId,
      goal: this.buildMissionGoal(task),
      runId,
      agents: missionAgents,
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
    task.resultSummary = "Browser smoke run launched.";
    task.waitingOnTaskIds = [];
    task.blockedByTaskIds = [];
    await this.persistTasks();
    await this.appendLog(task, `Launching browser smoke in ${workspacePath}`);

    const targetPath =
      typeof task.payload.targetPath === "string" && task.payload.targetPath.trim()
        ? task.payload.targetPath.trim()
        : undefined;
    const baseUrl =
      typeof task.payload.baseUrl === "string" && task.payload.baseUrl.trim()
        ? task.payload.baseUrl.trim()
        : undefined;

    const result = await runBrowserRunDetailed({
      kind: "qa",
      repoPath: workspacePath,
      runsDir: path.join(this.options.rootDir, "runs"),
      workspaceId,
      runId,
      baseUrl,
      targetPath
    });

    task.finishedAt = new Date().toISOString();
    task.status = result.ok ? "succeeded" : "failed";
    task.verdict = result.ok ? "ready_for_review" : "failed";
    task.waitingOnTaskIds = [];
    task.blockedByTaskIds = [];
    task.resultSummary = result.ok
      ? "Browser smoke run completed successfully."
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
    await this.persistTasks();
    await this.appendLog(task, `Mission ${run.runId} ${run.status}: ${task.resultSummary}`);
    await this.reconcileDependencyStates();
  }

  private mapRunStatusToTaskStatus(status: MissionRun["status"]): TaskStatus {
    if (status === "completed") return "succeeded";
    if (status === "paused") return "paused";
    if (status === "blocked") return "blocked";
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
      return run.error ?? "Mission blocked and needs operator intervention.";
    }
    if (run.status === "failed") {
      return run.error ?? "Mission failed.";
    }
    if (run.status === "cancelled") {
      return "Mission cancelled.";
    }
    return `Mission ended with status ${run.status}.`;
  }

  private buildMissionGoal(task: TaskRecord): string {
    const payloadText = JSON.stringify(task.payload ?? {}, null, 2);
    return [
      `Task title: ${task.title}`,
      "",
      task.description.trim(),
      "",
      "Payload:",
      payloadText
    ].join("\n").trim();
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
    await this.emit({
      t: eventType,
      ts: Date.now(),
      taskId: task.id,
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
      if (task.dependsOnTaskIds.length === 0) continue;
      if (task.status === "running" || task.status === "succeeded" || task.status === "failed" || task.status === "cancelled" || task.status === "paused") {
        continue;
      }

      const evaluation = this.evaluateTaskDependencies(task);
      const dependencyManaged = task.blockedByTaskIds.length > 0 || task.waitingOnTaskIds.length > 0;
      let nextStatus = task.status;
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
          source: "execution",
          type: String(event.t ?? "execution.event"),
          entityId:
            typeof event.taskId === "string"
              ? event.taskId
              : typeof event.linkedRunId === "string"
                ? event.linkedRunId
                : undefined,
          status: typeof event.status === "string" ? event.status : undefined,
          summary: String(event.t ?? "execution.event"),
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
  }

  private async resolveWorkspacePath(workspaceId: string): Promise<string | null> {
    const workspaces = await this.listKnownWorkspaces();
    return findWorkspaceById(workspaces, workspaceId)?.path ?? null;
  }

  private async listKnownWorkspaces() {
    const repoPaths = this.options.listWorkspacePaths ? await this.options.listWorkspacePaths().catch(() => []) : [];
    return loadWorkspaces(this.options.rootDir, { repoPaths }).catch(() => []);
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
    const runDir = path.join(this.options.rootDir, "runs", workspaceId, runId);
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
            task.status = this.mapRunStatusToTaskStatus(run.status);
            task.finishedAt = run.end ?? task.finishedAt ?? new Date().toISOString();
            task.resultSummary = this.summarizeMissionOutcome(run);
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
