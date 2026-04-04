import { afterEach, beforeEach, test, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

const { runMissionDetailedMock, resumeMissionRunMock, discoverMissionProvidersMock } = vi.hoisted(() => ({
  runMissionDetailedMock: vi.fn(),
  resumeMissionRunMock: vi.fn(),
  discoverMissionProvidersMock: vi.fn()
}));

vi.mock("@orchestrum/core", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@orchestrum/core");
  return {
    ...actual,
    runMissionDetailed: runMissionDetailedMock,
    resumeMissionRun: resumeMissionRunMock,
    discoverMissionProviders: discoverMissionProvidersMock
  };
});

import { AgentPlatform } from "../src/agentPlatform.js";
import { appendWorkItemTrace } from "@orchestrum/core";

type Fixture = Awaited<ReturnType<typeof createFixture>>;

let fixture: Fixture | null = null;
let originalHome = process.env.HOME;

beforeEach(async () => {
  fixture = await createFixture();
});

afterEach(async () => {
  fixture?.platform.shutdown();
  fixture = null;
  runMissionDetailedMock.mockReset();
  resumeMissionRunMock.mockReset();
  discoverMissionProvidersMock.mockReset();
  process.env.HOME = originalHome;
});

test("mission-backed implement task fails explicitly when mission execution fails", async () => {
  assert.ok(fixture);
  runMissionDetailedMock.mockRejectedValueOnce(new Error("provider blew up"));

  const task = await createQueuedTask(fixture, "implement");
  await (fixture.platform as any).schedulerTick();
  await waitFor(() => task.status === "failed");

  assert.equal(task.status, "failed");
  assert.match(task.resultSummary ?? "", /provider blew up/i);
  assert.equal(fsSync.existsSync(path.join(task.artifactsPath, "changes.diff")), false);
  assert.equal(fsSync.existsSync(path.join(task.artifactsPath, "manual-task.md")), false);
});

test("repo-changing tasks are mission-backed and mirror mission truth", async () => {
  assert.ok(fixture);
  const now = new Date().toISOString();
  runMissionDetailedMock.mockResolvedValueOnce({
    ok: true,
    runId: "run-1",
    runDir: path.join(fixture.rootDir, "runs", "demo", "run-1"),
    run: {
      runId: "run-1",
      kind: "mission",
      status: "completed",
      start: now,
      end: now,
      workspaceId: "demo",
      repoPath: fixture.repoPath,
      missionTemplateId: "implement-only",
      goal: "Implement the requested change.",
      totalSteps: 4,
      completedSteps: 4,
      totalTokens: 0,
      totalCost: 0,
      graph: {
        templateId: "feature-dev",
        name: "Feature Dev Loop",
        description: "Feature dev",
        category: "implementation",
        nodes: []
      },
      pauseReason: null,
      change: {
        status: "validated",
        diffArtifact: "git.diff",
        appliedAt: now,
        source: "provider"
      },
      validation: {
        status: "passed",
        commands: ["npm test"],
        results: [{ command: "npm test", ok: true, exitCode: 0, summary: "test passed." }],
        attemptedAt: now,
        completedAt: now
      },
      verdict: "ready_to_merge"
    }
  });

  const task = await createQueuedTask(fixture, "implement");
  await (fixture.platform as any).schedulerTick();
  await waitFor(() => task.status === "succeeded");

  assert.equal(task.status, "succeeded");
  assert.equal(task.linkedTemplateId, "implement-only");
  assert.equal(task.linkedRunId, "run-1");
  assert.equal(task.change?.status, "validated");
  assert.equal(task.validation?.status, "passed");
  assert.equal(task.verdict, "ready_to_merge");

  const call = runMissionDetailedMock.mock.calls[0]?.[0] as { templateId?: string; agents?: Array<{ role?: string }> };
  assert.equal(call?.templateId, "implement-only");
  assert.deepEqual(
    (call?.agents ?? []).map((agent) => agent.role).sort(),
    ["dev"]
  );
  assert.equal(fsSync.existsSync(path.join(task.artifactsPath, "linked-run.json")), true);
  assert.equal(fsSync.existsSync(path.join(task.artifactsPath, "run-result.json")), true);
});

test("resumed mission runs sync linked task truth when the resumed run settles immediately", async () => {
  assert.ok(fixture);
  const now = new Date().toISOString();
  const task = await createQueuedTask(fixture, "implement");
  Object.assign(task, {
    status: "paused",
    linkedRunId: "resume-run-1",
    linkedTemplateId: "implement-only",
    workspaceId: "demo",
    resultSummary: "Mission paused awaiting approval."
  });

  resumeMissionRunMock.mockResolvedValueOnce({
    ok: true,
    run: {
      runId: "resume-run-1",
      kind: "mission",
      status: "completed",
      start: now,
      end: now,
      workspaceId: "demo",
      repoPath: fixture.repoPath,
      missionTemplateId: "implement-only",
      goal: "Resume implement run.",
      totalSteps: 1,
      completedSteps: 1,
      totalTokens: 0,
      totalCost: 0,
      graph: {
        templateId: "implement-only",
        name: "Implement Only",
        description: "Implement only",
        category: "implementation",
        nodes: []
      },
      pauseReason: null,
      change: {
        status: "applied",
        diffArtifact: "git.diff",
        appliedAt: now,
        source: "provider"
      },
      validation: {
        status: "not_requested",
        commands: [],
        results: []
      },
      verdict: "ready_for_review"
    }
  });

  const resumed = await fixture.platform.resumeMission({
    runsDir: path.join(fixture.rootDir, "runs"),
    workspaceId: "demo",
    runId: "resume-run-1"
  });

  assert.equal(resumed.ok, true);
  assert.equal(task.status, "succeeded");
  assert.equal(task.pauseReason, null);
  assert.equal(task.change?.status, "applied");
  assert.equal(task.validation?.status, "not_requested");
  assert.equal(task.verdict, "ready_for_review");
  assert.match(task.resultSummary ?? "", /Mission completed with change=applied and validation=not_requested\./);
});

test("mission-backed task goals omit orchestration-only payload fields", async () => {
  assert.ok(fixture);
  const now = new Date().toISOString();
  runMissionDetailedMock.mockResolvedValueOnce({
    ok: true,
    runId: "run-audit-goal",
    runDir: path.join(fixture.rootDir, "runs", "demo", "run-audit-goal"),
    run: {
      runId: "run-audit-goal",
      kind: "mission",
      status: "completed",
      start: now,
      end: now,
      workspaceId: "demo",
      repoPath: fixture.repoPath,
      missionTemplateId: "audit-only",
      goal: "Audit the requested repo area.",
      totalSteps: 1,
      completedSteps: 1,
      totalTokens: 0,
      totalCost: 0,
      graph: {
        templateId: "audit-only",
        name: "Audit Only",
        description: "Audit only",
        category: "analysis",
        nodes: []
      },
      pauseReason: null,
      change: null,
      validation: null,
      verdict: "ready_to_merge"
    }
  });

  const task = await createQueuedTask(fixture, "audit");
  Object.assign(task, {
    title: "Produce audit findings",
    description: "Review the requested repo area and return findings without opening an implementation lane.",
    payload: {
      workItemId: "work-item-1",
      workItemTitle: "Packaged audit truth rerun",
      sourceType: "audit",
      request: "Audit the repo and report only repo-backed blocking findings.",
      planningSummary: "Audit the repo and report only repo-backed blocking findings.",
      acceptanceCriteria: [],
      constraints: [],
      plannerTaskId: "final_audit",
      plannerTaskKind: "review",
      cycleId: "cycle-1",
      workstreamId: "stream-audit",
      gateRefs: ["gate-audit"],
      qaMode: null,
      laneId: "audit",
      laneLabel: "Audit",
      roleHint: "audit",
      ownerAgentId: fixture.agent.id,
      ownerAgentName: fixture.agent.name,
      ownerRole: fixture.agent.role,
      cycleSequence: 1,
      cycleKind: "initial",
      reviewStatus: "pending",
      reviewNote: null,
      reviewedAt: null
    }
  });

  await (fixture.platform as any).schedulerTick();
  await waitFor(() => task.status === "succeeded");

  const call = runMissionDetailedMock.mock.calls[0]?.[0] as { templateId?: string; goal?: string } | undefined;
  assert.equal(call?.templateId, "audit-only");
  assert.match(call?.goal ?? "", /"request": "Audit the repo and report only repo-backed blocking findings\."/);
  assert.match(call?.goal ?? "", /"plannerTaskKind": "review"/);
  assert.doesNotMatch(call?.goal ?? "", /"workItemId":/);
  assert.doesNotMatch(call?.goal ?? "", /"plannerTaskId":/);
  assert.doesNotMatch(call?.goal ?? "", /"cycleId":/);
  assert.doesNotMatch(call?.goal ?? "", /"workstreamId":/);
  assert.doesNotMatch(call?.goal ?? "", /"gateRefs":/);
  assert.doesNotMatch(call?.goal ?? "", /"ownerAgentId":/);
  assert.doesNotMatch(call?.goal ?? "", /"reviewStatus":/);
});

test("agent runtime enrichment exposes active workstreams, prompts, exchanges, and cost", async () => {
  assert.ok(fixture);
  const task = await createQueuedTask(fixture, "implement");
  Object.assign(task, {
    workspaceId: "demo",
    status: "running",
    linkedWorkItemId: "work-item-1",
    linkedWorkItemTitle: "Add backend endpoint",
    workstreamId: "implement-backend",
    laneLabel: "Backend",
    ownerAgentId: fixture.agent.id,
    ownerAgentName: fixture.agent.name,
    ownerRole: fixture.agent.role
  });

  await appendWorkItemTrace(fixture.repoPath, {
    workspaceId: "demo",
    workItemId: "work-item-1",
    cycleId: "cycle-1",
    workstreamId: "implement-backend",
    taskId: task.id,
    traceType: "assignment",
    ownerAgentId: fixture.agent.id,
    ownerAgentName: fixture.agent.name,
    ownerRole: fixture.agent.role,
    assignmentToAgentId: fixture.agent.id,
    assignmentToAgentName: fixture.agent.name,
    promptCountDelta: 1,
    exchangeCountDelta: 0,
    summary: "Developer Agent assigned backend implementation."
  });
  await appendWorkItemTrace(fixture.repoPath, {
    workspaceId: "demo",
    workItemId: "work-item-1",
    cycleId: "cycle-1",
    workstreamId: "implement-backend",
    taskId: task.id,
    traceType: "provider_prompt",
    ownerAgentId: fixture.agent.id,
    ownerAgentName: fixture.agent.name,
    ownerRole: fixture.agent.role,
    providerModel: "gpt-5-mini",
    promptCountDelta: 1,
    exchangeCountDelta: 0,
    summary: "Developer Agent sent a provider prompt."
  });
  await appendWorkItemTrace(fixture.repoPath, {
    workspaceId: "demo",
    workItemId: "work-item-1",
    cycleId: "cycle-1",
    workstreamId: "implement-backend",
    taskId: task.id,
    traceType: "provider_response",
    ownerAgentId: fixture.agent.id,
    ownerAgentName: fixture.agent.name,
    ownerRole: fixture.agent.role,
    providerModel: "gpt-5-mini",
    promptCountDelta: 0,
    exchangeCountDelta: 1,
    summary: "Developer Agent received a provider response."
  });
  await appendWorkItemTrace(fixture.repoPath, {
    workspaceId: "demo",
    workItemId: "work-item-1",
    cycleId: "cycle-1",
    workstreamId: "implement-backend",
    taskId: task.id,
    traceType: "cost_update",
    ownerAgentId: fixture.agent.id,
    ownerAgentName: fixture.agent.name,
    ownerRole: fixture.agent.role,
    providerModel: "gpt-5-mini",
    estimatedCostUsd: 0.12,
    summary: "Developer Agent updated prompt cost."
  });

  const enriched = await (fixture.platform as any).enrichAgentsForRuntime([(fixture.platform as any).agents[0]], "demo", fixture.repoPath);
  assert.equal(enriched.length, 1);
  assert.equal(enriched[0].runtime.currentModel, "gpt-5-mini");
  assert.equal(enriched[0].runtime.promptCount, 2);
  assert.equal(enriched[0].runtime.exchangeCount, 1);
  assert.equal(enriched[0].runtime.estimatedCostUsd, 0.12);
  assert.deepEqual(enriched[0].runtime.assignedWorkItems, ["work-item-1"]);
  assert.equal(enriched[0].runtime.activeWorkstreams[0]?.workstreamId, "implement-backend");
  assert.match(enriched[0].runtime.recentAssignmentSummary ?? "", /assigned backend implementation/i);
});

test("mission launch auto-bootstraps a minimal workspace roster when none exists", async () => {
  const bootstrapFixture = await createFixture({ seedAgents: false });
  discoverMissionProvidersMock.mockResolvedValue([
    {
      vendor: "codex",
      label: "Codex",
      preferredTransport: "cli",
      transports: [{
        transport: "cli",
        available: true,
        configured: true,
        profiles: [{
          id: "codex-cli-balanced",
          vendor: "codex",
          transport: "cli",
          label: "Balanced",
          description: "Balanced",
          model: "gpt-5",
          recommended: true,
          roleHints: ["pm", "dev", "audit"]
        }],
        capabilities: {
          supportsTools: true,
          supportsEffort: false,
          supportsReadOnlyMode: true,
          supportsJsonOutput: true,
          supportsModelDiscovery: false,
          supportsAuthProbe: true
        }
      }]
    }
  ]);
  const now = new Date().toISOString();
  runMissionDetailedMock.mockResolvedValueOnce({
    ok: true,
    runId: "run-bootstrap",
    runDir: path.join(bootstrapFixture.rootDir, "runs", "demo", "run-bootstrap"),
    run: {
      runId: "run-bootstrap",
      kind: "mission",
      status: "completed",
      start: now,
      end: now,
      workspaceId: "demo",
      repoPath: bootstrapFixture.repoPath,
      missionTemplateId: "feature-dev",
      goal: "Bootstrap feature mission.",
      totalSteps: 4,
      completedSteps: 4,
      totalTokens: 0,
      totalCost: 0,
      graph: {
        templateId: "feature-dev",
        name: "Feature Dev Loop",
        description: "Feature dev",
        category: "implementation",
        nodes: []
      },
      pauseReason: null,
      change: null,
      validation: null,
      verdict: "ready_to_merge"
    }
  });

  const started = await bootstrapFixture.platform.startMission({
    runsDir: path.join(bootstrapFixture.rootDir, "runs"),
    workspaceId: "demo",
    repoPath: bootstrapFixture.repoPath,
    templateId: "feature-dev",
    goal: "Bootstrap feature mission."
  });

  assert.equal(started.ok, true);
  await waitFor(() => runMissionDetailedMock.mock.calls.length > 0);

  const call = runMissionDetailedMock.mock.calls.at(-1)?.[0] as { agents?: Array<{ role?: string; name?: string }> } | undefined;
  assert.deepEqual(
    (call?.agents ?? []).map((agent) => agent.role).sort(),
    ["audit", "dev", "pm"]
  );

  const savedAgents = JSON.parse(
    await fs.readFile(path.join(bootstrapFixture.repoPath, ".orchestrum", "control", "agents.json"), "utf8")
  ) as Array<{ name: string; role: string; profile?: { specialization?: string }; provider?: { vendor?: string; profileId?: string } }>;
  assert.deepEqual(
    savedAgents.map((agent) => `${agent.role}:${agent.profile?.specialization ?? ""}`).sort(),
    ["audit:audit", "dev:fullstack", "pm:pm"]
  );
  assert.equal(savedAgents.find((agent) => agent.role === "dev")?.provider?.vendor, "codex");
  assert.equal(savedAgents.find((agent) => agent.role === "dev")?.provider?.profileId, "codex-cli-balanced");

  bootstrapFixture.platform.shutdown();
});

test("audit-only mission bootstrap creates planner and auditor coverage", async () => {
  const bootstrapFixture = await createFixture({ seedAgents: false });
  discoverMissionProvidersMock.mockResolvedValue([]);
  const now = new Date().toISOString();
  runMissionDetailedMock.mockResolvedValueOnce({
    ok: true,
    runId: "run-audit-bootstrap",
    runDir: path.join(bootstrapFixture.rootDir, "runs", "demo", "run-audit-bootstrap"),
    run: {
      runId: "run-audit-bootstrap",
      kind: "mission",
      status: "completed",
      start: now,
      end: now,
      workspaceId: "demo",
      repoPath: bootstrapFixture.repoPath,
      missionTemplateId: "audit-only",
      goal: "Bootstrap audit mission.",
      totalSteps: 2,
      completedSteps: 2,
      totalTokens: 0,
      totalCost: 0,
      graph: {
        templateId: "audit-only",
        name: "Audit Only",
        description: "Audit only",
        category: "analysis",
        nodes: []
      },
      pauseReason: null,
      change: null,
      validation: null,
      verdict: "ready_to_merge"
    }
  });

  const started = await bootstrapFixture.platform.startMission({
    runsDir: path.join(bootstrapFixture.rootDir, "runs"),
    workspaceId: "demo",
    repoPath: bootstrapFixture.repoPath,
    templateId: "audit-only",
    goal: "Bootstrap audit mission."
  });

  assert.equal(started.ok, true);
  await waitFor(() => runMissionDetailedMock.mock.calls.length > 0);

  const call = runMissionDetailedMock.mock.calls.at(-1)?.[0] as { agents?: Array<{ role?: string }> } | undefined;
  assert.deepEqual(
    (call?.agents ?? []).map((agent) => agent.role).sort(),
    ["audit", "pm"]
  );

  const savedAgents = JSON.parse(
    await fs.readFile(path.join(bootstrapFixture.repoPath, ".orchestrum", "control", "agents.json"), "utf8")
  ) as Array<{ role: string; profile?: { specialization?: string } }>;
  assert.deepEqual(
    savedAgents.map((agent) => `${agent.role}:${agent.profile?.specialization ?? ""}`).sort(),
    ["audit:audit", "pm:pm"]
  );

  bootstrapFixture.platform.shutdown();
});

test("bootstrap keeps a detected provider but marks it as needing setup", async () => {
  const bootstrapFixture = await createFixture({ seedAgents: false });
  const now = new Date().toISOString();
  discoverMissionProvidersMock.mockResolvedValue([
    {
      vendor: "copilot",
      label: "GitHub Copilot",
      preferredTransport: "cli",
      transports: [{
        transport: "cli",
        available: true,
        configured: false,
        profiles: [{
          id: "copilot-cli-gpt54",
          vendor: "copilot",
          transport: "cli",
          label: "GPT-5.4",
          description: "Copilot GPT-5.4",
          model: "gpt-5.4",
          recommended: true,
          roleHints: ["dev"]
        }],
        capabilities: {
          supportsTools: true,
          supportsEffort: true,
          supportsReadOnlyMode: true,
          supportsJsonOutput: true,
          supportsModelDiscovery: false,
          supportsAuthProbe: true
        }
      }]
    }
  ]);
  runMissionDetailedMock.mockResolvedValueOnce({
    ok: true,
    runId: "run-detected-provider",
    runDir: path.join(bootstrapFixture.rootDir, "runs", "demo", "run-detected-provider"),
    run: {
      runId: "run-detected-provider",
      kind: "mission",
      status: "completed",
      start: now,
      end: now,
      workspaceId: "demo",
      repoPath: bootstrapFixture.repoPath,
      missionTemplateId: "feature-dev",
      goal: "Bootstrap feature mission.",
      totalSteps: 1,
      completedSteps: 1,
      totalTokens: 0,
      totalCost: 0,
      graph: {
        templateId: "feature-dev",
        name: "Feature Dev Loop",
        description: "Feature dev",
        category: "implementation",
        nodes: []
      },
      pauseReason: null,
      change: null,
      validation: null,
      verdict: "ready_to_merge"
    }
  });

  const started = await bootstrapFixture.platform.startMission({
    runsDir: path.join(bootstrapFixture.rootDir, "runs"),
    workspaceId: "demo",
    repoPath: bootstrapFixture.repoPath,
    templateId: "feature-dev",
    goal: "Bootstrap feature mission."
  });

  assert.equal(started.ok, true);
  const enriched = await (bootstrapFixture.platform as any).enrichAgentsForRuntime(
    (bootstrapFixture.platform as any).agents,
    "demo",
    bootstrapFixture.repoPath
  );
  const devAgent = enriched.find((agent: { role?: string }) => agent.role === "dev");
  assert.equal(devAgent?.provider?.vendor, "copilot");
  assert.equal(devAgent?.runtime?.providerReadiness, "detected_needs_setup");
  assert.match(devAgent?.runtime?.providerReadinessReason ?? "", /needs sign-in or setup/i);

  bootstrapFixture.platform.shutdown();
});

async function createFixture(options: { seedAgents?: boolean } = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-service-agent-"));
  const homeDir = path.join(rootDir, "home");
  const repoPath = path.join(rootDir, "repo");
  process.env.HOME = homeDir;
  await fs.mkdir(path.join(rootDir, ".orchestrum", "control"), { recursive: true });
  await fs.mkdir(path.join(repoPath, ".orchestrum", "control"), { recursive: true });
  await fs.writeFile(
    path.join(repoPath, ".orchestrum", "control", "workspace.json"),
    JSON.stringify({ id: "demo", path: repoPath, name: "Demo" }, null, 2),
    "utf8"
  );
  const agent = {
    id: "agent-1",
    workspaceId: "demo",
    name: "Developer Agent",
    role: "dev",
    tags: [],
    provider: {
      vendor: "openai",
      transport: "api",
      profileId: "openai-api-gpt5",
      auth: { kind: "api_key", secretRef: "OPENAI_API_KEY" }
    },
    capabilities: {
      shell: false,
      fs: true,
      network: true
    },
    status: {
      state: "idle",
      lastHeartbeatAt: new Date().toISOString()
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await fs.writeFile(
    path.join(repoPath, ".orchestrum", "control", "agents.json"),
    JSON.stringify(options.seedAgents === false ? [] : [agent], null, 2),
    "utf8"
  );
  await fs.writeFile(path.join(repoPath, ".orchestrum", "control", "org.json"), "[]", "utf8");

  const platform = new AgentPlatform({
    rootDir,
    listWorkspacePaths: async () => [repoPath]
  });
  await platform.init();
  return { platform, agent, rootDir, repoPath };
}

async function createQueuedTask(fixture: Fixture, type: "implement" | "spec" | "audit") {
  const taskId = `task-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const taskDir = path.join(fixture.repoPath, ".orchestrum", "control", "tasks", taskId);
  await fs.mkdir(path.join(taskDir, "artifacts"), { recursive: true });
  const task = {
    id: taskId,
    title: "Test task",
    description: "Run through the task pipeline.",
    type,
    payload: {},
    assignedToAgentId: fixture.agent.id,
    dependsOnTaskIds: [],
    waitingOnTaskIds: [],
    blockedByTaskIds: [],
    status: "queued",
    createdAt: new Date().toISOString(),
    attempts: 0,
    maxAttempts: 2,
    artifactsPath: path.join(taskDir, "artifacts"),
    logsPath: path.join(taskDir, "logs.ndjson")
  };
  (fixture.platform as any).tasks = [task];
  (fixture.platform as any).agents = [(fixture.platform as any).agents[0]];
  return task as {
    status: string;
    resultSummary?: string;
    linkedTemplateId?: string;
    linkedRunId?: string;
    change?: { status?: string };
    validation?: { status?: string };
    verdict?: string;
    artifactsPath: string;
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}
