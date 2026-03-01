# CLI Reference

## UI
```bash
orchestrum ui
```
Starts the local service and UI together.

## Run
```bash
orchestrum run <workflow.yaml> --repo /path/to/repo
```
Options:
- `--goal "<text>"`
- `--runs-dir <path>`
- `--branch <name>`
- `--sandbox docker`
- `--workspace <id>`

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

## Diagnostics
```bash
orchestrum diagnostics export --workspace <id> --run <runId>
```

## Cluster
```bash
orchestrum cluster start --workers 4 --workspace default
```
