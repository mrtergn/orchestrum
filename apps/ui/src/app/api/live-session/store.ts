export type StepStatus = "pending" | "in_progress" | "done";

export type StepName = "PM" | "Frontend" | "Backend" | "Tester" | "QA" | "Audit";

export interface BatonStep {
  name: StepName;
  status: StepStatus;
  updatedAt: string;
}

export interface BrowserValidation {
  at: string;
  userAgent: string;
}

export interface AuditReview {
  at: string;
  outcome: "approved" | "changes_requested";
  notes?: string;
}

export interface SessionState {
  id: string;
  currentIndex: number; // -1 means not started
  steps: BatonStep[];
  validations: BrowserValidation[];
  audit?: AuditReview;
}

const ORDER: StepName[] = ["PM", "Frontend", "Backend", "Tester", "QA", "Audit"];

const sessions = new Map<string, SessionState>();

function nowISO() {
  return new Date().toISOString();
}

function newSession(id: string): SessionState {
  return {
    id,
    currentIndex: -1,
    steps: ORDER.map((name) => ({ name, status: "pending", updatedAt: nowISO() })),
    validations: []
  };
}

export function getSession(id = "default"): SessionState {
  const hit = sessions.get(id);
  if (hit) return hit;
  const s = newSession(id);
  sessions.set(id, s);
  return s;
}

export function startSession(id = "default"): SessionState {
  const s = getSession(id);
  if (s.currentIndex === -1) {
    const firstStep = s.steps[0];
    if (!firstStep) return s;
    s.currentIndex = 0;
    firstStep.status = "in_progress";
    firstStep.updatedAt = nowISO();
  }
  return s;
}

export function advanceSession(id = "default"): SessionState {
  const s = getSession(id);
  if (s.currentIndex === -1) return startSession(id);

  const i = s.currentIndex;
  const currentStep = i >= 0 && i < s.steps.length ? s.steps[i] : undefined;
  if (currentStep) {
    currentStep.status = "done";
    currentStep.updatedAt = nowISO();
  }
  const next = i + 1;
  const nextStep = next < s.steps.length ? s.steps[next] : undefined;
  if (nextStep) {
    s.currentIndex = next;
    nextStep.status = "in_progress";
    nextStep.updatedAt = nowISO();
  } else {
    s.currentIndex = s.steps.length - 1;
  }
  return s;
}

export function recordValidation(id = "default", userAgent: string): SessionState {
  const s = getSession(id);
  s.validations.push({ at: nowISO(), userAgent });
  // If we are at Tester stage, browser validation can auto-complete it.
  const i = s.currentIndex;
  if (i >= 0 && s.steps[i]?.name === "Tester") {
    advanceSession(id);
  }
  return s;
}

export function setAudit(id = "default", outcome: AuditReview["outcome"], notes?: string): SessionState {
  const s = getSession(id);
  s.audit = { at: nowISO(), outcome, notes };
  // Mark Audit done if we are there
  const i = s.currentIndex;
  const isAuditStage = i >= 0 && s.steps[i]?.name === "Audit";
  if (isAuditStage) {
    const currentStep = s.steps[i];
    if (currentStep) {
      currentStep.status = "done";
      currentStep.updatedAt = nowISO();
    }
  }
  s.currentIndex = Math.max(i, s.steps.length - 1);
  return s;
}

