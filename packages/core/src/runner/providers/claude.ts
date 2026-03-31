import type { LlmUsage } from "../cost.js";
import { ProviderError } from "../../errors.js";
import type { CompletionOptions, CompletionResult, IAgentProvider } from "./interface.js";

export type ClaudeCompletionOptions = CompletionOptions;
export type ClaudeCompletionResult = CompletionResult;

export class ClaudeProvider implements IAgentProvider {
  constructor(
    private apiKey: string,
    private baseUrl = "https://api.anthropic.com/v1"
  ) {}

  async complete(options: CompletionOptions): Promise<CompletionResult>;
  async complete(prompt: string, options: CompletionOptions): Promise<CompletionResult>;
  async complete(arg1: string | CompletionOptions, arg2?: CompletionOptions): Promise<CompletionResult> {
    if (!this.apiKey) {
      throw new ProviderError("ANTHROPIC_API_KEY is missing. Set it before running missions.", "provider.claude.missing_key");
    }

    const resolved = normalizeCompletionArgs(arg1, arg2);

    const res = await this.fetchWithRetry(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: resolved.model,
        max_tokens: 4096,
        messages: [{ role: "user", content: resolved.prompt }]
      })
    });

    if (!res.ok) {
      const body = await res.text();
      throw new ProviderError(`Claude error ${res.status}: ${body}`, "provider.claude.http_error", {
        status: res.status
      });
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
      throw new ProviderError("Claude returned empty output.", "provider.claude.empty_output");
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
    throw new ProviderError("Claude request failed after retries.", "provider.claude.retry_exhausted", {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
