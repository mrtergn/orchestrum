import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadRememberedWorkspacePaths,
  saveRememberedWorkspacePaths
} from "../src/workspaceRegistryStore.js";

const tempRoots: string[] = [];

describe("workspaceRegistryStore", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
    );
  });

  it("persists normalized workspace paths", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-workspace-registry-"));
    tempRoots.push(tempRoot);
    const registryPath = path.join(tempRoot, "workspaces.json");

    const saved = await saveRememberedWorkspacePaths(
      [
        path.join(tempRoot, "alpha"),
        path.join(tempRoot, "..", path.basename(tempRoot), "alpha"),
        path.join(tempRoot, "beta")
      ],
      registryPath
    );

    expect(saved).toEqual([
      path.resolve(tempRoot, "alpha"),
      path.resolve(tempRoot, "beta")
    ]);

    const loaded = await loadRememberedWorkspacePaths(registryPath);
    expect(loaded).toEqual(saved);
  });
});
