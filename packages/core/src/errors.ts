export class OrchestrumError extends Error {
  code: string;
  context?: Record<string, unknown>;

  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.context = context;
  }
}

export class ProviderError extends OrchestrumError {}
export class ConfigError extends OrchestrumError {}
export class PolicyViolationError extends OrchestrumError {}
export class WorkspaceError extends OrchestrumError {}
export class ApprovalError extends OrchestrumError {}
export class SecretError extends OrchestrumError {}
export class ClusterTimeoutError extends OrchestrumError {}
