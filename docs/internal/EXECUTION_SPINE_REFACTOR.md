# Execution Spine Refactor

## Decision

Do not preserve parallel execution models.

The repo now converges around one repo-changing spine:

1. Mission runtime
2. Delivery sidecar inside mission runs
3. Validation and browser evidence as mission-adjacent truth

## Refactor moves

### 1. Mission became the only repo-changing runtime

- `feature-dev`, `bugfix-hotpatch`, `refactor-loop`, `release-hardening`, `test-hardening`, and `security-audit` now include explicit validation nodes.
- `spec-only` and `audit-only` exist so service tasks can route into the same mission machinery.

### 2. Delivery moved closer to mission truth

- Delivery session indexing now reads `delivery/session.json` from any run directory.
- CLI `delivery run` now starts `delivery-sprint` through `runMissionDetailed`.
- The service no longer exposes a standalone delivery start surface.

### 3. Task execution was narrowed to truthful behavior

- `spec`, `implement`, and `audit` tasks are mission-backed.
- `generic` tasks are manual coordination only.
- Task state mirrors linked mission truth instead of artifact existence.

### 4. State and readiness now derive from explicit evidence

- `pause_reason`, `change_status`, `validation_status`, and `verdict` are indexed.
- Release readiness uses validation/apply/verdict evidence plus approvals/governance/findings.

## Resulting product shape

- `mission`: primary execution
- `delivery`: mission-backed handoff/evidence/remediation
- `browser QA`: validation evidence producer
- `agent/task/org`: coordination shell around missions

This is still a transitional state, but it is now one coherent runtime story instead of several competing ones.
