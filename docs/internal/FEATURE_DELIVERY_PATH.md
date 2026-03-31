# Feature Delivery Path

This is the intended truthful path for a real feature request.

## Operator request

Example: "Add feature X, update tests, validate it, surface findings, and leave an audit trail."

## Execution path

1. Operator starts `feature-dev` or creates an `implement` task.
2. Service routes repo-changing task work into a mission run.
3. Mission executes:
   - `spec`
   - `implement`
   - `validate`
   - `audit`
4. Patch truth is recorded:
   - generated
   - applied
   - apply_failed
   - validated
   - validation_failed
5. Validation executes from `repo_execution.commands` or detected repo scripts.
6. Validation artifacts are written under the node `validation/` directory.
7. Run verdict is derived from explicit patch and validation truth.
8. If delivery handoff is involved, packet export/import, findings, remediations, and evidence are stored under the same run.

## Truth enforcement points

### Planning

- Planning output is an artifact, not success proof.

### Implementation

- A diff artifact alone is not merge readiness.
- Apply failure is explicit.

### Validation

- Validation can be `passed`, `failed`, or `unavailable`.
- No UI or state transition should imply validation if commands never ran.

### Audit

- Audit output is evidence, not automatic merge approval.

### Delivery import

- External diff import records whether a patch existed.
- If patch apply fails, that is explicit.
- If no patch exists, the import is evidence-only.

## Current limits

1. Validation depends on repo scripts or explicit `repo_execution.commands`.
2. Browser QA is still optional smoke evidence.
3. External patch import works, but merge readiness still depends on explicit validation and operator review.
