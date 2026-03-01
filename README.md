<div align="center">

<br/>

<img alt="Orchestrum" src="apps/ui/public/favicon.svg" width="80">

# Orchestrum

### **The Local-First AI Engineering OS**

*Define agents. Wire org charts. Let AI plan, build, audit, and deploy —<br/>all without sending a single line of code to third parties.*

<br/>

[![MIT License](https://img.shields.io/badge/license-MIT-10b981?style=for-the-badge&logo=opensourceinitiative&logoColor=white)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3b82f6?style=for-the-badge&logo=typescript&logoColor=white)](tsconfig.base.json)
[![Next.js](https://img.shields.io/badge/Next.js_14-black?style=for-the-badge&logo=next.js&logoColor=white)](apps/ui)
[![Node 18+](https://img.shields.io/badge/Node.js-18%2B-5fa04e?style=for-the-badge&logo=node.js&logoColor=white)](package.json)
[![Electron](https://img.shields.io/badge/Electron-Desktop-47848f?style=for-the-badge&logo=electron&logoColor=white)](apps/desktop)

<br/>

[Getting Started](#-getting-started) · [Features](#-features) · [Architecture](#-architecture) · [CLI Reference](#-cli-reference) · [Docs](#-documentation) · [Contributing](#-contributing)

<br/>

---

</div>

<br/>

## 🎬 See It in Action

<div align="center">

```
 ┌───────────────────────────────────────────────────────────────┐
 │                                                               │
 │   [ PM Agent ] ──> [ Dev Agent ] ──> [ Audit ] ──> [ Done ]  │
 │       |                |                |                     │
 │       v                v                v                     │
 │    Spec.md          Code.diff       Review.md     Metrics     │
 │                                                   Analytics   │
 │                                                   Audit Trail │
 │                                                               │
 │              * All data stays on YOUR machine *               │
 │                                                               │
 └───────────────────────────────────────────────────────────────┘
```

</div>

> **Orchestrum is not a SaaS.** There's no cloud, no telemetry by default, no vendor lock-in. It's an engineering OS that runs on your laptop, manages AI agent teams, and keeps every artifact on your local filesystem.

<br/>

## ✨ Features

<table>
<tr>
<td width="50%" valign="top">

### 🤖 Agent Management
- Create unlimited AI agents (PM, Dev, Audit, QA, …)
- Support for **OpenAI**, **Claude**, **Ollama**, **llama.cpp**
- Per-agent capabilities (filesystem, network, shell)
- Dynamic agent spawning at runtime
- Onboarding wizard for instant setup

</td>
<td width="50%" valign="top">

### 🏗️ Org Chart
- Visual hierarchy builder with drag & drop
- Define reporting lines between agents
- Role-colored cards (PM · Dev · Audit · QA)
- CSS tree connectors — see who reports to whom instantly

</td>
</tr>
<tr>
<td width="50%" valign="top">

### ⚡ Task Queue & Execution
- Assign tasks to agents from the UI
- Real-time output streaming via SSE
- Cancel, retry, and monitor live
- Attempt tracking with progress bars
- Approval gates for high-risk actions

</td>
<td width="50%" valign="top">

### 🎯 Mission Control
- Live dashboard with SSE event stream
- Agent status, task progress, cost tracking
- Color-coded event tape
- One-click run launching

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🔬 Multi-Model Arbitration
- Run multiple LLMs in parallel per step
- Score winners by policy compliance, patch quality, token efficiency
- Supports `score` / `fastest` / `vote` selection modes
- Full audit trail of all candidate outputs

</td>
<td width="50%" valign="top">

### 🐳 Sandboxed Execution
- Docker container isolation for agent actions
- Non-root, network-disabled by default
- Automatic fallback to local execution
- Full container logs per step

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 📊 Analytics & Metrics
- Cost trends, success rates, loop frequency
- Model win-rate and determinism scores
- Token tracking per agent and per step
- KPI dashboard with spark charts

</td>
<td width="50%" valign="top">

### 🔌 Plugin System
- Local plugin installation (`~/.orchestrum/plugins/`)
- Lifecycle hooks: `onRunStart`, `onStepFinish`, …
- Toggle enable/disable from UI
- Capability-based permissions

</td>
</tr>
</table>

<details>
<summary><strong>🔽 Click to see even more features</strong></summary>
<br/>

| Feature | Description |
|---------|-------------|
| **🗺️ Roadmap Mode** | Execute milestones sequentially with progress tracking |
| **🏆 Tournament Mode** | Compare strategies/models/prompts head-to-head |
| **🧪 Experiment Mode** | Run workflows across strategy modes and compare |
| **🎭 Simulation Mode** | Estimate cost, tokens & risk without calling the LLM |
| **👁️ CI Watch Mode** | Watch for commits, auto-audit, auto-fix minor issues |
| **🧬 Prompt Evolution** | Auto-score prompts, approve/reject/rollback suggestions |
| **🔴 Red-Team Security** | Adversarial simulation step with vulnerability scoring |
| **🧠 Knowledge Graph** | Cross-run knowledge injected into prompt context |
| **🎰 Reward Adaptation** | Reinforcement-style model/strategy selection |
| **📦 Backup & Restore** | Full archive of runs, memory, and configs |
| **📤 Template System** | Export/import portable `.orct` workflow bundles |
| **🔐 Secrets Management** | Encrypted storage with OS keychain support |
| **📱 Desktop App** | Electron wrapper, offline-first, same local service |
| **🧩 Workspace Profiles** | Per-repo config overrides for risk, cost, strategy |
| **⚡ Step Caching** | Input hash deduplication — skip repeated LLM calls |
| **🌿 Branch + Commit** | Auto-branch, auto-commit with SHA tracking |
| **🔄 Cluster Mode** | Local worker pool with filesystem-based queue |
| **💊 Crash Recovery** | Auto-detect interrupted runs, resume from last safe step |
| **📋 Schema Migrations** | Automatic run schema upgrades on service start |

</details>

<br/>

## 🚀 Getting Started

### Prerequisites

| Requirement | Version |
|-------------|---------|
| **Node.js** | 18+ |
| **npm** | 9+ |
| **Git** | Any (repo must be initialized) |
| Docker | Optional — for `--sandbox docker` |

### Install & Launch

```bash
# Clone and install
git clone https://github.com/mrtergn/orcherstrum.git
cd orcherstrum
npm install

# 🚀 One command to start everything
npx orchestrum ui
```

Then open **[http://localhost:3000](http://localhost:3000)** — that's it.

<details>
<summary><strong>⚙️ Other ways to start</strong></summary>

```bash
# Global install
npm i -g orchestrum
orchestrum ui

# Dev mode (separate service + UI)
npm run service    # Terminal 1
npm run dev        # Terminal 2

# Desktop app
npm run build:desktop
npm run dist:desktop
```

</details>

<br/>

### First Run — GUI Onboarding

```
  1. Open Orchestrum UI
  2. Complete the onboarding wizard:
     ├─ Save your provider API key
     ├─ Create PM / Dev / Audit agents
     ├─ Auto-generate org chart
     └─ Enqueue a demo task
  3. Use Tasks page to assign real work
  4. Watch live execution on Mission Control
```

<br/>

## 🏛️ Architecture

```
                    ┌──────────────────────────────────┐
                    │        apps/ui (Next.js 14)      │
                    │  ┌──────┬──────┬──────┬───────┐  │
                    │  │Agents│ Org  │Tasks │Mission│  │
                    │  │      │Chart │Queue │Control│  │
                    │  └──┬───┴──┬───┴──┬───┴───┬───┘  │
                    └─────┼──────┼──────┼───────┼──────┘
                          │      │      │       │
                     REST + SSE  │      │       │
                          │      │      │       │
                    ┌─────▼──────▼──────▼───────▼──────┐
                    │     packages/service (Express)    │
                    │   HTTP API · SSE Stream · Index   │
                    └──────────────┬────────────────────┘
                                  │
                    ┌─────────────▼─────────────────────┐
                    │       packages/core (Engine)       │
                    │  ┌────────┬────────┬────────────┐  │
                    │  │Runner  │Sandbox │ Analytics   │  │
                    │  │Policy  │Cluster │ Evolution   │  │
                    │  │Plugins │Security│ Arbitration │  │
                    │  └────────┴────────┴────────────┘  │
                    └──────────────┬────────────────────┘
                                  │
                    ┌─────────────▼─────────────────────┐
                    │     Filesystem Persistence         │
                    │  runs/ · .memory/ · logs/ · etc.   │
                    └───────────────────────────────────┘
```

<details>
<summary><strong>📂 Project Structure</strong></summary>

```
orcherstrum/
├── apps/
│   ├── ui/                 # Next.js 14 frontend
│   └── desktop/            # Electron wrapper
├── packages/
│   ├── core/               # Engine: runner, sandbox, policy, analytics
│   │   ├── prompts/        # Agent prompt templates
│   │   ├── workflows/      # YAML workflow definitions
│   │   └── src/
│   │       ├── agents/     # Agent management
│   │       ├── orchestration/
│   │       ├── security/   # Red-team, approvals
│   │       ├── evolution/  # Prompt evolution
│   │       ├── arbitration/# Multi-model scoring
│   │       └── ...
│   ├── service/            # Express HTTP + SSE server
│   ├── cli/                # CLI entry point
│   ├── analytics/          # Cost & performance tracking
│   ├── plugins/            # Built-in plugin examples
│   ├── sandbox/            # Docker isolation
│   ├── security/           # Security scanning
│   └── ...
├── docs/                   # Extended documentation
├── runs/                   # Run artifacts (git-ignored)
└── scripts/                # Build & release helpers
```

</details>

<br/>

## 🧩 Multi-Repo Workspaces

Register any number of repos and keep runs partitioned:

```bash
orchestrum workspace add /path/to/repo-a
orchestrum workspace add /path/to/repo-b
orchestrum workspace list
```

Each workspace gets its own:
- Runs directory (`runs/<workspaceId>/`)
- Memory store (`.memory/`)
- Config profile (`.orchestrum/profile.json`)

Switch between workspaces from the UI sidebar.

<br/>

## ⚔️ Multi-Model Arbitration

Run multiple LLMs in parallel and pick the best output:

```yaml
agents:
  dev:
    providers:
      - openai:codex
      - openai:gpt-5
arbitration:
  mode: score       # score | fastest | vote
  min_models: 2
```

The scoring engine evaluates each candidate on:
- ✅ Policy compliance
- 🔧 Patch validity
- 🧪 Test signal
- 💰 Token efficiency

Full results stored in `steps/<stepId>/arbitration.json`.

<br/>

## 🔒 Security & Isolation

| Layer | Protection |
|-------|------------|
| **Sandbox** | Docker containers with no network, non-root user |
| **Approvals** | Human-in-the-loop gates for high-risk actions |
| **Policy** | Max files changed, forbidden paths, cost limits |
| **Red-Team** | Adversarial simulation with vulnerability scoring |
| **Secrets** | AES-encrypted storage, OS keychain integration |
| **Capabilities** | Per-agent filesystem/network/shell restrictions |

<br/>

## 💻 CLI Reference

<details>
<summary><strong>Click to expand full CLI reference</strong></summary>

```bash
# ── Launch ──────────────────────────────────
orchestrum ui                                     # Start service + UI

# ── Workflows ───────────────────────────────
orchestrum run <workflow.yaml> --repo <path>      # Run a workflow
  --goal "description"                            # What to build
  --branch feature/x                              # Auto-branch
  --sandbox docker                                # Container isolation
  --workspace my-workspace                        # Target workspace

# ── Run Control ─────────────────────────────
orchestrum resume <runId> --from <stepId>         # Resume from step
orchestrum cancel <runId>                         # Cancel a run
orchestrum replay <runId>                         # Replay entire run

# ── Workspaces ──────────────────────────────
orchestrum workspace add /path/to/repo
orchestrum workspace list

# ── Secrets ─────────────────────────────────
orchestrum secrets set KEY --value val --scope global
orchestrum secrets list --scope global
orchestrum secrets unset KEY --scope global

# ── Templates ───────────────────────────────
orchestrum template export ./w.yaml --output t.orct
orchestrum template import t.orct --repo /path

# ── Plugins ─────────────────────────────────
orchestrum plugin install /path/to/plugin
orchestrum plugin list
orchestrum plugin enable <name>
orchestrum plugin disable <name>
orchestrum plugin remove <name>

# ── Advanced ────────────────────────────────
orchestrum cluster start --workers 4              # Worker pool
orchestrum ci --watch --repo /path                # CI watch mode
orchestrum experiment --repo /path                # Strategy comparison
orchestrum simulate --repo /path --cost-limit 1.0 # Dry run
orchestrum tournament --repo /path                # Model tournament
orchestrum evaluate <workflow> --repo /p --runs 5 # Determinism test
orchestrum roadmap run roadmap.yaml --repo /path  # Milestone exec

# ── Maintenance ─────────────────────────────
orchestrum backup create
orchestrum backup restore <file> --into /path
orchestrum diagnostics export --workspace <id>
orchestrum update check
orchestrum update install /path/to/update.tar.gz
orchestrum telemetry enable|disable
```

</details>

<br/>

## ⚙️ Configuration

Config is layered with clear precedence:

```
CLI flags  →  Workspace profile  →  Workspace config  →  Global config  →  Workflow defaults
```

<details>
<summary><strong>Example <code>orchestrum.config.json</code></strong></summary>

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
    "max_workers": 6
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
  ]
}
```

</details>

<details>
<summary><strong>Environment Variables</strong></summary>

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Required for OpenAI provider |
| `OPENAI_API_BASE_URL` | Custom endpoint (default: `api.openai.com/v1`) |
| `ORCHESTRUM_LOCAL_LLM_ENDPOINT` | Override local LLM endpoint |
| `ORCHESTRUM_RUNS_DIR` | Override runs directory |
| `ORCHESTRUM_SECRETS_PASSPHRASE` | Enable encrypted secret storage |
| `ORCHESTRUM_USE_KEYCHAIN` | `1` to use OS keychain (desktop mode) |
| `ORCHESTRUM_SERVICE_PORT` | Custom service port |
| `ORCHESTRUM_UI_PORT` | Custom UI port |

</details>

<br/>

## 📖 Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/ARCHITECTURE.md) | System design, data flow, storage model |
| [Workflows](docs/WORKFLOWS.md) | YAML schema, parallel steps, loops |
| [Plugins](docs/PLUGINS.md) | Plugin API, manifest, lifecycle hooks |
| [CLI](docs/CLI.md) | Full command reference |
| [Examples](docs/EXAMPLES.md) | Real-world usage examples |

<br/>

## 🛠️ Troubleshooting

<details>
<summary><strong>Common issues and quick fixes</strong></summary>

| Problem | Solution |
|---------|----------|
| Missing `OPENAI_API_KEY` | Set the key or configure `local_llm` for Ollama fallback |
| "Not a git repo" | Run `git init` or point `--repo` at an initialized repo |
| Patch apply failures | Runner auto-falls back from `git apply` to `patch` |
| Docker unavailable | Runner falls back to local execution with a warning |
| UI shows no runs | Verify `./runs` exists or set `ORCHESTRUM_RUNS_DIR` |
| SSE not streaming | Check `events.ndjson` is being appended |
| Approval stuck | Approve via UI or create `.approved` file and resume |

</details>

<br/>

## 🤝 Contributing

We welcome contributions! Before you start:

1. Read [CONTRIBUTING.md](CONTRIBUTING.md)
2. Review the [Code of Conduct](CODE_OF_CONDUCT.md)
3. Check [SECURITY.md](SECURITY.md) for vulnerability reporting

```bash
# Dev workflow
git clone https://github.com/mrtergn/orcherstrum.git
cd orcherstrum
npm install
npm run dev     # Starts Next.js dev server
```

<br/>

## 📄 License

Orchestrum is free and open source under the [MIT License](LICENSE).

<div align="center">

<br/>

---

<br/>

**Built with ❤️ for developers who want AI agents that respect their privacy.**

<br/>

*Your code never leaves your machine. That's a promise, not a feature.*

<br/>

<sub>If Orchestrum helps your workflow, consider giving it a ⭐</sub>

</div>
