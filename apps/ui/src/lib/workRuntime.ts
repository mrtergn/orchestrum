import type {
  WorkOrganizationControl,
  WorkItemReviewSummary,
  WorkItemRecord,
  WorkPlanLane,
  WorkPlanLaneAssignment,
  WorkPlanTask,
  WorkSprintControl
} from "@orchestrum/core";

export type RuntimeAgentRecord = {
  id: string;
  name: string;
  role: string;
  profile?: {
    specialization: string;
    seniority: string;
    maxParallelWork: number;
  };
  status?: {
    state: string;
    currentTaskId?: string;
    currentTaskIds?: string[];
    activeLoad?: number;
    lastHeartbeatAt?: string;
  };
};

export type RuntimeTaskRecord = {
  id: string;
  title: string;
  status: string;
  type?: string;
  assignedToAgentId: string;
  ownerAgentId?: string;
  ownerAgentName?: string;
  ownerRole?: string;
  linkedWorkItemId?: string;
  linkedWorkItemTitle?: string;
  cycleId?: string;
  laneId?: string;
  laneLabel?: string;
  workstreamId?: string;
  workstreamType?: string;
  gateRefs?: string[];
  dependsOnTaskIds?: string[];
  waitingOnTaskIds?: string[];
  blockedByTaskIds?: string[];
  linkedRunId?: string;
  resultSummary?: string;
};

export type WorkItemLaneRuntimeStatus =
  | "missing"
  | "idle"
  | "waiting"
  | "running"
  | "blocked"
  | "completed";

export type WorkItemLaneRuntime = {
  laneId: string;
  laneLabel: string;
  status: WorkItemLaneRuntimeStatus;
  coverage: WorkPlanLaneAssignment["coverage"];
  owner: RuntimeAgentRecord | null;
  ownerMatch: WorkPlanLaneAssignment["matches"][number] | null;
  plannedTaskCount: number;
  runtimeTaskCount: number;
  succeededTaskCount: number;
  runningTaskCount: number;
  blockedTaskCount: number;
  queuedTaskCount: number;
  dependsOnLanes: string[];
  activeTaskTitle?: string | null;
  summary?: string | null;
  waitingOn?: string[];
  blockedBy?: string[];
};

export type WorkItemTeamRuntime = {
  headline: string;
  currentStage: string;
  nextHandoff: string | null;
  activeAgents: number;
  blockedLanes: number;
  completedLanes: number;
  missingCoverage: number;
  lanes: WorkItemLaneRuntime[];
};

export type SprintStageRuntime = {
  laneId: string;
  laneLabel: string;
  running: number;
  queued: number;
  blocked: number;
  succeeded: number;
  total: number;
};

export type SprintAgentRuntime = {
  id: string;
  name: string;
  role: string;
  specialization: string;
  seniority: string;
  state: string;
  activeLoad: number;
  maxParallelWork: number;
  activePbis: string[];
  activeTasks: string[];
};

export type SprintTeamRuntime = {
  headline: string;
  pmFocus: string;
  activePbis: number;
  reviewQueue: number;
  blockedPbis: number;
  activeAgents: number;
  bottleneckLabel: string | null;
  stages: SprintStageRuntime[];
  agents: SprintAgentRuntime[];
};

export type WorkspaceTeamRuntime = {
  headline: string;
  pmFocus: string;
  activeWorkItems: number;
  reviewQueue: number;
  blockedItems: number;
  activeAgents: number;
  bottleneckLabel: string | null;
  stages: SprintStageRuntime[];
  agents: SprintAgentRuntime[];
};

const ACTIVE_STATUSES = new Set(["running", "active", "paused"]);
const BLOCKED_STATUSES = new Set(["blocked", "failed", "cancelled", "canceled"]);

export function buildWorkItemTeamRuntime(options: {
  lanes: WorkPlanLane[];
  assignments: WorkPlanLaneAssignment[];
  plannedTasks: WorkPlanTask[];
  tasks: RuntimeTaskRecord[];
  agents: RuntimeAgentRecord[];
  review: WorkItemReviewSummary;
}): WorkItemTeamRuntime {
  const assignmentByLane = new Map(options.assignments.map((assignment) => [assignment.laneId, assignment]));
  const agentById = new Map(options.agents.map((agent) => [agent.id, agent]));
  const plannerTaskById = new Map(options.plannedTasks.map((task) => [task.id, task]));
  const lanes = options.lanes.map((lane) => {
    const assignment = assignmentByLane.get(lane.id);
    const laneTasks = options.tasks.filter((task) => (task.laneId ?? "developer") === lane.id);
    const plannedTasks = options.plannedTasks.filter((task) => task.laneId === lane.id);
    const succeededTaskCount = laneTasks.filter((task) => task.status === "succeeded").length;
    const runningTaskCount = laneTasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length;
    const blockedTaskCount = laneTasks.filter((task) => BLOCKED_STATUSES.has(task.status)).length;
    const queuedTaskCount = laneTasks.filter((task) => task.status === "queued").length;
    const waitingOn = Array.from(new Set(laneTasks.flatMap((task) => task.waitingOnTaskIds ?? [])));
    const blockedBy = Array.from(new Set(laneTasks.flatMap((task) => task.blockedByTaskIds ?? [])));
    const dependsOnLanes = Array.from(new Set(
      plannedTasks.flatMap((task) => task.dependsOn)
        .map((dependencyId) => plannerTaskById.get(dependencyId))
        .filter((task): task is WorkPlanTask => Boolean(task))
        .map((task) => task.laneLabel)
        .filter((value) => value && value !== lane.label)
    ));
    const ownerMatch = assignment?.matches?.[0] ?? null;
    const owner = ownerMatch ? agentById.get(ownerMatch.id) ?? null : null;
    const activeTask = laneTasks.find((task) => ACTIVE_STATUSES.has(task.status)) ?? laneTasks.find((task) => task.status === "queued") ?? null;
    let status: WorkItemLaneRuntimeStatus = "idle";
    if ((assignment?.coverage ?? "missing") === "missing") {
      status = "missing";
    } else if (blockedTaskCount > 0 || blockedBy.length > 0) {
      status = "blocked";
    } else if (runningTaskCount > 0) {
      status = "running";
    } else if (laneTasks.length > 0 && succeededTaskCount === laneTasks.length) {
      status = "completed";
    } else if (queuedTaskCount > 0 || waitingOn.length > 0) {
      status = "waiting";
    }

    const summary =
      status === "blocked"
        ? laneTasks.find((task) => BLOCKED_STATUSES.has(task.status))?.resultSummary ?? (blockedBy[0] ? `Blocked by ${blockedBy[0]}.` : "Lane execution is blocked.")
        : status === "running"
          ? activeTask?.title ?? "Execution is in progress."
          : status === "waiting"
            ? waitingOn[0]
              ? `Waiting on ${waitingOn[0]}.`
              : activeTask?.title ?? "Queued for downstream execution."
            : status === "completed"
              ? laneTasks.slice().reverse().find((task) => task.resultSummary?.trim())?.resultSummary ?? "Lane tasks completed."
              : assignment?.note ?? null;

    return {
      laneId: lane.id,
      laneLabel: lane.label,
      status,
      coverage: assignment?.coverage ?? "missing",
      owner,
      ownerMatch,
      plannedTaskCount: plannedTasks.length,
      runtimeTaskCount: laneTasks.length,
      succeededTaskCount,
      runningTaskCount,
      blockedTaskCount,
      queuedTaskCount,
      dependsOnLanes,
      activeTaskTitle: activeTask?.title ?? null,
      summary,
      waitingOn,
      blockedBy
    } satisfies WorkItemLaneRuntime;
  });

  const blockedLanes = lanes.filter((lane) => lane.status === "blocked").length;
  const completedLanes = lanes.filter((lane) => lane.status === "completed").length;
  const missingCoverage = lanes.filter((lane) => lane.status === "missing").length;
  const activeAgents = new Set(lanes.filter((lane) => lane.status === "running").map((lane) => lane.owner?.id).filter(Boolean)).size;
  const runningLane = lanes.find((lane) => lane.status === "running");
  const blockedLane = lanes.find((lane) => lane.status === "blocked");
  const waitingLane = lanes.find((lane) => lane.status === "waiting");
  const nextLane = lanes.find((lane) => lane.status === "idle" || lane.status === "waiting");
  const currentStage =
    options.review.gate === "approved"
      ? "Operator approved this work item."
      : blockedLane
        ? `${blockedLane.laneLabel} is blocked.`
        : runningLane
          ? `${runningLane.laneLabel} is executing now.`
          : waitingLane
            ? `${waitingLane.laneLabel} is queued behind upstream work.`
            : options.review.gate === "ready"
              ? "Execution is complete and waiting for operator review."
              : "Cycle is ready to be launched.";
  const nextHandoff =
    options.review.gate === "approved"
      ? null
      : blockedLane
        ? blockedLane.laneLabel
        : nextLane?.laneLabel ?? (options.review.gate === "ready" ? "Operator review" : null);
  const headline =
    options.review.gate === "approved"
      ? "Agile team cycle completed."
      : blockedLane
        ? "Organization is blocked and needs intervention."
        : runningLane
          ? `${runningLane.laneLabel} currently owns the active handoff.`
          : options.review.gate === "ready"
            ? "Team execution is complete and ready for human gate."
            : "Team is staged and waiting for execution kickoff.";

  return {
    headline,
    currentStage,
    nextHandoff,
    activeAgents,
    blockedLanes,
    completedLanes,
    missingCoverage,
    lanes
  };
}

export function buildSprintTeamRuntime(options: {
  control: WorkSprintControl;
  agents: RuntimeAgentRecord[];
  tasks: RuntimeTaskRecord[];
}): SprintTeamRuntime {
  const workItemIds = new Set(options.control.pbis.map((pbi) => pbi.workItemId).filter(Boolean));
  const sprintTasks = options.tasks.filter((task) => task.linkedWorkItemId && workItemIds.has(task.linkedWorkItemId));
  const laneMap = new Map<string, SprintStageRuntime>();
  for (const task of sprintTasks) {
    const laneId = task.laneId ?? "developer";
    const laneLabel = task.laneLabel ?? laneId;
    const existing = laneMap.get(laneId) ?? {
      laneId,
      laneLabel,
      running: 0,
      queued: 0,
      blocked: 0,
      succeeded: 0,
      total: 0
    };
    existing.total += 1;
    if (ACTIVE_STATUSES.has(task.status)) existing.running += 1;
    else if (task.status === "queued") existing.queued += 1;
    else if (BLOCKED_STATUSES.has(task.status)) existing.blocked += 1;
    else if (task.status === "succeeded") existing.succeeded += 1;
    laneMap.set(laneId, existing);
  }

  const stages = Array.from(laneMap.values()).sort((left, right) => {
    const leftLoad = left.blocked * 4 + left.running * 3 + left.queued * 2 + left.total;
    const rightLoad = right.blocked * 4 + right.running * 3 + right.queued * 2 + right.total;
    if (rightLoad !== leftLoad) return rightLoad - leftLoad;
    return left.laneLabel.localeCompare(right.laneLabel);
  });

  const agentCards = options.agents
    .map((agent) => {
      const agentTasks = sprintTasks.filter((task) => task.assignedToAgentId === agent.id);
      const activeTaskTitles = agentTasks
        .filter((task) => ACTIVE_STATUSES.has(task.status) || task.status === "queued")
        .map((task) => task.title)
        .slice(0, 3);
      const activePbis = Array.from(new Set(
        agentTasks.map((task) => task.linkedWorkItemTitle).filter((value): value is string => Boolean(value))
      )).slice(0, 3);
      return {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        specialization: agent.profile?.specialization ?? agent.role,
        seniority: agent.profile?.seniority ?? "mid",
        state: agent.status?.state ?? "idle",
        activeLoad:
          typeof agent.status?.activeLoad === "number"
            ? agent.status.activeLoad
            : Array.isArray(agent.status?.currentTaskIds)
              ? agent.status.currentTaskIds.length
              : 0,
        maxParallelWork: agent.profile?.maxParallelWork ?? 1,
        activePbis,
        activeTasks: activeTaskTitles
      } satisfies SprintAgentRuntime;
    })
    .filter((agent) => agent.activePbis.length > 0 || agent.activeTasks.length > 0 || agent.role === "pm")
    .sort((left, right) => {
      const leftScore = left.activeLoad * 4 + left.activeTasks.length * 3 + (left.role === "pm" ? 1 : 0);
      const rightScore = right.activeLoad * 4 + right.activeTasks.length * 3 + (right.role === "pm" ? 1 : 0);
      if (rightScore !== leftScore) return rightScore - leftScore;
      return left.name.localeCompare(right.name);
    });

  const nextCandidate = options.control.launchQueue.find((candidate) => candidate.disposition === "selected") ?? null;
  const bottleneck = stages.find((stage) => stage.blocked > 0 || stage.queued > 0) ?? null;
  const pmFocus =
    options.control.summary.review > 0
      ? `${options.control.summary.review} PBI is waiting at the human review gate.`
      : bottleneck
        ? `${bottleneck.laneLabel} is the current bottleneck.`
        : nextCandidate
          ? `Next ready PBI is ${nextCandidate.pbiId}.`
          : "No immediate PM action is required.";
  const headline =
    options.control.summary.running > 0
      ? `${options.control.summary.running} PBI is currently moving through the team runtime.`
      : options.control.summary.review > 0
        ? "Execution is paused at review until the operator decides."
        : options.control.summary.launchable > 0
          ? `${options.control.summary.launchable} PBI can be pulled into execution.`
          : "Sprint runtime has no immediately launchable PBI.";

  return {
    headline,
    pmFocus,
    activePbis: options.control.summary.running,
    reviewQueue: options.control.summary.review,
    blockedPbis: options.control.summary.blocked,
    activeAgents: agentCards.filter((agent) => agent.activeLoad > 0 || agent.state === "active").length,
    bottleneckLabel: bottleneck?.laneLabel ?? null,
    stages,
    agents: agentCards
  };
}

export function buildWorkspaceTeamRuntime(options: {
  control: WorkOrganizationControl;
  workItems: WorkItemRecord[];
  agents: RuntimeAgentRecord[];
  tasks: RuntimeTaskRecord[];
}): WorkspaceTeamRuntime {
  const workItemIds = new Set(options.workItems.map((workItem) => workItem.id));
  const workspaceTasks = options.tasks.filter((task) => task.linkedWorkItemId && workItemIds.has(task.linkedWorkItemId));
  const laneMap = new Map<string, SprintStageRuntime>();
  for (const task of workspaceTasks) {
    const laneId = task.laneId ?? "developer";
    const laneLabel = task.laneLabel ?? laneId;
    const existing = laneMap.get(laneId) ?? {
      laneId,
      laneLabel,
      running: 0,
      queued: 0,
      blocked: 0,
      succeeded: 0,
      total: 0
    };
    existing.total += 1;
    if (ACTIVE_STATUSES.has(task.status)) existing.running += 1;
    else if (task.status === "queued") existing.queued += 1;
    else if (BLOCKED_STATUSES.has(task.status)) existing.blocked += 1;
    else if (task.status === "succeeded") existing.succeeded += 1;
    laneMap.set(laneId, existing);
  }

  const stages = Array.from(laneMap.values()).sort((left, right) => {
    const leftLoad = left.blocked * 4 + left.running * 3 + left.queued * 2 + left.total;
    const rightLoad = right.blocked * 4 + right.running * 3 + right.queued * 2 + right.total;
    if (rightLoad !== leftLoad) return rightLoad - leftLoad;
    return left.laneLabel.localeCompare(right.laneLabel);
  });

  const agentCards = options.agents
    .map((agent) => {
      const agentTasks = workspaceTasks.filter((task) => task.assignedToAgentId === agent.id);
      const activeTaskTitles = agentTasks
        .filter((task) => ACTIVE_STATUSES.has(task.status) || task.status === "queued")
        .map((task) => task.title)
        .slice(0, 3);
      const activeWorkItems = Array.from(new Set(
        agentTasks.map((task) => task.linkedWorkItemTitle).filter((value): value is string => Boolean(value))
      )).slice(0, 3);
      return {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        specialization: agent.profile?.specialization ?? agent.role,
        seniority: agent.profile?.seniority ?? "mid",
        state: agent.status?.state ?? "idle",
        activeLoad:
          typeof agent.status?.activeLoad === "number"
            ? agent.status.activeLoad
            : Array.isArray(agent.status?.currentTaskIds)
              ? agent.status.currentTaskIds.length
              : 0,
        maxParallelWork: agent.profile?.maxParallelWork ?? 1,
        activePbis: activeWorkItems,
        activeTasks: activeTaskTitles
      } satisfies SprintAgentRuntime;
    })
    .filter((agent) => agent.activePbis.length > 0 || agent.activeTasks.length > 0 || agent.role === "pm")
    .sort((left, right) => {
      const leftScore = left.activeLoad * 4 + left.activeTasks.length * 3 + (left.role === "pm" ? 1 : 0);
      const rightScore = right.activeLoad * 4 + right.activeTasks.length * 3 + (right.role === "pm" ? 1 : 0);
      if (rightScore !== leftScore) return rightScore - leftScore;
      return left.name.localeCompare(right.name);
    });

  const nextCandidate = options.control.launchQueue.find((candidate) => candidate.disposition === "selected") ?? null;
  const bottleneck = stages.find((stage) => stage.blocked > 0 || stage.queued > 0) ?? null;
  const pmFocus =
    options.control.summary.review > 0
      ? `${options.control.summary.review} work item is waiting at the human review gate.`
      : bottleneck
        ? `${bottleneck.laneLabel} is the current bottleneck across the workspace queue.`
        : nextCandidate
          ? `Next ready work item is ${nextCandidate.title}.`
          : "No immediate PM intervention is required.";
  const headline =
    options.control.summary.running > 0
      ? `${options.control.summary.running} work item is currently moving through the organization runtime.`
      : options.control.summary.review > 0
        ? "Execution is paused at review until the operator responds."
        : options.control.summary.launchable > 0
          ? `${options.control.summary.launchable} work item can be launched from the workspace queue.`
          : "Workspace organization runtime has no immediate launch candidates.";

  return {
    headline,
    pmFocus,
    activeWorkItems: options.control.summary.running,
    reviewQueue: options.control.summary.review,
    blockedItems: options.control.summary.blocked + options.control.summary.failed,
    activeAgents: agentCards.filter((agent) => agent.activeLoad > 0 || agent.state === "active").length,
    bottleneckLabel: bottleneck?.laneLabel ?? null,
    stages,
    agents: agentCards
  };
}
