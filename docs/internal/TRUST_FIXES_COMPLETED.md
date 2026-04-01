# Trust Fixes Completed

## What changed

1. Removed fake provider success semantics from the service task layer.
2. Removed fabricated fallback diffs in the service task layer.
3. Forced repo-changing tasks (`spec`, `implement`, `audit`) to execute through mission templates.
4. Added explicit task truth fields: linked run, pause reason, change state, validation state, verdict.
5. Added explicit run and step truth fields for pause, patch, validation, and verdict.
6. Added mission templates `spec-only` and `audit-only`.
7. Added explicit validation execution and validation artifacts to mission templates.
8. Indexed truth fields in `StateIndex` and indexed mission-backed delivery sessions.
9. Removed the stale `/delivery/start` service and UI path.
10. Removed the misleading mission sandbox toggle from the UI.
11. Downgraded UI copy that implied org charts or agent shells unlock autonomous delivery.
12. Removed forced desktop keychain mode and improved startup error messaging.

## Why it mattered

- A provider error can no longer become a plausible-looking successful task result.
- A task can no longer "implement" code by fabricating a fake diff.
- Paused delivery imports and approval gates are no longer represented as generic failure.
- Validation is no longer implied by artifact creation.
- Delivery indexing no longer depends on a standalone delivery runtime contract.

## Behavior that is now impossible

1. `implement` task success without a mission run.
2. Provider failure turning into a markdown artifact that still yields task success.
3. Fabricated `NOTES.md` diffs masquerading as implementation output.
4. Mission start UI surfacing sandbox behavior that the backend ignores.
5. Delivery summary depending only on `kind=delivery` runs when a mission-backed delivery session exists.

## What remains unfixed

1. Browser Smoke remains smoke-level.
2. Governance still uses limited rule depth.
3. Browser Smoke is still smoke-level and the broader coordination shell still exposes more surface than execution depth.
4. Agent/org/task surfaces still over-represent the maturity of the coordination layer compared with the mission runtime.
