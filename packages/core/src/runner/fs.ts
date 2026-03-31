import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function atomicWriteFile(
  filePath: string,
  data: string | Buffer,
  encoding: BufferEncoding = "utf8"
): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmpName = `.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  const tmpPath = path.join(dir, tmpName);
  const handle = await fs.open(tmpPath, "w");
  try {
    if (typeof data === "string") {
      await handle.writeFile(data, { encoding });
    } else {
      await handle.writeFile(data);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmpPath, filePath);
}

export async function writeText(filePath: string, content: string): Promise<void> {
  await atomicWriteFile(filePath, content, "utf8");
}

export async function writeJson(filePath: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  await atomicWriteFile(filePath, json, "utf8");
}

export async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function appendLine(filePath: string, line: string): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  await fs.appendFile(filePath, `${line}\n`, "utf8");
  let fd: number | null = null;
  try {
    fd = fsSync.openSync(filePath, "r+");
    fsSync.fsyncSync(fd);
  } finally {
    if (fd !== null) {
      fsSync.closeSync(fd);
    }
  }
}

export function safeRunId(runId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(runId)) {
    throw new Error("Invalid run id");
  }
  return runId;
}

export function resolveRunsDir(baseDir: string, runId: string): string {
  return path.join(baseDir, safeRunId(runId));
}
