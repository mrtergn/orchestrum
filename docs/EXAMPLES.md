# Examples

## Run a Workflow
```bash
npx orchestrum run packages/core/workflows/default.yaml --repo /path/to/repo --goal "Add a health check endpoint"
```

## Resume From Step
```bash
npx orchestrum resume 2026-02-28T100311553Z-v1ix --from implement
```

## Parallel Steps
```yaml
steps:
  - id: analysis
    parallel: true
    substeps:
      - id: security_scan
        agent: audit
      - id: perf_scan
        agent: audit
```

## Docker Sandbox
```bash
npx orchestrum run packages/core/workflows/default.yaml --repo /path/to/repo --sandbox docker
```

## Local LLM Fallback
```json
{
  "local_llm": {
    "provider": "ollama",
    "endpoint": "http://localhost:11434",
    "model": "llama3"
  }
}
```

## Multi-Model Arbitration
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

## Cluster
```bash
npx orchestrum cluster start --workers 4 --workspace default
```
