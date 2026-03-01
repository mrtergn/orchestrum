import { OpenAIProvider } from "../runner/providers/openai.js";
import { OllamaProvider } from "../runner/providers/ollama.js";
import { LlamaCppProvider } from "../runner/providers/llamaCpp.js";
import type { LlmUsage } from "../runner/cost.js";

export type AgentFactoryOptions = {
  provider: string;
  model: string;
  agentId: string;
  env: NodeJS.ProcessEnv;
};

export type AgentResult = {
  text: string;
  usage?: LlmUsage;
};

export type AgentClient = {
  complete: (prompt: string) => Promise<AgentResult>;
};

export type AgentFactory = (options: AgentFactoryOptions) => AgentClient;

const registry = new Map<string, AgentFactory>();

export function registerAgent(provider: string, factory: AgentFactory) {
  registry.set(provider, factory);
}

export function getAgentFactory(provider: string): AgentFactory | undefined {
  return registry.get(provider);
}

export function registerBuiltInAgents() {
  if (!registry.has("openai")) {
    registerAgent("openai", (options) => {
      const apiKey = options.env.OPENAI_API_KEY ?? "";
      const baseUrl =
        options.env.OPENAI_API_BASE_URL ?? options.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
      const mode = (options.env.OPENAI_API_MODE as "responses" | "chat" | "auto") ?? "auto";
      const client = new OpenAIProvider(apiKey, baseUrl, mode);
      return {
        complete: (prompt: string) => client.complete({ model: options.model, prompt })
      };
    });
  }
  if (!registry.has("ollama")) {
    registerAgent("ollama", (options) => {
      const endpoint =
        options.env.ORCHESTRUM_LOCAL_LLM_ENDPOINT ??
        "http://localhost:11434";
      const client = new OllamaProvider(endpoint);
      return {
        complete: async (prompt: string) => {
          const result = await client.complete({ model: options.model, prompt });
          return { text: result.text };
        }
      };
    });
  }
  const llamaFactory = (options: AgentFactoryOptions) => {
    const endpoint =
      options.env.ORCHESTRUM_LOCAL_LLM_ENDPOINT ??
      "http://localhost:8080";
    const client = new LlamaCppProvider(endpoint);
    return {
      complete: async (prompt: string) => {
        const result = await client.complete({ model: options.model, prompt });
        return { text: result.text };
      }
    };
  };
  if (!registry.has("llama_cpp")) {
    registerAgent("llama_cpp", llamaFactory);
  }
  if (!registry.has("llama.cpp")) {
    registerAgent("llama.cpp", llamaFactory);
  }
}
