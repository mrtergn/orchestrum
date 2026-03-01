import { spawn } from "node:child_process";
import fs from "node:fs";

export type CommandResult = {
  ok: boolean;
  exitCode: number | null;
};

export async function runCommands(options: {
  commands: string[];
  cwd: string;
  logFile: string;
  onLine?: (line: string) => void;
}): Promise<CommandResult[]> {
  const { commands, cwd, logFile, onLine } = options;
  const results: CommandResult[] = [];

  for (const command of commands) {
    const result = await runSingle(command, cwd, logFile, onLine);
    results.push(result);
  }

  return results;
}

function runSingle(
  command: string,
  cwd: string,
  logFile: string,
  onLine?: (line: string) => void
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, env: process.env });
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const logStream = fs.createWriteStream(logFile, { flags: "a" });

    const handleChunk = (chunk: Buffer, isStdErr: boolean) => {
      const text = chunk.toString();
      const lines = (isStdErr ? stderrBuffer : stdoutBuffer) + text;
      const parts = lines.split(/\r?\n/);
      const remainder = parts.pop() ?? "";

      for (const line of parts) {
        const tagged = isStdErr ? `[stderr] ${line}` : line;
        logStream.write(`${tagged}\n`);
        onLine?.(tagged);
      }

      if (isStdErr) {
        stderrBuffer = remainder;
      } else {
        stdoutBuffer = remainder;
      }
    };

    child.stdout.on("data", (chunk) => handleChunk(chunk as Buffer, false));
    child.stderr.on("data", (chunk) => handleChunk(chunk as Buffer, true));

    child.on("error", (err) => {
      logStream.end();
      reject(err);
    });

    child.on("close", (code) => {
      if (stdoutBuffer.length > 0) {
        logStream.write(`${stdoutBuffer}\n`);
        onLine?.(stdoutBuffer);
      }
      if (stderrBuffer.length > 0) {
        const tagged = `[stderr] ${stderrBuffer}`;
        logStream.write(`${tagged}\n`);
        onLine?.(tagged);
      }
      logStream.end();
      resolve({ ok: code === 0, exitCode: code ?? null });
    });
  });
}
