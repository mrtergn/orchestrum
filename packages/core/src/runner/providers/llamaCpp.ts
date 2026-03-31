import { ProviderError } from "../../errors.js";
import type { CompletionOptions, CompletionResult, IAgentProvider } from "./interface.js";

export type LlamaCppOptions = {
  endpoint: string;
};

export class LlamaCppProvider implements IAgentProvider {
  constructor(private endpoint: string) {}

  async complete(options: CompletionOptions): Promise<CompletionResult>;
  async complete(prompt: string, options: CompletionOptions): Promise<CompletionResult>;
  async complete(arg1: string | CompletionOptions, arg2?: CompletionOptions): Promise<CompletionResult> {
    const resolved = normalizeCompletionArgs(arg1, arg2);
    try {
      return await this.completion(resolved.prompt);
    } catch {
      return await this.v1Completion(resolved.prompt, resolved.model);
    }
  }

  private async completion(prompt: string): Promise<CompletionResult> {
    const res = await this.fetchWithRetry(`${this.endpoint}/completion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt })
    });
    if (!res.ok) {
      const body = await res.text();
      throw new ProviderError(`llama.cpp completion error ${res.status}: ${body}`, "provider.llama_cpp.completion_error", {
        status: res.status
      });
    }
    const data = (await res.json()) as { content?: string };
    if (!data.content) {
      throw new ProviderError("llama.cpp completion returned empty content.", "provider.llama_cpp.empty_output");
    }
    return { text: data.content };
  }

  private async v1Completion(prompt: string, model: string): Promise<CompletionResult> {
    const res = await this.fetchWithRetry(`${this.endpoint}/v1/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, max_tokens: 512 })
    });
    if (!res.ok) {
      const body = await res.text();
      throw new ProviderError(`llama.cpp v1 completion error ${res.status}: ${body}`, "provider.llama_cpp.v1_error", {
        status: res.status
      });
    }
    const data = (await res.json()) as { choices?: Array<{ text?: string }> };
    const text = data.choices?.[0]?.text;
    if (!text) {
      throw new ProviderError("llama.cpp v1 completion returned empty output.", "provider.llama_cpp.empty_output");
    }
    return { text };
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
    throw new ProviderError("llama.cpp request failed after retries.", "provider.llama_cpp.retry_exhausted", {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
