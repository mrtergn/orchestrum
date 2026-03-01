import fs from "node:fs/promises";
import path from "node:path";

export type RepoContextOptions = {
  repoPath: string;
  mode: "pm" | "dev";
  goal?: string;
  specText?: string;
  index?: RepoIndex;
  memorySummaries?: string[];
};

const MAX_FILE_CHARS = 6000;
const MAX_LIST_ENTRIES = 200;

export type RepoIndex = {
  topLevel: string[];
  srcList: string[];
};

export async function buildRepoIndex(repoPath: string): Promise<RepoIndex> {
  const topLevel = await listDir(repoPath, 1);
  const srcDir = path.join(repoPath, "src");
  const srcList = await listDir(srcDir, 4).catch(() => [] as string[]);
  return { topLevel, srcList };
}

export async function buildRepoContext(options: RepoContextOptions): Promise<string> {
  const { repoPath, mode, goal, specText, index } = options;
  const parts: string[] = [];

  if (mode === "pm") {
    if (goal && goal.trim().length > 0) {
      parts.push(section("User Goal", goal.trim()));
    }

    if (options.memorySummaries && options.memorySummaries.length > 0) {
      parts.push(section("Recent Memory", options.memorySummaries.join("\n")));
    }

    const knowledge = await loadKnowledgeSummary(repoPath);
    if (knowledge) {
      parts.push(section("Knowledge Graph", knowledge));
    }

    const readme = await readIfExists(path.join(repoPath, "README.md"));
    if (readme) {
      parts.push(section("README.md", readme));
    }

    const pkg = await readIfExists(path.join(repoPath, "package.json"));
    if (pkg) {
      parts.push(section("package.json", pkg));
    }

    return parts.join("\n\n").trim();
  }

  if (goal && goal.trim().length > 0) {
    parts.push(section("User Goal", goal.trim()));
  }

  const knowledge = await loadKnowledgeSummary(repoPath);
  if (knowledge) {
    parts.push(section("Knowledge Graph", knowledge));
  }

  const topLevel = index?.topLevel ?? (await listDir(repoPath, 1));
  parts.push(section("Top-Level Files", topLevel.join("\n")));

  const srcList = index?.srcList ?? (await listDir(path.join(repoPath, "src"), 4).catch(() => [] as string[]));
  if (srcList.length > 0) {
    parts.push(section("src/ Files", srcList.join("\n")));
  }

  const readme = await readIfExists(path.join(repoPath, "README.md"));
  if (readme) {
    parts.push(section("README.md", readme));
  }

  const pkg = await readIfExists(path.join(repoPath, "package.json"));
  if (pkg) {
    parts.push(section("package.json", pkg));
  }

  const tsconfig = await readIfExists(path.join(repoPath, "tsconfig.json"));
  if (tsconfig) {
    parts.push(section("tsconfig.json", tsconfig));
  }

  if (specText) {
    const referencedFiles = extractFileReferences(specText);
    for (const rel of referencedFiles) {
      const full = path.resolve(repoPath, rel);
      if (!full.startsWith(path.resolve(repoPath))) {
        continue;
      }
      const content = await readIfExists(full);
      if (content) {
        parts.push(section(rel, content));
      }
    }
  }

  return parts.join("\n\n").trim();
}

async function loadKnowledgeSummary(repoPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(repoPath, ".memory", "knowledge.json"), "utf8");
    const parsed = JSON.parse(raw) as { nodes?: Array<{ id: string; type: string }>; edges?: Array<{ from: string; to: string; type: string; weight: number }> };
    if (!parsed?.edges || parsed.edges.length === 0) return null;
    const topEdges = [...parsed.edges]
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      .slice(0, 6)
      .map((edge) => `${edge.from} -> ${edge.to} (${edge.type}, ${edge.weight ?? 1})`);
    return topEdges.join("\n");
  } catch {
    return null;
  }
}

function section(title: string, body: string): string {
  return `## ${title}\n${body}`;
}

async function listDir(dirPath: string, depth: number): Promise<string[]> {
  const entries: string[] = [];
  async function walk(current: string, currentDepth: number, prefix: string) {
    if (entries.length >= MAX_LIST_ENTRIES) return;
    const items = await fs.readdir(current, { withFileTypes: true });
    for (const item of items) {
      if (entries.length >= MAX_LIST_ENTRIES) return;
      const name = item.name;
      if (name === "node_modules" || name === ".git" || name === "runs") {
        continue;
      }
      const relative = path.join(prefix, name);
      entries.push(relative + (item.isDirectory() ? "/" : ""));
      if (item.isDirectory() && currentDepth < depth) {
        await walk(path.join(current, name), currentDepth + 1, relative);
      }
    }
  }

  await walk(dirPath, 1, "");
  return entries;
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    const content = await fs.readFile(filePath, "utf8");
    return truncate(content, MAX_FILE_CHARS);
  } catch {
    return null;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... (truncated)`;
}

function extractFileReferences(specText: string): string[] {
  const pattern = /[A-Za-z0-9_./-]+\.(ts|tsx|js|json|md|css|html)/g;
  const matches = specText.match(pattern) ?? [];
  const unique = new Set<string>();
  for (const match of matches) {
    unique.add(match);
  }
  return Array.from(unique).slice(0, 10);
}
