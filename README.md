# Orchestrum

Local-first AI agent management platform for building autonomous teams. Orchestrum keeps all state local, supports OpenAI, Claude, and local model adapters, dispatches task queues to agent runtimes, and stores task artifacts/traces under local storage.

Legacy workflow orchestration remains available and is now treated as a template/preset path.

Works on Windows, macOS, and Linux.

## Prerequisites
- Node.js 18+
- npm 9+
- Git (repo must be initialized)
- Optional: Docker (for `--sandbox docker`)
- Optional: `patch` command (fallback if `git apply` fails)

## Install
```bash
npm install
```

### Global CLI (optional)
```bash
npm i -g orchestrum
```

## License
Orchestrum is free and open source under the MIT License. See `LICENSE`.

## Quick Start (One Command)
Start the local service and UI together:
```bash
orchestrum ui
```
Or without global install:
```bash
npx orchestrum ui
```
If your global npm config runs workspace scripts by default (e.g. `workspaces=true`), prefer `npx orchestrum ui` to avoid npm fanning the script across all workspaces.
Then open `http://localhost:3000`.

## Workspaces (Multi-Repo)
Register repos to show in the UI workspace selector and to keep runs partitioned by workspace.
```bash
npx orchestrum workspace add /path/to/repo
npx orchestrum workspace list
```

Workspaces are stored in `workspaces.json` at the monorepo root.

## Run the UI (Dev)
For local development without the CLI:
```bash
npm run service
npm run dev
```
Open `http://localhost:3000`.
Primary UI pages:
- `Agents` - connect and configure agents
- `Org` - build reporting lines (React Flow canvas)
- `Tasks` - dispatch and monitor task queue
- `orchestrum` - live mission dashboard (SSE)

Legacy run detail pages still include tabs for **Prompt Evolution**, **Strategy**, **Security**, **Analytics**, **Opportunities**, **Experiments**, **Arbitration**, **Tournaments**, and **Roadmap**.

## Agent Platform Quick Start (GUI-first)
1. Open Orchestrum UI.
2. Complete onboarding wizard:
  - save provider key,
  - create PM/Dev/Audit agents,
  - auto-generate org chart,
  - enqueue demo task.
3. Use `Tasks` to assign real work and `orchestrum` to monitor live execution.

## Documentation
- `docs/ARCHITECTURE.md`
- `docs/WORKFLOWS.md`
- `docs/PLUGINS.md`
- `docs/CLI.md`
- `docs/EXAMPLES.md`

## Contributing
We welcome contributions. Please read:
- `CONTRIBUTING.md`
- `CODE_OF_CONDUCT.md`
- `SECURITY.md`

## Desktop App (Electron)
Build the desktop wrapper that embeds the UI and starts the local service:
```bash
npm run build:desktop
npm run dist:desktop
```
For local dev:
```bash
npm --prefix apps/desktop run dev
```
The desktop app is offline-first and uses the same local service.

## Updates (Local)
Orchestrum updates are fully local/offline. Place `version.json` for the available update under:
```
~/.orchestrum/updates/version.json
```

Check for updates:
```bash
orchestrum update check
```

Install from a local update package:
```bash
orchestrum update install /path/to/update.tar.gz
```

PowerShell helper:
```bash
./scripts/install-update.ps1 -Package /path/to/update.tar.gz
```

Optional legacy flow:
```bash
orchestrum self-update --file /path/to/orchestrum.tgz
```

## Run a Workflow
```bash
npx orchestrum run packages/core/workflows/default.yaml --repo /path/to/your/repo --goal "Describe the change you want"
```

Optional flags:
```bash
npx orchestrum run packages/core/workflows/default.yaml --repo /path/to/repo --goal "..." --runs-dir /path/to/runs
npx orchestrum run packages/core/workflows/default.yaml --repo /path/to/repo --goal "..." --branch feature/x
npx orchestrum run packages/core/workflows/default.yaml --repo /path/to/repo --goal "..." --sandbox docker
npx orchestrum run packages/core/workflows/default.yaml --repo /path/to/repo --goal "..." --workspace my-workspace
```

## Resume / Cancel / Replay
```bash
npx orchestrum resume <runId> --from <stepId>
npx orchestrum cancel <runId>
npx orchestrum replay <runId>
```

The UI includes **Retry From Here** and **Cancel Run** buttons.

## Run Recovery
If a run crashes mid-flight, the service marks it as `interrupted` on startup. The home page shows a **Recovery** banner so you can resume from the last safe step.

## Storage Layout
Runs are stored under `./runs/<workspaceId>/<runId>/` (legacy runs remain under `./runs/<runId>/`):
- `run.json`
- `events.ndjson`
- `steps/<stepId>/input.json`
- `steps/<stepId>/input.hash`
- `steps/<stepId>/output.md`
- `steps/<stepId>/output.json` (when applicable)
- `steps/<stepId>/arbitration.json` (when multi-model arbitration runs)
- `steps/<stepId>/arbitration/<provider-model>.md`
- `steps/<stepId>/git.diff`
- `steps/<stepId>/commands.log`
- `steps/<stepId>/status.json`
- `steps/<stepId>/container.log` (when sandboxed)
- `approvals/<stepId>.json` (approval request)
- `approvals/<stepId>.approved` (approval grant)

Workspace memory files live under the target repo:
- `.memory/prompt_history.json`
- `.memory/analytics.json`
- `.memory/opportunities.json`
- `.memory/strategy_state.json`
- `.memory/knowledge.json`
- `.memory/adaptation.json`
- `.memory/tournaments.json`
- `.memory/evaluations.json`
- `.memory/roadmap.json`
- `.memory/summaries.json`

Other local product folders:
- `logs/` (service logs)
- `backups/` (backup archives)
- `diagnostics/` (crash reports and bundles)

## Storage Versioning and Migrations
Each run stores `schemaVersion` in `run.json`. The service migrates older runs on startup using `packages/core/migrations`.

## Environment Variables
- `OPENAI_API_KEY` (required for provider=openai)
- `OPENAI_API_BASE_URL` or `OPENAI_BASE_URL` (optional, default `https://api.openai.com/v1`)
- `OPENAI_API_MODE` (optional: `auto`, `responses`, `chat`)
- `ORCHESTRUM_LOCAL_LLM_ENDPOINT` (optional override for local LLM providers)
- `ORCHESTRUM_RUNS_DIR` (optional override for UI to read runs)
- `ORCHESTRUM_SECRETS_PASSPHRASE` (required to store encrypted secrets in `.secrets.enc`)
- `ORCHESTRUM_USE_KEYCHAIN` (set to `1` to prefer OS keychain, used in desktop mode)
- `ORCHESTRUM_SERVICE_PORT` (override local service port)
- `ORCHESTRUM_UI_PORT` (override desktop UI port)

## Secrets Management
Store secrets without writing them to run artifacts:
```bash
orchestrum secrets set OPENAI_API_KEY --value sk-... --scope global
orchestrum secrets list --scope global
orchestrum secrets unset OPENAI_API_KEY --scope global
```
For encrypted storage, set `ORCHESTRUM_SECRETS_PASSPHRASE`. In desktop mode, the app uses the OS keychain when available.
Keychain support uses the optional `keytar` dependency.
When running the service/UI, ensure `ORCHESTRUM_SECRETS_PASSPHRASE` is available in the environment so the service can decrypt stored secrets.

## Workspace Profiles
Each workspace can override defaults with `.orchestrum/profile.json`:
```json
{
  "risk_tolerance": "low",
  "max_cost_per_run": 1.0,
  "default_strategy": "balanced",
  "sandbox_mode": "docker"
}
```
Profiles merge into config before CLI overrides.

## Config Layering
Config precedence:
1. CLI flags
2. Workspace profile `<repo>/.orchestrum/profile.json`
3. Workspace config `<repo>/.orchestrum/config.json`
4. Global config `~/.orchestrum/config.json`
5. Workflow defaults

## Config File (`orchestrum.config.json`)
Optional per-repo defaults:
```json
{
  "defaultWorkflow": "packages/core/workflows/default.yaml",
  "concurrency": 3,
  "models": {
    "pm": "gpt-5",
    "dev": "codex",
    "audit": "gpt-5"
  },
  "arbitration": {
    "mode": "score",
    "min_models": 2
  },
  "local_llm": {
    "provider": "ollama",
    "endpoint": "http://localhost:11434",
    "model": "llama3"
  },
  "cluster": {
    "enabled": true,
    "min_workers": 2,
    "max_workers": 6,
    "queue_dir": "./runs/.cluster"
  },
  "reward": {
    "success_weight": 1,
    "cost_weight": 0.3,
    "loop_penalty": 0.2,
    "risk_penalty": 0.4
  },
  "sandbox": {
    "enabled": true,
    "image": "node:20-alpine"
  },
  "telemetry": {
    "enabled": false
  },
  "plugins": [
    "packages/plugins/log-to-console.ts",
    "packages/plugins/cost-alert.ts"
  ],
  "pricing": {
    "gpt-5": { "prompt_per_1k": 0.005, "completion_per_1k": 0.015 }
  }
}
```

## Backups and Restore
Create a compressed archive of runs, memory, and configs:
```bash
orchestrum backup create
orchestrum backup restore ./backups/backup-<timestamp>.tar.gz --into /path/to/restore
```

## Templates (Export/Import)
Export a workflow + prompts to a portable `.orct`:
```bash
orchestrum template export ./packages/core/workflows/default.yaml --output my-template.orct
```

Import into a workspace:
```bash
orchestrum template import my-template.orct --repo /path/to/repo
```

The UI **Templates** page supports drag-and-drop import.

## Share / Import Runs (Local)
Share a run bundle:
```bash
orchestrum share <runId> --workspace <id>
```

Import a shared run:
```bash
orchestrum import-run ./exports/<runId>.orun
```

## Diagnostics
Export a local diagnostics bundle (no secrets included):
```bash
orchestrum diagnostics export --workspace <id> --run <runId>
```
The UI **Diagnostics** page can also export bundles and tail logs.
Service logs are stored under `logs/service.ndjson`, and per-run logs under `runs/<workspace>/<runId>/logs/runner.ndjson`.

## Strategy File (`orchestrum.strategy.json`)
```json
{
  "mode": "balanced",
  "available_modes": ["aggressive", "balanced", "conservative"]
}
```
Strategies adjust loop rounds, parallelism, auto-test behavior, and cost tolerance. Strategy decisions and suggestions are logged in `run.json`.

## Prompt Evolution
After each run, prompt performance is scored and suggestions are stored in:
```
.memory/prompt_history.json
```
Use the UI **Prompt Evolution** tab to approve/reject suggestions or roll back to previous versions.

## Opportunities (Backlog Refinement)
The system stores backlog suggestions in:
```
.memory/opportunities.json
```
The UI **Opportunities** tab provides a one-click improvement workflow trigger.

## Red-Team Security Phase
Add a `type: red_team` step to simulate adversarial behavior. If the vulnerability score exceeds the workflow security threshold, the run is blocked and emits `security.alert`.

## CI Watch Mode
```bash
npx orchestrum ci --watch --repo /path/to/repo
```
Watches for new commits, runs audit/tests, and auto-fixes minor issues. Unsafe runs create `needs-review.md` in the run folder.

## Experiment Mode
```bash
npx orchestrum experiment --repo /path/to/repo --strategy aggressive
```
Runs the workflow across strategy modes and stores comparison results under:
```
runs/<workspaceId>/experiments/
```

## Simulation Mode
```bash
npx orchestrum simulate --repo /path/to/repo --cost-limit 1.0
```
Estimates cost, token usage, loops, and risk without calling the LLM.

## Analytics
Long-term analytics are stored in:
```
.memory/analytics.json
```
The UI **Analytics** tab shows cost trends, success rate, loop frequency, reward trends, model win-rate, determinism scores, and worker utilization.

## Policy File (`orchestrum.policy.json`)
```json
{
  "max_files_changed": 20,
  "forbidden_paths": ["src/security/critical.ts"],
  "max_cost_usd": 2.0
}
```

If a policy is violated, the runner emits `policy.violation` and stops the run.

## Docker Sandbox
Run DEV/AUDIT LLM calls inside a temporary container:
```bash
npx orchestrum run packages/core/workflows/default.yaml --repo /path/to/repo --sandbox docker
```

The repo and run folder are mounted read-write, and `container.log` is stored under the step folder. If Docker is unavailable, the runner falls back to local mode and logs a warning.

## Multi-Model Arbitration
Define multiple providers per agent or step:
```yaml
agents:
  dev:
    providers:
      - openai:codex
      - openai:gpt-5
arbitration:
  mode: score
  min_models: 2
```
Each candidate runs in parallel; the winner is selected by scoring (policy compliance, patch validity, test signal, token efficiency). Results are stored in `steps/<stepId>/arbitration.json` and per-model outputs.

## Local LLM Providers
Supported local providers:
- `ollama`
- `llama_cpp`

Configure in `orchestrum.config.json`:
```json
{
  "local_llm": {
    "provider": "ollama",
    "endpoint": "http://localhost:11434",
    "model": "llama3"
  }
}
```
If `OPENAI_API_KEY` is missing, the runner falls back to the local provider when available.

## Local Worker Cluster
Start a local worker pool to offload LLM calls:
```bash
npx orchestrum cluster start --workers 4 --workspace default
```
Workers listen on a filesystem queue under `./runs/<workspaceId>/.cluster` (or `cluster.queue_dir`).

## Tournament Mode
```bash
npx orchestrum tournament --repo /path/to/repo
```
Runs the workflow across strategies/models/prompts and stores results under `.memory/tournaments.json`.

## Deterministic Evaluation
```bash
npx orchestrum evaluate packages/core/workflows/default.yaml --repo /path/to/repo --runs 5
```
Stores determinism scores in `.memory/evaluations.json`.

## Roadmap Mode
```bash
npx orchestrum roadmap run roadmap.yaml --repo /path/to/repo
```
Executes milestones sequentially and stores progress in `.memory/roadmap.json`.

## Safety Guardrails & Approvals
High-risk commands or diffs trigger an approval gate. The UI shows an **Approval Required** modal; approvals are stored under `runs/<runId>/approvals/`.

## Capability Tiers
Define per-agent capabilities:
```yaml
capabilities:
  pm:
    filesystem: read
    network: false
    shell: false
  dev:
    filesystem: read_write
    network: false
    shell: limited
```

## Knowledge Graph
Cross-run knowledge relationships are stored in `.memory/knowledge.json` and injected into prompt context.

## Reward Adaptation
After each run, a reward is computed and used to bias future strategy/model selection. State is stored in `.memory/adaptation.json`.

## Workflow Schema Highlights
Workflows live in `packages/core/workflows/`.

Key fields:
- `agents`: provider/model per agent (unlimited agents allowed)
- `agents.providers` / `steps.providers`: multi-model arbitration candidates
- `arbitration`: scoring/fastest/vote selection rules
- `concurrency.max_agents`: global LLM concurrency limit
- `loop.max_rounds`, `loop.max_loop_per_step`: audit/fix loop control
- `steps`: ordered steps
- `parallel: true` with `substeps`: run substeps concurrently
- `continue_on_error`: allow a step to fail without stopping the run
- `phase`: used for timeline grouping in UI
- `capabilities`: per-agent filesystem/network/shell policy
- `type: test_generation`: DEV generates tests under `__orchestrum_generated_tests__/`
- `type: red_team`: run a security simulation step
- `security.threshold`: block run if vulnerability exceeds threshold
- `enable_auto_tests`: toggle test generation steps

### Parallel Step Example
```yaml
steps:
  - id: analysis
    parallel: true
    prompt: ../prompts/audit.md
    substeps:
      - id: security_scan
        agent: audit
      - id: performance_scan
        agent: audit
```

### Dynamic Agent Spawn Example
If a PM step outputs:
```json
{
  "agents": [
    { "id": "security", "role": "audit" },
    { "id": "performance", "role": "audit" }
  ]
}
```
The runner registers new agents and executes their steps in parallel, emitting `agent.spawned`.

## Caching
Each step stores `input.hash`. If the hash matches a previous execution, the runner skips the LLM call and reuses the output, emitting `step.cached`.

## Branch + Commit Mode
With `--branch`, the runner creates/resets the branch at start and commits after successful patch steps. Commit SHAs are recorded in step metadata.

## Cost & Token Tracking
Usage is stored per step (`usage.json` and `status.json`) and aggregated into `run.json` with:
- `totalTokens`
- `totalCost`
- `costByAgent`

The UI shows a Metrics tab with per-agent costs and tokens per step.

## Structured Memory
Each workspace stores summaries under `.memory/summaries.json`. Recent summaries are added to PM context for new runs. A placeholder `.memory/embeddings.json` is created for future use.

## Plugin System
Plugins can be installed locally into `~/.orchestrum/plugins/` and enabled/disabled via the UI or CLI.
Plugins are local-first and free to use.

```bash
orchestrum plugin install /path/to/plugin
orchestrum plugin list
orchestrum plugin enable plugin-name
orchestrum plugin disable plugin-name
orchestrum plugin remove plugin-name
```

Plugin interface:
```ts
export interface OrchestrumPlugin {
  name: string;
  onRunStart?(runState)
  onStepStart?(stepState)
  onStepFinish?(stepState)
  onRunFinish?(runState)
}
```

Plugins use a `plugin.json` manifest:
```json
{
  "name": "security-audit-plus",
  "version": "1.0.0",
  "capabilities_required": ["audit"],
  "min_tier": "Pro"
}
```
Note: `min_tier` is retained for compatibility but is not enforced in the open-source edition.

Example plugins (dev):
- `packages/plugins/log-to-console.ts`
- `packages/plugins/cost-alert.ts`

## Telemetry (Opt-In)
Telemetry is disabled by default. Enable explicitly:
```bash
orchestrum telemetry enable
orchestrum telemetry disable
```
When enabled, only anonymized metrics (duration, tokens, cost) are recorded.

## Troubleshooting
- **Missing OPENAI_API_KEY**: Configure `local_llm` for fallback or set the key.
- **Not a git repo**: Initialize with `git init` or point `--repo` at a valid repo.
- **Patch apply failures**: Ensure the model outputs a valid unified diff. If `git apply` fails, the runner falls back to `patch`.
- **Docker unavailable**: The runner falls back to local execution and logs a warning.
- **UI shows no runs**: Confirm `./runs` exists under the repo root or set `ORCHESTRUM_RUNS_DIR` for the UI.
- **SSE not streaming**: Check `runs/<runId>/events.ndjson` is being appended.
- **Approval required**: Approve via the UI or create `runs/<runId>/approvals/<stepId>.approved` and resume.

## Commands Recap
- `npm install`
- `npm run dev`
- `orchestrum ui`
- `npx orchestrum workspace add /path/to/repo`
- `npx orchestrum run packages/core/workflows/default.yaml --repo /path/to/repo --goal "Your goal"`
- `npx orchestrum resume <runId> --from <stepId>`
- `npx orchestrum cancel <runId>`
- `npx orchestrum replay <runId>`
- `orchestrum backup create`
- `orchestrum backup restore <file> --into /path`
- `orchestrum secrets set OPENAI_API_KEY --value ...`
- `orchestrum secrets unset OPENAI_API_KEY`
- `orchestrum update check`
- `orchestrum update install /path/to/update.tar.gz`
- `orchestrum plugin install /path/to/plugin`
- `orchestrum template export ./workflow.yaml --output my-template.orct`
- `orchestrum template import my-template.orct --repo /path/to/repo`
- `orchestrum share <runId> --workspace <id>`
- `orchestrum import-run ./exports/<runId>.orun`
- `orchestrum telemetry enable`
- `npx orchestrum ci --watch --repo /path/to/repo`
- `npx orchestrum experiment --repo /path/to/repo`
- `npx orchestrum simulate --repo /path/to/repo --cost-limit 1.0`
- `npx orchestrum tournament --repo /path/to/repo`
- `npx orchestrum evaluate packages/core/workflows/default.yaml --repo /path/to/repo --runs 5`
- `npx orchestrum roadmap run roadmap.yaml --repo /path/to/repo`
- `npx orchestrum cluster start --workers 4 --workspace default`
- `orchestrum self-update --file /path/to/orchestrum.tgz`

## Acceptance Checklist
- Install dependencies
- Start service + UI with `orchestrum ui`
- Add a workspace
- Run a workflow
- See live graph updates
- Cancel and resume a run
- Simulate crash recovery (stop runner mid-run and restart service)
- Create and restore a backup
- Set and unset secrets
- Check for updates
- Install a plugin and toggle enable/disable
- Save a workspace profile
- Export/import a template
- Share/import a run bundle
- Toggle telemetry (opt-in)
- Export diagnostics bundle
- Build desktop app (optional)
