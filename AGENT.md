# AGENT.md

## Purpose
This document defines how AI agents should operate in Orchestrum.

Primary goals:
- Keep the project local-first and deterministic.
- Preserve feature parity while improving architecture quality.
- Avoid hidden compatibility behavior and legacy branches.

## README Protection
- `README.md` is the project's public cover and branded landing page, not just a reference file.
- README or documentation edits must preserve visual hierarchy, narrative flow, and the overall landing-page feel.
- Preserve the hero, iconography, Mermaid diagrams, card or table structure, editorial dividers, and footer unless a user explicitly asks for a redesign.
- README edits should preserve the cover-quality composition, not just the information.
- Routine docs sync or maintenance edits must patch claims, commands, and links inside the existing structure instead of replacing the README with a bare outline.
- Structural simplification or flattening is allowed only when the user explicitly requests it.

## Non-Negotiable Rules
- No legacy/backward compatibility layers for internal refactors.
- No silent fallback for critical paths (secrets, storage, approvals, provider config).
- Fail fast on invalid state instead of auto-healing with implicit behavior.
- Never leak secrets to logs, events, or artifacts.
- Keep all behavior explicit and typed at module boundaries.

## SOLID Enforcement
- Single Responsibility: each module owns one cohesive concern. Monolithic registrars/orchestrators must be split.
- Open/Closed: new providers, commands, and workflow extensions should be added via new modules, not invasive edits.
- Liskov Substitution: all provider implementations must be substitutable behind `IAgentProvider` without behavior break.
- Interface Segregation: avoid broad interfaces; prefer small role-focused contracts.
- Dependency Inversion: high-level orchestration depends on abstractions/interfaces, not concrete transport/provider details.

## System Contract
- Run storage layout is canonical:
  - `runs/<workspaceId>/<runId>/`
- Core/service/ui/desktop must use the same run/workspace contract.
- Service remains localhost-only by design.
- Reliability fallback is allowed only where intentionally designed (for example provider failover), not for backward compatibility.

## Architecture Guardrails
- Dependency direction is strict: `apps/ui -> packages/service -> packages/core`.
- Reverse imports from lower layers to higher layers are forbidden.
- Circular dependencies are forbidden.
- Prefer composition over inheritance for runtime behaviors.
- Files that grow into large mixed-responsibility units must be decomposed before adding new features.

## Agent Roles

### 1. DEV (Fix)
Source prompt: `packages/core/prompts/fix.md`

Responsibilities:
- Implement concrete fixes.
- Produce minimal, reviewable diffs.
- Keep behavior changes intentional and test-backed.

Output contract:
- Unified diff in a fenced `diff` block.
- Short summary after the diff.

### 2. AUDIT
Source prompt: `packages/core/prompts/audit.md`

Responsibilities:
- Review spec, diff, and logs.
- Report blocking and non-blocking issues by severity.
- Propose targeted fixes when small and unambiguous.

Output contract:
- JSON only:
  - `blocking`
  - `issues[]`
  - optional `suggested_fix`

### 3. RED_TEAM
Source prompt: `packages/core/prompts/red_team.md`

Responsibilities:
- Probe injection, policy bypass, and tampering risks.
- Estimate exploitability and impact.
- Recommend mitigations with practical priority.

Output contract:
- JSON only:
  - `vulnerability_report`
  - `vulnerability_score`
  - `exploit_probability`
  - `recommendations[]`

## Standard Execution Flow
1. Intake: capture scope, constraints, and affected packages.
2. Analyze: inspect full code paths, not only diffs.
3. Implement: apply focused changes with clear ownership.
4. Validate: run targeted checks, then full gates.
5. Report: summarize changes, risks, and follow-up work.

## Required Quality Gates
Run these before closing substantial work:

```bash
npm test
npm run typecheck
npm run build
npm run --prefix packages/core coverage
```

Coverage minimum:
- lines >= 70
- branches >= 60

## Testing Policy
- Every behavior change requires at least one test that fails before and passes after the change.
- Refactors must preserve behavior; add parity tests for moved/split logic.
- Error paths, timeout paths, and retry paths must be covered where applicable.
- Do not close work with placeholder tests.

## Security Baseline
- Use argument tokenization with `shell: false` for command execution.
- Enforce command allowlists where untrusted input can flow.
- Validate provider endpoints against approved patterns.
- Enforce approval token issuance time and expiry checks.
- Prefer explicit typed errors over broad catch-and-ignore paths.

## Fallback Policy
- Backward-compatibility fallbacks are forbidden.
- Reliability fallbacks are allowed only when:
  - explicitly configured,
  - observable in logs/events,
  - and covered by tests.
- Any fallback that mutates persistent state must be explicit and auditable.

## Coding Standards for Agents
- Follow SRP: keep modules narrow and composable.
- Prefer explicit interfaces for cross-module contracts.
- Centralize constants and status unions.
- Avoid magic numbers and ad-hoc schema drift.
- Add or update tests for each behavior change.

## Package Ownership Map
- `packages/core`: orchestration engine, policy, storage, delivery logic.
- `packages/service`: API surface, event streaming, run indexing.
- `apps/ui`: operator UI, query/event integration, accessibility.
- `apps/desktop`: local desktop shell aligned with service/CLI contracts.

## Definition of Done
- No legacy/backward branch introduced.
- No silent failure path introduced.
- Tests/typecheck/build pass.
- Coverage gate is met or explicitly documented as a known blocker.
- User-facing docs updated when behavior or interfaces change.
