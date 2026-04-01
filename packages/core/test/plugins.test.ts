import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureWorkspaceManifest } from "../src/runner/control.js";
import { installPlugin, listInstalledPlugins } from "../src/plugins/registry.js";
import { loadPlugins, runPluginHook } from "../src/runner/plugins.js";

test("plugin registry installs local plugin", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-plugin-"));
  const repoPath = path.join(root, "repo");
  const pluginDir = path.join(root, "plugin");
  await fs.mkdir(repoPath, { recursive: true });
  await ensureWorkspaceManifest(repoPath, { id: "demo", name: "Demo" });
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify({
    name: "test-plugin",
    version: "0.0.1",
    entry: "index.js"
  }, null, 2));
  await fs.writeFile(path.join(pluginDir, "index.js"), "module.exports = { default: { name: 'test-plugin' } };\\n", "utf8");

  await installPlugin(repoPath, pluginDir);
  const plugins = await listInstalledPlugins(repoPath);
  assert.ok(plugins.some((plugin) => plugin.name === "test-plugin"));
});

test("plugin registry rejects unsupported capabilities", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-plugin-cap-"));
  const repoPath = path.join(root, "repo");
  const pluginDir = path.join(root, "plugin");
  await fs.mkdir(repoPath, { recursive: true });
  await ensureWorkspaceManifest(repoPath, { id: "demo", name: "Demo" });
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify({
    name: "unsafe-plugin",
    version: "0.0.1",
    entry: "index.js",
    capabilities_required: ["shell.exec"]
  }, null, 2));
  await fs.writeFile(path.join(pluginDir, "index.js"), "module.exports = { default: { name: 'unsafe-plugin' } };\\n", "utf8");

  await assert.rejects(() => installPlugin(repoPath, pluginDir), /Unsupported plugin capabilities/);
});

test("runtime rejects direct path plugins in config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-plugin-config-"));
  const repoPath = path.join(root, "repo");
  await fs.mkdir(repoPath, { recursive: true });
  await ensureWorkspaceManifest(repoPath, { id: "demo", name: "Demo" });

  await assert.rejects(
    () => loadPlugins(repoPath, { plugins: ["./direct-plugin.js"] } as never),
    /Direct path plugins are no longer supported/
  );
});

test("plugin hook failures are recorded as workspace signals", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-plugin-signal-"));
  const repoPath = path.join(root, "repo");
  await fs.mkdir(repoPath, { recursive: true });
  await ensureWorkspaceManifest(repoPath, { id: "demo", name: "Demo" });

  await runPluginHook(
    [{
      name: "broken-plugin",
      onRunStart: async () => {
        throw new Error("boom");
      }
    }],
    "onRunStart",
    {
      runId: "run-1",
      kind: "mission",
      status: "running",
      start: new Date().toISOString(),
      end: null,
      goal: "test"
    },
    {
      repoPath,
      workspaceId: "demo",
      entityId: "run-1"
    }
  );

  const signalsPath = path.join(repoPath, ".orchestrum", "control", "signals.ndjson");
  const entries = (await fs.readFile(signalsPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; source?: string; status?: string; payload?: { plugin?: string; hook?: string } });
  assert.ok(entries.some((entry) =>
    entry.type === "plugin.hook.failed"
    && entry.source === "plugin"
    && entry.status === "warning"
    && entry.payload?.plugin === "broken-plugin"
    && entry.payload?.hook === "onRunStart"
  ));
});
