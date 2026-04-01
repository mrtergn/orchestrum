# CLI Reference

## UI

```bash
orchestrum ui
```

Starts the local service and UI together.
Ports are allocated dynamically; the command prints the resolved service and UI URLs instead of force-killing existing listeners.

## Workspaces

```bash
orchestrum workspace add /path/to/repo
orchestrum workspace list
```

Notes:
- Workspaces are resolved from repo-local `.orchestrum/control/workspace.json` manifests.
- The UI may remember recent repo paths in browser local storage, but the service does not keep a persistent global workspace registry.

## Missions

```bash
orchestrum mission start --repo /path/to/repo --template feature-dev --workspace demo --goal "Ship the feature"
orchestrum mission import --repo /path/to/repo --run mission-123 --node implement --workspace demo --file response.md
orchestrum cancel mission-123 --workspace demo
```

Notes:
- `mission start` uses built-in templates only.
- `mission import` is used for nodes that wait for external tool handoff.
- Legacy YAML workflow commands were removed.

## Delivery

```bash
orchestrum delivery doctor --repo /path/to/repo --workspace demo
orchestrum delivery init-preset --repo /path/to/repo --workspace demo
orchestrum delivery run --repo /path/to/repo --workspace demo --goal "Sprint 12"
orchestrum delivery export packet-1 --run mission-123 --workspace demo --target chatgpt
orchestrum delivery import --run mission-123 --workspace demo --target chatgpt --file response.txt
orchestrum delivery findings --run mission-123 --workspace demo
orchestrum delivery summary --workspace demo
```

Notes:
- `delivery run` starts the `delivery-sprint` mission template and returns a mission run id.
- `delivery export` supports `--format text|markdown|json`.
- `delivery import` exits non-zero when packet matching fails.
- `delivery doctor` inspects repo setup, tools, and preset readiness.

## Browser Smoke

```bash
orchestrum qa --repo /path/to/repo --workspace demo --base-url http://localhost:3000
orchestrum benchmark --repo /path/to/repo --workspace demo --base-url http://localhost:3000
orchestrum canary --repo /path/to/repo --workspace demo --base-url http://localhost:3000
```

Notes:
- `qa` is the browser smoke entry point.
- Browser scenarios can be attached through the API/UI for step-level browser evidence.

## Learnings, Docs, and Diagnostics

```bash
orchestrum learnings list --repo /path/to/repo
orchestrum docs sync --repo /path/to/repo
orchestrum doctor --workspace demo
orchestrum diagnostics export --workspace demo --run mission-123
```

## Secrets

```bash
orchestrum secrets set OPENAI_API_KEY --value sk-... --scope global
orchestrum secrets list --scope global
orchestrum secrets unset OPENAI_API_KEY --scope global
```

## Backup and Restore

```bash
orchestrum backup create
orchestrum backup restore ./backups/backup-123.tar.gz --into /tmp/orchestrum-restore
```

## Hidden Prerequisites

- `patch` for patch application workflows
- `lsof` for richer diagnostics
- Playwright browsers for browser smoke runs
- Provider CLI auth or API keys for the model transports you choose
- Optional `keytar` or Docker, depending on secret storage and sandbox mode
- Repo-local control state lives under `.orchestrum/control/`; only secrets, licensing, and update cache stay under `~/.orchestrum`

## Updates

```bash
orchestrum update check --remote
orchestrum update install --remote
orchestrum update install ./orchestrum-update.tar.gz
```
