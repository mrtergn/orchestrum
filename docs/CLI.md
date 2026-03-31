# CLI Reference

## UI

```bash
orchestrum ui
```

Starts the local service and UI together.

## Workspaces

```bash
orchestrum workspace add /path/to/repo
orchestrum workspace list
```

## Missions

```bash
orchestrum mission start --template feature-dev --workspace demo --goal "Ship the feature"
orchestrum mission import --run mission-123 --node implement --workspace demo --file response.md
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
orchestrum delivery export packet-1 --run delivery-123 --workspace demo --target chatgpt
orchestrum delivery import --run delivery-123 --workspace demo --target chatgpt --file response.txt
orchestrum delivery findings --run delivery-123 --workspace demo
orchestrum delivery summary --workspace demo
```

Notes:
- `delivery export` supports `--format text|markdown|json`.
- `delivery import` exits non-zero when packet matching fails.
- `delivery doctor` inspects repo setup, tools, and preset readiness.

## Browser QA

```bash
orchestrum qa --repo /path/to/repo --workspace demo --base-url http://localhost:3000
orchestrum benchmark --repo /path/to/repo --workspace demo --base-url http://localhost:3000
orchestrum canary --repo /path/to/repo --workspace demo --base-url http://localhost:3000
```

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

## Updates

```bash
orchestrum update check --remote
orchestrum update install --remote
orchestrum update install ./orchestrum-update.tar.gz
```

## Cluster

```bash
orchestrum cluster start --workers 4 --workspace default
```
