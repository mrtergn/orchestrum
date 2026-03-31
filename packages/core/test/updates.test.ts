import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "vitest";
import * as tar from "tar";
import { getAvailableVersion, installUpdate, selectUpdateAsset } from "../src/updates/index.js";

test("getAvailableVersion normalizes manifest assets", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-updates-"));
  const manifestPath = path.join(tempDir, "version.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      version: "0.5.0",
      channel: "stable",
      releaseUrl: "https://example.com/release",
      assets: [
        {
          name: "orchestrum-0.5.0-linux-x64.tar.gz",
          url: "https://example.com/orchestrum-0.5.0-linux-x64.tar.gz",
          sha256: "abc123",
          size: 42
        }
      ]
    }),
    "utf8"
  );

  const version = await getAvailableVersion({ sourcePath: manifestPath });
  assert.equal(version?.version, "0.5.0");
  assert.equal(version?.releaseUrl, "https://example.com/release");
  assert.equal(version?.assets?.[0]?.kind, "archive");
  assert.equal(version?.assets?.[0]?.platform, "linux");
  assert.equal(version?.assets?.[0]?.arch, "x64");
});

test("selectUpdateAsset prefers exact platform and architecture", () => {
  const asset = selectUpdateAsset(
    {
      version: "0.5.0",
      channel: "stable",
      assets: [
        {
          name: "orchestrum-0.5.0.tar.gz",
          url: "https://example.com/any.tar.gz",
          kind: "archive",
          platform: "any",
          arch: "any"
        },
        {
          name: "orchestrum-0.5.0-linux-arm64.tar.gz",
          url: "https://example.com/linux-arm64.tar.gz",
          kind: "archive",
          platform: "linux",
          arch: "arm64"
        },
        {
          name: "orchestrum-0.5.0-linux-x64.tar.gz",
          url: "https://example.com/linux-x64.tar.gz",
          kind: "archive",
          platform: "linux",
          arch: "x64",
          sha256: "abc123"
        }
      ]
    },
    { platform: "linux", arch: "x64", kind: "archive" }
  );

  assert.equal(asset?.name, "orchestrum-0.5.0-linux-x64.tar.gz");
});

test("installUpdate strips single archive root directory", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-install-"));
  const sourceRoot = path.join(tempDir, "package-root");
  const targetDir = path.join(tempDir, "target");
  const archivePath = path.join(tempDir, "update.tar.gz");

  await fs.mkdir(path.join(sourceRoot, "nested"), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, "nested", "file.txt"), "hello", "utf8");
  await tar.c({ gzip: true, cwd: tempDir, file: archivePath }, ["package-root"]);

  const result = await installUpdate({ archivePath, targetDir });
  const installed = await fs.readFile(path.join(targetDir, "nested", "file.txt"), "utf8");

  assert.equal(result.ok, true);
  assert.equal(result.updatedFiles, 1);
  assert.equal(installed, "hello");
});
