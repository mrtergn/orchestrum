import path from "node:path";
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
  allowlist?: string[];
}): Promise<CommandResult[]> {
  const { commands, cwd, logFile, onLine, allowlist } = options;
  const results: CommandResult[] = [];

  for (const command of commands) {
    const result = await runSingle(command, cwd, logFile, onLine, allowlist);
    results.push(result);
  }

  return results;
}

function runSingle(
  command: string,
  cwd: string,
  logFile: string,
  onLine?: (line: string) => void,
  allowlist?: string[]
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const parts = splitCommand(command);
    if (parts.length === 0) {
      reject(new Error("Command cannot be empty."));
      return;
    }
    const [bin, ...args] = parts;
    if (!bin) {
      reject(new Error("Command binary is missing."));
      return;
    }
    validateCommandBinary(bin, allowlist);
    const child = spawn(bin, args, { cwd, shell: false, env: process.env });
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

    child.stdout?.on("data", (chunk) => handleChunk(chunk as Buffer, false));
    child.stderr?.on("data", (chunk) => handleChunk(chunk as Buffer, true));

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

function splitCommand(input: string): string[] {
  const text = input.trim();
  if (!text) return [];
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaping || quote) {
    throw new Error(`Invalid command syntax: ${input}`);
  }
  if (current) tokens.push(current);
  return tokens;
}

function normalizeBinary(bin: string): string {
  const lower = path.basename(bin).trim().toLowerCase();
  return lower
    .replace(/\.exe$/i, "")
    .replace(/\.cmd$/i, "")
    .replace(/\.bat$/i, "")
    .replace(/\.ps1$/i, "");
}

function validateCommandBinary(bin: string, allowlist?: string[]): void {
  const effective = (allowlist ?? []).map((entry) => normalizeBinary(entry)).filter(Boolean);
  const normalized = normalizeBinary(bin);
  if (!normalized) {
    throw new Error("Command binary is empty.");
  }
  if (effective.length > 0) {
    if (!effective.includes(normalized)) {
      throw new Error(`Command "${bin}" is not in shell_allowlist.`);
    }
  }
}
