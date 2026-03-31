# Execution Gap Map

This file records the implementation gap that existed before the refactor and the current disposition after code changes in this tranche.

## Subsystem classification

| Subsystem | Starting state | Current state | Notes |
| --- | --- | --- | --- |
| Root scripts | partial / under-integrated | real but brittle | Root `build` now includes service, but desktop packaging and release flows still need harder proof. |
| `packages/core` mission runtime | real but brittle | real and more reliable | Explicit pause, blocked, change, validation, and verdict truth now exist in run and step state. |
| `packages/core` delivery runtime | partial / split-brain | real but still partial | Delivery is now indexed from mission-backed `delivery/session.json`, but some standalone delivery code still exists for packet ops and historical CLI flows. |
| `packages/core` browser QA | real but brittle | real but brittle | Smoke evidence is real; it is still not a deep QA system. |
| `packages/service` mission routes | partial / under-integrated | real and more reliable | `concurrency`, `modelOverrides`, and `strategyMode` now reach the mission runtime. |
| `packages/service` task/agent platform | harmful to product trust | partial / under-integrated | Fake provider success and fabricated diffs are removed. Repo-changing tasks are mission-backed. Coordination surfaces still remain broader than core execution. |
| `apps/ui` run config | misleading | real but narrower | Sandbox toggle removed. Only options that reach the backend remain surfaced. |
| `apps/ui` tasks | misleading | real but still partial | Task UI now shows linked mission run, change state, validation state, verdict, and pause reason. |
| `apps/ui` delivery | partial / stale assumptions | real but brittle | Summary now relies on mission-backed delivery indexing. Some broader delivery UX is still thinner than the page suggests. |
| `apps/desktop` | partial / misleading | partial / under-integrated | Forced keychain mode removed. Errors are more explicit. Desktop still assumes localhost service/UI startup. |
| State indexing | partial / under-integrated | real and more reliable | Index now stores `pause_reason`, `change_status`, `validation_status`, `verdict`, and mission-backed delivery sessions. |
| Approvals | real but brittle | real but brittle | Approval state is now modeled truthfully, but the underlying safety rules are still narrow. |
| Evidence and artifacts | real | real and stronger | Validation logs, summaries, external patches, linked task run artifacts, and mission-backed delivery session evidence are now first-class. |
| Recovery | partial | partial | Interrupted run marking still exists, but recovery is not execution checkpointing. |
| Plugins | stale / legacy | stale / legacy | Not part of the trust-critical spine in this tranche. |
| Governance | misleading | real but brittle | Governance is still limited. Readiness now relies more on explicit evidence than on generic posture. |
| Learnings | stale | stale | Not part of the trust-critical spine in this tranche. |
| Updates | partial / risky | partial / risky | Not part of the trust-critical spine in this tranche. |
| Telemetry | stale | stale | Not part of the trust-critical spine in this tranche. |
| Workspaces | real but brittle | real and more reliable | Workspace registry now hard-cuts to app-home storage and supports `ORCHESTRUM_HOME` overrides for deterministic local/test execution. |

## Top trust gaps that blocked product honesty

1. Task execution could claim success after provider failure.
2. Task execution could fabricate a diff against `NOTES.md`.
3. Mission pause states leaked through failure-shaped events and status handling.
4. Patch truth and validation truth were not explicit enough to support credible verdicts.
5. Delivery state was split between a standalone runtime and mission-backed UI language.
6. UI controls suggested runtime behavior that the backend did not honor.
7. State indexing ignored the new truth fields and assumed delivery only existed as `kind=delivery`.
8. Release readiness was based too heavily on weak signals instead of explicit apply/validation evidence.

## Gaps intentionally not solved in this tranche

1. Browser QA is still smoke-level, not release-grade.
2. Plugins, telemetry, learnings, and cluster remain outside the core truth spine.
3. Agent/org/task coordination still exposes more surface area than the product has execution depth for.
4. Desktop startup is clearer, but still not a hardened distribution path.
