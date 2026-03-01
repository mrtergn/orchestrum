export type OllamaOptions = {
  endpoint: string;
};

export class OllamaProvider {
  constructor(private endpoint: string) {}

  async complete(options: { model: string; prompt: string }): Promise<{ text: string }> {
    const res = await fetch(`${this.endpoint}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        prompt: options.prompt,
        stream: false
      })
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama error ${res.status}: ${body}`);
    }
    const data = (await res.json()) as { response?: string };
    const text = data.response;
    if (!text) throw new Error("Ollama returned empty response.");
    return { text };
  }
}
