import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import * as tar from "tar";
import yaml from "yaml";
import { ensureDir, writeJson, readJsonIfExists } from "../runner/fs.js";

export type TemplateMetadata = {
  name: string;
  title?: string;
  description?: string;
  required_tier?: "Free" | "Pro" | "Studio";
  createdAt: string;
};

export async function exportTemplate(options: {
  workflowPath: string;
  outputPath?: string;
  requiredTier?: TemplateMetadata["required_tier"];
}): Promise<string> {
  const workflowPath = path.resolve(options.workflowPath);
  if (!fsSync.existsSync(workflowPath)) {
    throw new Error("Workflow not found.");
  }
  const raw = await fs.readFile(workflowPath, "utf8");
  const data = yaml.parse(raw) as any;
  const workflowDir = path.dirname(workflowPath);
  const promptPaths = collectPromptPaths(data).map((p) => path.resolve(workflowDir, p));

  const tempDir = path.join(os.tmpdir(), `orchestrum-template-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  await ensureDir(tempDir);
  const promptsDir = path.join(tempDir, "prompts");
  await ensureDir(promptsDir);
  const normalized = normalizePromptPaths(data);
  await fs.writeFile(path.join(tempDir, "workflow.yaml"), yaml.stringify(normalized));
  for (const promptPath of promptPaths) {
    if (!fsSync.existsSync(promptPath)) continue;
    const name = path.basename(promptPath);
    await fs.copyFile(promptPath, path.join(promptsDir, name));
  }

  const metadata: TemplateMetadata = {
    name: path.basename(workflowPath, path.extname(workflowPath)),
    title: typeof data?.name === "string" ? data.name : undefined,
    description: typeof data?.description === "string" ? data.description : undefined,
    required_tier: options.requiredTier,
    createdAt: new Date().toISOString()
  };
  await writeJson(path.join(tempDir, "template.json"), metadata);

  const outputPath =
    options.outputPath ??
    path.join(process.cwd(), `${metadata.name}.orct`);
  await tar.c({ gzip: true, file: outputPath, cwd: tempDir }, ["workflow.yaml", "prompts", "template.json"]);
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  return outputPath;
}

export async function importTemplate(options: {
  archivePath: string;
  targetDir: string;
}): Promise<{ name: string; path: string }> {
  const archivePath = path.resolve(options.archivePath);
  if (!fsSync.existsSync(archivePath)) {
    throw new Error("Template archive not found.");
  }
  const tempDir = path.join(os.tmpdir(), `orchestrum-template-import-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  await ensureDir(tempDir);
  await tar.x({
    file: archivePath,
    cwd: tempDir,
    strict: true,
    filter: (entryPath) => isSafeArchivePath(entryPath)
  });
  const metadata = await readJsonIfExists<TemplateMetadata>(path.join(tempDir, "template.json"));
  const name =
    metadata?.name ??
    path
      .basename(archivePath)
      .replace(/\\.orct$/, "");
  const destDir = path.join(options.targetDir, name);
  await ensureDir(destDir);
  await copyRecursive(path.join(tempDir, "workflow.yaml"), path.join(destDir, "workflow.yaml"));
  const promptsDir = path.join(tempDir, "prompts");
  if (fsSync.existsSync(promptsDir)) {
    await copyRecursive(promptsDir, path.join(destDir, "prompts"));
  }
  if (metadata) {
    await writeJson(path.join(destDir, "template.json"), metadata);
  }
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  return { name, path: destDir };
}

function collectPromptPaths(data: any): string[] {
  const prompts: string[] = [];
  const steps = Array.isArray(data?.steps) ? data.steps : [];
  for (const step of steps) {
    if (typeof step?.prompt === "string") prompts.push(step.prompt);
    if (Array.isArray(step?.substeps)) {
      for (const sub of step.substeps) {
        if (typeof sub?.prompt === "string") prompts.push(sub.prompt);
      }
    }
  }
  return Array.from(new Set(prompts));
}

function normalizePromptPaths(data: any): any {
  if (!data || typeof data !== "object") return data;
  const clone = JSON.parse(JSON.stringify(data));
  const steps = Array.isArray(clone.steps) ? clone.steps : [];
  for (const step of steps) {
    if (typeof step.prompt === "string") {
      step.prompt = `./prompts/${path.basename(step.prompt)}`;
    }
    if (Array.isArray(step.substeps)) {
      for (const sub of step.substeps) {
        if (typeof sub.prompt === "string") {
          sub.prompt = `./prompts/${path.basename(sub.prompt)}`;
        }
      }
    }
  }
  return clone;
}

function isSafeArchivePath(entryPath: string): boolean {
  if (!entryPath) return false;
  if (entryPath.startsWith("/") || entryPath.startsWith("\\")) return false;
  const normalized = entryPath.replace(/\\/g, "/");
  if (normalized.includes("..")) return false;
  return true;
}

async function copyRecursive(src: string, dest: string): Promise<void> {
  const stat = await fs.stat(src);
  if (stat.isDirectory()) {
    await ensureDir(dest);
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      await copyRecursive(path.join(src, entry.name), path.join(dest, entry.name));
    }
    return;
  }
  await ensureDir(path.dirname(dest));
  await fs.copyFile(src, dest);
}
