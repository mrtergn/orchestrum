import fs from "node:fs/promises";
import path from "node:path";
import {
  getWorkspaceAgentsPath,
  loadMissionTemplate,
  type WorkItemAuditRisk,
  type WorkItemGate,
  type MissionTemplate,
  type WorkItemCyclePlan,
  type WorkItemExecutionStep,
  type WorkItemMinimalTeamMember,
  type WorkItemPlanningDetail,
  type WorkItemRemediationPlan,
  type WorkItemRecord,
  type WorkItemReviewSummary,
  type WorkItemTeamSelectionLane,
  type WorkItemValidationContract,
  type WorkItemWorkstream,
  type WorkPlanLane,
  type WorkPlanLaneAssignment,
  type WorkPlanLaneMatch,
  type WorkPlanTask,
  type WorkPlanTaskKind,
  type WorkSprintPreview
} from "@orchestrum/core";

type ParsedPbi = {
  sourcePath: string;
  sprintName: string | null;
  pbiId: string;
  pbiTitle: string;
  summary: string | null;
  acceptanceCriteria: string[];
  tasks: WorkPlanTask[];
  warnings: string[];
};

type SourceRefParts = {
  sourcePath: string;
  pbiRef: string | null;
};

type InternalPbiRecord = {
  id: string;
  title: string;
  summaryLines: string[];
  dependsOnPbis: string[];
  acceptanceCriteria: string[];
  tasks: WorkPlanTask[];
  warnings: string[];
};

type WorkspaceAgentRecord = {
  id: string;
  name: string;
  role: string;
  tags: string[];
  profile: {
    specialization: string;
    seniority: string;
    maxParallelWork: number;
  };
  status: {
    state: string;
  };
};

type RemediationTaskSignal = {
  id: string;
  title?: string;
  status: string;
  type?: string;
  laneId?: string;
  laneLabel?: string;
  resultSummary?: string;
};

type LifecycleIntentSignals = {
  frontend: boolean;
  backend: boolean;
  browser: boolean;
  scenario: boolean;
  validation: boolean;
  api: boolean;
  data: boolean;
  notes: string[];
};

const LANE_DEFINITIONS: WorkPlanLane[] = [
  { id: "pm", label: "PM", description: "Scope, framing, and planning work." },
  { id: "frontend", label: "Frontend", description: "UI and client-side implementation." },
  { id: "backend", label: "Backend", description: "API, server, and data flow work." },
  { id: "developer", label: "Development", description: "General implementation work." },
  { id: "tester", label: "Tester", description: "Verification and validation work." },
  { id: "qa", label: "Browser Smoke", description: "Browser smoke checks and user-journey evidence." },
  { id: "audit", label: "Audit", description: "Review, hardening, and sign-off work." }
];

async function composePlanningDetail(options: {
  workspacePath: string;
  sourceType: WorkItemRecord["brief"]["sourceType"];
  summary: string;
  acceptanceCriteria: string[];
  constraints: string[];
  tasks: WorkPlanTask[];
  template: ReturnType<typeof templateSummary>;
  sourceSnapshot: WorkItemPlanningDetail["sourceSnapshot"];
}): Promise<WorkItemPlanningDetail> {
  const tasks = ensureExecutionLifecycleTasks(options.tasks, options.sourceType, {
    summary: options.summary,
    acceptanceCriteria: options.acceptanceCriteria,
    constraints: options.constraints
  });
  const lanes = lanesFromTasks(tasks);
  const workspaceAgents = await loadWorkspaceAgents(options.workspacePath);
  const teamAssignments = buildTeamAssignmentsForLanes(lanes, workspaceAgents);
  const { workstreams, gates, qaCoverage, tasks: annotatedTasks } = buildWorkstreamPlan({
    tasks,
    teamAssignments
  });
  const validationContract = buildValidationContract({
    sourceType: options.sourceType,
    summary: options.summary,
    acceptanceCriteria: options.acceptanceCriteria,
    constraints: options.constraints,
    tasks: annotatedTasks,
    workstreams
  });
  const {
    teamSelection,
    omittedLanes,
    missingCapabilities,
    selectionRationale
  } = buildTeamSelection({
    workspaceAgents,
    activeLanes: lanes,
    workstreams,
    gates,
    teamAssignments,
    summary: options.summary,
    acceptanceCriteria: options.acceptanceCriteria,
    constraints: options.constraints,
    sourceType: options.sourceType
  });
  const auditRisk = buildAuditRisk({
    sourceType: options.sourceType,
    summary: options.summary,
    acceptanceCriteria: options.acceptanceCriteria,
    constraints: options.constraints,
    workstreams,
    gates,
    validationContract,
    teamSelection
  });
  return {
    summary: options.summary,
    acceptanceCriteria: options.acceptanceCriteria,
    constraints: options.constraints,
    lanes,
    tasks: annotatedTasks,
    workstreams,
    gates,
    qaCoverage,
    validationContract,
    auditRisk,
    teamAssignments,
    teamSelection,
    omittedLanes,
    missingCapabilities,
    selectionRationale,
    executionSteps: executionStepsFromTasks(annotatedTasks),
    template: options.template,
    sourceSnapshot: options.sourceSnapshot
  };
}

export async function buildWorkItemPlanningDetail(options: {
  workspacePath: string;
  workItem: WorkItemRecord;
}): Promise<WorkItemPlanningDetail> {
  const template = loadMissionTemplate(options.workItem.recommendedTemplateId);
  const templateInfo = templateSummary(template);

  if (options.workItem.brief.sourceType === "pbi" && options.workItem.brief.sourceRef) {
    try {
      const parsed = await parsePbiSource({
        workspacePath: options.workspacePath,
        sourceRef: options.workItem.brief.sourceRef
      });
      const acceptanceCriteria = mergeUnique(
        parsed.acceptanceCriteria,
        options.workItem.brief.acceptanceCriteria
      );
      const warnings = [...parsed.warnings];
      if (parsed.tasks.length === 0) {
        warnings.push("No explicit PBI task list was found, so the mission template stages are shown instead.");
      }
      return composePlanningDetail({
        workspacePath: options.workspacePath,
        sourceType: options.workItem.brief.sourceType,
        summary: parsed.summary ?? options.workItem.brief.request,
        acceptanceCriteria,
        constraints: options.workItem.brief.constraints,
        template: templateInfo,
        sourceSnapshot: {
          kind: "pbi_markdown",
          label: "Sprint Markdown",
          sourcePath: parsed.sourcePath,
          sprintName: parsed.sprintName,
          pbiId: parsed.pbiId,
          pbiTitle: parsed.pbiTitle,
          summary: parsed.summary,
          warnings
        }
        ,
        tasks: parsed.tasks.length > 0 ? parsed.tasks : templatePlanningTasks(template)
      });
    } catch (error) {
      return composePlanningDetail({
        workspacePath: options.workspacePath,
        sourceType: options.workItem.brief.sourceType,
        summary: options.workItem.brief.request,
        acceptanceCriteria: options.workItem.brief.acceptanceCriteria,
        constraints: options.workItem.brief.constraints,
        template: templateInfo,
        sourceSnapshot: {
          kind: "pbi_markdown",
          label: "Sprint Markdown",
          sourcePath: parseSourceRef(options.workItem.brief.sourceRef).sourcePath,
          pbiId: parseSourceRef(options.workItem.brief.sourceRef).pbiRef,
          pbiTitle: null,
          summary: null,
          warnings: [error instanceof Error ? error.message : String(error)]
        }
        ,
        tasks: templatePlanningTasks(template)
      });
    }
  }

  const tasks = buildBriefDrivenLifecycleTasks(options.workItem, template);
  return composePlanningDetail({
    workspacePath: options.workspacePath,
    sourceType: options.workItem.brief.sourceType,
    summary: options.workItem.brief.request,
    acceptanceCriteria: options.workItem.brief.acceptanceCriteria,
    constraints: options.workItem.brief.constraints,
    tasks,
    template: templateInfo,
    sourceSnapshot: {
      kind: "mission_template",
      label: "Mission Template",
      sourcePath: null,
      sprintName: null,
      pbiId: null,
      pbiTitle: null,
      summary: `Derived from ${template.name}.`,
      warnings: []
    }
  });
}

export async function previewPbiPlanning(options: {
  workspacePath: string;
  sourceRef: string;
  templateId?: string;
}): Promise<WorkItemPlanningDetail> {
  const template = loadMissionTemplate(options.templateId ?? "feature-dev");
  const parsed = await parsePbiSource({
    workspacePath: options.workspacePath,
    sourceRef: options.sourceRef
  });
  const warnings = [...parsed.warnings];
  if (parsed.tasks.length === 0) {
    warnings.push("No explicit PBI task list was found, so the mission template stages are shown instead.");
  }
  return composePlanningDetail({
    workspacePath: options.workspacePath,
    sourceType: "pbi",
    summary: parsed.summary ?? `${parsed.pbiId} ${parsed.pbiTitle}`.trim(),
    acceptanceCriteria: parsed.acceptanceCriteria,
    constraints: [],
    template: templateSummary(template),
    sourceSnapshot: {
      kind: "pbi_markdown",
      label: "Sprint Markdown",
      sourcePath: parsed.sourcePath,
      sprintName: parsed.sprintName,
      pbiId: parsed.pbiId,
      pbiTitle: parsed.pbiTitle,
      summary: parsed.summary,
      warnings
    }
    ,
    tasks: parsed.tasks.length > 0 ? parsed.tasks : templatePlanningTasks(template)
  });
}

export async function previewSprintBacklog(options: {
  workspacePath: string;
  sourcePath: string;
}): Promise<WorkSprintPreview> {
  const absolutePath = resolveWorkspaceFile(options.workspacePath, options.sourcePath);
  const raw = await fs.readFile(absolutePath, "utf8").catch(() => {
    throw new Error(`Sprint source file not found: ${options.sourcePath}`);
  });
  const parsed = parseSprintMarkdown(raw);
  if (parsed.pbis.length === 0) {
    throw new Error("No PBI headings were found. Expected a heading like `## PBI ABC: Title`.");
  }
  const relativePath = path.relative(options.workspacePath, absolutePath) || path.basename(absolutePath);
  return {
    sourcePath: relativePath,
    sprintName: parsed.sprintName,
    warnings: [...parsed.warnings],
    pbis: parsed.pbis.map((pbi) => ({
      pbiId: pbi.id,
      pbiTitle: pbi.title,
      summary: collapseSummary(pbi.summaryLines),
      sourceRef: `${relativePath} :: ${pbi.id}`,
      dependsOn: [...pbi.dependsOnPbis],
      acceptanceCriteria: [...pbi.acceptanceCriteria],
      taskCount: pbi.tasks.length,
      warnings: [...pbi.warnings]
    }))
  };
}

export function buildWorkItemRemediationPlan(options: {
  workItem: WorkItemRecord;
  detail: WorkItemPlanningDetail;
  review: WorkItemReviewSummary;
  relatedTasks: RemediationTaskSignal[];
  now?: string;
}): WorkItemRemediationPlan {
  const note = options.workItem.reviewNote?.trim() ?? "";
  const laneReasons = new Map<string, Set<string>>();
  const addLaneReason = (laneId: string, reason: string) => {
    const key = laneId.trim();
    if (!key) return;
    const bucket = laneReasons.get(key) ?? new Set<string>();
    bucket.add(reason);
    laneReasons.set(key, bucket);
  };

  for (const laneId of inferRemediationLanesFromText(note)) {
    addLaneReason(laneId, "Operator note explicitly targeted this lane.");
  }

  for (const task of options.relatedTasks) {
    const status = task.status.trim().toLowerCase();
    if (!task.laneId) continue;
    if (status === "failed" || status === "blocked" || status === "cancelled" || status === "canceled") {
      addLaneReason(task.laneId, `Previous ${task.laneLabel ?? task.laneId} task '${task.title ?? task.id}' ended as ${status}.`);
    }
  }

  for (const signal of options.review.signals) {
    if (signal.status === "passed") continue;
    if (signal.label === "Validation") {
      addLaneReason("tester", `Validation signal is ${signal.status}.`);
    } else if (signal.label === "Browser Smoke") {
      addLaneReason("qa", `Browser smoke signal is ${signal.status}.`);
    } else if (signal.label === "Audit") {
      addLaneReason("audit", `Audit signal is ${signal.status}.`);
    }
  }

  if (laneReasons.size === 0) {
    addLaneReason("developer", "No explicit lane was identified, so remediation falls back to the general development lane.");
  }

  const selectedTasks = selectRemediationTasks({
    detail: options.detail,
    selectedLaneIds: Array.from(laneReasons.keys()),
    review: options.review,
    note
  });

  const nextCycleSequence = Math.max(1, (options.workItem.cycles?.length ?? 0) + 1);
  const selectedLaneIds = Array.from(new Set(selectedTasks.map((task) => task.laneId)));
  const rationale = Array.from(laneReasons.entries()).flatMap(([laneId, reasons]) => {
    const lane = laneById(laneId);
    return Array.from(reasons).map((reason) => `${lane.label}: ${reason}`);
  });
  const acceptanceDelta = buildRemediationAcceptanceDelta({
    review: options.review,
    note,
    selectedLaneIds
  });
  const constraintDelta = buildRemediationConstraintDelta({
    selectedLaneIds,
    note
  });
  const cycleTasks = buildRemediationCycleTasks({
    detail: options.detail,
    selectedTasks,
    note,
    review: options.review,
    sequence: nextCycleSequence
  });
  const cycleTeamAssignments = options.detail.teamAssignments.filter((assignment) =>
    cycleTasks.some((task) => task.laneId === assignment.laneId)
  );
  const cycleWorkstreamPlan = buildWorkstreamPlan({
    tasks: cycleTasks,
    teamAssignments: cycleTeamAssignments
  });
  const cycleValidationContract = buildValidationContract({
    sourceType: options.workItem.brief.sourceType,
    summary: `Cycle ${nextCycleSequence} remediation plan. ${buildRemediationSummary(selectedLaneIds, note, options.review)}`,
    acceptanceCriteria: mergeUnique(options.detail.acceptanceCriteria, acceptanceDelta),
    constraints: mergeUnique(options.detail.constraints, constraintDelta),
    tasks: cycleWorkstreamPlan.tasks,
    workstreams: cycleWorkstreamPlan.workstreams
  });
  const cycleTeamSelection = options.detail.teamSelection.map((entry) => {
    const required = selectedLaneIds.includes(entry.laneId);
    const hasMatch = entry.matches.length > 0;
    return {
      ...entry,
      required,
      decision: required ? (hasMatch ? "selected" : "missing") : hasMatch ? "standby" : "omitted",
      selectionReason: required
        ? entry.selectionReason ?? `${entry.laneLabel} participates in the remediation cycle.`
        : entry.selectionReason ?? null,
      omissionReason: required
        ? null
        : `Lane is not part of the remediation minimal team for this cycle.`,
      expectedWorkstreams: [],
      expectedGates: []
    } satisfies WorkItemTeamSelectionLane;
  });
  const cycleDetail = {
    ...options.detail,
    summary: `Cycle ${nextCycleSequence} remediation plan. ${buildRemediationSummary(selectedLaneIds, note, options.review)}`,
    acceptanceCriteria: mergeUnique(options.detail.acceptanceCriteria, acceptanceDelta),
    constraints: mergeUnique(options.detail.constraints, constraintDelta),
    lanes: lanesFromTasks(cycleTasks),
    tasks: cycleWorkstreamPlan.tasks,
    workstreams: cycleWorkstreamPlan.workstreams,
    gates: cycleWorkstreamPlan.gates,
    qaCoverage: cycleWorkstreamPlan.qaCoverage,
    teamAssignments: cycleTeamAssignments,
    teamSelection: cycleTeamSelection,
    omittedLanes: cycleTeamSelection
      .filter((entry) => !selectedLaneIds.includes(entry.laneId))
      .map((entry) => entry.laneId),
    missingCapabilities: cycleTeamSelection
      .filter((entry) => selectedLaneIds.includes(entry.laneId) && entry.matches.length === 0)
      .map((entry) => `${entry.laneLabel}: no specialist is configured for this remediation lane.`),
    selectionRationale: cycleTeamSelection
      .filter((entry) => selectedLaneIds.includes(entry.laneId))
      .map((entry) => entry.selectionReason ?? `${entry.laneLabel} was retained for remediation.`),
    executionSteps: executionStepsFromTasks(cycleTasks),
    validationContract: cycleValidationContract,
    auditRisk: buildAuditRisk({
      sourceType: options.workItem.brief.sourceType,
      summary: `Cycle ${nextCycleSequence} remediation plan. ${buildRemediationSummary(selectedLaneIds, note, options.review)}`,
      acceptanceCriteria: mergeUnique(options.detail.acceptanceCriteria, acceptanceDelta),
      constraints: mergeUnique(options.detail.constraints, constraintDelta),
      workstreams: cycleWorkstreamPlan.workstreams,
      gates: cycleWorkstreamPlan.gates,
      validationContract: cycleValidationContract,
      teamSelection: cycleTeamSelection
    })
  } satisfies WorkItemPlanningDetail;
  const cyclePlan = createWorkItemCyclePlan({
    detail: cycleDetail,
    source: "remediation",
    sourceCycleId: options.workItem.currentCycleId ?? null,
    sourceRemediationPlanId: `remediation-${Date.now()}`,
    headline: `Cycle ${nextCycleSequence} remediation`
  });
  const remediationPlanId = cyclePlan.sourceRemediationPlanId ?? `remediation-${Date.now()}`;

  return {
    id: remediationPlanId,
    status: "suggested",
    createdAt: options.now ?? new Date().toISOString(),
    launchedAt: null,
    resolvedAt: null,
    sourceCycleId: options.workItem.currentCycleId ?? null,
    note: note || null,
    summary: cyclePlan.summary,
    rationale,
    laneIds: selectedLaneIds,
    acceptanceDelta,
    constraintDelta,
    taskIds: cycleTasks.map((task) => task.id),
    tasks: cycleTasks,
    executionSteps: cyclePlan.executionSteps,
    cyclePlan: {
      ...cyclePlan,
      sourceRemediationPlanId: remediationPlanId
    }
  };
}

export function applyRemediationPlanToPlanningDetail(options: {
  detail: WorkItemPlanningDetail;
  remediationPlan: WorkItemRemediationPlan;
}): WorkItemPlanningDetail {
  const teamSelection = options.remediationPlan.cyclePlan.teamSelection.map((entry) => ({
    ...entry,
    preferredSpecializations: [...entry.preferredSpecializations],
    expectedWorkstreams: [...entry.expectedWorkstreams],
    expectedGates: [...entry.expectedGates],
    matches: entry.matches.map((match) => ({ ...match }))
  }));
  return {
    ...options.detail,
    summary: options.remediationPlan.cyclePlan.summary,
    acceptanceCriteria: [...options.remediationPlan.cyclePlan.acceptanceCriteria],
    constraints: [...options.remediationPlan.cyclePlan.constraints],
    lanes: [...options.remediationPlan.cyclePlan.lanes],
    tasks: [...options.remediationPlan.cyclePlan.tasks],
    workstreams: [...options.remediationPlan.cyclePlan.workstreams],
    gates: [...options.remediationPlan.cyclePlan.gates],
    qaCoverage: options.remediationPlan.cyclePlan.gates.some((gate) => gate.type === "qa_scenario") ? "scenario" : "none",
    validationContract: options.remediationPlan.cyclePlan.validationContract ?? null,
    auditRisk: options.remediationPlan.cyclePlan.auditRisk ?? null,
    teamAssignments: [...options.remediationPlan.cyclePlan.teamAssignments],
    teamSelection,
    omittedLanes: teamSelection
      .filter((entry) => entry.decision === "omitted" || entry.decision === "standby")
      .map((entry) => entry.laneId),
    missingCapabilities: teamSelection
      .filter((entry) => entry.decision === "missing")
      .map((entry) => `${entry.laneLabel}: no specialist is configured for this lane.`),
    selectionRationale: teamSelection
      .map((entry) => entry.selectionReason ?? entry.omissionReason ?? "")
      .filter(Boolean),
    executionSteps: [...options.remediationPlan.cyclePlan.executionSteps]
  };
}

export function createWorkItemCyclePlan(options: {
  detail: WorkItemPlanningDetail;
  source: WorkItemCyclePlan["source"];
  sourceCycleId?: string | null;
  sourceRemediationPlanId?: string | null;
  headline?: string | null;
  cycleId?: string | null;
}): WorkItemCyclePlan {
  return {
    summary: options.detail.summary,
    headline: options.headline ?? null,
    source: options.source,
    sourceCycleId: options.sourceCycleId ?? null,
    sourceRemediationPlanId: options.sourceRemediationPlanId ?? null,
    acceptanceCriteria: [...options.detail.acceptanceCriteria],
    constraints: [...options.detail.constraints],
    lanes: options.detail.lanes.map((lane) => ({ ...lane })),
    tasks: options.detail.tasks.map((task) => ({
      ...task,
      dependsOn: [...task.dependsOn],
      gateRefs: [...(task.gateRefs ?? [])],
      cycleId: options.cycleId ?? task.cycleId ?? null,
      ownerAgentId: task.ownerAgentId ?? null,
      ownerAgentName: task.ownerAgentName ?? null,
      ownerRole: task.ownerRole ?? null
    })),
    workstreams: options.detail.workstreams.map((workstream) => ({
      ...workstream,
      taskIds: [...workstream.taskIds],
      dependsOn: [...workstream.dependsOn],
      gateRefs: [...workstream.gateRefs],
      cycleId: options.cycleId ?? workstream.cycleId ?? null,
      ownerAgentId: workstream.ownerAgentId ?? null,
      ownerAgentName: workstream.ownerAgentName ?? null,
      ownerRole: workstream.ownerRole ?? null
    })),
    gates: options.detail.gates.map((gate) => ({
      ...gate,
      workstreamIds: [...gate.workstreamIds]
    })),
    validationContract: options.detail.validationContract
      ? {
          ...options.detail.validationContract,
          commands: [...options.detail.validationContract.commands],
          requirements: [...options.detail.validationContract.requirements],
          rationale: [...options.detail.validationContract.rationale]
        }
      : null,
    auditRisk: options.detail.auditRisk
      ? {
          level: options.detail.auditRisk.level,
          reasons: [...options.detail.auditRisk.reasons]
        }
      : null,
    teamAssignments: options.detail.teamAssignments.map((assignment) => ({
      ...assignment,
      preferredSpecializations: [...assignment.preferredSpecializations],
      matches: assignment.matches.map((match) => ({ ...match }))
    })),
    teamSelection: options.detail.teamSelection.map((selection) => ({
      ...selection,
      preferredSpecializations: [...selection.preferredSpecializations],
      expectedWorkstreams: [...selection.expectedWorkstreams],
      expectedGates: [...selection.expectedGates],
      matches: selection.matches.map((match) => ({ ...match }))
    })),
    recommendedMinimalTeam: buildRecommendedMinimalTeam(options.detail.teamSelection),
    executionSteps: options.detail.executionSteps.map((step) => ({
      ...step,
      dependsOn: [...step.dependsOn],
      acceptanceCriteria: [...step.acceptanceCriteria]
    }))
  };
}

async function parsePbiSource(options: {
  workspacePath: string;
  sourceRef: string;
}): Promise<ParsedPbi> {
  const ref = parseSourceRef(options.sourceRef);
  const absolutePath = resolveWorkspaceFile(options.workspacePath, ref.sourcePath);
  const raw = await fs.readFile(absolutePath, "utf8").catch(() => {
    throw new Error(`PBI source file not found: ${ref.sourcePath}`);
  });
  const parsed = parseSprintMarkdown(raw);
  if (parsed.pbis.length === 0) {
    throw new Error("No PBI headings were found. Expected a heading like `## PBI ABC: Title`.");
  }
  const selected = selectPbi(parsed.pbis, ref.pbiRef);
  const selectionWarnings =
    !ref.pbiRef && parsed.pbis.length > 1
      ? [`No explicit PBI id was provided, so the first PBI (${selected.id}) was selected.`]
      : [];
  const relativePath = path.relative(options.workspacePath, absolutePath) || path.basename(absolutePath);
  return {
    sourcePath: relativePath,
    sprintName: parsed.sprintName,
    pbiId: selected.id,
    pbiTitle: selected.title,
    summary: collapseSummary(selected.summaryLines),
    acceptanceCriteria: selected.acceptanceCriteria,
    tasks: selected.tasks.map((task) => ({
      ...task,
      dependsOn: task.dependsOn.map((dependency) => slugifyIdentifier(dependency))
    })),
    warnings: [...parsed.warnings, ...selectionWarnings, ...selected.warnings]
  };
}

function parseSprintMarkdown(markdown: string): {
  sprintName: string | null;
  pbis: InternalPbiRecord[];
  warnings: string[];
} {
  const lines = markdown.split(/\r?\n/);
  const pbis: InternalPbiRecord[] = [];
  const warnings: string[] = [];
  let sprintName: string | null = null;
  let currentPbi: InternalPbiRecord | null = null;
  let currentSection: "summary" | "dependencies" | "acceptance" | "tasks" | "other" = "summary";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (!sprintName) {
      const sprintHeading = parseHeading(trimmed, 1);
      if (sprintHeading) {
        sprintName = sprintHeading;
        continue;
      }
    }

    const pbiHeading = parsePbiHeading(trimmed);
    if (pbiHeading) {
      currentPbi = {
        id: pbiHeading.id,
        title: pbiHeading.title,
        summaryLines: [],
        dependsOnPbis: [],
        acceptanceCriteria: [],
        tasks: [],
        warnings: []
      };
      pbis.push(currentPbi);
      currentSection = "summary";
      continue;
    }

    if (!currentPbi) continue;

    const subheading = parseHeading(trimmed, 3) ?? parseHeading(trimmed, 4);
    if (subheading) {
      currentSection = sectionFromHeading(subheading);
      continue;
    }

    const listItem = parseListItem(trimmed);
    if (listItem) {
      if (currentSection === "dependencies") {
        currentPbi.dependsOnPbis.push(...extractPbiDependencies(listItem));
        continue;
      }
      if (currentSection === "acceptance") {
        currentPbi.acceptanceCriteria.push(listItem);
        continue;
      }
      if (currentSection === "tasks") {
        currentPbi.tasks.push(parseTaskItem(listItem, index + 1, currentPbi.tasks.length + 1));
        continue;
      }
    }

    if (currentSection === "summary" || currentSection === "other") {
      currentPbi.summaryLines.push(trimmed);
    }
  }

  for (const pbi of pbis) {
    pbi.dependsOnPbis = Array.from(new Set(pbi.dependsOnPbis.map((dependency) => dependency.trim()).filter(Boolean)));
    const knownPbis = new Set(pbis.map((entry) => entry.id.toLowerCase()));
    const unknownPbiDependencies = pbi.dependsOnPbis.filter((dependency) => !knownPbis.has(dependency.toLowerCase()));
    if (unknownPbiDependencies.length > 0) {
      pbi.warnings.push(
        `PBI dependencies not found in sprint file: ${unknownPbiDependencies.join(", ")}.`
      );
    }
    const taskIds = new Set(pbi.tasks.map((task) => task.id));
    for (const task of pbi.tasks) {
      const unknownDependencies = task.dependsOn.filter((dependency) => !taskIds.has(slugifyIdentifier(dependency)));
      if (unknownDependencies.length > 0) {
        pbi.warnings.push(
          `Task ${task.id} references unknown dependencies: ${unknownDependencies.join(", ")}.`
        );
      }
    }
  }

  return {
    sprintName,
    pbis,
    warnings
  };
}

function parseSourceRef(sourceRef: string): SourceRefParts {
  const value = sourceRef.trim();
  if (!value) {
    throw new Error("PBI sourceRef is empty.");
  }
  const doubleColonIndex = value.indexOf("::");
  if (doubleColonIndex >= 0) {
    return {
      sourcePath: value.slice(0, doubleColonIndex).trim(),
      pbiRef: value.slice(doubleColonIndex + 2).trim() || null
    };
  }
  const hashMatch = value.match(/^(.*?\.md)\s*#\s*([A-Za-z0-9._-]+)$/i);
  if (hashMatch) {
    return {
      sourcePath: hashMatch[1]!.trim(),
      pbiRef: hashMatch[2]!.trim()
    };
  }
  return {
    sourcePath: value,
    pbiRef: null
  };
}

function resolveWorkspaceFile(workspacePath: string, sourcePath: string): string {
  const resolvedWorkspace = path.resolve(workspacePath);
  const absolutePath = path.resolve(workspacePath, sourcePath);
  if (absolutePath !== resolvedWorkspace && !absolutePath.startsWith(`${resolvedWorkspace}${path.sep}`)) {
    throw new Error("PBI sourceRef must resolve inside the selected workspace.");
  }
  return absolutePath;
}

function selectPbi(pbis: InternalPbiRecord[], pbiRef: string | null): InternalPbiRecord {
  if (pbiRef) {
    const normalizedRef = pbiRef.trim().toLowerCase();
    const match = pbis.find((pbi) => pbi.id.toLowerCase() === normalizedRef);
    if (!match) {
      throw new Error(`PBI '${pbiRef}' was not found in the sprint file.`);
    }
    return match;
  }
  return pbis[0]!;
}

function parsePbiHeading(line: string): { id: string; title: string } | null {
  const direct = line.match(/^#{2,3}\s+(?:PBI\s+)?([A-Za-z0-9._-]+)\s*[:\-]\s+(.+)$/i);
  if (direct) {
    return {
      id: direct[1]!.trim(),
      title: direct[2]!.trim()
    };
  }
  const bracketed = line.match(/^#{2,3}\s+\[([A-Za-z0-9._-]+)\]\s+(.+)$/);
  if (bracketed) {
    return {
      id: bracketed[1]!.trim(),
      title: bracketed[2]!.trim()
    };
  }
  return null;
}

function parseHeading(line: string, level: number): string | null {
  const match = line.match(new RegExp(`^#{${level}}\\s+(.+)$`));
  return match ? match[1]!.trim() : null;
}

function sectionFromHeading(heading: string): "summary" | "dependencies" | "acceptance" | "tasks" | "other" {
  const normalized = heading.trim().toLowerCase();
  if (
    normalized === "depends on" ||
    normalized === "dependencies" ||
    normalized === "blocked by" ||
    normalized === "upstream dependencies"
  ) {
    return "dependencies";
  }
  if (normalized.startsWith("acceptance")) return "acceptance";
  if (normalized === "tasks" || normalized === "subtasks" || normalized === "work breakdown") return "tasks";
  if (
    normalized === "summary" ||
    normalized === "overview" ||
    normalized === "context" ||
    normalized === "description"
  ) {
    return "summary";
  }
  return "other";
}

function parseListItem(line: string): string | null {
  const checkbox = line.match(/^[-*+]\s+\[[ xX]\]\s+(.*)$/);
  if (checkbox) return checkbox[1]!.trim();
  const bullet = line.match(/^[-*+]\s+(.*)$/);
  if (bullet) return bullet[1]!.trim();
  const numbered = line.match(/^\d+[.)]\s+(.*)$/);
  if (numbered) return numbered[1]!.trim();
  return null;
}

function extractPbiDependencies(value: string): string[] {
  const normalized = value
    .replace(/^pbi\s+/i, "")
    .split(/[,/]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return normalized
    .map((entry) => {
      const match = entry.match(/[A-Za-z0-9._-]+/);
      return match ? match[0]!.trim() : "";
    })
    .filter(Boolean);
}

function parseTaskItem(raw: string, sourceLine: number, fallbackIndex: number): WorkPlanTask {
  let text = raw.replace(/^\[[ xX]\]\s+/, "").trim();
  const explicitTag = text.match(/^\[([A-Za-z]+)\]\s*(.+)$/);
  let roleHint = explicitTag ? inferRoleHint(explicitTag[1]!) : inferRoleHint(text);
  if (explicitTag) {
    text = explicitTag[2]!.trim();
  }

  let dependsOn: string[] = [];
  const dependencyMatch =
    text.match(/\((?:deps?|depends on)\s*[:\-]?\s*([^)]+)\)\s*$/i) ??
    text.match(/\s+(?:deps?|depends on)\s*[:\-]\s*([A-Za-z0-9._,\s-]+)$/i);
  if (dependencyMatch) {
    dependsOn = dependencyMatch[1]!
      .split(/[,\s]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    text = text.slice(0, dependencyMatch.index).trim();
  }

  const idMatch = text.match(/^([A-Z]{2,}[A-Z0-9._-]*|[A-Za-z]{1,8}[-_][A-Za-z0-9._-]+)\s*[:\-]\s+(.+)$/);
  let id = `task-${fallbackIndex}`;
  let title = text;
  if (idMatch) {
    id = slugifyIdentifier(idMatch[1]!);
    title = idMatch[2]!.trim();
    roleHint = roleHint ?? inferRoleHint(idMatch[1]!);
  }

  const lane = laneForRole(roleHint, title);
  return {
    id,
    title,
    description: null,
    laneId: lane.id,
    laneLabel: lane.label,
    roleHint,
    kind: kindForLane(lane.id, title),
    source: "pbi",
    dependsOn,
    sourceLine
  };
}

function templatePlanningTasks(template: MissionTemplate): WorkPlanTask[] {
  return template.nodes.map((node) => {
    const lane = laneForTemplateNode(node.role, node.executor, node.phase ?? null);
    return {
      id: node.id,
      title: node.title,
      description: node.acceptanceCriteria?.join(" ") ?? null,
      laneId: lane.id,
      laneLabel: lane.label,
      roleHint: node.role,
      kind: kindForTemplateNode(node.executor, lane.id),
      source: "template",
      dependsOn: [...(node.dependsOn ?? [])],
      sourceLine: null
    };
  });
}

function templateExecutionSteps(template: MissionTemplate): WorkItemExecutionStep[] {
  return template.nodes.map((node) => ({
    id: node.id,
    title: node.title,
    role: node.role,
    executor: node.executor,
    phase: node.phase ?? null,
    dependsOn: [...(node.dependsOn ?? [])],
    acceptanceCriteria: [...(node.acceptanceCriteria ?? [])]
  }));
}

function synthesizeTemplateLifecycleTasks(
  tasks: WorkPlanTask[],
  sourceType: WorkItemRecord["brief"]["sourceType"],
  context?: {
    summary?: string;
    acceptanceCriteria?: string[];
    constraints?: string[];
  }
): WorkPlanTask[] {
  return ensureExecutionLifecycleTasks(tasks, sourceType, context);
}

function buildBriefDrivenLifecycleTasks(
  workItem: WorkItemRecord,
  template: MissionTemplate
): WorkPlanTask[] {
  if (workItem.brief.sourceType === "audit") {
    return [
      {
        id: "plan_audit_scope",
        title: planningTaskTitleForSourceType("audit"),
        description: "Frame the audit scope, expected evidence, and review focus before findings are generated.",
        laneId: "pm",
        laneLabel: laneById("pm").label,
        roleHint: "pm",
        kind: "planning",
        source: "template",
        dependsOn: [],
        sourceLine: null
      },
      {
        id: "final_audit",
        title: auditTaskTitleForSourceType("audit"),
        description: "Review the requested repo area and return findings without opening an implementation lane.",
        laneId: "audit",
        laneLabel: laneById("audit").label,
        roleHint: "audit",
        kind: "review",
        source: "template",
        dependsOn: ["plan_audit_scope"],
        sourceLine: null
      }
    ];
  }
  const lifecycleSignals = detectLifecycleIntentSignals({
    sourceType: workItem.brief.sourceType,
    summary: workItem.brief.request,
    acceptanceCriteria: workItem.brief.acceptanceCriteria,
    constraints: workItem.brief.constraints
  });
  const workstreamSeeds = deriveImplementationWorkstreamsWithSignals(workItem, lifecycleSignals);
  if (workstreamSeeds.length === 0) {
    return synthesizeTemplateLifecycleTasks(templatePlanningTasks(template), workItem.brief.sourceType, {
      summary: workItem.brief.request,
      acceptanceCriteria: workItem.brief.acceptanceCriteria,
      constraints: workItem.brief.constraints
    });
  }

  const implementationTasks: WorkPlanTask[] = [];
  for (const [index, seed] of workstreamSeeds.entries()) {
    const normalizedTitle = seed.title.trim();
    implementationTasks.push({
      id: uniquePlannerTaskId(
        implementationTasks,
        `${seed.laneId || "developer"}_${slugifyIdentifier(normalizedTitle).slice(0, 32) || `workstream_${index + 1}`}`
      ),
      title: normalizedTitle,
      description: seed.description,
      laneId: seed.laneId,
      laneLabel: laneById(seed.laneId).label,
      roleHint: seed.roleHint,
      kind: "implementation" as const,
      source: "template" as const,
      dependsOn: [],
      sourceLine: null
    } satisfies WorkPlanTask);
  }

  const uniqueImplementationTasks = dedupeImplementationTasks(implementationTasks);
  const needsIntegrationTask =
    uniqueImplementationTasks.length > 1 &&
    new Set(uniqueImplementationTasks.map((task) => task.laneId)).size > 1;
  const withIntegration = needsIntegrationTask
    ? [
        ...uniqueImplementationTasks,
        {
          id: uniquePlannerTaskId(uniqueImplementationTasks, "integrate_workstreams"),
          title: integrationTaskTitleForSourceType(workItem.brief.sourceType),
          description: "Join the parallel implementation tracks into one coherent delivery slice before validation.",
          laneId: "developer",
          laneLabel: laneById("developer").label,
          roleHint: "dev",
          kind: "implementation" as const,
          source: "template" as const,
          dependsOn: uniqueImplementationTasks.map((task) => task.id),
          sourceLine: null
        } satisfies WorkPlanTask
      ]
    : uniqueImplementationTasks;

  return ensureExecutionLifecycleTasks(withIntegration, workItem.brief.sourceType, {
    summary: workItem.brief.request,
    acceptanceCriteria: workItem.brief.acceptanceCriteria,
    constraints: workItem.brief.constraints
  });
}

function deriveImplementationWorkstreams(workItem: WorkItemRecord): Array<{
  title: string;
  description: string | null;
  laneId: string;
  roleHint: string | null;
}> {
  return deriveImplementationWorkstreamsWithSignals(workItem, detectLifecycleIntentSignals({
    sourceType: workItem.brief.sourceType,
    summary: workItem.brief.request,
    acceptanceCriteria: workItem.brief.acceptanceCriteria,
    constraints: workItem.brief.constraints
  }));
}

function deriveImplementationWorkstreamsWithSignals(
  workItem: WorkItemRecord,
  lifecycleSignals: LifecycleIntentSignals
): Array<{
  title: string;
  description: string | null;
  laneId: string;
  roleHint: string | null;
}> {
  const sourceType = workItem.brief.sourceType;
  const criteriaSeeds = workItem.brief.acceptanceCriteria
    .map((criterion) => criterion.trim())
    .filter(Boolean)
    .slice(0, 5);
  const requestSeeds = criteriaSeeds.length > 0 ? [] : extractRequestWorkstreamSeeds(workItem.brief.request);
  const rawSeeds = (criteriaSeeds.length > 0 ? criteriaSeeds : requestSeeds).filter(Boolean);

  if (rawSeeds.length === 0) {
    const fallbackLanes = inferImplementationLanes(
      [workItem.brief.title, workItem.brief.request].filter(Boolean).join("\n"),
      sourceType,
      lifecycleSignals
    );
    return fallbackLanes.map((laneId, index) => ({
      title: implementationTaskTitleFromSeed(defaultImplementationTaskTitle(sourceType), laneId, index + 1),
      description: workItem.brief.request.trim() || null,
      laneId,
      roleHint: roleForImplementationLane(laneId)
    }));
  }

  const seeds: Array<{
    title: string;
    description: string | null;
    laneId: string;
    roleHint: string | null;
  }> = rawSeeds.flatMap((seed, index) => {
    const laneIds = inferImplementationLanes(seed, sourceType, lifecycleSignals);
    return laneIds.map((laneId, laneIndex) => ({
      title: implementationTaskTitleFromSeed(seed, laneId, index + laneIndex + 1),
      description: seed,
      laneId,
      roleHint: roleForImplementationLane(laneId)
    }));
  });

  const requiredLanes: string[] = [];
  if (lifecycleSignals.frontend) requiredLanes.push("frontend");
  if (lifecycleSignals.backend) requiredLanes.push("backend");

  for (const laneId of requiredLanes) {
    if (seeds.some((seed) => seed.laneId === laneId)) continue;
    seeds.push({
      title: implementationTaskTitleFromSeed(workItem.brief.title || workItem.brief.request, laneId, seeds.length + 1),
      description: workItem.brief.request.trim() || null,
      laneId,
      roleHint: roleForImplementationLane(laneId)
    });
  }

  return seeds;
}

function extractRequestWorkstreamSeeds(request: string): string[] {
  const normalizedLines = request
    .split(/\r?\n/)
    .map((line) => parseListItem(line.trim()) ?? line.trim())
    .filter((line) => Boolean(line) && line.length > 8);
  const candidateLines =
    normalizedLines.length >= 2
      ? normalizedLines
      : request
          .split(/(?<=[.!?])\s+/)
          .map((line) => line.trim())
          .filter((line) => Boolean(line) && line.length > 12);
  return candidateLines
    .filter((line) => !/^describe\b/i.test(line))
    .slice(0, 4);
}

function inferImplementationLanes(
  text: string,
  sourceType: WorkItemRecord["brief"]["sourceType"],
  lifecycleSignals?: LifecycleIntentSignals | null
): string[] {
  const normalized = text.trim().toLowerCase();
  const frontendOnly = /\b(frontend-only|ui-only|client-only|visual-only)\b/.test(normalized);
  const backendOnly = /\b(backend-only|server-only|api-only|service-only|data-only)\b/.test(normalized);
  const frontend = !backendOnly && (
    frontendOnly ||
    /\b(ui|ux|page|screen|layout|modal|dialog|component|button|form|client|frontend|browser|view|dashboard)\b/.test(normalized)
  );
  const backend = !frontendOnly && (
    backendOnly ||
    /\b(api|server|backend|database|db|schema|migration|query|endpoint|auth|worker|service|repository|webhook|queue)\b/.test(normalized)
  );
  if (frontend && backend) return ["frontend", "backend"];
  if (frontend) return ["frontend"];
  if (backend) return ["backend"];
  if (lifecycleSignals?.frontend && lifecycleSignals?.backend) return ["frontend", "backend"];
  if (lifecycleSignals?.frontend) return ["frontend"];
  if (lifecycleSignals?.backend) return ["backend"];
  if (sourceType === "bug" && /\b(crash|error|exception|regression|fix)\b/.test(normalized)) {
    return ["developer"];
  }
  return ["developer"];
}

function implementationTaskTitleFromSeed(seed: string, laneId: string, fallbackIndex: number): string {
  const cleaned = seed
    .replace(/^ensure\s+/i, "")
    .replace(/^support\s+/i, "")
    .replace(/^allow\s+/i, "")
    .replace(/^the\s+/i, "")
    .trim();
  const prefix =
    laneId === "frontend"
      ? "Implement frontend"
      : laneId === "backend"
        ? "Implement backend"
        : "Implement";
  const collapsed = cleaned.replace(/[.:]+$/g, "").trim();
  const body = collapsed.length > 72 ? `${collapsed.slice(0, 69).trim()}...` : collapsed;
  return body ? `${prefix}: ${body}` : `${prefix} workstream ${fallbackIndex}`;
}

function defaultImplementationTaskTitle(sourceType: WorkItemRecord["brief"]["sourceType"]): string {
  switch (sourceType) {
    case "audit":
      return "Inspect requested scope";
    case "bug":
      return "Implement reported bugfix";
    case "pr_hardening":
      return "Apply release hardening changes";
    case "pbi":
      return "Implement PBI scope";
    default:
      return "Implement requested feature";
  }
}

function isBrowserRelevantLifecycle(options: {
  sourceType: WorkItemRecord["brief"]["sourceType"];
  tasks: WorkPlanTask[];
  summary: string;
  acceptanceCriteria: string[];
  constraints: string[];
}): boolean {
  if (options.tasks.some((task) => task.laneId === "qa" || task.qaMode)) return true;
  if (options.tasks.some((task) => task.laneId === "frontend")) return true;
  const signals = detectLifecycleIntentSignals(options);
  return signals.browser;
}

function requiresScenarioGate(options: {
  sourceType: WorkItemRecord["brief"]["sourceType"];
  tasks: WorkPlanTask[];
  summary: string;
  acceptanceCriteria: string[];
  constraints: string[];
}): boolean {
  if (options.tasks.some((task) => task.qaMode === "scenario")) return true;
  const signals = detectLifecycleIntentSignals(options);
  return signals.scenario;
}

function buildValidationContract(options: {
  sourceType: WorkItemRecord["brief"]["sourceType"];
  summary: string;
  acceptanceCriteria: string[];
  constraints: string[];
  tasks: WorkPlanTask[];
  workstreams: WorkItemWorkstream[];
}): WorkItemValidationContract {
  const commands = extractValidationCommands([
    options.summary,
    ...options.acceptanceCriteria,
    ...options.constraints,
    ...options.tasks.map((task) => `${task.title} ${task.description ?? ""}`)
  ]);
  const implementationLaneCount = new Set(
    options.workstreams
      .filter((workstream) => workstream.type === "implement")
      .map((workstream) => workstream.laneId)
  ).size;
  const required = commands.length > 0 || requiresValidationLane({
    sourceType: options.sourceType,
    tasks: options.tasks,
    summary: options.summary,
    acceptanceCriteria: options.acceptanceCriteria,
    constraints: options.constraints,
    implementationLaneCount
  });
  if (commands.length > 0) {
    return {
      required: true,
      source: "explicit",
      commands,
      requirements: commands.map((command) => `Run \`${command}\` and record the outcome before review.`),
      rationale: ["Validation is explicitly required because this cycle names concrete verification commands."]
    };
  }
  if (!required) {
    return {
      required: false,
      source: "not_required",
      commands: [],
      requirements: [],
      rationale: ["No separate validation contract is required for this low-risk cycle."]
    };
  }
  const signals = detectLifecycleIntentSignals(options);
  const requirements = new Set<string>();
  if (signals.backend || signals.api || signals.data) {
    requirements.add("Verify the affected backend/API path with the workspace validation command before review.");
  }
  if (signals.browser) {
    requirements.add("Verify the user-facing flow before the cycle can be reviewed.");
  }
  if (implementationLaneCount > 1) {
    requirements.add("Run validation after the implementation lanes have been integrated into one delivery slice.");
  }
  if (options.sourceType === "bug") {
    requirements.add("Prove the reported regression is fixed with explicit validation evidence.");
  }
  if (options.sourceType === "pr_hardening") {
    requirements.add("Record release-hardening validation evidence before operator review.");
  }
  return {
    required: true,
    source: "risk_based",
    commands: [],
    requirements: Array.from(requirements),
    rationale: ["Validation is required because this cycle carries enough product or integration risk to need explicit verification."]
  };
}

function buildAuditRisk(options: {
  sourceType: WorkItemRecord["brief"]["sourceType"];
  summary: string;
  acceptanceCriteria: string[];
  constraints: string[];
  workstreams: WorkItemWorkstream[];
  gates: WorkItemGate[];
  validationContract: WorkItemValidationContract;
  teamSelection: WorkItemTeamSelectionLane[];
}): WorkItemAuditRisk {
  const normalized = [options.summary, ...options.acceptanceCriteria, ...options.constraints].join("\n").toLowerCase();
  const implementLaneCount = new Set(
    options.workstreams.filter((workstream) => workstream.type === "implement").map((workstream) => workstream.laneId)
  ).size;
  const reasons: string[] = [];
  let score = 0;
  if (options.sourceType === "pr_hardening") {
    score += 3;
    reasons.push("Release hardening cycles are treated as high-audit-risk by default.");
  }
  if (implementLaneCount > 1 || options.workstreams.some((workstream) => workstream.type === "integrate")) {
    score += 2;
    reasons.push("Cross-lane implementation and integration increase the review surface.");
  }
  if (options.gates.some((gate) => gate.type === "qa_scenario")) {
    score += 1;
    reasons.push("Browser Scenario coverage indicates a user-critical flow that needs stronger audit attention.");
  }
  if (options.validationContract.required) {
    score += options.validationContract.source === "explicit" ? 2 : 1;
    reasons.push(
      options.validationContract.source === "explicit"
        ? "This cycle names explicit validation commands that the audit must verify."
        : "This cycle needs explicit validation evidence before the operator should trust it."
    );
  }
  if (/\b(auth|security|permission|secret|token|payment|billing|migration|schema|database|rollback|compliance)\b/.test(normalized)) {
    score += 2;
    reasons.push("The change touches a sensitive area such as auth, data, migration, or security.");
  }
  const missingSelectedCoverage = options.teamSelection.filter((selection) => selection.required && selection.decision === "missing");
  if (missingSelectedCoverage.length > 0) {
    score += 2;
    reasons.push(`Missing specialist coverage remains on ${missingSelectedCoverage.map((entry) => entry.laneLabel).join(", ")}.`);
  }

  const level = score >= 5 ? "high" : score >= 2 ? "medium" : "low";
  if (reasons.length === 0) {
    reasons.push(
      level === "low"
        ? "The cycle stays narrow enough for a lightweight operator audit."
        : "The cycle still needs an operator-facing audit before review."
    );
  }
  return {
    level,
    reasons
  };
}

function extractValidationCommands(parts: string[]): string[] {
  const commandPatterns = [
    /`((?:npm|pnpm|yarn|bun)\s+run\s+[a-z0-9:_-]+)`/gi,
    /`((?:npm|pnpm|yarn|bun)\s+(?:test|lint|build))`/gi,
    /`(tsc\s+-p\s+[^\s`]+)`/gi,
    /`(vitest(?:\s+[^\s`]+)*)`/gi,
    /\b((?:npm|pnpm|yarn|bun)\s+run\s+[a-z0-9:_-]+)\b/gi,
    /\b((?:npm|pnpm|yarn|bun)\s+(?:test|lint|build))\b/gi,
    /\b(tsc\s+-p\s+[^\s]+)\b/gi,
    /\b(vitest(?:\s+[^\s]+)*)\b/gi
  ];
  const matches: Array<{ command: string; position: number }> = [];
  for (const part of parts) {
    for (const pattern of commandPatterns) {
      for (const match of part.matchAll(pattern)) {
        const command = match[1]?.trim();
        if (!command) continue;
        matches.push({
          command,
          position: match.index ?? Number.MAX_SAFE_INTEGER
        });
      }
    }
  }
  matches.sort((left, right) => left.position - right.position);
  const seen = new Set<string>();
  const commands: string[] = [];
  for (const match of matches) {
    if (seen.has(match.command)) continue;
    seen.add(match.command);
    commands.push(match.command);
    if (commands.length >= 6) break;
  }
  return commands;
}

function requiresValidationLane(options: {
  sourceType: WorkItemRecord["brief"]["sourceType"];
  tasks: WorkPlanTask[];
  summary: string;
  acceptanceCriteria: string[];
  constraints: string[];
  implementationLaneCount: number;
}): boolean {
  if (options.tasks.some((task) => task.kind === "validation" || task.laneId === "tester")) return true;
  const signals = detectLifecycleIntentSignals(options);
  const normalized = [options.summary, ...options.acceptanceCriteria, ...options.constraints].join("\n").toLowerCase();
  const explicitValidationRequested =
    /\b(npm test|pnpm test|yarn test|bun test|vitest|jest|typecheck|tsc|lint|build|validate|validation|verify|verification|unit test|integration test|contract test|regression test)\b/.test(normalized);
  if (explicitValidationRequested) return true;
  if (options.sourceType === "bug" || options.sourceType === "pr_hardening") return true;
  if (options.implementationLaneCount > 1) return true;
  if (options.acceptanceCriteria.length > 0 && (signals.api || signals.data || signals.browser || signals.backend)) {
    return true;
  }
  return false;
}

function integrationTaskTitleForSourceType(sourceType: WorkItemRecord["brief"]["sourceType"]): string {
  switch (sourceType) {
    case "bug":
      return "Integrate bugfix workstreams";
    case "pr_hardening":
      return "Integrate hardening workstreams";
    case "pbi":
      return "Integrate PBI workstreams";
    default:
      return "Integrate feature workstreams";
  }
}

function roleForImplementationLane(laneId: string): string {
  if (laneId === "frontend") return "frontend";
  if (laneId === "backend") return "backend";
  return "dev";
}

function dedupeImplementationTasks(tasks: WorkPlanTask[]): WorkPlanTask[] {
  const seen = new Set<string>();
  const deduped: WorkPlanTask[] = [];
  for (const task of tasks) {
    const key = `${task.laneId}:${task.title.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(task);
  }
  return deduped;
}

function ensureExecutionLifecycleTasks(
  tasks: WorkPlanTask[],
  sourceType: WorkItemRecord["brief"]["sourceType"],
  context?: {
    summary?: string;
    acceptanceCriteria?: string[];
    constraints?: string[];
  }
): WorkPlanTask[] {
  const nextTasks: WorkPlanTask[] = tasks.map((task): WorkPlanTask => ({
    ...task,
    dependsOn: [...task.dependsOn],
    gateRefs: [...(task.gateRefs ?? [])],
    cycleId: task.cycleId ?? null,
    ownerAgentId: task.ownerAgentId ?? null,
    ownerAgentName: task.ownerAgentName ?? null,
    ownerRole: task.ownerRole ?? null
  }));

  const planningTasks = nextTasks.filter((task) => task.kind === "planning" || task.laneId === "pm");
  if (planningTasks.length === 0) {
    const planTaskId = uniquePlannerTaskId(nextTasks, "plan_cycle");
    const planTask: WorkPlanTask = {
      id: planTaskId,
      title: planningTaskTitleForSourceType(sourceType),
      description: "Frame scope, acceptance criteria, and delivery order before implementation begins.",
      laneId: "pm",
      laneLabel: laneById("pm").label,
      roleHint: "pm",
      kind: "planning",
      source: "template",
      dependsOn: [],
      sourceLine: null
    };
    for (let index = 0; index < nextTasks.length; index += 1) {
      const task = nextTasks[index]!;
      if (task.laneId === "pm" || task.kind === "planning") continue;
      if (task.dependsOn.length === 0) {
        nextTasks[index] = {
          ...task,
          dependsOn: [planTaskId]
        };
      }
    }
    nextTasks.unshift(planTask);
  }

  const implementationTasks = nextTasks.filter((task) =>
    task.kind === "implementation" &&
    task.laneId !== "pm" &&
    task.laneId !== "tester" &&
    task.laneId !== "qa" &&
    task.laneId !== "audit"
  );

  const integrationTaskIds = implementationTasks
    .filter((task) => isIntegrationTask(task))
    .map((task) => task.id);

  const implementationTaskIds =
    integrationTaskIds.length > 0
      ? integrationTaskIds
      : implementationTasks.map((task) => task.id);
  const planningTaskIds = nextTasks
    .filter((task) => task.kind === "planning" || task.laneId === "pm")
    .map((task) => task.id);
  const browserRelevant = isBrowserRelevantLifecycle({
    sourceType,
    tasks: nextTasks,
    summary: context?.summary ?? "",
    acceptanceCriteria: context?.acceptanceCriteria ?? [],
    constraints: context?.constraints ?? []
  });
  const scenarioRequired = browserRelevant && requiresScenarioGate({
    sourceType,
    tasks: nextTasks,
    summary: context?.summary ?? "",
    acceptanceCriteria: context?.acceptanceCriteria ?? [],
    constraints: context?.constraints ?? []
  });

  const implementationLanes = new Set(
    implementationTasks
      .filter((task) => !isIntegrationTask(task))
      .map((task) => task.laneId)
  );
  const validationRequired = requiresValidationLane({
    sourceType,
    tasks: nextTasks,
    summary: context?.summary ?? "",
    acceptanceCriteria: context?.acceptanceCriteria ?? [],
    constraints: context?.constraints ?? [],
    implementationLaneCount: implementationLanes.size
  });

  if (implementationLanes.size > 1 && integrationTaskIds.length === 0) {
    const integrateTaskId = uniquePlannerTaskId(nextTasks, "integrate_workstreams");
    nextTasks.push({
      id: integrateTaskId,
      title: integrationTaskTitleForSourceType(sourceType),
      description: "Merge the parallel implementation tracks into one reviewable delivery slice before validation.",
      laneId: "developer",
      laneLabel: laneById("developer").label,
      roleHint: "dev",
      kind: "implementation",
      source: "template",
      dependsOn: implementationTasks.filter((task) => !isIntegrationTask(task)).map((task) => task.id),
      sourceLine: null
    });
    implementationTaskIds.splice(0, implementationTaskIds.length, integrateTaskId);
  }

  let validationTaskIds = nextTasks
    .filter((task) => task.kind === "validation" || task.laneId === "tester")
    .map((task) => task.id);
  if (validationTaskIds.length === 0 && validationRequired && implementationTaskIds.length > 0) {
    const validationTaskId = uniquePlannerTaskId(nextTasks, "validation_pass");
    nextTasks.push({
      id: validationTaskId,
      title: validationTaskTitleForSourceType(sourceType),
      description: "Run the configured verification checks and capture the actual outcome before QA.",
      laneId: "tester",
      laneLabel: laneById("tester").label,
      roleHint: "tester",
      kind: "validation",
      source: "template",
      dependsOn: [...implementationTaskIds],
      sourceLine: null
    });
    validationTaskIds = [validationTaskId];
  }

  let qaSmokeTaskIds = nextTasks
    .filter((task) => (task.kind === "qa" || task.laneId === "qa") && (task.qaMode ?? "smoke") === "smoke")
    .map((task) => task.id);
  if (
    qaSmokeTaskIds.length === 0 &&
    browserRelevant &&
    (
      validationTaskIds.length > 0 ||
      implementationTaskIds.length > 0 ||
      (sourceType === "audit" && planningTaskIds.length > 0)
    )
  ) {
    const qaTaskId = uniquePlannerTaskId(nextTasks, "browser_smoke");
    const reviewInsertIndex = nextTasks.findIndex((task) => task.kind === "review" || task.laneId === "audit");
    const qaTask: WorkPlanTask = {
      id: qaTaskId,
      title: qaTaskTitleForSourceType(sourceType),
      description: "Verify the changed behavior in a browser-level flow and capture evidence before final audit.",
      laneId: "qa",
      laneLabel: laneById("qa").label,
      roleHint: "qa",
      kind: "qa",
      source: "template",
      dependsOn: validationTaskIds.length > 0
        ? [...validationTaskIds]
        : implementationTaskIds.length > 0
          ? [...implementationTaskIds]
          : [...planningTaskIds],
      sourceLine: null,
      qaMode: "smoke"
    };
    if (reviewInsertIndex < 0) {
      nextTasks.push(qaTask);
    } else {
      nextTasks.splice(reviewInsertIndex, 0, qaTask);
    }
    qaSmokeTaskIds = [qaTaskId];
  }

  let qaScenarioTaskIds = nextTasks
    .filter((task) => (task.kind === "qa" || task.laneId === "qa") && task.qaMode === "scenario")
    .map((task) => task.id);
  if (
    qaScenarioTaskIds.length === 0 &&
    scenarioRequired &&
    (
      qaSmokeTaskIds.length > 0 ||
      validationTaskIds.length > 0 ||
      implementationTaskIds.length > 0 ||
      (sourceType === "audit" && planningTaskIds.length > 0)
    )
  ) {
    const qaScenarioTaskId = uniquePlannerTaskId(nextTasks, "browser_scenario");
    const reviewInsertIndex = nextTasks.findIndex((task) => task.kind === "review" || task.laneId === "audit");
    const qaScenarioTask: WorkPlanTask = {
      id: qaScenarioTaskId,
      title: qaScenarioTaskTitleForSourceType(sourceType),
      description: "Run an assertion-driven browser scenario and produce an explicit gate verdict before audit.",
      laneId: "qa",
      laneLabel: laneById("qa").label,
      roleHint: "qa",
      kind: "qa",
      source: "template",
      dependsOn: qaSmokeTaskIds.length > 0
        ? [...qaSmokeTaskIds]
        : validationTaskIds.length > 0
          ? [...validationTaskIds]
          : implementationTaskIds.length > 0
            ? [...implementationTaskIds]
            : [...planningTaskIds],
      sourceLine: null,
      qaMode: "scenario"
    };
    if (reviewInsertIndex < 0) {
      nextTasks.push(qaScenarioTask);
    } else {
      nextTasks.splice(reviewInsertIndex, 0, qaScenarioTask);
    }
    qaScenarioTaskIds = [qaScenarioTaskId];
  }

  const reviewTaskIds = nextTasks
    .filter((task) => task.kind === "review" || task.laneId === "audit")
    .map((task) => task.id);
  if (reviewTaskIds.length === 0 && (qaScenarioTaskIds.length > 0 || qaSmokeTaskIds.length > 0 || validationTaskIds.length > 0 || implementationTaskIds.length > 0)) {
    nextTasks.push({
      id: uniquePlannerTaskId(nextTasks, "final_audit"),
      title: auditTaskTitleForSourceType(sourceType),
      description: "Review the delivered change, validation evidence, and residual risks before human approval.",
      laneId: "audit",
      laneLabel: laneById("audit").label,
      roleHint: "audit",
      kind: "review",
      source: "template",
      dependsOn:
        qaScenarioTaskIds.length > 0
          ? [...qaScenarioTaskIds]
          : qaSmokeTaskIds.length > 0
            ? [...qaSmokeTaskIds]
            : validationTaskIds.length > 0
              ? [...validationTaskIds]
              : [...implementationTaskIds],
      sourceLine: null
    });
  } else if (qaScenarioTaskIds.length > 0 || qaSmokeTaskIds.length > 0) {
    const reviewTaskIdSet = new Set(reviewTaskIds);
    const upstreamQaTaskIds = qaScenarioTaskIds.length > 0 ? qaScenarioTaskIds : qaSmokeTaskIds;
    for (let index = 0; index < nextTasks.length; index += 1) {
      const task = nextTasks[index]!;
      if (!reviewTaskIdSet.has(task.id)) continue;
      nextTasks[index] = {
        ...task,
        dependsOn: mergeUnique(task.dependsOn, upstreamQaTaskIds)
      };
    }
  }

  return nextTasks;
}

function planningTaskTitleForSourceType(sourceType: WorkItemRecord["brief"]["sourceType"]): string {
  switch (sourceType) {
    case "audit":
      return "Frame audit scope";
    case "bug":
      return "Frame bug remediation plan";
    case "pr_hardening":
      return "Frame hardening plan";
    case "pbi":
      return "Frame PBI execution plan";
    default:
      return "Frame implementation plan";
  }
}

function validationTaskTitleForSourceType(sourceType: WorkItemRecord["brief"]["sourceType"]): string {
  switch (sourceType) {
    case "audit":
      return "Run audit evidence validation";
    case "bug":
      return "Run bugfix validation";
    case "pr_hardening":
      return "Run release validation";
    case "pbi":
      return "Run PBI validation";
    default:
      return "Run implementation validation";
  }
}

function qaTaskTitleForSourceType(sourceType: WorkItemRecord["brief"]["sourceType"]): string {
  switch (sourceType) {
    case "audit":
      return "Run audit browser smoke";
    case "bug":
      return "Run browser regression QA";
    case "pr_hardening":
      return "Run release candidate QA";
    case "pbi":
      return "Run backlog browser smoke";
    default:
      return "Run browser smoke";
  }
}

function qaScenarioTaskTitleForSourceType(sourceType: WorkItemRecord["brief"]["sourceType"]): string {
  switch (sourceType) {
    case "audit":
      return "Run audit browser scenario gate";
    case "bug":
      return "Run browser scenario regression gate";
    case "pr_hardening":
      return "Run release candidate browser scenario";
    case "pbi":
      return "Run backlog browser scenario gate";
    default:
      return "Run browser scenario gate";
  }
}

function isIntegrationTask(task: WorkPlanTask): boolean {
  const normalized = `${task.id} ${task.title}`.trim().toLowerCase();
  return /\bintegrat(e|ion)\b/.test(normalized) || normalized.includes("integrate_workstreams");
}

function buildWorkstreamPlan(options: {
  tasks: WorkPlanTask[];
  teamAssignments: WorkPlanLaneAssignment[];
}): {
  tasks: WorkPlanTask[];
  workstreams: WorkItemWorkstream[];
  gates: WorkItemGate[];
  qaCoverage: "none" | "scenario";
} {
  const streams: Array<{
    id: string;
    type: WorkItemWorkstream["type"];
    title: string;
    description?: string | null;
    laneId: string;
    laneLabel: string;
    taskIds: string[];
  }> = [];

  const planningTasks = options.tasks.filter((task) => task.kind === "planning" || task.laneId === "pm");
  if (planningTasks.length > 0) {
    streams.push({
      id: "stream-plan",
      type: "plan",
      title: "Planner workstream",
      description: "Scope, ordering, and execution framing before implementation.",
      laneId: "pm",
      laneLabel: laneById("pm").label,
      taskIds: planningTasks.map((task) => task.id)
    });
  }

  const implementationGroups = new Map<string, WorkPlanTask[]>();
  for (const task of options.tasks) {
    if (task.kind !== "implementation") continue;
    if (task.laneId === "pm" || task.laneId === "tester" || task.laneId === "qa" || task.laneId === "audit") continue;
    const streamType = isIntegrationTask(task) ? "integrate" : "implement";
    const groupKey = streamType === "integrate" ? "integrate" : `${streamType}:${task.laneId}`;
    const bucket = implementationGroups.get(groupKey) ?? [];
    bucket.push(task);
    implementationGroups.set(groupKey, bucket);
  }

  for (const [groupKey, groupTasks] of implementationGroups.entries()) {
    const first = groupTasks[0]!;
    const type = groupKey === "integrate" ? "integrate" : "implement";
    const laneId = groupKey === "integrate" ? "developer" : first.laneId;
    const laneLabel = laneById(laneId).label;
    streams.push({
      id: `stream-${slugifyIdentifier(groupKey)}`,
      type,
      title:
        type === "integrate"
          ? "Integration workstream"
          : `${laneLabel} workstream`,
      description:
        type === "integrate"
          ? "Join the parallel implementation work into one coherent delivery slice."
          : `Own the ${laneLabel.toLowerCase()} implementation slice for this cycle.`,
      laneId,
      laneLabel,
      taskIds: groupTasks.map((task) => task.id)
    });
  }

  const validationTasks = options.tasks.filter((task) => task.kind === "validation" || task.laneId === "tester");
  if (validationTasks.length > 0) {
    streams.push({
      id: "stream-validate",
      type: "validate",
      title: "Validation workstream",
      description: "Run the required verification commands and capture explicit outcomes.",
      laneId: "tester",
      laneLabel: laneById("tester").label,
      taskIds: validationTasks.map((task) => task.id)
    });
  }

  const qaSmokeTasks = options.tasks.filter((task) => (task.kind === "qa" || task.laneId === "qa") && (task.qaMode ?? "smoke") === "smoke");
  if (qaSmokeTasks.length > 0) {
    streams.push({
      id: "stream-qa-smoke",
      type: "qa_smoke",
      title: "Browser Smoke workstream",
      description: "Capture fast browser evidence before the scenario gate.",
      laneId: "qa",
      laneLabel: laneById("qa").label,
      taskIds: qaSmokeTasks.map((task) => task.id)
    });
  }

  const qaScenarioTasks = options.tasks.filter((task) => (task.kind === "qa" || task.laneId === "qa") && task.qaMode === "scenario");
  if (qaScenarioTasks.length > 0) {
    streams.push({
      id: "stream-qa-scenario",
      type: "qa_scenario",
      title: "Browser Scenario gate",
      description: "Run assertion-driven browser steps and produce a review gate verdict.",
      laneId: "qa",
      laneLabel: laneById("qa").label,
      taskIds: qaScenarioTasks.map((task) => task.id)
    });
  }

  const auditTasks = options.tasks.filter((task) => task.kind === "review" || task.laneId === "audit");
  if (auditTasks.length > 0) {
    streams.push({
      id: "stream-audit",
      type: "audit",
      title: "Audit workstream",
      description: "Review readiness, residual risk, and evidence before human approval.",
      laneId: "audit",
      laneLabel: laneById("audit").label,
      taskIds: auditTasks.map((task) => task.id)
    });
  }

  const taskToStreamId = new Map<string, string>();
  for (const stream of streams) {
    for (const taskId of stream.taskIds) {
      taskToStreamId.set(taskId, stream.id);
    }
  }

  const gates: WorkItemGate[] = [];
  if (streams.some((stream) => stream.type === "validate")) {
    gates.push({
      id: "gate-validation",
      type: "validation",
      label: "Validation",
      required: true,
      workstreamIds: streams.filter((stream) => stream.type === "validate").map((stream) => stream.id)
    });
  }
  if (streams.some((stream) => stream.type === "qa_scenario")) {
    gates.push({
      id: "gate-qa-scenario",
      type: "qa_scenario",
      label: "Browser Scenario",
      required: true,
      workstreamIds: streams.filter((stream) => stream.type === "qa_scenario").map((stream) => stream.id)
    });
  }
  if (streams.some((stream) => stream.type === "audit")) {
    gates.push({
      id: "gate-audit",
      type: "audit",
      label: "Audit",
      required: true,
      workstreamIds: streams.filter((stream) => stream.type === "audit").map((stream) => stream.id)
    });
  }

  const gateRefsByStreamId = new Map<string, string[]>();
  for (const gate of gates) {
    for (const streamId of gate.workstreamIds) {
      const bucket = gateRefsByStreamId.get(streamId) ?? [];
      bucket.push(gate.id);
      gateRefsByStreamId.set(streamId, bucket);
    }
  }

  const streamRecords: WorkItemWorkstream[] = streams.map((stream) => {
    const dependencyIds = new Set<string>();
    for (const taskId of stream.taskIds) {
      const task = options.tasks.find((candidate) => candidate.id === taskId);
      for (const dependency of task?.dependsOn ?? []) {
        const dependencyStreamId = taskToStreamId.get(dependency);
        if (dependencyStreamId && dependencyStreamId !== stream.id) {
          dependencyIds.add(dependencyStreamId);
        }
      }
    }
    const assignment = options.teamAssignments.find((candidate) => candidate.laneId === stream.laneId);
    return {
      id: stream.id,
      type: stream.type,
      title: stream.title,
      description: stream.description ?? null,
      laneId: stream.laneId,
      laneLabel: stream.laneLabel,
      taskIds: [...stream.taskIds],
      dependsOn: Array.from(dependencyIds),
      gateRefs: [...(gateRefsByStreamId.get(stream.id) ?? [])],
      ownerAgentId: assignment?.matches[0]?.id ?? null,
      ownerAgentName: assignment?.matches[0]?.name ?? null,
      ownerRole: assignment?.preferredRole ?? null
    };
  });

  const annotatedTasks = options.tasks.map((task) => {
    const workstreamId = taskToStreamId.get(task.id) ?? null;
    const workstream = workstreamId ? streamRecords.find((candidate) => candidate.id === workstreamId) ?? null : null;
    return {
      ...task,
      workstreamId,
      workstreamType: workstream?.type ?? null,
      gateRefs: workstream?.gateRefs ?? [],
      qaMode: task.kind === "qa" || task.laneId === "qa" ? task.qaMode ?? "smoke" : null,
      ownerAgentId: workstream?.ownerAgentId ?? null,
      ownerAgentName: workstream?.ownerAgentName ?? null,
      ownerRole: workstream?.ownerRole ?? null
    };
  });

  return {
    tasks: annotatedTasks,
    workstreams: streamRecords,
    gates,
    qaCoverage: streamRecords.some((stream) => stream.type === "qa_scenario") ? "scenario" : "none"
  };
}

function auditTaskTitleForSourceType(sourceType: WorkItemRecord["brief"]["sourceType"]): string {
  switch (sourceType) {
    case "audit":
      return "Produce audit findings";
    case "bug":
      return "Audit bugfix readiness";
    case "pr_hardening":
      return "Audit release readiness";
    case "pbi":
      return "Audit PBI delivery";
    default:
      return "Audit implementation";
  }
}

function uniquePlannerTaskId(tasks: WorkPlanTask[], baseId: string): string {
  if (!tasks.some((task) => task.id === baseId)) return baseId;
  let index = 2;
  while (tasks.some((task) => task.id === `${baseId}_${index}`)) {
    index += 1;
  }
  return `${baseId}_${index}`;
}

function templateSummary(template: MissionTemplate) {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    recommendedRoles: [...(template.recommendedRoles ?? [])],
    outcomes: [...(template.outcomes ?? [])]
  };
}

async function loadWorkspaceAgents(workspacePath: string): Promise<WorkspaceAgentRecord[]> {
  const agentsPath = getWorkspaceAgentsPath(workspacePath);
  const raw = await fs.readFile(agentsPath, "utf8").catch(() => "[]");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((entry) => normalizeWorkspaceAgent(entry))
    .filter((entry): entry is WorkspaceAgentRecord => entry !== null);
}

function buildTeamAssignmentsForLanes(
  lanes: WorkPlanLane[],
  agents: WorkspaceAgentRecord[]
): WorkPlanLaneAssignment[] {
  return lanes.map((lane) => buildTeamAssignmentForLane(lane, agents));
}

function normalizeWorkspaceAgent(input: unknown): WorkspaceAgentRecord | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!role || !name) return null;
  const profile = record.profile && typeof record.profile === "object"
    ? record.profile as Record<string, unknown>
    : {};
  const status = record.status && typeof record.status === "object"
    ? record.status as Record<string, unknown>
    : {};
  return {
    id: typeof record.id === "string" ? record.id : `${role}-${name}`,
    name,
    role,
    tags: Array.isArray(record.tags)
      ? record.tags.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
      : [],
    profile: {
      specialization:
        typeof profile.specialization === "string" && profile.specialization.trim()
          ? profile.specialization.trim()
          : role === "pm"
            ? "pm"
            : role === "audit"
              ? "audit"
              : "fullstack",
      seniority:
        typeof profile.seniority === "string" && profile.seniority.trim()
          ? profile.seniority.trim().toLowerCase()
          : "mid",
      maxParallelWork:
        typeof profile.maxParallelWork === "number" && profile.maxParallelWork > 0
          ? Math.max(1, Math.floor(profile.maxParallelWork))
          : 1
    },
    status: {
      state: typeof status.state === "string" && status.state.trim() ? status.state.trim().toLowerCase() : "idle"
    }
  };
}

function buildTeamAssignmentForLane(lane: WorkPlanLane, agents: WorkspaceAgentRecord[]): WorkPlanLaneAssignment {
  const preference = preferenceForLane(lane.id);
  const ranked = agents
    .map((agent) => ({ agent, score: scoreAgentForLane(agent, lane.id, preference) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.agent.name.localeCompare(right.agent.name);
    })
    .slice(0, 3);

  const coverage =
    ranked.length === 0
      ? "missing"
      : ranked.some((entry) => isStrongLaneMatch(entry.agent, preference))
        ? "strong"
        : "fallback";

  const note =
    coverage === "missing"
      ? `No ${lane.label.toLowerCase()} specialist is configured for this workspace yet.`
      : coverage === "fallback"
        ? `${lane.label} can be covered by a generalist or adjacent specialist, but a dedicated agent would route more cleanly.`
        : null;

  return {
    laneId: lane.id,
    laneLabel: lane.label,
    preferredRole: preference.preferredRole,
    preferredSpecializations: preference.preferredSpecializations,
    coverage,
    note,
    matches: ranked.map(({ agent, score }) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      specialization: agent.profile.specialization,
      seniority: agent.profile.seniority,
      maxParallelWork: agent.profile.maxParallelWork,
      state: agent.status.state,
      score
    }))
  };
}

function buildTeamSelection(options: {
  workspaceAgents: WorkspaceAgentRecord[];
  activeLanes: WorkPlanLane[];
  workstreams: WorkItemWorkstream[];
  gates: WorkItemGate[];
  teamAssignments: WorkPlanLaneAssignment[];
  summary: string;
  acceptanceCriteria: string[];
  constraints: string[];
  sourceType: WorkItemRecord["brief"]["sourceType"];
}): {
  teamSelection: WorkItemTeamSelectionLane[];
  omittedLanes: string[];
  missingCapabilities: string[];
  selectionRationale: string[];
} {
  const lifecycleSignals = detectLifecycleIntentSignals({
    sourceType: options.sourceType,
    summary: options.summary,
    acceptanceCriteria: options.acceptanceCriteria,
    constraints: options.constraints,
    tasks: options.workstreams.flatMap((workstream) => workstream.title ? [{
      id: workstream.id,
      title: workstream.title,
      description: workstream.description ?? null,
      laneId: workstream.laneId,
      laneLabel: workstream.laneLabel,
      kind: workstream.type === "validate" ? "validation" : workstream.type === "qa_smoke" || workstream.type === "qa_scenario" ? "qa" : workstream.type === "audit" ? "review" : workstream.type === "plan" ? "planning" : "implementation",
      source: "template" as const,
      dependsOn: [...workstream.dependsOn]
    }] : [])
  });
  const assignmentByLane = new Map(options.teamAssignments.map((assignment) => [assignment.laneId, assignment]));
  const activeLaneIds = new Set(options.activeLanes.map((lane) => lane.id));
  const workstreamsByLane = new Map<string, WorkItemWorkstream[]>();
  for (const workstream of options.workstreams) {
    const bucket = workstreamsByLane.get(workstream.laneId) ?? [];
    bucket.push(workstream);
    workstreamsByLane.set(workstream.laneId, bucket);
  }
  const selection = LANE_DEFINITIONS.map((lane) => {
    const assignment = assignmentByLane.get(lane.id) ?? buildTeamAssignmentForLane(lane, options.workspaceAgents);
    const laneWorkstreams = workstreamsByLane.get(lane.id) ?? [];
    const expectedWorkstreams = laneWorkstreams.map((entry) => entry.id);
    const expectedGates = options.gates
      .filter((gate) => gate.workstreamIds.some((workstreamId) => expectedWorkstreams.includes(workstreamId)))
      .map((gate) => gate.id);
    const chosen = assignment.matches[0] ?? null;
    const required = activeLaneIds.has(lane.id) || expectedWorkstreams.length > 0 || expectedGates.length > 0;
    const hasMatch = assignment.matches.length > 0;
    const decision: WorkItemTeamSelectionLane["decision"] =
      required
        ? hasMatch
          ? "selected"
          : "missing"
        : hasMatch
          ? "standby"
          : "omitted";
    return {
      laneId: lane.id,
      laneLabel: lane.label,
      required,
      decision,
      preferredRole: assignment.preferredRole,
      preferredSpecializations: [...assignment.preferredSpecializations],
      selectionReason:
        decision === "selected"
          ? buildLaneSelectionReason(lane, assignment, laneWorkstreams)
          : decision === "missing"
            ? `${lane.label} is part of the minimal team, but no matching specialist is configured in this workspace.`
            : null,
      omissionReason:
        decision === "selected" || decision === "missing"
          ? null
          : buildLaneOmissionReason({
              laneId: lane.id,
              summary: options.summary,
              acceptanceCriteria: options.acceptanceCriteria,
              constraints: options.constraints,
              sourceType: options.sourceType,
              hasMatch,
              lifecycleSignals
            }),
      chosenAgentId: chosen?.id ?? null,
      chosenAgentName: chosen?.name ?? null,
      chosenRole: chosen?.role ?? assignment.preferredRole,
      fallbackAgentId: assignment.coverage === "fallback" ? chosen?.id ?? null : null,
      fallbackReason:
        assignment.coverage === "fallback" && chosen
          ? `${chosen.name} is covering ${lane.label.toLowerCase()} as a fallback specialist.`
          : null,
      expectedWorkstreams,
      expectedGates,
      matches: assignment.matches.map((match) => ({ ...match }))
    };
  });

  const omittedLanes = selection
    .filter((entry) => entry.decision === "standby" || entry.decision === "omitted")
    .map((entry) => entry.laneId);
  const missingCapabilities = selection
    .filter((entry) => entry.decision === "missing")
    .map((entry) => `${entry.laneLabel}: no matching specialist is configured for this cycle.`);
  const selectionRationale = buildSelectionRationale(selection, lifecycleSignals);

  return {
    teamSelection: selection,
    omittedLanes,
    missingCapabilities,
    selectionRationale
  };
}

function buildLaneSelectionReason(
  lane: WorkPlanLane,
  assignment: WorkPlanLaneAssignment,
  workstreams: WorkItemWorkstream[]
): string {
  const chosen = assignment.matches[0];
  const workstreamSummary = workstreams.length > 0
    ? `${workstreams.length} workstream${workstreams.length === 1 ? "" : "s"}`
    : "an explicit lane requirement";
  if (!chosen) {
    return `${lane.label} is part of the minimal team because this cycle needs ${workstreamSummary}.`;
  }
  if (assignment.coverage === "fallback") {
    return `${lane.label} stays in the minimal team for ${workstreamSummary}, with ${chosen.name} covering it as a fallback ${chosen.specialization} specialist.`;
  }
  return `${lane.label} is part of the minimal team for ${workstreamSummary}, and ${chosen.name} is the strongest available match.`;
}

function buildLaneOmissionReason(options: {
  laneId: string;
  summary: string;
  acceptanceCriteria: string[];
  constraints: string[];
  sourceType: WorkItemRecord["brief"]["sourceType"];
  hasMatch: boolean;
  lifecycleSignals: LifecycleIntentSignals;
}): string {
  switch (options.laneId) {
    case "frontend":
      return options.lifecycleSignals.backend && !options.lifecycleSignals.frontend
        ? "This cycle is backend-only, so no UI or client-facing lane was opened."
        : "No browser, UI, or client-facing surface was detected for this cycle.";
    case "backend":
      return options.lifecycleSignals.frontend && !options.lifecycleSignals.backend
        ? "This cycle stays in the client/browser surface, so no backend lane was opened."
        : "No API, server, or data-flow surface was detected for this cycle.";
    case "developer":
      return "A dedicated integration/generalist lane was not needed for this cycle.";
    case "tester":
      return "This cycle does not require a separate validation specialist lane.";
    case "qa":
      return options.lifecycleSignals.browser
        ? "Browser evidence is available, but this cycle did not require a dedicated QA lane."
        : "No browser or journey-critical surface was detected, so QA stayed out of the minimal team.";
    case "audit":
      return options.hasMatch
        ? "Audit stays on standby until review-time evidence exists."
        : "Audit is not separately staffed in this workspace yet.";
    default:
      return options.hasMatch
        ? `${laneById(options.laneId).label} remains on standby for this cycle.`
        : `${laneById(options.laneId).label} is not needed for this cycle.`;
  }
}

function buildSelectionRationale(selection: WorkItemTeamSelectionLane[], lifecycleSignals: LifecycleIntentSignals): string[] {
  const selected = selection.filter((entry) => entry.decision === "selected");
  const standby = selection.filter((entry) => entry.decision === "standby");
  const missing = selection.filter((entry) => entry.decision === "missing");
  const lines: string[] = [];
  lines.push(...lifecycleSignals.notes);
  if (selected.length > 0) {
    lines.push(`Minimal team: ${selected.map((entry) => entry.laneLabel).join(", ")}.`);
  }
  if (standby.length > 0) {
    lines.push(`Standby coverage: ${standby.map((entry) => entry.laneLabel).join(", ")}.`);
  }
  if (missing.length > 0) {
    lines.push(`Missing specialist coverage: ${missing.map((entry) => entry.laneLabel).join(", ")}.`);
  }
  return lines;
}

function detectLifecycleIntentSignals(options: {
  sourceType: WorkItemRecord["brief"]["sourceType"];
  summary: string;
  acceptanceCriteria: string[];
  constraints: string[];
  tasks?: WorkPlanTask[];
}): LifecycleIntentSignals {
  const normalized = [
    options.summary,
    ...options.acceptanceCriteria,
    ...options.constraints,
    ...(options.tasks ?? []).map((task) => `${task.title} ${task.description ?? ""}`)
  ]
    .join("\n")
    .toLowerCase();
  if (options.sourceType === "audit") {
    const browser = /\b(browser smoke|browser evidence|browser check|browser coverage|browser audit|playwright|e2e|journey|user flow|critical path|visual smoke|smoke run|scenario)\b/.test(normalized);
    const scenario = browser && /\b(playwright|e2e|journey|scenario|assert|critical path|browser gate|scenario gate)\b/.test(normalized);
    const notes = [
      "Audit-only route selected, so the minimal team stays review-focused instead of opening implementation lanes."
    ];
    if (browser) {
      notes.push(
        scenario
          ? "Audit request explicitly asked for browser scenario evidence, so QA can add a gate without opening implementation work."
          : "Audit request explicitly asked for browser evidence, so browser smoke can be added without opening implementation work."
      );
    }
    return {
      frontend: false,
      backend: false,
      browser,
      scenario,
      validation: false,
      api: false,
      data: false,
      notes
    };
  }
  const frontendOnly = /\b(frontend-only|ui-only|client-only|visual-only)\b/.test(normalized);
  const backendOnly = /\b(backend-only|server-only|api-only|service-only|data-only)\b/.test(normalized);
  const noBrowser = /\b(no browser|without browser|non-visual|server-only|backend-only|api-only|headless)\b/.test(normalized);
  const frontend = !backendOnly && (
    frontendOnly ||
    /\b(ui|ux|page|screen|layout|modal|dialog|component|button|form|client|frontend|browser|view|dashboard|navigation|stylesheet|css)\b/.test(normalized)
  );
  const api = /\b(api|endpoint|route|http|rest|graphql|webhook|rpc)\b/.test(normalized);
  const data = /\b(database|db|schema|migration|query|table|column|model|serialization|deserialize|payload)\b/.test(normalized);
  const backend = !frontendOnly && (
    backendOnly ||
    api ||
    data ||
    /\b(server|backend|auth|worker|service|repository|queue|job)\b/.test(normalized)
  );
  const browser = !noBrowser && (
    frontend ||
    /\b(browser|playwright|e2e|journey|user flow|critical path|interaction|click|form submit|visual)\b/.test(normalized)
  );
  const scenario = browser && /\b(playwright|e2e|journey|scenario|assert|user flow|critical path|regression gate|prove it in the browser|browser gate)\b/.test(normalized);
  const validation =
    /\b(npm test|pnpm test|yarn test|bun test|vitest|jest|typecheck|tsc|lint|build|validate|validation|verify|verification|unit test|integration test|contract test|regression test)\b/.test(normalized) ||
    options.sourceType === "bug" ||
    options.sourceType === "pr_hardening";

  const notes: string[] = [];
  if (frontend && backend) {
    notes.push("Detected a cross-stack change touching both UI/client and backend/API surfaces.");
  } else if (backend) {
    notes.push("Detected a backend/API/data-focused change, so the minimal team stays server-heavy.");
  } else if (frontend) {
    notes.push("Detected a UI/client-facing change, so the minimal team stays browser-facing.");
  } else {
    notes.push("No strong surface signal was detected, so the planner falls back to the general development lane.");
  }
  if (browser) {
    notes.push(
      scenario
        ? "Detected browser-critical flow coverage, so Browser Scenario can become a required gate."
        : "Detected browser-facing impact, so browser smoke evidence stays available for this cycle."
    );
  }
  if (validation) {
    notes.push("Detected explicit validation or higher-risk verification needs for this cycle.");
  }

  return {
    frontend,
    backend,
    browser,
    scenario,
    validation,
    api,
    data,
    notes
  };
}

function buildRecommendedMinimalTeam(selection: WorkItemTeamSelectionLane[]): WorkItemMinimalTeamMember[] {
  return selection
    .filter((entry) => entry.decision === "selected" || entry.decision === "missing")
    .map((entry) => ({
      laneId: entry.laneId,
      laneLabel: entry.laneLabel,
      agentId: entry.chosenAgentId ?? null,
      agentName: entry.chosenAgentName ?? null,
      role: entry.chosenRole ?? entry.preferredRole
    }));
}

function preferenceForLane(laneId: string): {
  preferredRole: string;
  preferredSpecializations: string[];
  fallbackSpecializations: string[];
} {
  switch (laneId) {
    case "pm":
      return { preferredRole: "pm", preferredSpecializations: ["pm"], fallbackSpecializations: [] };
    case "frontend":
      return { preferredRole: "dev", preferredSpecializations: ["frontend"], fallbackSpecializations: ["fullstack"] };
    case "backend":
      return { preferredRole: "dev", preferredSpecializations: ["backend"], fallbackSpecializations: ["fullstack"] };
    case "tester":
      return { preferredRole: "dev", preferredSpecializations: ["tester"], fallbackSpecializations: ["qa", "fullstack"] };
    case "qa":
      return { preferredRole: "dev", preferredSpecializations: ["qa"], fallbackSpecializations: ["tester", "fullstack"] };
    case "audit":
      return { preferredRole: "audit", preferredSpecializations: ["audit"], fallbackSpecializations: [] };
    default:
      return { preferredRole: "dev", preferredSpecializations: ["fullstack"], fallbackSpecializations: ["frontend", "backend"] };
  }
}

function scoreAgentForLane(
  agent: WorkspaceAgentRecord,
  laneId: string,
  preference: {
    preferredRole: string;
    preferredSpecializations: string[];
    fallbackSpecializations: string[];
  }
): number {
  const role = agent.role.trim().toLowerCase();
  const specialization = agent.profile.specialization.trim().toLowerCase();
  const seniority = agent.profile.seniority.trim().toLowerCase();
  const tags = agent.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean);

  let score = 0;
  if (role === preference.preferredRole) score += 26;
  else if (preference.preferredRole === "dev" && ["frontend", "backend", "fullstack", "tester", "qa"].includes(specialization)) score += 18;
  else if (tags.includes(preference.preferredRole)) score += 12;
  else return 0;

  if (preference.preferredSpecializations.includes(specialization)) score += 24;
  else if (preference.fallbackSpecializations.includes(specialization)) score += 14;
  else if (tags.includes(laneId)) score += 10;
  else if (tags.includes(specialization)) score += 6;
  else if (preference.preferredRole === role) score += 4;

  if (seniority === "lead") score += 4;
  else if (seniority === "senior") score += 3;
  else if (seniority === "mid") score += 2;

  score += Math.min(3, Math.max(1, agent.profile.maxParallelWork));

  if (agent.status.state === "active") score -= 2;
  if (agent.status.state === "sleeping") score -= 4;
  if (agent.status.state === "error") score -= 18;

  return score;
}

function isStrongLaneMatch(
  agent: WorkspaceAgentRecord,
  preference: {
    preferredRole: string;
    preferredSpecializations: string[];
    fallbackSpecializations: string[];
  }
): boolean {
  const role = agent.role.trim().toLowerCase();
  const specialization = agent.profile.specialization.trim().toLowerCase();
  if (preference.preferredSpecializations.includes(specialization)) return true;
  return role === preference.preferredRole && preference.preferredSpecializations.length === 0;
}

function lanesFromTasks(tasks: WorkPlanTask[]): WorkPlanLane[] {
  const seen = new Set(tasks.map((task) => task.laneId));
  const known = LANE_DEFINITIONS.filter((lane) => seen.has(lane.id));
  const unknown = Array.from(seen)
    .filter((laneId) => !known.some((lane) => lane.id === laneId))
    .map((laneId) => ({ id: laneId, label: laneId, description: undefined }));
  return [...known, ...unknown];
}

function laneForRole(roleHint: string | null, title: string): WorkPlanLane {
  if (roleHint === "pm") return laneById("pm");
  if (roleHint === "frontend") return laneById("frontend");
  if (roleHint === "backend") return laneById("backend");
  if (roleHint === "tester") return laneById("tester");
  if (roleHint === "qa") return laneById("qa");
  if (roleHint === "audit") return laneById("audit");
  if (/\bqa\b/i.test(title)) return laneById("qa");
  if (/\b(test|verify|validation)\b/i.test(title)) return laneById("tester");
  return laneById("developer");
}

function laneForTemplateNode(role: string, executor: string, phase: string | null): WorkPlanLane {
  const normalizedRole = role.trim().toLowerCase();
  if (normalizedRole === "pm") return laneById("pm");
  if (normalizedRole === "audit") return laneById("audit");
  if (executor === "validate" || phase === "verify") return laneById("tester");
  return laneById("developer");
}

function laneById(id: string): WorkPlanLane {
  return LANE_DEFINITIONS.find((lane) => lane.id === id) ?? { id, label: id };
}

function kindForLane(laneId: string, title: string): WorkPlanTaskKind {
  if (laneId === "pm") return "planning";
  if (laneId === "tester") return "validation";
  if (laneId === "qa") return "qa";
  if (laneId === "audit") return "review";
  if (/\b(test|verify|validation)\b/i.test(title)) return "validation";
  return "implementation";
}

function kindForTemplateNode(executor: string, laneId: string): WorkPlanTaskKind {
  if (executor === "validate") return "validation";
  if (executor === "audit") return "review";
  if (laneId === "pm") return "planning";
  return "implementation";
}

function inferRoleHint(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (/\b(pm|product|planner|spec)\b/.test(normalized) || /^(pm)[-_]/.test(normalized)) return "pm";
  if (/\b(frontend|fe|ui|ux|web|client)\b/.test(normalized) || /^(fe|ui|web)[-_]/.test(normalized)) return "frontend";
  if (/\b(backend|be|api|server|db|database)\b/.test(normalized) || /^(be|api|server|db)[-_]/.test(normalized)) return "backend";
  if (/\b(qa|browser qa|exploratory)\b/.test(normalized) || /^qa[-_]/.test(normalized)) return "qa";
  if (/\b(test|tester|verify|validation)\b/.test(normalized) || /^(test|verify)[-_]/.test(normalized)) return "tester";
  if (/\b(audit|review|security)\b/.test(normalized) || /^(audit|review)[-_]/.test(normalized)) return "audit";
  return null;
}

function mergeUnique(primary: string[], secondary: string[]): string[] {
  const seen = new Set<string>();
  const values = [...primary, ...secondary].map((item) => item.trim()).filter(Boolean);
  const merged: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(value);
  }
  return merged;
}

function collapseSummary(lines: string[]): string | null {
  const value = lines.map((line) => line.trim()).filter(Boolean).join(" ");
  return value || null;
}

function slugifyIdentifier(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "task";
}

function executionStepsFromTasks(tasks: WorkPlanTask[]): WorkItemExecutionStep[] {
  return tasks.map((task) => ({
    id: task.id,
    title: task.title,
    role: task.roleHint ?? roleForLane(task.laneId),
    executor: executorForTaskKind(task.kind, task.laneId),
    phase: phaseForLane(task.laneId),
    dependsOn: [...task.dependsOn],
    acceptanceCriteria: task.description ? [task.description] : []
  }));
}

function roleForLane(laneId: string): string {
  if (laneId === "pm") return "pm";
  if (laneId === "audit") return "audit";
  if (laneId === "frontend") return "frontend";
  if (laneId === "backend") return "backend";
  if (laneId === "tester") return "tester";
  if (laneId === "qa") return "qa";
  return "dev";
}

function executorForTaskKind(kind: WorkPlanTaskKind, laneId: string): string {
  if (kind === "validation" || laneId === "tester") return "validate";
  if (kind === "qa" || laneId === "qa") return "qa";
  if (kind === "review" || laneId === "audit") return "audit";
  return "implement";
}

function phaseForLane(laneId: string): string | null {
  if (laneId === "pm") return "plan";
  if (laneId === "tester") return "verify";
  if (laneId === "qa") return "qa";
  if (laneId === "audit") return "review";
  return "build";
}

function buildRemediationAcceptanceDelta(options: {
  review: WorkItemReviewSummary;
  note: string;
  selectedLaneIds: string[];
}): string[] {
  const delta: string[] = [];
  for (const point of splitFocusPoints(options.note)) {
    delta.push(`Address operator feedback: ${point}`);
  }
  const hasImplementationLane = options.selectedLaneIds.some((laneId) =>
    ["frontend", "backend", "developer"].includes(laneId)
  );
  if (hasImplementationLane) {
    delta.push("Resolve the implementation defects that caused the previous review cycle to fail.");
  }
  for (const signal of options.review.signals) {
    if (signal.status === "passed") continue;
    if (signal.label === "Validation") {
      delta.push("Restore passing validation coverage for the impacted change set.");
    } else if (signal.label === "Browser Smoke") {
      delta.push("Produce a passing browser smoke result for the impacted user journey.");
    } else if (signal.label === "Audit") {
      delta.push("Close outstanding audit concerns or document the residual risk before review.");
    }
  }
  return mergeUnique(delta, []);
}

function buildRemediationConstraintDelta(options: {
  selectedLaneIds: string[];
  note: string;
}): string[] {
  const constraints = ["Keep the remediation cycle scoped to the affected lanes and avoid unrelated refactors."];
  if (options.selectedLaneIds.some((laneId) => ["frontend", "backend", "developer"].includes(laneId))) {
    constraints.push("Preserve already accepted behavior outside the remediation scope.");
  }
  if (
    options.selectedLaneIds.length > 0 &&
    options.selectedLaneIds.every((laneId) => ["tester", "qa", "audit", "pm"].includes(laneId))
  ) {
    constraints.push("Treat this cycle as evidence and verification work unless a new defect is discovered.");
  }
  if (/\b(regression|stability|flake)\b/i.test(options.note)) {
    constraints.push("Bias toward deterministic fixes and reproducible validation evidence.");
  }
  return mergeUnique(constraints, []);
}

function splitFocusPoints(note: string): string[] {
  return note
    .split(/\r?\n|[.;]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function inferRemediationLanesFromText(text: string): string[] {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return [];
  const lanes = new Set<string>();
  if (/\b(pm|product|scope|acceptance|requirements|brief)\b/.test(normalized)) lanes.add("pm");
  if (/\b(frontend|ui|ux|react|next|tailwind|css|client)\b/.test(normalized)) lanes.add("frontend");
  if (/\b(backend|api|server|database|db|schema|queue)\b/.test(normalized)) lanes.add("backend");
  if (/\b(test|tester|validation|regression|unit|integration)\b/.test(normalized)) lanes.add("tester");
  if (/\b(qa|browser|playwright|e2e|journey|smoke)\b/.test(normalized)) lanes.add("qa");
  if (/\b(audit|review|security|hardening)\b/.test(normalized)) lanes.add("audit");
  if (lanes.size === 0 && /\b(code|implementation|fix|patch)\b/.test(normalized)) lanes.add("developer");
  return Array.from(lanes);
}

function selectRemediationTasks(options: {
  detail: WorkItemPlanningDetail;
  selectedLaneIds: string[];
  review: WorkItemReviewSummary;
  note: string;
}): WorkPlanTask[] {
  const taskById = new Map(options.detail.tasks.map((task) => [task.id, task]));
  const selectedTaskIds = new Set<string>();
  const selectedLaneIds = new Set(options.selectedLaneIds);

  const includeTask = (taskId: string) => {
    const task = taskById.get(taskId);
    if (!task || selectedTaskIds.has(taskId)) return;
    for (const dependencyId of task.dependsOn) {
      includeTask(dependencyId);
    }
    selectedTaskIds.add(taskId);
  };

  for (const task of options.detail.tasks) {
    if (selectedLaneIds.has(task.laneId)) {
      includeTask(task.id);
    }
  }

  if (selectedTaskIds.size === 0 && selectedLaneIds.has("frontend")) {
    for (const task of options.detail.tasks) {
      if (task.laneId === "developer") includeTask(task.id);
    }
  }
  if (selectedTaskIds.size === 0 && selectedLaneIds.has("backend")) {
    for (const task of options.detail.tasks) {
      if (task.laneId === "developer") includeTask(task.id);
    }
  }

  const implementationNeeded =
    Array.from(selectedLaneIds).some((laneId) => ["pm", "frontend", "backend", "developer"].includes(laneId)) ||
    /\b(fix|implement|change|update|patch|rewrite)\b/.test(options.note.toLowerCase());
  const validationSignal = options.review.signals.find((signal) => signal.label === "Validation");
  const qaSignal = options.review.signals.find((signal) => signal.label === "Browser Smoke");
  const auditSignal = options.review.signals.find((signal) => signal.label === "Audit");
  const needValidation = implementationNeeded || (validationSignal?.status && validationSignal.status !== "passed");
  const needQa = /\b(browser|qa|playwright|e2e|journey|smoke)\b/.test(options.note.toLowerCase()) || (qaSignal?.status && qaSignal.status !== "passed");
  const needAudit = implementationNeeded || (auditSignal?.status && auditSignal.status !== "passed");

  for (const task of options.detail.tasks) {
    if (needValidation && task.laneId === "tester") includeTask(task.id);
    if (needQa && task.laneId === "qa") includeTask(task.id);
    if (needAudit && task.laneId === "audit") includeTask(task.id);
  }

  if (selectedTaskIds.size === 0) {
    for (const task of options.detail.tasks) {
      includeTask(task.id);
    }
  }

  return options.detail.tasks.filter((task) => selectedTaskIds.has(task.id));
}

function buildRemediationCycleTasks(options: {
  detail: WorkItemPlanningDetail;
  selectedTasks: WorkPlanTask[];
  note: string;
  review: WorkItemReviewSummary;
  sequence: number;
}): WorkPlanTask[] {
  const selectedTaskIds = new Set(options.selectedTasks.map((task) => task.id));
  const selectedLanes = new Set(options.selectedTasks.map((task) => task.laneId));
  const hasPmCoverage = options.detail.teamAssignments.some(
    (assignment) => assignment.laneId === "pm" && assignment.coverage !== "missing"
  );
  const shouldInsertReplanTask = hasPmCoverage && !selectedLanes.has("pm");
  const idMap = new Map<string, string>();
  const cycleTasks: WorkPlanTask[] = [];
  const replanTaskId = shouldInsertReplanTask ? `cycle-${options.sequence}-pm-replan` : null;

  if (replanTaskId) {
    cycleTasks.push({
      id: replanTaskId,
      title: `Re-plan remediation scope for cycle ${options.sequence}`,
      description: options.note
        ? `Review the operator note and convert it into a focused remediation cycle. ${options.note}`
        : "Re-frame the remediation cycle before implementation resumes.",
      laneId: "pm",
      laneLabel: laneById("pm").label,
      roleHint: "pm",
      kind: "planning",
      source: "template",
      dependsOn: [],
      sourceLine: null
    });
  }

  for (const task of options.selectedTasks) {
    idMap.set(task.id, `cycle-${options.sequence}-${task.id}`);
  }

  for (const task of options.selectedTasks) {
    const dependsOn = task.dependsOn
      .filter((dependency) => selectedTaskIds.has(dependency))
      .map((dependency) => idMap.get(dependency) ?? dependency);
    if (replanTaskId && task.laneId !== "pm" && !dependsOn.includes(replanTaskId)) {
      dependsOn.unshift(replanTaskId);
    }
    const descriptionParts = [task.description ?? null];
    if (!task.description && task.kind === "implementation") {
      descriptionParts.push("Apply the focused remediation changes for this cycle and keep the diff scoped.");
    }
    if (task.kind === "validation" && options.review.signals.some((signal) => signal.label === "Validation" && signal.status !== "passed")) {
      descriptionParts.push("Re-run validation and confirm the previous failure mode is closed.");
    }
    if (task.kind === "qa" && options.review.signals.some((signal) => signal.label === "Browser Smoke" && signal.status !== "passed")) {
      descriptionParts.push("Capture a passing exploratory browser smoke result for the affected journey.");
    }
    if (task.kind === "review" && options.review.signals.some((signal) => signal.label === "Audit" && signal.status !== "passed")) {
      descriptionParts.push("Confirm the remediation cycle is review-ready and summarize residual risk.");
    }
    cycleTasks.push({
      ...task,
      id: idMap.get(task.id) ?? task.id,
      title: task.kind === "planning" ? `Cycle ${options.sequence} · ${task.title}` : task.title,
      description: descriptionParts.filter(Boolean).join(" ") || null,
      dependsOn
    });
  }

  return cycleTasks;
}

function buildRemediationSummary(laneIds: string[], note: string, review: WorkItemReviewSummary): string {
  const laneLabels = laneIds.map((laneId) => laneById(laneId).label);
  const headline = laneLabels.length > 0
    ? `Focus remediation on ${laneLabels.join(", ")} lanes.`
    : "Focus remediation on the default development lane.";
  if (note) {
    return `${headline} Operator note: ${note}`;
  }
  const blockers = review.openRisks.slice(0, 2).join(" ");
  return blockers ? `${headline} ${blockers}` : headline;
}
