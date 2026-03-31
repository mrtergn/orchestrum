import { ProviderError } from "../../errors.js";
import type { CompletionOptions, CompletionResult, IAgentProvider } from "./interface.js";

export type OllamaOptions = {
  endpoint: string;
};

export class OllamaProvider implements IAgentProvider {
  constructor(private endpoint: string) {}

  async complete(options: CompletionOptions): Promise<CompletionResult>;
  async complete(prompt: string, options: CompletionOptions): Promise<CompletionResult>;
  async complete(arg1: string | CompletionOptions, arg2?: CompletionOptions): Promise<CompletionResult> {
    const resolved = normalizeCompletionArgs(arg1, arg2);
    const res = await this.fetchWithRetry(`${this.endpoint}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: resolved.model,
        prompt: resolved.prompt,
        stream: false
      })
    });
    if (!res.ok) {
      const body = await res.text();
      throw new ProviderError(`Ollama error ${res.status}: ${body}`, "provider.ollama.http_error", {
        status: res.status
      });
    }
    const data = (await res.json()) as { response?: string };
    const text = data.response;
    if (!text) throw new ProviderError("Ollama returned empty response.", "provider.ollama.empty_output");
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
    throw new ProviderError("Ollama request failed after retries.", "provider.ollama.retry_exhausted", {
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
