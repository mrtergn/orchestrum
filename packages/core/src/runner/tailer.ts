import fs from "node:fs/promises";

type TailState = {
  position: number;
  buffer: string;
};

export type TailerState = TailState;

export async function readAppendedLines(
  filePath: string,
  state: TailerState
): Promise<{ lines: string[]; state: TailerState }> {
  let position = state.position;
  let buffer = state.buffer;
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || stat.size <= position) {
    return { lines: [], state };
  }
  const fd = await fs.open(filePath, "r");
  try {
    const length = stat.size - position;
    const buf = Buffer.alloc(length);
    await fd.read(buf, 0, length, position);
    position = stat.size;
    buffer += buf.toString("utf8");
  } finally {
    await fd.close();
  }

  const lines: string[] = [];
  let idx = buffer.indexOf("\n");
  while (idx !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) lines.push(line);
    idx = buffer.indexOf("\n");
  }

  return { lines, state: { position, buffer } };
}

export async function readTailLines(filePath: string, maxLines = 200): Promise<string[]> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw) return [];
  const lines = raw.split(/\r?\n/).filter(Boolean);
  return lines.slice(-maxLines);
}
