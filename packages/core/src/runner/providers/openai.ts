import type { LlmUsage } from "../cost.js";

export type CompletionOptions = {
  model: string;
  prompt: string;
};

export type CompletionResult = {
  text: string;
  usage?: LlmUsage;
};

export class OpenAIProvider {
  constructor(
    private apiKey: string,
    private baseUrl = "https://api.openai.com/v1",
    private mode: "responses" | "chat" | "auto" = "auto"
  ) {}

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is missing. Set it before running workflows.");
    }

    const { model, prompt } = options;

    if (this.mode === "chat") {
      return this.chatCompletion(model, prompt);
    }

    if (this.mode === "responses") {
      return this.responsesCompletion(model, prompt);
    }

    try {
      return await this.responsesCompletion(model, prompt);
    } catch {
      return await this.chatCompletion(model, prompt);
    }
  }

  private async responsesCompletion(model: string, prompt: string): Promise<CompletionResult> {
    const res = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model,
        input: prompt,
        temperature: 0.2
      })
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI responses error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as any;
    const text =
      data.output?.[0]?.content?.[0]?.text ??
      data.output_text ??
      data.output?.[0]?.text ??
      data?.choices?.[0]?.message?.content;

    if (!text || typeof text !== "string") {
      throw new Error("OpenAI responses returned empty output.");
    }

    return {
      text,
      usage: normalizeUsage(data.usage)
    };
  }

  private async chatCompletion(model: string, prompt: string): Promise<CompletionResult> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2
      })
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI chat error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as any;
    const text = data?.choices?.[0]?.message?.content;
    if (!text || typeof text !== "string") {
      throw new Error("OpenAI chat returned empty output.");
    }

    return {
      text,
      usage: normalizeUsage(data.usage)
    };
  }
}

function normalizeUsage(raw: any): LlmUsage | undefined {
  if (!raw) return undefined;
  const prompt = raw.input_tokens ?? raw.prompt_tokens ?? 0;
  const completion = raw.output_tokens ?? raw.completion_tokens ?? 0;
  const total = raw.total_tokens ?? prompt + completion;
  if (prompt === 0 && completion === 0 && total === 0) return undefined;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total
  };
}
