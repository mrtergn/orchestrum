import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { importMissionNodeInput, loadMissionRun, resumeMissionRun, runMissionDetailed } from "../src/mission/runtime.js";
import { buildAgents, buildDeliveryAgents, createMissionSandbox, enablePassingValidationScripts, mockProviderFetch, singleLineDiff, wrapDiff } from "./missionTestUtils.js";

const execFileAsync = promisify(execFile);

test("feature-dev mission records explicit patch and validation truth", async () => {
  const sandbox = await createMissionSandbox("mission-truth-validate");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  await fs.writeFile(
    path.join(sandbox.repoPath, "package.json"),
    JSON.stringify({
      name: "mission-truth-validate",
      version: "1.0.0",
      scripts: {
        typecheck: "node -e \"process.exit(0)\"",
        test: "node -e \"process.exit(0)\""
      }
    }, null, 2),
    "utf8"
  );
  globalThis.fetch = mockProviderFetch("openai", [
    { text: "Implementation plan ready." },
    { text: wrapDiff(singleLineDiff("src/index.ts", "export const ok = true;", "export const ok = false;")) },
    { text: JSON.stringify({ blocking: false, issues: [] }) }
  ]);

  try {
    const result = await runMissionDetailed({
      templateId: "feature-dev",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Flip the exported value and validate it.",
      agents: buildAgents("openai")
    });

    assert.equal(result.run.status, "completed");
    assert.equal(result.run.change?.status, "validated");
    assert.equal(result.run.validation?.status, "passed");
    assert.equal(result.run.verdict, "ready_to_merge");
    assert.equal(result.run.graph.nodes.find((node) => node.id === "validate")?.status, "completed");
    assert.ok(fsSync.existsSync(path.join(result.runDir, "nodes", "validate", "validation", "summary.json")));
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  }
});

test("delivery-sprint pauses for input without emitting a failed node event", async () => {
  const sandbox = await createMissionSandbox("mission-truth-pause");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  globalThis.fetch = mockProviderFetch("openai", [
    { text: "Sprint brief ready." }
  ]);

  try {
    const result = await runMissionDetailed({
      templateId: "delivery-sprint",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Prepare a delivery handoff and wait for import.",
      agents: buildDeliveryAgents("openai")
    });

    assert.equal(result.run.status, "paused");
    assert.equal(result.run.pauseReason, "awaiting_input");
    assert.equal(result.run.graph.nodes.find((node) => node.id === "handoff_wait")?.status, "waiting_input");

    const events = await fs.readFile(path.join(result.runDir, "events.ndjson"), "utf8");
    assert.match(events, /mission\.node\.paused/);
    assert.doesNotMatch(events, /"t":"mission\.node\.failed".*"nodeId":"handoff_wait"/);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  }
});

test("blocking audit findings become explicit finding review recovery", async () => {
  const sandbox = await createMissionSandbox("mission-truth-audit-findings");
  await enablePassingValidationScripts(sandbox.repoPath);
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  globalThis.fetch = mockProviderFetch("openai", [
    { text: "Implementation plan ready." },
    { text: wrapDiff(singleLineDiff("src/index.ts", "export const ok = true;", "export const ok = false;")) },
    {
      text: JSON.stringify({
        blocking: true,
        issues: [
          { severity: "high", file: "README.md", line: 1, message: "Document the new runtime behavior" }
        ],
        suggested_fix: wrapDiff(singleLineDiff("README.md", "# Demo", "# Demo\n\nDocument the new runtime behavior."))
      })
    }
  ]);

  try {
    const result = await runMissionDetailed({
      templateId: "feature-dev",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Flip the exported value and block on audit findings.",
      agents: buildAgents("openai")
    });

    assert.equal(result.run.status, "blocked");
    assert.equal(result.run.recovery?.kind, "audit_findings");
    assert.match(result.run.recovery?.summary ?? "", /Audit recorded 1 blocking finding/i);
    assert.equal(result.run.recovery?.artifacts.some((artifact) => artifact.path === "output.json"), true);
    assert.equal(result.run.recovery?.artifacts.some((artifact) => artifact.path === "suggested_fix.diff"), true);
    assert.equal(result.run.recovery?.suggestedActions.some((action) => action.kind === "inspect_artifact"), true);
    assert.match(result.run.graph.nodes.find((node) => node.id === "audit")?.error ?? "", /Audit recorded 1 blocking finding/i);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  }
});

test("audit-only mission truncates oversized git diff inputs for prompt safety", async () => {
  const sandbox = await createMissionSandbox("mission-truth-audit-diff-budget", {
    relativePath: "src/oversized.ts",
    initialContent: "export const seed = 0;\n"
  });
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  const largeDiffBody = Array.from({ length: 9_000 }, (_, index) => `export const value${index} = ${index};`).join("\n");
  await fs.writeFile(path.join(sandbox.repoPath, "src", "oversized.ts"), `${largeDiffBody}\n`, "utf8");
  globalThis.fetch = mockProviderFetch("openai", [
    {
      text: JSON.stringify({
        blocking: false,
        issues: []
      })
    }
  ]);

  try {
    const goal = [
      "Task title: Produce audit findings",
      "",
      "Review the requested repo area and return findings without opening an implementation lane.",
      "",
      "Payload:",
      JSON.stringify({
        workItemTitle: "Packaged audit truth rerun",
        sourceType: "audit",
        request: "Audit the repo and report only repo-backed blocking findings.",
        planningSummary: "Audit the repo and report only repo-backed blocking findings.",
        plannerTaskKind: "review",
        workstreamType: "audit",
        laneLabel: "Audit",
        roleHint: "audit"
      }, null, 2)
    ].join("\n");
    const result = await runMissionDetailed({
      templateId: "audit-only",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal,
      agents: buildAgents("openai")
    });

    assert.equal(result.run.status, "completed");
    const prompt = await fs.readFile(path.join(result.runDir, "nodes", "audit", "prompt.md"), "utf8");
    assert.match(prompt, /Git diff truncated for prompt safety/i);
    assert.match(prompt, /Top-level entries:/i);
    assert.match(prompt, /Patch excerpt \(start\):/i);
    assert.ok(prompt.length < 18_000);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  }
});

test("audit-only mission drops false-positive missing module findings when the import resolves", async () => {
  const sandbox = await createMissionSandbox("mission-truth-audit-module-resolution");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  await fs.mkdir(path.join(sandbox.repoPath, "apps", "ui", "src", "app", "about"), { recursive: true });
  await fs.mkdir(path.join(sandbox.repoPath, "apps", "ui", "src", "components", "ui"), { recursive: true });
  await fs.writeFile(
    path.join(sandbox.repoPath, "apps", "ui", "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "@/*": ["src/*"]
        }
      }
    }, null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(sandbox.repoPath, "apps", "ui", "src", "app", "about", "page.tsx"),
    [
      '"use client";',
      'import { PageHeader } from "@/components/ui/PagePrimitives";',
      "",
      "export default function AboutPage() {",
      '  return <PageHeader title="About" />;',
      "}"
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(sandbox.repoPath, "apps", "ui", "src", "components", "ui", "PagePrimitives.tsx"),
    [
      '"use client";',
      "",
      "export function PageHeader({ title }: { title: string }) {",
      "  return <div>{title}</div>;",
      "}"
    ].join("\n"),
    "utf8"
  );
  globalThis.fetch = mockProviderFetch("openai", [
    {
      text: JSON.stringify({
        blocking: true,
        issues: [
          {
            severity: "high",
            file: "apps/ui/src/app/about/page.tsx",
            line: 2,
            message: "Imports '@/components/ui/PagePrimitives' but that module does not exist in the repository; Next.js build will fail with 'Module not found'."
          }
        ]
      })
    }
  ]);

  try {
    const result = await runMissionDetailed({
      templateId: "audit-only",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Audit the repo without accepting false missing-module findings.",
      agents: buildAgents("openai")
    });

    assert.equal(result.run.status, "completed");
    const output = JSON.parse(await fs.readFile(path.join(result.runDir, "nodes", "audit", "output.json"), "utf8")) as {
      blocking: boolean;
      issues: Array<unknown>;
    };
    assert.equal(output.blocking, false);
    assert.deepEqual(output.issues, []);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  }
});

test("audit-only mission drops false-positive missing API route findings when handlers exist", async () => {
  const sandbox = await createMissionSandbox("mission-truth-audit-route-resolution");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  await fs.mkdir(path.join(sandbox.repoPath, "apps", "ui", "src", "app", "about"), { recursive: true });
  await fs.mkdir(path.join(sandbox.repoPath, "apps", "ui", "src", "app", "api", "updates", "status"), { recursive: true });
  await fs.mkdir(path.join(sandbox.repoPath, "apps", "ui", "src", "app", "api", "updates", "install"), { recursive: true });
  await fs.mkdir(path.join(sandbox.repoPath, "apps", "ui", "src", "app", "api", "updates", "history"), { recursive: true });
  await fs.mkdir(path.join(sandbox.repoPath, "apps", "ui", "src", "app", "api", "updates", "rollback"), { recursive: true });
  await fs.writeFile(
    path.join(sandbox.repoPath, "apps", "ui", "src", "app", "about", "page.tsx"),
    [
      '"use client";',
      "",
      "export default function AboutPage() {",
      "  return null;",
      "}"
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(path.join(sandbox.repoPath, "apps", "ui", "src", "app", "api", "updates", "status", "route.ts"), "export async function GET() { return Response.json({ ok: true }); }\n", "utf8");
  await fs.writeFile(path.join(sandbox.repoPath, "apps", "ui", "src", "app", "api", "updates", "install", "route.ts"), "export async function POST() { return Response.json({ ok: true }); }\n", "utf8");
  await fs.writeFile(path.join(sandbox.repoPath, "apps", "ui", "src", "app", "api", "updates", "history", "route.ts"), "export async function GET() { return Response.json({ journals: [] }); }\n", "utf8");
  await fs.writeFile(path.join(sandbox.repoPath, "apps", "ui", "src", "app", "api", "updates", "rollback", "route.ts"), "export async function POST() { return Response.json({ ok: true }); }\n", "utf8");
  globalThis.fetch = mockProviderFetch("openai", [
    {
      text: JSON.stringify({
        blocking: true,
        issues: [
          {
            severity: "high",
            file: "apps/ui/src/app/about/page.tsx",
            line: null,
            message: "About page calls missing API routes: /api/updates/status, /api/updates/install (POST), /api/updates/history, and /api/updates/rollback (POST). No corresponding handlers exist under apps/ui/src/app/api/updates/, causing runtime 404s and breaking the updater UI."
          }
        ]
      })
    }
  ]);

  try {
    const result = await runMissionDetailed({
      templateId: "audit-only",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Audit the repo without accepting false missing API route findings.",
      agents: buildAgents("openai")
    });

    assert.equal(result.run.status, "completed");
    const output = JSON.parse(await fs.readFile(path.join(result.runDir, "nodes", "audit", "output.json"), "utf8")) as {
      blocking: boolean;
      issues: Array<unknown>;
    };
    assert.equal(output.blocking, false);
    assert.deepEqual(output.issues, []);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  }
});

test("audit-only mission drops false-positive unused import findings when the symbol is referenced", async () => {
  const sandbox = await createMissionSandbox("mission-truth-audit-unused-import-resolution");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  await fs.mkdir(path.join(sandbox.repoPath, "apps", "ui", "src", "app", "about"), { recursive: true });
  await fs.writeFile(
    path.join(sandbox.repoPath, "apps", "ui", "src", "app", "about", "page.tsx"),
    [
      '"use client";',
      'import Link from "next/link";',
      "",
      "export default function AboutPage() {",
      '  return <Link href="/help">Help</Link>;',
      "}"
    ].join("\n"),
    "utf8"
  );
  globalThis.fetch = mockProviderFetch("openai", [
    {
      text: JSON.stringify({
        blocking: true,
        issues: [
          {
            severity: "medium",
            file: "apps/ui/src/app/about/page.tsx",
            line: 2,
            message: 'Unused import: Link from "next/link". The verify pipeline runs lint and may fail if unused imports are treated as errors.'
          }
        ]
      })
    }
  ]);

  try {
    const result = await runMissionDetailed({
      templateId: "audit-only",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Audit the repo without accepting false unused import findings.",
      agents: buildAgents("openai")
    });

    assert.equal(result.run.status, "completed");
    const output = JSON.parse(await fs.readFile(path.join(result.runDir, "nodes", "audit", "output.json"), "utf8")) as {
      blocking: boolean;
      issues: Array<unknown>;
    };
    assert.equal(output.blocking, false);
    assert.deepEqual(output.issues, []);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  }
});

test("audit-only mission drops false-positive linked work item task field findings when service task records set the field", async () => {
  const sandbox = await createMissionSandbox("mission-truth-audit-linked-work-item-resolution");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  await fs.mkdir(path.join(sandbox.repoPath, "apps", "ui", "src", "lib"), { recursive: true });
  await fs.mkdir(path.join(sandbox.repoPath, "packages", "service", "src"), { recursive: true });
  await fs.writeFile(
    path.join(sandbox.repoPath, "apps", "ui", "src", "lib", "workRuntime.ts"),
    [
      "export type RuntimeTaskRecord = {",
      "  linkedWorkItemId?: string;",
      "};",
      "",
      "export function getQueuedTasks(tasks: RuntimeTaskRecord[], workItemId: string) {",
      "  return tasks.filter((task) => task.linkedWorkItemId === workItemId);",
      "}"
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(sandbox.repoPath, "packages", "service", "src", "agentPlatform.ts"),
    [
      "export function queueTask(options: { workItem: { id: string } }) {",
      "  return { linkedWorkItemId: options.workItem.id };",
      "}",
      "",
      "export function createTask(input: { linkedWorkItemId?: string }) {",
      "  return { linkedWorkItemId: input.linkedWorkItemId };",
      "}",
      "",
      "export function hydrateRecord(record: { linkedWorkItemId?: string }) {",
      '  return { linkedWorkItemId: typeof record.linkedWorkItemId === "string" ? record.linkedWorkItemId : undefined };',
      "}"
    ].join("\n"),
    "utf8"
  );
  globalThis.fetch = mockProviderFetch("openai", [
    {
      text: JSON.stringify({
        blocking: true,
        issues: [
          {
            severity: "high",
            file: "apps/ui/src/lib/workRuntime.ts",
            line: null,
            message: "getQueuedTasks filters by task.linkedWorkItemId, but created tasks never set this property (only linkedRunId is set). This causes queued task queries per work item to return empty results and breaks runtime truth surfaces that depend on them."
          }
        ]
      })
    }
  ]);

  try {
    const result = await runMissionDetailed({
      templateId: "audit-only",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Audit the repo without accepting false linked work item task field findings.",
      agents: buildAgents("openai")
    });

    assert.equal(result.run.status, "completed");
    const output = JSON.parse(await fs.readFile(path.join(result.runDir, "nodes", "audit", "output.json"), "utf8")) as {
      blocking: boolean;
      issues: Array<unknown>;
    };
    assert.equal(output.blocking, false);
    assert.deepEqual(output.issues, []);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  }
});

test("audit-only mission drops false-positive build script findings when build:desktop already calls build:service", async () => {
  const sandbox = await createMissionSandbox("mission-truth-audit-build-script-resolution");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  await fs.writeFile(
    path.join(sandbox.repoPath, "package.json"),
    JSON.stringify({
      name: "mission-truth-audit-build-script-resolution",
      version: "1.0.0",
      scripts: {
        "build:ui": "echo ui",
        "build:service": "echo service",
        "build:desktop": "npm run build:ui && npm run build:service"
      }
    }, null, 2),
    "utf8"
  );
  globalThis.fetch = mockProviderFetch("openai", [
    {
      text: JSON.stringify({
        blocking: true,
        issues: [
          {
            severity: "high",
            file: "package.json",
            line: null,
            message: 'scripts.build:desktop appears to call a non-existent script ("build:ser..."). This will fail npm run verify (which invokes build:desktop) and block builds; it should call build:service.'
          }
        ]
      })
    }
  ]);

  try {
    const result = await runMissionDetailed({
      templateId: "audit-only",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Audit the repo without accepting false build script findings.",
      agents: buildAgents("openai")
    });

    assert.equal(result.run.status, "completed");
    const output = JSON.parse(await fs.readFile(path.join(result.runDir, "nodes", "audit", "output.json"), "utf8")) as {
      blocking: boolean;
      issues: Array<unknown>;
    };
    assert.equal(output.blocking, false);
    assert.deepEqual(output.issues, []);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  }
});

test("delivery import with invalid external patch becomes explicit apply failure", async () => {
  const sandbox = await createMissionSandbox("mission-truth-apply-fail");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  globalThis.fetch = mockProviderFetch("openai", [
    { text: "Sprint brief ready." }
  ]);

  try {
    const started = await runMissionDetailed({
      templateId: "delivery-sprint",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Wait for an external patch.",
      agents: buildDeliveryAgents("openai")
    });
    assert.equal(started.run.status, "paused");

    const imported = await importMissionNodeInput({
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      runId: started.runId,
      nodeId: "handoff_wait",
      text: [
        "Status: completed",
        "Summary: attempted to apply the requested change",
        "```diff",
        "--- src/index.ts",
        "+++ src/index.ts",
        "@@ malformed",
        "+broken",
        "```"
      ].join("\n")
    });

    assert.equal(imported.status, "blocked");
    assert.equal(imported.change?.status, "apply_failed");
    assert.equal(imported.graph.nodes.find((node) => node.id === "handoff_wait")?.change?.status, "apply_failed");
    assert.ok(fsSync.existsSync(path.join(started.runDir, "nodes", "handoff_wait", "conflict-summary.md")));
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  }
});

test("delivery import blocked by dirty repo writes recovery artifacts and can resume after cleanup", async () => {
  const sandbox = await createMissionSandbox("mission-truth-dirty-tree");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  globalThis.fetch = mockProviderFetch("openai", [
    { text: "Sprint brief ready." },
    { text: JSON.stringify({ blocking: false, issues: [] }) }
  ]);

  try {
    const started = await runMissionDetailed({
      templateId: "delivery-sprint",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Wait for an external implementation patch while the repo is dirty.",
      agents: buildDeliveryAgents("openai")
    });
    assert.equal(started.run.status, "paused");

    await fs.writeFile(path.join(sandbox.repoPath, "src", "index.ts"), "export const ok = 'dirty';\n", "utf8");
    const blocked = await importMissionNodeInput({
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      runId: started.runId,
      nodeId: "handoff_wait",
      text: [
        "Status: completed",
        "Summary: external tool supplied a patch",
        "```diff",
        singleLineDiff("src/index.ts", "export const ok = true;", "export const ok = false;"),
        "```"
      ].join("\n")
    });

    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.recovery?.kind, "dirty_tree");
    assert.ok(fsSync.existsSync(path.join(started.runDir, "nodes", "handoff_wait", "git-status.txt")));
    assert.ok(fsSync.existsSync(path.join(started.runDir, "nodes", "handoff_wait", "recovery-guide.md")));

    await execFileAsync("git", ["restore", "src/index.ts"], { cwd: sandbox.repoPath });

    const resumed = await resumeMissionRun({
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      runId: started.runId,
      agents: buildDeliveryAgents("openai")
    });

    assert.equal(resumed.run.status, "completed");
    assert.equal(resumed.run.recovery, null);
    assert.match(await fs.readFile(path.join(sandbox.repoPath, "src", "index.ts"), "utf8"), /false/);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  }
});

test("delivery import with external patch resumes to a truthful review-ready verdict", async () => {
  const sandbox = await createMissionSandbox("mission-truth-external-patch");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  globalThis.fetch = mockProviderFetch("openai", [
    { text: "Sprint brief ready." },
    { text: JSON.stringify({ blocking: false, issues: [] }) }
  ]);

  try {
    const started = await runMissionDetailed({
      templateId: "delivery-sprint",
      repoPath: sandbox.repoPath,
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      goal: "Wait for an external implementation patch.",
      agents: buildDeliveryAgents("openai")
    });
    assert.equal(started.run.status, "paused");

    const imported = await importMissionNodeInput({
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      runId: started.runId,
      nodeId: "handoff_wait",
      text: [
        "Status: completed",
        "Summary: external tool supplied a patch",
        "```diff",
        singleLineDiff("src/index.ts", "export const ok = true;", "export const ok = false;"),
        "```"
      ].join("\n")
    });

    assert.equal(imported.status, "running");
    assert.equal(imported.change?.status, "applied");
    assert.match(await fs.readFile(path.join(sandbox.repoPath, "src", "index.ts"), "utf8"), /false/);

    const resumed = await resumeMissionRun({
      runsDir: sandbox.runsDir,
      workspaceId: "demo",
      runId: started.runId,
      agents: buildDeliveryAgents("openai")
    });
    const latest = await loadMissionRun(path.join(sandbox.runsDir, "demo", started.runId));

    assert.equal(resumed.run.status, "completed");
    assert.equal(latest?.status, "completed");
    assert.equal(latest?.change?.status, "applied");
    assert.equal(latest?.validation?.status, "not_requested");
    assert.equal(latest?.verdict, "ready_for_review");
    assert.ok(fsSync.existsSync(path.join(started.runDir, "nodes", "handoff_wait", "external_patch.diff")));
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  }
});
