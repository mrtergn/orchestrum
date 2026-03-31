# CLI Reference

## UI
```bash
orchestrum ui
```
Starts the local service and UI together.

## Delivery
```bash
orchestrum delivery doctor --repo /path/to/repo --workspace <id>
orchestrum delivery init-preset --repo /path/to/repo --workspace <id>
orchestrum delivery run --repo /path/to/repo --workspace <id> --goal "Sprint 10" --sprint "Sprint 10"
orchestrum delivery export <packetId> --run <runId> --workspace <id> --target chatgpt
orchestrum delivery import --run <runId> --workspace <id> --target chatgpt --file response.txt
orchestrum delivery findings --run <runId> --workspace <id>
orchestrum delivery summary --workspace <id>
```

Notes:
- `delivery export` supports `--format text|markdown|json`.
- `delivery import` is non-interactive. If packet matching is ambiguous, it prints candidate packet ids and exits non-zero.
- `delivery run` compiles repo context, team preset, learnings, and readiness into role-specific work packets.

## Workflow Runs
```bash
orchestrum run <workflow.yaml> --repo /path/to/repo
```
Options:
- `--goal "<text>"`
- `--runs-dir <path>`
- `--branch <name>`
- `--sandbox docker`
- `--workspace <id>`

## Browser QA / Benchmark / Canary
```bash
orchestrum qa --repo /path/to/repo --workspace <id> --base-url http://localhost:3000
orchestrum benchmark --repo /path/to/repo --workspace <id> --base-url http://localhost:3000
orchestrum canary --repo /path/to/repo --workspace <id> --base-url http://localhost:3000
```

## Resume / Cancel / Replay
```bash
orchestrum resume <runId> --from <stepId>
orchestrum cancel <runId>
orchestrum replay <runId>
```

## Workspace
```bash
orchestrum workspace add /path/to/repo
orchestrum workspace list
```

## Templates
```bash
orchestrum template export ./workflow.yaml --output my-template.orct
orchestrum template import my-template.orct --repo /path/to/repo
```

## Learnings / Docs / Readiness
```bash
orchestrum learnings list --repo /path/to/repo
orchestrum docs sync --repo /path/to/repo
orchestrum doctor --repo /path/to/repo
```

## Backup / Restore
```bash
orchestrum backup create
orchestrum backup restore ./backups/backup-<timestamp>.tar.gz --into /path
```

## Secrets
```bash
orchestrum secrets set OPENAI_API_KEY --value sk-... --scope global
orchestrum secrets list --scope global
orchestrum secrets unset OPENAI_API_KEY --scope global
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
