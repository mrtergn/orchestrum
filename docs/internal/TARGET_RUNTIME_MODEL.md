# Target Runtime Model

## Primary execution spine

`mission` is the only repo-changing execution spine.

`delivery` is a mission-backed handoff, findings, remediation, and evidence subsystem.

`qa` / `benchmark` / `canary` are evidence-producing validation runs.

`agent` / `task` / `org` are coordination surfaces around missions. They are not an independent repo mutation engine.

## Canonical state model

### Run status

- `pending`: created but not yet executing
- `running`: active execution is in progress
- `paused`: execution stopped for human input or approval
- `blocked`: execution reached an explicit blocker
- `completed`: required runtime work finished successfully
- `failed`: execution failed
- `interrupted`: process died before a truthful terminal result
- `cancelled`: operator cancelled the run

### Step status

- `pending`
- `running`
- `paused`
- `blocked`
- `completed`
- `failed`
- `cancelled`
- `skipped`
- `cached`

### Task status

- `queued`
- `running`
- `paused`
- `blocked`
- `succeeded`
- `failed`
- `cancelled`

### Pause reason

- `awaiting_input`
- `awaiting_approval`

### Change status

- `none`
- `generated`
- `apply_pending`
- `applied`
- `apply_failed`
- `validated`
- `validation_failed`
- `needs_review`

### Validation status

- `not_requested`
- `pending`
- `running`
- `passed`
- `failed`
- `unavailable`

### Verdict

- `running`
- `needs_human_review`
- `ready_for_review`
- `ready_to_merge`
- `blocked`
- `failed`

## Canonical truth model

- `proposed`: a patch exists as an artifact, but has not been applied
- `applied`: the patch was successfully applied to the repo
- `validated`: the relevant validation commands completed successfully after apply
- `blocked`: execution hit an explicit blocker or unresolved approval/input gate
- `failed`: execution failed or patch apply failed
- `needs_human_review`: operator review is required before claiming readiness
- `ready_for_review`: work is applied or imported and evidence exists, but merge readiness is not yet proven
- `ready_to_merge`: explicit validation and readiness requirements passed, with no unresolved blockers

## Canonical evidence model

Evidence must be attributable to a run, node, or task and must support the verdict.

Required evidence classes:

1. Prompt/output artifacts for plan, patch, audit, and handoff nodes.
2. Diff artifacts that clearly separate generated vs applied state.
3. Validation logs, stdout, stderr, and `validation/summary.json`.
4. Delivery packet exports, imports, findings, remediations, and matching metadata.
5. Approval artifacts and governance event logs.
6. Browser screenshots / DOM / metrics when browser validation is requested.

## Success criteria

A repo-changing run is only `completed` with a meaningful positive verdict if:

1. Required nodes completed.
2. Any generated/imported patch truth is explicit.
3. Validation truth is explicit.
4. No unresolved apply failure exists.
5. No unresolved approval or blocking finding invalidates readiness.

`completed` alone is not equal to `ready_to_merge`.
