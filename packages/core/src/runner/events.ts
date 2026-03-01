import fs from "node:fs";
import path from "node:path";
import { writeJson } from "./fs.js";

export type EventRecord = Record<string, unknown> & { t: string; ts: number };

export type EventWriterOptions = {
  checkpointEvery?: number;
  checkpointPath?: string;
};

export class EventWriter {
  private fd: number;
  private count = 0;
  private checkpointEvery: number;
  private checkpointPath: string;

  constructor(private filePath: string, options: EventWriterOptions = {}) {
    if (!fs.existsSync(filePath)) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "", "utf8");
    }
    this.fd = fs.openSync(filePath, "a");
    this.checkpointEvery = options.checkpointEvery ?? 250;
    this.checkpointPath =
      options.checkpointPath ?? path.join(path.dirname(filePath), "events.checkpoint.json");
  }

  append(event: EventRecord): void {
    const line = JSON.stringify(event);
    fs.writeSync(this.fd, `${line}\n`, undefined, "utf8");
    fs.fsyncSync(this.fd);
    this.count += 1;
    if (this.count % this.checkpointEvery === 0) {
      void this.writeCheckpoint(event);
    }
  }

  emit(event: EventRecord): void {
    this.append(event);
  }

  close(): void {
    fs.closeSync(this.fd);
  }

  private async writeCheckpoint(event: EventRecord): Promise<void> {
    const payload = {
      ts: event.ts,
      lastEvent: event.t,
      count: this.count
    };
    await writeJson(this.checkpointPath, payload);
  }
}
