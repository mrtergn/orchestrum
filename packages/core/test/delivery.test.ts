import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  analyzeDeliveryImport,
  createDefaultTeamPreset,
  detectMachineCapabilities,
  exportDeliveryPacket,
  initTeamPreset,
  importDeliveryPacketResponse,
  loadDeliverySession,
  loadTeamPreset,
  saveTeamPreset,
  suggestRoleBindings,
  summarizeDeliverySessions,
  runDeliverySessionDetailed
} from "../src/delivery/index.js";

test("delivery preset scaffolds into the repo", async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-delivery-preset-"));
  await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }, null, 2), "utf8");

  const result = await initTeamPreset({
    repoPath,
    workspaceId: "demo",
    force: true
  });

  assert.equal(result.preset?.version, 1);
  assert.equal(result.preset?.roles.length, 4);
  const raw = await fs.readFile(path.join(repoPath, ".orchestrum", "team-preset.json"), "utf8");
  const saved = JSON.parse(raw) as { name?: string };
  assert.equal(saved.name, result.preset?.name);
});

test("delivery preset accepts tool profile overrides", async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-delivery-tool-profiles-"));
  await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }, null, 2), "utf8");
  const preset = createDefaultTeamPreset();
  preset.tool_profiles = {
    chatgpt: {
      label: "ChatGPT Business",
      guidance: ["Keep the reply enterprise-safe."],
      response_contract: ["Status: completed|blocked"],
      text_variant: "browser_prompt"
    }
  };
  await saveTeamPreset(repoPath, preset);
  const loaded = await loadTeamPreset(repoPath);
  assert.equal(loaded?.tool_profiles?.chatgpt?.label, "ChatGPT Business");
});

test("delivery session supports packet export, import, findings, and remediation closure", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-delivery-run-"));
  const repoPath = path.join(rootDir, "repo");
  const runsDir = path.join(rootDir, "runs");
  await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
  await fs.writeFile(
    path.join(repoPath, "package.json"),
    JSON.stringify({
      name: "delivery-demo",
      version: "1.0.0",
      scripts: {
        typecheck: "node -e \"console.log('typecheck-ok')\""
      }
    }, null, 2),
    "utf8"
  );
  await fs.writeFile(path.join(repoPath, "src", "index.ts"), "export const ok = true;\n", "utf8");
  await fs.writeFile(path.join(repoPath, "README.md"), "# Demo\n", "utf8");

  const preset = createDefaultTeamPreset();
  const sessionResult = await runDeliverySessionDetailed({
    repoPath,
    runsDir,
    workspaceId: "demo",
    goal: "Implement sprint goal",
    sprintName: "Sprint 10",
    notes: "Focus on delivery loop coverage.",
    selectedPaths: ["src/index.ts"],
    preset
  });

  assert.equal(sessionResult.ok, true);
  const plannerPacket = sessionResult.session.packets.find((packet) => packet.roleId === "planner");
  assert.ok(plannerPacket);
  const testerPacket = sessionResult.session.packets.find((packet) => packet.roleId === "tester");
  assert.ok(testerPacket);
  assert.equal(testerPacket?.status, "completed");

  const exported = await exportDeliveryPacket({
    runsDir,
    runId: sessionResult.runId,
    workspaceId: "demo",
    packetId: plannerPacket!.id,
    targetTool: "chatgpt"
  });
  assert.match(exported.markdown, /Packet ID:/);
  assert.equal(exported.packetId, plannerPacket!.id);
  assert.equal(exported.targetTool, "chatgpt");
  assert.match(exported.renderedText, /Tool Target: chatgpt/);

  const ambiguous = await analyzeDeliveryImport({
    runsDir,
    runId: sessionResult.runId,
    workspaceId: "demo",
    text: "Summary: review this sprint\nFindings:\n- follow up on rollout",
    source: "paste",
    targetTool: "chatgpt"
  });
  assert.equal(ambiguous.matchStatus, "ambiguous");
  assert.ok((ambiguous.candidatePacketIds ?? []).length >= 2);

  await importDeliveryPacketResponse({
    runsDir,
    runId: sessionResult.runId,
    workspaceId: "demo",
    packetId: plannerPacket!.id,
    text: [
      `Packet ID: ${plannerPacket!.id}`,
      "Status: blocked",
      "Summary: Found a release blocker in the current sprint plan.",
      "Findings:",
      "- [delivery_blocker|high] Missing migration plan :: The rollout path is undefined."
    ].join("\n"),
    source: "paste"
  });

  const afterImport = await loadDeliverySession({
    runsDir,
    runId: sessionResult.runId,
    workspaceId: "demo"
  });
  assert.ok(afterImport);
  const importedFinding = afterImport?.findings.find((finding) => finding.title === "Missing migration plan");
  assert.ok(importedFinding);
  assert.ok((afterImport?.remediations.length ?? 0) >= 1);
  const remediationTask = afterImport?.remediations[0];
  assert.ok(remediationTask?.packetId);
  assert.equal(remediationTask?.priority, "high");
  const remediationPacket = afterImport?.packets.find((packet) => packet.id === remediationTask?.packetId);
  assert.ok(remediationPacket);

  await importDeliveryPacketResponse({
    runsDir,
    runId: sessionResult.runId,
    workspaceId: "demo",
    packetId: remediationPacket!.id,
    text: [
      `Packet ID: ${remediationPacket!.id}`,
      "Status: completed",
      "Summary: Added the missing migration plan."
    ].join("\n"),
    source: "paste"
  });

  const finalSession = await loadDeliverySession({
    runsDir,
    runId: sessionResult.runId,
    workspaceId: "demo"
  });
  assert.ok(finalSession);
  const resolvedFinding = finalSession?.findings.find((finding) => finding.title === "Missing migration plan");
  assert.equal(resolvedFinding?.status, "resolved");
  assert.equal(finalSession?.remediations[0]?.status, "done");

  const summary = await summarizeDeliverySessions({
    runsDir,
    workspaceId: "demo"
  });
  assert.equal(summary.sessions, 1);
  assert.equal(summary.toolUsage.chatgpt, 1);
  assert.equal(summary.unmatchedImportAttempts, 0);
  assert.equal(summary.findingCategoryCounts.delivery_blocker, 1);
  assert.equal(summary.findingSeverityCounts.high, 1);
  assert.equal(summary.remediationPriorityCounts.high, 1);
  assert.equal(summary.latestImport?.runId, sessionResult.runId);
  assert.equal(summary.latestImport?.matchStatus, "matched");
  assert.equal(summary.latestImport?.confidence, "high");
  assert.ok((summary.latestImport?.matchReasons ?? []).some((reason) => reason.includes("Requested packet")));
});

test("delivery import analysis auto-matches strong implementation responses", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-delivery-match-"));
  const repoPath = path.join(rootDir, "repo");
  const runsDir = path.join(rootDir, "runs");
  await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
  await fs.writeFile(
    path.join(repoPath, "package.json"),
    JSON.stringify({
      name: "delivery-match-demo",
      version: "1.0.0"
    }, null, 2),
    "utf8"
  );
  await fs.writeFile(path.join(repoPath, "src", "index.ts"), "export const ok = true;\n", "utf8");

  const preset = createDefaultTeamPreset();
  const plannerRole = preset.roles.find((role) => role.id === "planner");
  if (plannerRole) {
    plannerRole.mode = "manual_ide";
    plannerRole.preferred_targets = ["cursor"];
  }
  preset.tool_preferences = {
    ...preset.tool_preferences,
    planner: ["cursor"],
    developer: ["cursor"]
  };
  const capabilities = await detectMachineCapabilities(repoPath);
  const roleBindings = suggestRoleBindings(preset, capabilities);

  const sessionResult = await runDeliverySessionDetailed({
    repoPath,
    runsDir,
    workspaceId: "demo",
    goal: "Tighten implementation",
    selectedPaths: ["src/index.ts"],
    preset,
    roleBindings
  });

  const developerPacket = sessionResult.session.packets.find((packet) => packet.roleId === "developer");
  const plannerPacket = sessionResult.session.packets.find((packet) => packet.roleId === "planner");
  assert.ok(developerPacket);
  assert.ok(plannerPacket);
  assert.equal(developerPacket?.target, "cursor");
  assert.equal(plannerPacket?.target, "cursor");

  const analysis = await analyzeDeliveryImport({
    runsDir,
    runId: sessionResult.runId,
    workspaceId: "demo",
    targetTool: "cursor",
    text: [
      "Status: completed",
      "Summary: Implemented the patch and updated the affected file.",
      "Changed Files:",
      "- src/index.ts",
      "Verification:",
      "- npm test :: ok"
    ].join("\n"),
    source: "paste"
  });

  assert.equal(analysis.matchStatus, "matched");
  assert.equal(analysis.matchedPacketId, developerPacket?.id);
  assert.equal(analysis.confidence, "high");
  assert.ok((analysis.matchReasons ?? []).some((reason) => reason.includes("developer response shape")));
});

test("delivery import extracts verification and blocker findings from structured sections", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-delivery-signals-"));
  const repoPath = path.join(rootDir, "repo");
  const runsDir = path.join(rootDir, "runs");
  await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
  await fs.writeFile(
    path.join(repoPath, "package.json"),
    JSON.stringify({
      name: "delivery-signals-demo",
      version: "1.0.0"
    }, null, 2),
    "utf8"
  );
  await fs.writeFile(path.join(repoPath, "src", "index.ts"), "export const ok = true;\n", "utf8");

  const sessionResult = await runDeliverySessionDetailed({
    repoPath,
    runsDir,
    workspaceId: "demo",
    goal: "Validate delivery import parser",
    selectedPaths: ["src/index.ts"],
    preset: createDefaultTeamPreset()
  });
  const developerPacket = sessionResult.session.packets.find((packet) => packet.roleId === "developer");
  assert.ok(developerPacket);

  const result = await importDeliveryPacketResponse({
    runsDir,
    runId: sessionResult.runId,
    workspaceId: "demo",
    packetId: developerPacket!.id,
    targetTool: "cursor",
    text: [
      `Packet ID: ${developerPacket!.id}`,
      "Status: blocked",
      "Summary: Validation failed after the patch.",
      "Changed Files:",
      "- src/index.ts",
      "Verification:",
      "- npm test :: failed because the migration is missing",
      "Blocked By:",
      "- rollout cannot continue until the schema version is updated"
    ].join("\n"),
    source: "paste"
  });

  const categories = result.findings.map((finding) => finding.category);
  assert.ok(categories.includes("test_gap"));
  assert.ok(categories.includes("delivery_blocker"));
});
