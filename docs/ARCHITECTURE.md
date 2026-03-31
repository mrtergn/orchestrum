# Orchestrum Architecture

## Overview

Orchestrum is a local-first AI engineering platform with four main layers:

1. CLI commands for mission, delivery, browser QA, and operations
2. A local service that exposes HTTP and SSE
3. A Next.js UI and Electron desktop wrapper
4. Filesystem-backed persistence under `runs/` and workspace metadata under `.orchestrum/` and `.memory/`

## Data Flow

1. The CLI or service starts a mission, delivery session, or browser run.
2. `packages/core` creates a run directory and writes `run.json` plus `events.ndjson`.
3. Step, node, packet, finding, and remediation artifacts are written under the run directory.
4. `packages/service` indexes runs and streams events over SSE.
5. `apps/ui` renders live state, artifacts, packets, and diagnostics.

## Packages

- `packages/core`: mission runtime, delivery lifecycle, browser QA runtime, learnings, security, plugins, state index
- `packages/service`: Express API, SSE, run indexing, recovery, provider checks
- `apps/ui`: Next.js UI for workspaces, runs, metrics, delivery, and settings
- `apps/desktop`: Electron shell around the UI and service

## Storage Model

Typical run layout:

```text
runs/<workspaceId>/<runId>/
  run.json
  events.ndjson
  logs/
  steps/
  nodes/
  delivery/
```

Workspace-scoped metadata typically lives in:

```text
.orchestrum/
.memory/
```

## Mission Runtime

Mission templates are built in. A mission expands into a graph of nodes, assigns agents, writes node artifacts, and pauses when approval or external input is required.

## Delivery Runtime

Delivery sessions generate work packets from repo context and team preset data. Exports and imports are tracked as evidence. Imported responses become findings, remediations, packet status updates, and summary metrics.

## Browser QA Runtime

`qa`, `benchmark`, and `canary` runs capture browser state and artifacts locally. These runs share the same run index, logs, and diagnostics surfaces.

## Event Streaming

The service tails `events.ndjson` and exposes SSE endpoints for run detail pages and system-wide activity streams.

## Recovery and Indexing

The service rebuilds a SQLite-backed state index from filesystem artifacts. Interrupted runs are marked during startup so the UI can surface them for review.
