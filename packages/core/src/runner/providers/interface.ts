import type { LlmUsage } from "../cost.js";

export type CompletionOptions = {
  model: string;
  prompt: string;
};

export type CompletionResult = {
  text: string;
  usage?: LlmUsage;
};

export interface IAgentProvider {
  complete(options: CompletionOptions): Promise<CompletionResult>;
  complete(prompt: string, options: CompletionOptions): Promise<CompletionResult>;
}
