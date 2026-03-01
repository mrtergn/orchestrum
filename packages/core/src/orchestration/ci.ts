import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { runWorkflow } from "../runner/run.js";
import { getHeadSha, ensureGitRepo } from "../runner/git.js";
import { readTextIfExists, writeText } from "../runner/fs.js";

export async function startCiWatch(options: {
  repoPath: string;
  runsDir: string;
  workspaceId: string;
}): Promise<void> {
  await ensureGitRepo(options.repoPath);
  let lastSha = await getHeadSha(options.repoPath);
  let running = false;
  console.log(`[orchestrum] CI watch started at ${lastSha}`);

  setInterval(async () => {
    if (running) return;
    const current = await getHeadSha(options.repoPath).catch(() => lastSha);
    if (current !== lastSha) {
      running = true;
      console.log(`[orchestrum] CI detected new commit ${current}`);
      try {
        await runWorkflow({
          workflowPath: path.resolve(path.join(process.cwd(), "packages/core/workflows/ci.yaml")),
          repoPath: options.repoPath,
          runsDir: options.runsDir,
          goal: "CI auto-heal",
          branch: "ci/auto-fix",
          workspaceId: options.workspaceId
        });
        await finalizeCiRun(options.runsDir, options.workspaceId);
      } catch (err) {
        console.warn(`[orchestrum] CI run failed: ${(err as Error).message}`);
      }
      lastSha = current;
      running = false;
    }
  }, 2500);
}

async function finalizeCiRun(runsDir: string, workspaceId: string): Promise<void> {
  const runDir = await findLatestRunDir(runsDir, workspaceId);
  if (!runDir) return;
  const runMetaPath = path.join(runDir, "run.json");
  const raw = await readTextIfExists(runMetaPath);
  if (!raw) return;
  const runMeta = JSON.parse(raw) as { status?: string; riskSummary?: { maxRisk?: number } };
  const risk = runMeta.riskSummary?.maxRisk ?? 0;
  if (runMeta.status !== "finished" || risk >= 0.7) {
    const report = `CI auto-heal needs review.\nStatus: ${runMeta.status}\nMax risk: ${risk}\n`;
    await writeText(path.join(runDir, "needs-review.md"), report);
  }
}

async function findLatestRunDir(runsDir: string, workspaceId: string): Promise<string | null> {
  const base = path.join(runsDir, workspaceId);
  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  let latest: { dir: string; ts: number } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runMeta = path.join(base, entry.name, "run.json");
    if (!fsSync.existsSync(runMeta)) continue;
    const raw = await fs.readFile(runMeta, "utf8").catch(() => "");
    if (!raw) continue;
    try {
      const meta = JSON.parse(raw) as { start?: string };
      const ts = meta.start ? Date.parse(meta.start) : 0;
      if (!latest || ts > latest.ts) {
        latest = { dir: path.join(base, entry.name), ts };
      }
    } catch {
      // ignore
    }
  }
  return latest?.dir ?? null;
}
