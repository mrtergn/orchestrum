import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import type express from "express";

type AgentState = "idle" | "active" | "sleeping" | "error";
type ProviderType = "openai" | "claude" | "ollama" | "local";
type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
type TaskType = "spec" | "implement" | "audit" | "generic";

type AgentRecord = {
  id: string;
  name: string;
  role: string;
  tags: string[];
  provider: {
    type: ProviderType;
    model: string;
    apiKeyRef?: string;
  };
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
  agentId: string;
  parentId?: string;
  department?: string;
  position?: string;
  x?: number;
  y?: number;
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
    this.agents = await this.readJson<AgentRecord[]>(this.agentsPath, []);
    this.orgNodes = await this.readJson<OrgNode[]>(this.orgPath, []);
    this.tasks = await this.readJson<TaskRecord[]>(this.tasksPath, []);
    this.messages = await this.readJson<MessageRecord[]>(this.messagesPath, []);
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
      app.get(route, async (_req, res) => {
        res.json({ agents: this.agents });
      });
      app.post(route, async (req, res) => {
        const now = new Date().toISOString();
        const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
        const providerTypeRaw =
          body.provider && typeof body.provider === "object"
            ? (body.provider as Record<string, unknown>).type
            : undefined;
        const providerType: ProviderType =
          providerTypeRaw === "local" || providerTypeRaw === "ollama" || providerTypeRaw === "claude" ? providerTypeRaw : "openai";
        const defaultModel =
          providerType === "claude" ? "claude-3-5-sonnet-latest" : providerType === "ollama" || providerType === "local" ? "llama3.1:8b" : "gpt-4.1-mini";
        const defaultApiKeyRef = providerType === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
        const agent: AgentRecord = {
          id: crypto.randomUUID(),
          name: String(body.name ?? "Agent"),
          role: String(body.role ?? "general"),
          tags: this.normalizeStringArray(body.tags),
          provider: {
            type: providerType,
            model: String(
              body.provider && typeof body.provider === "object"
                ? ((body.provider as Record<string, unknown>).model ?? defaultModel)
                : defaultModel
            ),
            apiKeyRef:
              body.provider && typeof body.provider === "object" && typeof (body.provider as Record<string, unknown>).apiKeyRef === "string"
                ? String((body.provider as Record<string, unknown>).apiKeyRef)
                : providerType === "local" || providerType === "ollama"
                  ? undefined
                  : defaultApiKeyRef
          },
          capabilities: {
            shell: this.readBoolean(body.capabilities, "shell", false),
            fs: this.readBoolean(body.capabilities, "fs", true),
            network: this.readBoolean(body.capabilities, "network", true)
          },
          status: { state: "idle", lastHeartbeatAt: now },
          createdAt: now,
          updatedAt: now
        };
        this.agents.push(agent);
        await this.persistAgents();
        await this.emit({ t: "agent.created", ts: Date.now(), agent });
        res.status(201).json({ agent });
      });
    }

    const agentItemRoutes = ["/agents/:id", "/api/agents/:id"] as const;
    for (const route of agentItemRoutes) {
      app.patch(route, async (req, res) => {
        const agent = this.agents.find((item) => item.id === req.params.id);
        if (!agent) return res.status(404).json({ error: "Agent not found" });
        const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
        if (typeof body.name === "string") agent.name = body.name;
        if (typeof body.role === "string") agent.role = body.role;
        if (Array.isArray(body.tags)) agent.tags = this.normalizeStringArray(body.tags);
        if (body.provider && typeof body.provider === "object") {
          const provider = body.provider as Record<string, unknown>;
          if (provider.type === "openai" || provider.type === "claude" || provider.type === "local" || provider.type === "ollama") {
            agent.provider.type = provider.type;
          }
          if (typeof provider.model === "string" && provider.model.trim()) {
            agent.provider.model = provider.model.trim();
          }
          if (typeof provider.apiKeyRef === "string" && provider.apiKeyRef.trim()) {
            agent.provider.apiKeyRef = provider.apiKeyRef.trim();
          }
        }
        if (body.capabilities && typeof body.capabilities === "object") {
          const caps = body.capabilities as Record<string, unknown>;
          if (typeof caps.shell === "boolean") agent.capabilities.shell = caps.shell;
          if (typeof caps.fs === "boolean") agent.capabilities.fs = caps.fs;
          if (typeof caps.network === "boolean") agent.capabilities.network = caps.network;
        }
        agent.updatedAt = new Date().toISOString();
        await this.persistAgents();
        await this.emit({ t: "agent.updated", ts: Date.now(), agent });
        res.json({ agent });
      });

      app.delete(route, async (req, res) => {
        const before = this.agents.length;
        this.agents = this.agents.filter((item) => item.id !== req.params.id);
        if (this.agents.length === before) return res.status(404).json({ error: "Agent not found" });
        this.orgNodes = this.orgNodes.filter((node) => node.agentId !== req.params.id && node.id !== req.params.id && node.parentId !== req.params.id);
        await Promise.all([this.persistAgents(), this.persistOrg()]);
        await this.emit({ t: "agent.deleted", ts: Date.now(), agentId: req.params.id });
        res.json({ ok: true });
      });
    }

    const orgRoutes = ["/org", "/api/org"] as const;
    for (const route of orgRoutes) {
      app.get(route, async (_req, res) => {
        res.json({ nodes: this.orgNodes });
      });
      app.put(route, async (req, res) => {
        const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
        const nodesRaw = Array.isArray(body.nodes) ? body.nodes : [];
        this.orgNodes = nodesRaw
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
          .map((item) => this.normalizeOrgNode(item))
          .filter((item): item is OrgNode => item !== null);
        await this.persistOrg();
        await this.emit({ t: "org.updated", ts: Date.now(), nodes: this.orgNodes });
        res.json({ ok: true, nodes: this.orgNodes });
      });
    }

    const orgNodeRoutes = ["/org/nodes", "/api/org/nodes"] as const;
    for (const route of orgNodeRoutes) {
      app.post(route, async (req, res) => {
        const node = this.normalizeOrgNode(req.body as Record<string, unknown>);
        if (!node) return res.status(400).json({ error: "Invalid node payload" });
        this.orgNodes.push(node);
        await this.persistOrg();
        await this.emit({ t: "org.updated", ts: Date.now(), nodes: this.orgNodes });
        res.status(201).json({ node });
      });
    }

    const orgNodeItemRoutes = ["/org/nodes/:id", "/api/org/nodes/:id"] as const;
    for (const route of orgNodeItemRoutes) {
      app.delete(route, async (req, res) => {
        const before = this.orgNodes.length;
        this.orgNodes = this.orgNodes.filter((node) => node.id !== req.params.id && node.parentId !== req.params.id);
        if (this.orgNodes.length === before) return res.status(404).json({ error: "Node not found" });
        await this.persistOrg();
        await this.emit({ t: "org.updated", ts: Date.now(), nodes: this.orgNodes });
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
    await this.appendLog(task, `Executing ${task.type} task with ${agent.provider.type}/${agent.provider.model}`);
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
    if (agent.provider.type === "local" || agent.provider.type === "ollama") {
      const response = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: agent.provider.model, prompt, stream: false })
      }).catch(() => null);
      if (!response || !response.ok) {
        return `# Local model unavailable\n\nCould not reach local provider.\n\nPrompt:\n\n${prompt}`;
      }
      const body = (await response.json().catch(() => ({}))) as { response?: string };
      return body.response?.trim() || "No output from local model.";
    }

    if (agent.provider.type === "claude") {
      const keyRef = agent.provider.apiKeyRef?.trim() || "ANTHROPIC_API_KEY";
      const apiKey = process.env[keyRef] ?? "";
      if (!apiKey) {
        return `# Provider not configured\n\nMissing API key in env var ${keyRef}.\n\nPrompt:\n\n${prompt}`;
      }

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: agent.provider.model,
          max_tokens: 4096,
          messages: [{ role: "user", content: prompt }]
        })
      }).catch(() => null);

      if (!response || !response.ok) {
        return `# Claude request failed\n\nCould not generate output from ${agent.provider.model}.\n\nPrompt:\n\n${prompt}`;
      }

      const body = (await response.json().catch(() => ({}))) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const text = body.content?.find((item) => item.type === "text")?.text;
      return text?.trim() || "No output produced.";
    }

    const keyRef = agent.provider.apiKeyRef?.trim() || "OPENAI_API_KEY";
    const apiKey = process.env[keyRef] ?? "";
    if (!apiKey) {
      return `# Provider not configured\n\nMissing API key in env var ${keyRef}.\n\nPrompt:\n\n${prompt}`;
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: agent.provider.model,
        input: prompt
      })
    }).catch(() => null);

    if (!response || !response.ok) {
      return `# OpenAI request failed\n\nCould not generate output from ${agent.provider.model}.\n\nPrompt:\n\n${prompt}`;
    }

    const body = (await response.json().catch(() => ({}))) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };
    if (typeof body.output_text === "string" && body.output_text.trim()) return body.output_text;
    const text = body.output?.flatMap((item) => item.content ?? []).find((entry) => entry.type === "output_text" || entry.type === "text")?.text;
    return text?.trim() || "No output produced.";
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

  private normalizeOrgNode(input: Record<string, unknown> | null): OrgNode | null {
    if (!input) return null;
    const agentId = typeof input.agentId === "string" ? input.agentId : "";
    if (!agentId) return null;
    const node: OrgNode = {
      id: typeof input.id === "string" && input.id ? input.id : crypto.randomUUID(),
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
}
