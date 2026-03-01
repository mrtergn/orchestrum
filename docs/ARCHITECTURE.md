# Orchestrum Architecture

## Overview
Orchestrum is a local-first AI orchestration platform with:
- A TypeScript CLI runner
- A local service (HTTP + SSE)
- A Next.js UI
- Filesystem-based persistence under `./runs`

Everything runs offline by default and avoids external databases.

## High-Level Data Flow
1. **CLI or Service** starts a run.
2. **Runner** executes workflow steps, producing artifacts.
3. **Events** are appended to `events.ndjson`.
4. **Service** tails events and exposes SSE streams.
5. **UI** renders live updates.

## Packages
- `packages/core`: workflow parsing, runner, sandbox, policy, storage, analytics
- `packages/service`: API, SSE, indexing, recovery
- `apps/ui`: Next.js UI
- `apps/desktop`: Electron wrapper

## Storage Model
Runs are stored under:
```
runs/<workspaceId>/<runId>/
  run.json
  events.ndjson
  steps/<stepId>/
```

Steps contain:
- `input.json`, `output.md`, `git.diff`, `commands.log`, `status.json`
- `arbitration.json` and per-model outputs when arbitration is enabled
- `container.log` when sandboxed

## Event Streaming
The service tails `events.ndjson` and exposes:
```
GET /api/runs/<id>/stream
```
with SSE frames. Heartbeats are emitted every 3s.

## Sandbox Execution
When enabled, DEV/AUDIT steps run in ephemeral Docker containers with:
- repo and run folders mounted
- non-root user
- network disabled by default

If Docker is unavailable, runner falls back to local execution.

## Policies & Approvals
Policy checks run after patch application. Violations emit `policy.violation` and stop the run.
High-risk actions require a user approval token, stored under `runs/<id>/approvals/`.

## Cluster Mode
`orchestrum cluster start` spawns worker processes and dispatches steps through a filesystem queue in `runs/<workspace>/.cluster`.

## Analytics & Memory
Workspace memory is stored under `.memory/`:
- `analytics.json`
- `prompt_history.json`
- `summaries.json`
- `knowledge.json`

These files inform strategy evolution and prompt improvements.
