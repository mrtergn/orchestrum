import fs from "node:fs/promises";
import path from "node:path";
import type { RunState } from "../runner/types.js";
import type { Workflow } from "../runner/workflow.js";
import type { RunAnalysis } from "./runAnalysis.js";
import { writeJson } from "../runner/fs.js";

export type KnowledgeNode = {
  id: string;
  type: "file" | "agent" | "failure" | "strategy" | "model";
  label?: string;
};

export type KnowledgeEdge = {
  from: string;
  to: string;
  type: "caused_failure" | "improved_by" | "related_to";
  weight: number;
};

export type KnowledgeGraph = {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
};

const DEFAULT_GRAPH: KnowledgeGraph = { nodes: [], edges: [] };

export async function loadKnowledgeGraph(workspacePath: string): Promise<KnowledgeGraph> {
  const filePath = path.join(workspacePath, ".memory", "knowledge.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as KnowledgeGraph;
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : []
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_GRAPH };
    }
    throw err;
  }
}

export async function updateKnowledgeGraph(options: {
  workspacePath: string;
  runMeta: RunState;
  workflow: Workflow;
  analysis: RunAnalysis;
  changedFiles: string[];
}): Promise<KnowledgeGraph> {
  const graph = await loadKnowledgeGraph(options.workspacePath);
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const edgeMap = new Map(graph.edges.map((e) => [`${e.from}|${e.to}|${e.type}`, e]));

  const ensureNode = (id: string, type: KnowledgeNode["type"], label?: string) => {
    if (!nodeMap.has(id)) {
      nodeMap.set(id, { id, type, label });
    }
  };

  const ensureEdge = (from: string, to: string, type: KnowledgeEdge["type"], weight = 1) => {
    const key = `${from}|${to}|${type}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.weight += weight;
    } else {
      edgeMap.set(key, { from, to, type, weight });
    }
  };

  const failures: Array<{ id: string; count: number }> = [];
  if (options.analysis.policyViolations > 0) failures.push({ id: "failure:policy", count: options.analysis.policyViolations });
  if (options.analysis.auditFailures > 0) failures.push({ id: "failure:audit", count: options.analysis.auditFailures });
  if (options.analysis.testFailures > 0) failures.push({ id: "failure:test", count: options.analysis.testFailures });
  if (options.analysis.securityAlerts > 0) failures.push({ id: "failure:security", count: options.analysis.securityAlerts });

  for (const failure of failures) {
    ensureNode(failure.id, "failure", failure.id.replace("failure:", ""));
  }

  for (const agentId of Object.keys(options.workflow.agents)) {
    ensureNode(`agent:${agentId}`, "agent", agentId);
  }

  const strategy = options.runMeta.strategy?.mode;
  if (strategy) {
    ensureNode(`strategy:${strategy}`, "strategy", strategy);
  }

  for (const model of Object.keys(options.runMeta.modelUsage ?? {})) {
    ensureNode(`model:${model}`, "model", model);
  }

  for (const file of options.changedFiles) {
    ensureNode(`file:${file}`, "file", file);
  }

  for (const failure of failures) {
    if (strategy) {
      ensureEdge(`strategy:${strategy}`, failure.id, "caused_failure", failure.count);
    }
    for (const model of Object.keys(options.runMeta.modelUsage ?? {})) {
      ensureEdge(`model:${model}`, failure.id, "caused_failure", failure.count);
    }
    for (const file of options.changedFiles) {
      ensureEdge(`file:${file}`, failure.id, "caused_failure", Math.max(1, failure.count));
    }
  }

  graph.nodes = Array.from(nodeMap.values());
  graph.edges = Array.from(edgeMap.values());

  await saveGraph(options.workspacePath, graph);
  return graph;
}

async function saveGraph(workspacePath: string, graph: KnowledgeGraph): Promise<void> {
  const memoryDir = path.join(workspacePath, ".memory");
  await fs.mkdir(memoryDir, { recursive: true });
  await writeJson(path.join(memoryDir, "knowledge.json"), graph);
}
