import type { LlmUsage } from "../cost.js";

export type ClaudeCompletionOptions = {
  model: string;
  prompt: string;
};

export type ClaudeCompletionResult = {
  text: string;
  usage?: LlmUsage;
};

export class ClaudeProvider {
  constructor(
    private apiKey: string,
    private baseUrl = "https://api.anthropic.com/v1"
  ) {}

  async complete(options: ClaudeCompletionOptions): Promise<ClaudeCompletionResult> {
    if (!this.apiKey) {
      throw new Error("ANTHROPIC_API_KEY is missing. Set it before running missions.");
    }

    const res = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: options.model,
        max_tokens: 4096,
        messages: [{ role: "user", content: options.prompt }]
      })
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Claude error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
      };
    };
    const text = data.content?.find((item) => item.type === "text")?.text;
    if (!text || typeof text !== "string") {
      throw new Error("Claude returned empty output.");
    }

    return {
      text,
      usage: normalizeUsage(data.usage)
    };
  }
}

function normalizeUsage(raw: { input_tokens?: number; output_tokens?: number } | undefined): LlmUsage | undefined {
  if (!raw) return undefined;
  const prompt = raw.input_tokens ?? 0;
  const completion = raw.output_tokens ?? 0;
  const total = prompt + completion;
  if (total === 0) return undefined;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total
  };
}
