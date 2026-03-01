import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ensureClusterPaths, recordWorkerStat } from "./queue.js";
import fs from "node:fs/promises";

export type ClusterStartOptions = {
  workers: number;
  queueRoot: string;
  minWorkers?: number;
  maxWorkers?: number;
};

export async function startCluster(options: ClusterStartOptions): Promise<void> {
  const minWorkers = options.minWorkers ?? options.workers;
  const maxWorkers = options.maxWorkers ?? Math.max(minWorkers, options.workers);
  const { queueDir } = await ensureClusterPaths(options.queueRoot);

  const __filename = fileURLToPath(import.meta.url);
  const workerScript = path.resolve(path.join(path.dirname(__filename), "worker.ts"));
  const tsxBin = resolveTsxBin();

  let activeWorkers: ChildProcess[] = [];
  let idleTicks = 0;

  const spawnWorker = () => {
    const id = `worker-${activeWorkers.length + 1}-${Date.now()}`;
    const child = spawn(process.execPath, [tsxBin, workerScript], {
      stdio: "inherit",
      env: {
        ...process.env,
        ORCHESTRUM_CLUSTER_QUEUE: options.queueRoot,
        ORCHESTRUM_WORKER_ID: id
      }
    });
    activeWorkers.push(child);
    child.on("exit", () => {
      activeWorkers = activeWorkers.filter((w) => w !== child);
    });
  };

  for (let i = 0; i < options.workers; i += 1) {
    spawnWorker();
  }

  const loop = async () => {
    const entries = await fs.readdir(queueDir, { withFileTypes: true }).catch(() => []);
    const queueLength = entries.filter((e) => e.isFile() && e.name.endsWith(".json")).length;

    if (queueLength > activeWorkers.length && activeWorkers.length < maxWorkers) {
      spawnWorker();
    }

    if (queueLength === 0) {
      idleTicks += 1;
      if (idleTicks >= 5 && activeWorkers.length > minWorkers) {
        const worker = activeWorkers.pop();
        if (worker) {
          worker.kill();
        }
        idleTicks = 0;
      }
    } else {
      idleTicks = 0;
    }

    await recordWorkerStat(options.queueRoot, { active: activeWorkers.length, queue: queueLength });
  };

  setInterval(loop, 2000);
}

function resolveTsxBin(): string {
  const require = createRequire(import.meta.url);
  const tsxPkgPath = require.resolve("tsx/package.json");
  const tsxPkg = JSON.parse(require("fs").readFileSync(tsxPkgPath, "utf8"));
  const binRel =
    typeof tsxPkg.bin === "string" ? tsxPkg.bin : tsxPkg.bin?.tsx ?? Object.values(tsxPkg.bin ?? {})[0];
  return path.resolve(path.dirname(tsxPkgPath), binRel);
}
