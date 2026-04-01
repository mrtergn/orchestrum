import { afterEach, beforeEach, test, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

const { runMissionDetailedMock } = vi.hoisted(() => ({
  runMissionDetailedMock: vi.fn()
}));

vi.mock("@orchestrum/core", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@orchestrum/core");
  return {
    ...actual,
    runMissionDetailed: runMissionDetailedMock
  };
});

import { AgentPlatform } from "../src/agentPlatform.js";

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

async function createFixture() {
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
  await fs.writeFile(path.join(repoPath, ".orchestrum", "control", "agents.json"), JSON.stringify([agent], null, 2), "utf8");
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
