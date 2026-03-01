export function extractDiffBlock(text: string): string | null {
  const match = text.match(/```diff\n([\s\S]*?)```/i);
  const block = match?.[1];
  if (!block) return null;
  return block.trim();
}

export function extractJsonBlock(text: string): unknown | null {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function nowTs(): number {
  return Date.now();
}

export function createRunId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "");
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${timestamp}-${suffix}`;
}

export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
