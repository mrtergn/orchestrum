import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { LlmUsage } from "./cost.js";
import { writeJson, writeText } from "./fs.js";

export type SandboxConfig = {
  enabled: boolean;
  image: string;
  network?: boolean;
  user?: string;
  cpu_limit?: number;
  memory_limit_mb?: number;
};

type SandboxResult =
  | { ok: true; outputText: string; usage?: LlmUsage; logs: string }
  | { ok: false; error: string; logs: string };

let dockerAvailableCache: boolean | null = null;

export async function isDockerAvailable(): Promise<boolean> {
  if (dockerAvailableCache !== null) return dockerAvailableCache;
  return new Promise((resolve) => {
    const child = spawn("docker", ["--version"], { stdio: "ignore" });
    child.on("error", () => {
      dockerAvailableCache = false;
      resolve(false);
    });
    child.on("close", (code) => {
      dockerAvailableCache = code === 0;
      resolve(dockerAvailableCache);
    });
  });
}

export async function runSandboxedLLM(options: {
  repoPath: string;
  runDir: string;
  stepId: string;
  provider: string;
  model: string;
  image: string;
  env: NodeJS.ProcessEnv;
  config?: SandboxConfig | null;
}): Promise<SandboxResult> {
  const stepDir = path.join(options.runDir, "steps", options.stepId);
  const runnerPath = path.join(stepDir, "sandbox-runner.mjs");
  const configPath = path.join(stepDir, "step_config.json");
  const logPath = path.join(stepDir, "container.log");

  await writeText(runnerPath, SANDBOX_RUNNER);
  await writeJson(configPath, {
    provider: options.provider,
    model: options.model,
    mode: options.env.OPENAI_API_MODE ?? "auto"
  });

  const repoPath = path.resolve(options.repoPath);
  const runDir = path.resolve(options.runDir);
  const containerStepDir = `/runs/steps/${options.stepId}`;

  const sandboxUser = options.config?.user ?? "node";
  const args = [
    "run",
    "--rm",
    "--read-only",
    "--user",
    sandboxUser,
    "-v",
    `${repoPath}:/repo:rw`,
    "-v",
    `${runDir}:/runs:rw`,
    "-w",
    "/repo",
    "--tmpfs",
    "/tmp",
    "-e",
    `OPENAI_API_KEY=${options.env.OPENAI_API_KEY ?? ""}`,
    "-e",
    `OPENAI_API_BASE_URL=${options.env.OPENAI_API_BASE_URL ?? options.env.OPENAI_BASE_URL ?? ""}`,
    "-e",
    `OPENAI_API_MODE=${options.env.OPENAI_API_MODE ?? "auto"}`,
    "-e",
    `ORCHESTRUM_STEP_DIR=${containerStepDir}`,
    ...(options.config?.network === false || options.config?.network === undefined ? ["--network", "none"] : []),
    ...(options.config?.cpu_limit ? ["--cpus", String(options.config.cpu_limit)] : []),
    ...(options.config?.memory_limit_mb ? ["--memory", `${options.config.memory_limit_mb}m`] : []),
    options.image,
    "node",
    `${containerStepDir}/sandbox-runner.mjs`
  ];

  const child = spawn("docker", args, { shell: false });
  let logs = "";

  const appendLog = (chunk: Buffer, isErr: boolean) => {
    const text = chunk.toString();
    logs += text;
    const prefix = isErr ? "[stderr] " : "";
    fsSync.appendFileSync(logPath, `${prefix}${text}`, "utf8");
  };

  child.stdout.on("data", (chunk) => appendLog(chunk as Buffer, false));
  child.stderr.on("data", (chunk) => appendLog(chunk as Buffer, true));

  const exitCode = await new Promise<number>((resolve) => {
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    return { ok: false, error: `Docker sandbox exited with code ${exitCode}`, logs };
  }

  const outputPath = path.join(stepDir, "output.md");
  const usagePath = path.join(stepDir, "usage.json");
  const outputText = await fs.readFile(outputPath, "utf8").catch(() => "");
  const usage = await fs
    .readFile(usagePath, "utf8")
    .then((raw) => JSON.parse(raw) as LlmUsage)
    .catch(() => undefined);

  return { ok: true, outputText, usage, logs };
}

const SANDBOX_RUNNER = String.raw`import fs from "node:fs/promises";

async function main() {
  const stepDir = process.env.ORCHESTRUM_STEP_DIR;
  if (!stepDir) {
    throw new Error("ORCHESTRUM_STEP_DIR not set");
  }
  const configRaw = await fs.readFile(stepDir + "/step_config.json", "utf8");
  const config = JSON.parse(configRaw);
  const inputRaw = await fs.readFile(stepDir + "/input.json", "utf8");
  const input = JSON.parse(inputRaw);
  const prompt = input.renderedPrompt ?? "";

  if (config.provider !== "openai") {
    throw new Error("Unsupported provider in sandbox: " + config.provider);
  }

  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY missing in sandbox");
  }
  const baseUrl = process.env.OPENAI_API_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const mode = process.env.OPENAI_API_MODE ?? "auto";

  const result = mode === "chat"
    ? await chatCompletion(baseUrl, apiKey, config.model, prompt)
    : await responsesCompletion(baseUrl, apiKey, config.model, prompt).catch(async (err) => {
        if (mode === "responses") throw err;
        return await chatCompletion(baseUrl, apiKey, config.model, prompt);
      });

  await writeText(stepDir + "/output.md", result.text);
  if (result.usage) {
    await writeJson(stepDir + "/usage.json", result.usage);
  }
}

async function responsesCompletion(baseUrl, apiKey, model, prompt) {
  const res = await fetch(baseUrl + "/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey
    },
    body: JSON.stringify({ model, input: prompt, temperature: 0.2 })
  });
  if (!res.ok) {
    throw new Error("OpenAI responses error " + res.status + ": " + (await res.text()));
  }
  const data = await res.json();
  const text = data.output?.[0]?.content?.[0]?.text ?? data.output_text ?? data.output?.[0]?.text ?? data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Empty output from responses");
  const usage = normalizeUsage(data.usage);
  return { text, usage };
}

async function chatCompletion(baseUrl, apiKey, model, prompt) {
  const res = await fetch(baseUrl + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey
    },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.2 })
  });
  if (!res.ok) {
    throw new Error("OpenAI chat error " + res.status + ": " + (await res.text()));
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Empty output from chat");
  const usage = normalizeUsage(data.usage);
  return { text, usage };
}

function normalizeUsage(raw) {
  if (!raw) return undefined;
  const prompt = raw.input_tokens ?? raw.prompt_tokens ?? 0;
  const completion = raw.output_tokens ?? raw.completion_tokens ?? 0;
  const total = raw.total_tokens ?? (prompt + completion);
  if (prompt === 0 && completion === 0 && total === 0) return undefined;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

main().catch((err) => {
  console.error(err?.message ?? String(err));
  process.exit(1);
});`;
