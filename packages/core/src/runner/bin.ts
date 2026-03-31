import { spawn } from "node:child_process";

export type BinaryRunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  allowNonZeroExit?: boolean;
};

export type BinaryRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export async function lookupBinary(name: string, env?: NodeJS.ProcessEnv): Promise<{ available: boolean; path?: string }> {
  const command = process.platform === "win32" ? "where" : "which";
  try {
    const result = await runBinary(command, [name], { env });
    const resolved = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return resolved ? { available: true, path: resolved } : { available: false };
  } catch {
    return { available: false };
  }
}

export function runBinary(command: string, args: string[], options: BinaryRunOptions = {}): Promise<BinaryRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let finished = false;
    let timeout: NodeJS.Timeout | null = null;

    const settle = (err: Error | null, result?: BinaryRunResult) => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      if (err) reject(err);
      else resolve(result!);
    };

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => settle(err));
    child.on("close", (code) => {
      const exitCode = code ?? 0;
      if (exitCode === 0 || options.allowNonZeroExit) {
        settle(null, { stdout, stderr, exitCode });
      } else {
        const error = new Error(stderr.trim() || `${command} ${args.join(" ")} failed with code ${exitCode}`);
        settle(error);
      }
    });

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        settle(new Error(`${command} ${args.join(" ")} timed out after ${options.timeoutMs}ms`));
      }, options.timeoutMs);
    }

    child.stdin.on("error", () => undefined);
    if (typeof options.stdin === "string") {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}
