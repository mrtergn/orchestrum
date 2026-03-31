import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installPlugin, listInstalledPlugins } from "../src/plugins/registry.js";

test("plugin registry installs local plugin", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-plugin-"));
  const pluginDir = path.join(root, "plugin");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify({
    name: "test-plugin",
    version: "0.0.1",
    entry: "index.js"
  }, null, 2));
  await fs.writeFile(path.join(pluginDir, "index.js"), "module.exports = { default: { name: 'test-plugin' } };\\n", "utf8");

  const oldHome = process.env.HOME;
  process.env.HOME = root;
  try {
    await installPlugin(pluginDir);
    const plugins = await listInstalledPlugins();
    assert.ok(plugins.some((plugin) => plugin.name === "test-plugin"));
  } finally {
    process.env.HOME = oldHome;
  }
});
