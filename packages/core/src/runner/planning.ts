import type { Workflow, StepDefinition } from "./workflow.js";

export type StepPointer = {
  stepId: string;
  parentId?: string;
  definition: StepDefinition;
};

export type StepBlock =
  | {
      kind: "single";
      step: StepPointer;
      phase?: string;
    }
  | {
      kind: "parallel";
      parentId: string;
      steps: StepPointer[];
      phase?: string;
    };

export function buildStepBlocks(workflow: Workflow): StepBlock[] {
  const blocks: StepBlock[] = [];
  for (const step of workflow.steps) {
    if (step.parallel && step.substeps && step.substeps.length > 0) {
      const steps = step.substeps.map((sub) => ({
        stepId: `${step.id}.${sub.id}`,
        parentId: step.id,
        definition: sub
      }));
      blocks.push({ kind: "parallel", parentId: step.id, steps, phase: step.phase });
      continue;
    }

    blocks.push({
      kind: "single",
      step: {
        stepId: step.id,
        definition: step
      },
      phase: step.phase
    });
  }
  return blocks;
}

export function flattenBlocks(blocks: StepBlock[]): StepPointer[] {
  const list: StepPointer[] = [];
  for (const block of blocks) {
    if (block.kind === "single") {
      list.push(block.step);
    } else {
      for (const sub of block.steps) {
        list.push(sub);
      }
    }
  }
  return list;
}

export function buildParentIndex(blocks: StepBlock[]): Map<string, number> {
  const map = new Map<string, number>();
  let idx = 0;
  for (const block of blocks) {
    if (block.kind === "single") {
      map.set(block.step.stepId, idx);
      idx += 1;
    } else {
      map.set(block.parentId, idx);
      for (const step of block.steps) {
        map.set(step.stepId, idx);
        idx += 1;
      }
    }
  }
  return map;
}

export function resolveStartIndex(stepIds: string[], parentIndex: Map<string, number>, fromStepId: string): number {
  if (parentIndex.has(fromStepId)) {
    return parentIndex.get(fromStepId) ?? 0;
  }
  const idx = stepIds.indexOf(fromStepId);
  if (idx === -1) {
    throw new Error(`Unknown step id ${fromStepId}`);
  }
  return idx;
}

export function buildResumePlan(options: {
  stepIds: string[];
  startIndex: number;
  completed: Set<string>;
  forceRun?: Set<string>;
}): { toRun: Set<string>; skipped: Set<string> } {
  const toRun = new Set<string>();
  const skipped = new Set<string>();
  options.stepIds.forEach((id, idx) => {
    if (idx < options.startIndex) {
      if (options.completed.has(id)) {
        skipped.add(id);
      }
      return;
    }
    if (options.forceRun?.has(id)) {
      toRun.add(id);
      return;
    }
    if (options.completed.has(id)) {
      skipped.add(id);
      return;
    }
    toRun.add(id);
  });
  return { toRun, skipped };
}
