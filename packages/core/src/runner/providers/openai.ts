import type { LlmUsage } from "../cost.js";
import { DEFAULT_TEMPERATURE } from "../../constants.js";
import { ProviderError } from "../../errors.js";
import type { CompletionOptions, CompletionResult, IAgentProvider } from "./interface.js";

export type { CompletionOptions, CompletionResult };

export class OpenAIProvider implements IAgentProvider {
  constructor(
    private apiKey: string,
    private baseUrl = "https://api.openai.com/v1",
    private mode: "responses" | "chat" | "auto" = "auto"
  ) {}

  async complete(options: CompletionOptions): Promise<CompletionResult>;
  async complete(prompt: string, options: CompletionOptions): Promise<CompletionResult>;
  async complete(arg1: string | CompletionOptions, arg2?: CompletionOptions): Promise<CompletionResult> {
    if (!this.apiKey) {
      throw new ProviderError("OPENAI_API_KEY is missing. Set it before running missions or delivery sessions.", "provider.openai.missing_key");
    }

    const resolved = normalizeCompletionArgs(arg1, arg2);
    const { model, prompt } = resolved;

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
    const res = await this.fetchWithRetry(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model,
        input: prompt,
        temperature: DEFAULT_TEMPERATURE
      })
    });

    if (!res.ok) {
      const body = await res.text();
      throw new ProviderError(`OpenAI responses error ${res.status}: ${body}`, "provider.openai.responses_error", {
        status: res.status
      });
    }

    const data = (await res.json()) as any;
    const text =
      data.output?.[0]?.content?.[0]?.text ??
      data.output_text ??
      data.output?.[0]?.text ??
      data?.choices?.[0]?.message?.content;

    if (!text || typeof text !== "string") {
      throw new ProviderError("OpenAI responses returned empty output.", "provider.openai.empty_output");
    }

    return {
      text,
      usage: normalizeUsage(data.usage)
    };
  }

  private async chatCompletion(model: string, prompt: string): Promise<CompletionResult> {
    const res = await this.fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: DEFAULT_TEMPERATURE
      })
    });

    if (!res.ok) {
      const body = await res.text();
      throw new ProviderError(`OpenAI chat error ${res.status}: ${body}`, "provider.openai.chat_error", {
        status: res.status
      });
    }

    const data = (await res.json()) as any;
    const text = data?.choices?.[0]?.message?.content;
    if (!text || typeof text !== "string") {
      throw new ProviderError("OpenAI chat returned empty output.", "provider.openai.empty_output");
    }

    return {
      text,
      usage: normalizeUsage(data.usage)
    };
  }

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    const delays = [1000, 2000, 4000];
    let lastError: unknown;
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      try {
        const response = await fetch(url, init);
        if ((response.status === 429 || response.status >= 500) && attempt < delays.length) {
          await sleep(delays[attempt] ?? 0);
          continue;
        }
        return response;
      } catch (err) {
        lastError = err;
        if (attempt >= delays.length) break;
        await sleep(delays[attempt] ?? 0);
      }
    }
    throw new ProviderError("OpenAI request failed after retries.", "provider.openai.retry_exhausted", {
      cause: lastError instanceof Error ? lastError.message : String(lastError ?? "unknown")
    });
  }
}

function normalizeCompletionArgs(arg1: string | CompletionOptions, arg2?: CompletionOptions): CompletionOptions {
  if (typeof arg1 === "string") {
    return {
      model: arg2?.model ?? "",
      prompt: arg1
    };
  }
  return arg1;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
