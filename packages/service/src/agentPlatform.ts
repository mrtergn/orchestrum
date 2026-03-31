import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import type express from "express";
import {
  completeWithProvider,
  defaultProviderForRole,
  normalizeMissionProvider,
  loadWorkspaces,
  findWorkspaceById,
  runMissionDetailed,
  resumeMissionRun,
  importMissionNodeInput,
  loadMissionRun,
  type MissionAgent,
  type MissionRun,
  type MissionProviderSpec
} from "@orchestrum/core";

type AgentState = "idle" | "active" | "sleeping" | "error";
type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
type TaskType = "spec" | "implement" | "audit" | "generic";

type AgentRecord = {
  id: string;
  workspaceId?: string;
  name: string;
  role: string;
  tags: string[];
  provider: MissionProviderSpec;
  capabilities: {
    shell: boolean;
    fs: boolean;
    network: boolean;
  };
  status: {
    state: AgentState;
    currentTaskId?: string;
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

type TaskRecord = {
  id: string;
  title: string;
  description: string;
  type: TaskType;
  payload: Record<string, unknown>;
  assignedToAgentId: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  attempts: number;
  maxAttempts: number;
  artifactsPath: string;
  logsPath: string;
  resultSummary?: string;
};

type MessageRecord = {
  id: string;
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
};

type LoggerLike = {
  info: (event: string, payload?: Record<string, unknown>) => Promise<void> | void;
  warn: (event: string, payload?: Record<string, unknown>) => Promise<void> | void;
  error: (event: string, payload?: Record<string, unknown>) => Promise<void> | void;
};

export class AgentPlatform {
  private dataDir: string;
  private tasksDir: string;
  private eventsPath: string;
  private agentsPath: string;
  private orgPath: string;
  private tasksPath: string;
  private messagesPath: string;
  private agents: AgentRecord[] = [];
  private orgNodes: OrgNode[] = [];
  private tasks: TaskRecord[] = [];
  private messages: MessageRecord[] = [];
  private missions: MissionRecord[] = [];
  private runningTaskIds = new Set<string>();
  private schedulerTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private streamClients = new Set<express.Response>();
  private logger: LoggerLike | null = null;

  constructor(private options: AgentPlatformOptions) {
    this.dataDir = path.join(os.homedir(), ".orchestrum");
    this.tasksDir = path.join(this.dataDir, "tasks");
    this.eventsPath = path.join(options.rootDir, "logs", "agent-events.ndjson");
    this.agentsPath = path.join(this.dataDir, "agents.json");
    this.orgPath = path.join(this.dataDir, "org.json");
    this.tasksPath = path.join(this.dataDir, "tasks.json");
    this.messagesPath = path.join(this.dataDir, "messages.json");
  }

  async init(logger?: LoggerLike) {
    this.logger = logger ?? null;
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.mkdir(this.tasksDir, { recursive: true });
    await fs.mkdir(path.dirname(this.eventsPath), { recursive: true });
    this.tasks = await this.readJson<TaskRecord[]>(this.tasksPath, []);
    this.messages = await this.readJson<MessageRecord[]>(this.messagesPath, []);
    await this.refreshWorkspaceState();
    this.startRuntime();
    await this.emit({ t: "platform.ready", ts: Date.now(), dataDir: this.dataDir });
  }

  shutdown() {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.schedulerTimer = null;
    this.heartbeatTimer = null;
    for (const client of this.streamClients) {
      client.end();
    }
    this.streamClients.clear();
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
        const agent: AgentRecord = {
          id: crypto.randomUUID(),
          workspaceId,
          name: String(body.name ?? "Agent"),
          role,
          tags: this.normalizeStringArray(body.tags),
          provider: normalizeMissionProvider(body.provider ?? defaultProviderForRole(role), role),
          capabilities: {
            shell: this.readBoolean(body.capabilities, "shell", false),
            fs: this.readBoolean(body.capabilities, "fs", true),
            network: this.readBoolean(body.capabilities, "network", true)
          },
          status: { state: "idle", lastHeartbeatAt: now },
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
      app.get(route, async (_req, res) => {
        const items = this.tasks.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        res.json({ tasks: items });
      });
      app.post(route, async (req, res) => {
        const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
        const assignedToAgentId = String(body.assignedToAgentId ?? "");
        if (!assignedToAgentId) return res.status(400).json({ error: "assignedToAgentId is required" });
        const agent = this.agents.find((item) => item.id === assignedToAgentId);
        if (!agent) return res.status(404).json({ error: "Assigned agent not found" });
        const taskId = crypto.randomUUID();
        const taskDir = path.join(this.tasksDir, taskId);
        await fs.mkdir(taskDir, { recursive: true });
        const logsPath = path.join(taskDir, "logs.ndjson");
        const artifactsPath = path.join(taskDir, "artifacts");
        await fs.mkdir(artifactsPath, { recursive: true });
        const now = new Date().toISOString();
        const task: TaskRecord = {
          id: taskId,
          title: String(body.title ?? "Untitled Task"),
          description: String(body.description ?? ""),
          type: this.normalizeTaskType(body.type),
          payload: body.payload && typeof body.payload === "object" ? (body.payload as Record<string, unknown>) : {},
          assignedToAgentId,
          status: "queued",
          createdAt: now,
          attempts: 0,
          maxAttempts: typeof body.maxAttempts === "number" && body.maxAttempts > 0 ? Math.floor(body.maxAttempts) : 2,
          artifactsPath,
          logsPath
        };
        this.tasks.push(task);
        await this.persistTasks();
        await this.appendLog(task, `Task queued for ${agent.name}`);
        await this.emit({ t: "task.created", ts: Date.now(), task });
        await this.emit({ t: "task.queued", ts: Date.now(), task });
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
        if (task.status === "succeeded" || task.status === "failed") {
          return res.status(400).json({ error: "Task already completed" });
        }
        task.status = "cancelled";
        task.finishedAt = new Date().toISOString();
        await this.persistTasks();
        await this.appendLog(task, "Task cancelled by user");
        await this.emit({ t: "task.cancelled", ts: Date.now(), taskId: task.id });
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
        task.resultSummary = undefined;
        await this.persistTasks();
        await this.appendLog(task, "Task moved back to queue");
        await this.emit({ t: "task.queued", ts: Date.now(), task });
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
        const record: MessageRecord = {
          id: crypto.randomUUID(),
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

    const streamRoutes = ["/stream", "/api/stream"] as const;
    for (const route of streamRoutes) {
      app.get(route, async (_req, res) => {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();
        const snapshot = this.buildSnapshot();
        res.write(`data: ${JSON.stringify({ t: "snapshot", ts: Date.now(), ...snapshot })}\n\n`);
        this.streamClients.add(res);
        const pulse = setInterval(() => {
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ t: "heartbeat", ts: Date.now() })}\n\n`);
          }
        }, 3000);
        res.on("close", () => {
          clearInterval(pulse);
          this.streamClients.delete(res);
        });
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
    const queued = this.tasks.filter((task) => task.status === "queued");
    for (const task of queued) {
      if (this.runningTaskIds.has(task.id)) continue;
      const agent = this.agents.find((item) => item.id === task.assignedToAgentId);
      if (!agent) {
        task.status = "failed";
        task.finishedAt = new Date().toISOString();
        task.resultSummary = "Assigned agent does not exist";
        await this.persistTasks();
        await this.emit({ t: "task.failed", ts: Date.now(), taskId: task.id, reason: "agent_missing" });
        continue;
      }
      if (agent.status.state === "active") continue;
      this.runningTaskIds.add(task.id);
      agent.status.state = "active";
      agent.status.currentTaskId = task.id;
      agent.status.lastHeartbeatAt = new Date().toISOString();
      task.status = "running";
      task.startedAt = new Date().toISOString();
      task.attempts += 1;
      await Promise.all([this.persistAgents(), this.persistTasks()]);
      await this.emit({ t: "agent.status", ts: Date.now(), agentId: agent.id, state: agent.status.state, currentTaskId: task.id });
      await this.emit({ t: "task.started", ts: Date.now(), taskId: task.id, agentId: agent.id });
      void this.executeTask(task, agent)
        .catch(async (err: unknown) => {
          const message = err instanceof Error ? err.message : "Task execution failed";
          task.status = "failed";
          task.finishedAt = new Date().toISOString();
          task.resultSummary = message;
          await this.appendLog(task, `Task failed: ${message}`);
          await this.emit({ t: "task.failed", ts: Date.now(), taskId: task.id, error: message });
        })
        .finally(async () => {
          agent.status.state = "idle";
          agent.status.currentTaskId = undefined;
          agent.status.lastHeartbeatAt = new Date().toISOString();
          this.runningTaskIds.delete(task.id);
          await Promise.all([this.persistAgents(), this.persistTasks()]);
          await this.emit({ t: "agent.status", ts: Date.now(), agentId: agent.id, state: agent.status.state });
        });
    }
  }

  private async heartbeatTick() {
    const now = new Date().toISOString();
    const nowMs = Date.now();
    let changed = false;
    for (const agent of this.agents) {
      if (agent.status.state === "active") {
        agent.status.lastHeartbeatAt = now;
        changed = true;
        await this.emit({ t: "agent.status", ts: Date.now(), agentId: agent.id, state: agent.status.state, currentTaskId: agent.status.currentTaskId, lastHeartbeatAt: now });
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
    const prompt = this.buildPrompt(task, agent);
    const modelOutput = await this.invokeProvider(agent, prompt);
    const artifactsDir = task.artifactsPath;

    if (task.type === "spec") {
      const specPath = path.join(artifactsDir, "spec.md");
      await fs.writeFile(specPath, modelOutput, "utf8");
      task.resultSummary = "Specification created";
      await this.notifyRole("dev", agent.id, "acceptance.criteria", {
        taskId: task.id,
        title: task.title,
        acceptanceCriteria: modelOutput.slice(0, 3000)
      });
    } else if (task.type === "implement") {
      const patchText = this.ensureUnifiedDiff(modelOutput, task);
      const patchPath = path.join(artifactsDir, "changes.diff");
      await fs.writeFile(patchPath, patchText, "utf8");
      const repoPath = typeof task.payload.repoPath === "string" ? task.payload.repoPath : "";
      if (repoPath) {
        const apply = await this.applyPatch(repoPath, patchText);
        await this.appendLog(task, `Patch apply result: ${apply.ok ? "ok" : "failed"}`);
        if (!apply.ok) {
          await this.appendLog(task, apply.error ?? "Patch apply failed");
          throw new Error(`Patch apply failed: ${apply.error ?? "unknown error"}`);
        }
      }
      task.resultSummary = "Implementation diff generated";
    } else if (task.type === "audit") {
      const report = {
        summary: modelOutput.slice(0, 6000),
        score: 0.7,
        generatedAt: new Date().toISOString()
      };
      const reportPath = path.join(artifactsDir, "audit-report.json");
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
      task.resultSummary = "Audit report generated";
      await this.notifyRole("dev", agent.id, "audit.issues", {
        taskId: task.id,
        title: task.title,
        reportSummary: report.summary
      });
    } else {
      const outputPath = path.join(artifactsDir, "output.md");
      await fs.writeFile(outputPath, modelOutput, "utf8");
      task.resultSummary = "Generic output generated";
    }

    task.status = "succeeded";
    task.finishedAt = new Date().toISOString();
    await this.appendLog(task, `Task succeeded: ${task.resultSummary ?? "completed"}`);
    await this.emit({ t: "task.completed", ts: Date.now(), taskId: task.id, resultSummary: task.resultSummary });
    await this.emit({ t: "task.succeeded", ts: Date.now(), taskId: task.id, resultSummary: task.resultSummary });
  }

  private buildPrompt(task: TaskRecord, agent: AgentRecord): string {
    const payloadText = JSON.stringify(task.payload ?? {}, null, 2);
    return [
      `You are ${agent.name} (${agent.role}).`,
      `Task type: ${task.type}`,
      `Title: ${task.title}`,
      `Description: ${task.description}`,
      "Payload:",
      payloadText,
      "Produce concise, actionable output."
    ].join("\n");
  }

  private async invokeProvider(agent: AgentRecord, prompt: string): Promise<string> {
    try {
      const repoPath = agent.workspaceId ? await this.resolveWorkspacePath(agent.workspaceId) : null;
      const execution = await completeWithProvider(agent.provider, prompt, process.env, {
        repoPath: repoPath ?? this.options.rootDir,
        role: agent.role,
        executor: this.executorForRole(agent.role)
      });
      return execution.text?.trim() || "No output produced.";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `# Provider request failed\n\n${message}\n\nPrompt:\n\n${prompt}`;
    }
  }

  private ensureUnifiedDiff(output: string, task: TaskRecord): string {
    if (output.includes("--- ") && output.includes("+++ ") && output.includes("@@")) {
      return output;
    }
    const safeTitle = task.title.replace(/[^a-z0-9-_]/gi, "-").toLowerCase();
    return [
      `--- a/NOTES.md`,
      `+++ b/NOTES.md`,
      `@@ -0,0 +1,6 @@`,
      `+# ${safeTitle || "task"}`,
      `+`,
      `+${output.replace(/\r?\n/g, "\n+").slice(0, 8000)}`
    ].join("\n");
  }

  private async applyPatch(repoPath: string, patchText: string): Promise<{ ok: boolean; error?: string }> {
    if (!repoPath || !fsSync.existsSync(repoPath)) {
      return { ok: false, error: "repoPath does not exist" };
    }
    const dangerous = ["rm -rf", "rmdir", "del /f", "format c:"];
    const lower = patchText.toLowerCase();
    if (dangerous.some((entry) => lower.includes(entry))) {
      return { ok: false, error: "Patch rejected by safety guard" };
    }

    return await new Promise((resolve) => {
      const child = spawn("git", ["apply", "--whitespace=nowarn", "-"], {
        cwd: repoPath,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (err) => {
        resolve({ ok: false, error: err.message });
      });
      child.stdin.write(patchText);
      child.stdin.end();
      child.on("exit", (code) => {
        if (code === 0) resolve({ ok: true });
        else resolve({ ok: false, error: stderr.trim() || `git apply exited with ${code ?? -1}` });
      });
    });
  }

  private async notifyRole(roleNeedle: string, fromAgentId: string, topic: string, payload: Record<string, unknown>) {
    const to = this.agents.find((agent) => agent.role.toLowerCase().includes(roleNeedle));
    if (!to) return;
    const message: MessageRecord = {
      id: crypto.randomUUID(),
      fromAgentId,
      toAgentId: to.id,
      topic,
      payload,
      ts: new Date().toISOString()
    };
    this.messages.push(message);
    await this.persistMessages();
    await this.emit({ t: "message.created", ts: Date.now(), message });
    await this.emit({ t: "message.sent", ts: Date.now(), message });
  }

  private buildSnapshot() {
    const queue = this.tasks.filter((task) => task.status === "queued").length;
    const running = this.tasks.filter((task) => task.status === "running").length;
    return {
      agents: this.agents,
      org: this.orgNodes,
      missions: this.missions.slice(-40),
      tasks: this.tasks.slice(-100),
      messages: this.messages.slice(-100),
      queue: { queued: queue, running }
    };
  }

  private normalizeTaskType(input: unknown): TaskType {
    if (input === "spec" || input === "implement" || input === "audit" || input === "generic") {
      return input;
    }
    return "generic";
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
    for (const client of this.streamClients) {
      if (!client.writableEnded) {
        client.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    }
    if (this.logger) {
      await this.logger.info("agent.event", event as Record<string, unknown>);
    }
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
    await fs.writeFile(this.agentsPath, JSON.stringify(this.agents, null, 2), "utf8");
  }

  private async persistOrg() {
    await fs.writeFile(this.orgPath, JSON.stringify(this.orgNodes, null, 2), "utf8");
  }

  private async persistTasks() {
    await fs.writeFile(this.tasksPath, JSON.stringify(this.tasks, null, 2), "utf8");
  }

  private async persistMessages() {
    await fs.writeFile(this.messagesPath, JSON.stringify(this.messages, null, 2), "utf8");
  }

  private async refreshWorkspaceState() {
    const workspaces = await loadWorkspaces(this.options.rootDir).catch(() => []);
    const agents: AgentRecord[] = [];
    const orgNodes: OrgNode[] = [];
    for (const workspace of workspaces) {
      const workspaceAgents = await this.loadAgentsForWorkspacePath(workspace.path);
      const workspaceOrg = await this.loadOrgForWorkspacePath(workspace.path);
      agents.push(...workspaceAgents);
      orgNodes.push(...workspaceOrg);
    }
    this.agents = agents;
    this.orgNodes = orgNodes;
    await this.persistAgents();
    await this.persistOrg();
  }

  private async resolveWorkspacePath(workspaceId: string): Promise<string | null> {
    const workspaces = await loadWorkspaces(this.options.rootDir).catch(() => []);
    return findWorkspaceById(workspaces, workspaceId)?.path ?? null;
  }

  private getWorkspaceAgentsPath(workspacePath: string): string {
    return path.join(workspacePath, ".orchestrum", "agents.json");
  }

  private getWorkspaceOrgPath(workspacePath: string): string {
    return path.join(workspacePath, ".orchestrum", "org.json");
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

  private toMissionAgent(agent: AgentRecord): MissionAgent {
    return {
      id: agent.id,
      workspaceId: agent.workspaceId,
      name: agent.name,
      role: agent.role,
      tags: agent.tags,
      provider: normalizeMissionProvider(agent.provider, agent.role),
      capabilities: agent.capabilities
    };
  }

  private normalizeAgentRecord(input: unknown): AgentRecord {
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const now = new Date().toISOString();
    const role = typeof record.role === "string" ? record.role : "general";
    return {
      id: typeof record.id === "string" && record.id.trim() ? record.id : crypto.randomUUID(),
      workspaceId: typeof record.workspaceId === "string" ? record.workspaceId : undefined,
      name: typeof record.name === "string" && record.name.trim() ? record.name : "Agent",
      role,
      tags: this.normalizeStringArray(record.tags),
      provider: normalizeMissionProvider(record.provider ?? defaultProviderForRole(role), role),
      capabilities: {
        shell: this.readBoolean(record.capabilities, "shell", false),
        fs: this.readBoolean(record.capabilities, "fs", true),
        network: this.readBoolean(record.capabilities, "network", true)
      },
      status: {
        state: this.normalizeAgentState(record.status),
        currentTaskId:
          record.status && typeof record.status === "object" && typeof (record.status as Record<string, unknown>).currentTaskId === "string"
            ? String((record.status as Record<string, unknown>).currentTaskId)
            : undefined,
        lastHeartbeatAt:
          record.status && typeof record.status === "object" && typeof (record.status as Record<string, unknown>).lastHeartbeatAt === "string"
            ? String((record.status as Record<string, unknown>).lastHeartbeatAt)
            : now
      },
      createdAt: typeof record.createdAt === "string" ? record.createdAt : now,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now
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

  private executorForRole(role: string): "prompt" | "patch" | "audit" {
    const normalized = role.trim().toLowerCase();
    if (normalized.includes("audit")) return "audit";
    if (normalized.includes("dev")) return "patch";
    return "prompt";
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
    }
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
