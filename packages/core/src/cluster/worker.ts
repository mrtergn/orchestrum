import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { registerBuiltInAgents, getAgentFactory } from "../agents/index.js";
import { ensureClusterPaths } from "./queue.js";
import { writeJson } from "../runner/fs.js";

const queueRoot = process.env.ORCHESTRUM_CLUSTER_QUEUE ?? "";
if (!queueRoot) {
  throw new Error("ORCHESTRUM_CLUSTER_QUEUE not set");
}

const workerId = process.env.ORCHESTRUM_WORKER_ID ?? `worker-${process.pid}`;
const pollMs = Number(process.env.ORCHESTRUM_WORKER_POLL ?? 300);

registerBuiltInAgents();

let shuttingDown = false;
process.on("SIGTERM", () => {
  shuttingDown = true;
});
process.on("SIGINT", () => {
  shuttingDown = true;
});

async function main() {
  const { queueDir, resultsDir } = await ensureClusterPaths(queueRoot);

  while (!shuttingDown) {
    const entries = await fs.readdir(queueDir, { withFileTypes: true }).catch(() => []);
    let claimed = false;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const taskPath = path.join(queueDir, entry.name);
      const lockPath = path.join(queueDir, `${entry.name}.${workerId}.lock`);
      try {
        fsSync.renameSync(taskPath, lockPath);
      } catch {
        continue;
      }
      claimed = true;
      try {
        const raw = await fs.readFile(lockPath, "utf8");
        const task = JSON.parse(raw) as {
          id: string;
          provider: string;
          model: string;
          prompt: string;
          agentId: string;
        };

        const factory = getAgentFactory(task.provider);
        if (!factory) {
          await writeJson(path.join(resultsDir, `${task.id}.json`), {
            id: task.id,
            ok: false,
            error: `Unsupported provider ${task.provider}`
          });
          continue;
        }

        const client = factory({
          provider: task.provider,
          model: task.model,
          agentId: task.agentId,
          env: process.env
        });
        const start = Date.now();
        const result = await client.complete(task.prompt);
        const durationMs = Date.now() - start;
        await writeJson(path.join(resultsDir, `${task.id}.json`), {
          id: task.id,
          ok: true,
          text: result.text,
          usage: result.usage,
          durationMs
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const taskId = entry.name.replace(/\.json.*/, "");
        await writeJson(path.join(resultsDir, `${taskId}.json`), {
          id: taskId,
          ok: false,
          error: message
        });
      } finally {
        await fs.unlink(lockPath).catch(() => undefined);
      }
    }

    if (!claimed) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
