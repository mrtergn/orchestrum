import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import assert from "node:assert/strict";
import { test } from "vitest";
import * as tar from "tar";
import { getAvailableVersion, installUpdate, listUpdateInstallJournals, rollbackUpdate, selectUpdateAsset } from "../src/updates/index.js";

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

test("installUpdate rolls back previous files when verification fails", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-install-rollback-"));
  const appHome = path.join(tempDir, "app-home");
  const sourceRoot = path.join(tempDir, "package-root");
  const targetDir = path.join(tempDir, "target");
  const archivePath = path.join(tempDir, "update.tar.gz");
  const originalAppHome = process.env.ORCHESTRUM_HOME;
  process.env.ORCHESTRUM_HOME = appHome;

  try {
    await fs.mkdir(path.join(sourceRoot, "nested"), { recursive: true });
    await fs.mkdir(path.join(targetDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, "nested", "file.txt"), "after", "utf8");
    await fs.writeFile(path.join(targetDir, "nested", "file.txt"), "before", "utf8");
    await tar.c({ gzip: true, cwd: tempDir, file: archivePath }, ["package-root"]);

    await assert.rejects(
      installUpdate({
        archivePath,
        targetDir,
        verify: async () => {
          throw new Error("health check failed");
        }
      }),
      /rollback completed/i
    );

    const restored = await fs.readFile(path.join(targetDir, "nested", "file.txt"), "utf8");
    assert.equal(restored, "before");
    const installsRoot = path.join(appHome, "updates", "installs");
    const sessions = await fs.readdir(installsRoot);
    assert.equal(sessions.length, 1);
    const journalPath = path.join(installsRoot, sessions[0]!, "journal.json");
    const journalRaw = await fs.readFile(journalPath, "utf8");
    assert.match(journalRaw, /"status": "rolled_back"/);
  } finally {
    if (originalAppHome) process.env.ORCHESTRUM_HOME = originalAppHome;
    else delete process.env.ORCHESTRUM_HOME;
  }
});

test("rollbackUpdate restores backed up files from a completed install journal", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-install-manual-"));
  const appHome = path.join(tempDir, "app-home");
  const sourceRoot = path.join(tempDir, "package-root");
  const targetDir = path.join(tempDir, "target");
  const archivePath = path.join(tempDir, "update.tar.gz");
  const originalAppHome = process.env.ORCHESTRUM_HOME;
  process.env.ORCHESTRUM_HOME = appHome;

  try {
    await fs.mkdir(path.join(sourceRoot, "nested"), { recursive: true });
    await fs.mkdir(path.join(targetDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, "nested", "file.txt"), "after", "utf8");
    await fs.writeFile(path.join(targetDir, "nested", "file.txt"), "before", "utf8");
    await tar.c({ gzip: true, cwd: tempDir, file: archivePath }, ["package-root"]);

    const result = await installUpdate({ archivePath, targetDir });
    assert.equal(fsSync.existsSync(result.journalPath), true);
    assert.equal(await fs.readFile(path.join(targetDir, "nested", "file.txt"), "utf8"), "after");

    const rollback = await rollbackUpdate({ journalPath: result.journalPath });
    assert.equal(rollback.ok, true);
    assert.equal(await fs.readFile(path.join(targetDir, "nested", "file.txt"), "utf8"), "before");
  } finally {
    if (originalAppHome) process.env.ORCHESTRUM_HOME = originalAppHome;
    else delete process.env.ORCHESTRUM_HOME;
  }
});

test("listUpdateInstallJournals returns recent install sessions in descending order", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-install-history-"));
  const appHome = path.join(tempDir, "app-home");
  const sourceRoot = path.join(tempDir, "package-root");
  const targetDir = path.join(tempDir, "target");
  const archivePath = path.join(tempDir, "update.tar.gz");
  const originalAppHome = process.env.ORCHESTRUM_HOME;
  process.env.ORCHESTRUM_HOME = appHome;

  try {
    await fs.mkdir(path.join(sourceRoot, "nested"), { recursive: true });
    await fs.mkdir(path.join(targetDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, "nested", "file.txt"), "first", "utf8");
    await tar.c({ gzip: true, cwd: tempDir, file: archivePath }, ["package-root"]);
    const first = await installUpdate({ archivePath, targetDir });

    await fs.writeFile(path.join(sourceRoot, "nested", "file.txt"), "second", "utf8");
    await tar.c({ gzip: true, cwd: tempDir, file: archivePath }, ["package-root"]);
    const second = await installUpdate({ archivePath, targetDir });

    const history = await listUpdateInstallJournals({ limit: 10 });
    assert.equal(history.length, 2);
    assert.equal(history[0]?.journalPath, second.journalPath);
    assert.equal(history[1]?.journalPath, first.journalPath);
  } finally {
    if (originalAppHome) process.env.ORCHESTRUM_HOME = originalAppHome;
    else delete process.env.ORCHESTRUM_HOME;
  }
});
