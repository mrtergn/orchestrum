import path from "node:path";
import { appendLine, ensureDir } from "./fs.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = {
  ts: string;
  level: LogLevel;
  message: string;
  correlationId?: string;
  data?: Record<string, unknown>;
};

export class Logger {
  constructor(private filePath: string, private correlationId?: string) {}

  async log(level: LogLevel, message: string, data?: Record<string, unknown>): Promise<void> {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      message,
      correlationId: this.correlationId,
      data
    };
    await ensureDir(path.dirname(this.filePath));
    await appendLine(this.filePath, JSON.stringify(entry));
  }

  info(message: string, data?: Record<string, unknown>) {
    return this.log("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>) {
    return this.log("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>) {
    return this.log("error", message, data);
  }
}
