import { spawn } from "node:child_process";
import path from "node:path";

const MAX_ERROR_ARG_CHARS = 160;
const MAX_ERROR_ARGS = 12;

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
    const invocation = resolveSpawnInvocation(command, args);
    const invocationSummary = formatSpawnInvocationForError(command, args);
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      shell: invocation.shell,
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
        const error = new Error(stderr.trim() || `${invocationSummary} failed with code ${exitCode}`);
        settle(error);
      }
    });

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        settle(new Error(`${invocationSummary} timed out after ${options.timeoutMs}ms`));
      }, options.timeoutMs);
    }

    child.stdin.on("error", () => undefined);
    if (typeof options.stdin === "string") {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

function resolveSpawnInvocation(
  command: string,
  args: string[]
): { command: string; args: string[]; shell: boolean } {
  const extension = path.extname(command).toLowerCase();
  if (extension === ".js" || extension === ".cjs" || extension === ".mjs") {
    return {
      command: process.execPath,
      args: [command, ...args],
      shell: false
    };
  }
  if (process.platform === "win32" && (extension === ".cmd" || extension === ".bat")) {
    return {
      command,
      args,
      shell: true
    };
  }
  return {
    command,
    args,
    shell: false
  };
}

function formatSpawnInvocationForError(command: string, args: string[]): string {
  const renderedArgs = args.slice(0, MAX_ERROR_ARGS).map((arg, index) => formatSpawnArgForError(arg, index));
  if (args.length > MAX_ERROR_ARGS) {
    renderedArgs.push(`... (${args.length - MAX_ERROR_ARGS} more args omitted)`);
  }
  return [command, ...renderedArgs].join(" ");
}

function formatSpawnArgForError(arg: string, index: number): string {
  const normalized = String(arg).replace(/\s+/g, " ").trim();
  if (normalized.length > MAX_ERROR_ARG_CHARS) {
    return `<arg ${index + 1} omitted: ${normalized.length} chars>`;
  }
  return normalized || `""`;
}
