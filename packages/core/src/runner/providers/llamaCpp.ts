export type LlamaCppOptions = {
  endpoint: string;
};

export class LlamaCppProvider {
  constructor(private endpoint: string) {}

  async complete(options: { model: string; prompt: string }): Promise<{ text: string }> {
    try {
      return await this.completion(options.prompt);
    } catch {
      return await this.v1Completion(options.prompt, options.model);
    }
  }

  private async completion(prompt: string): Promise<{ text: string }> {
    const res = await fetch(`${this.endpoint}/completion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt })
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`llama.cpp completion error ${res.status}: ${body}`);
    }
    const data = (await res.json()) as { content?: string };
    if (!data.content) {
      throw new Error("llama.cpp completion returned empty content.");
    }
    return { text: data.content };
  }

  private async v1Completion(prompt: string, model: string): Promise<{ text: string }> {
    const res = await fetch(`${this.endpoint}/v1/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, max_tokens: 512 })
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`llama.cpp v1 completion error ${res.status}: ${body}`);
    }
    const data = (await res.json()) as { choices?: Array<{ text?: string }> };
    const text = data.choices?.[0]?.text;
    if (!text) {
      throw new Error("llama.cpp v1 completion returned empty output.");
    }
    return { text };
  }
}
