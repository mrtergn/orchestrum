import crypto from "node:crypto";

export type StepCacheInput = {
  renderedPrompt: string;
  model: string;
  agent: string;
  headSha: string;
};

export function computeInputHash(input: StepCacheInput): string {
  const payload = JSON.stringify(input);
  return crypto.createHash("sha256").update(payload).digest("hex");
}
