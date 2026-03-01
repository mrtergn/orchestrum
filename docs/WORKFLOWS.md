# Workflows

Workflows are YAML files that define agents, steps, loops, and parallel execution.

## Minimal Example
```yaml
name: "Quick Spec"
agents:
  pm:
    provider: openai
    model: gpt-5
steps:
  - id: spec
    agent: pm
    prompt: ../prompts/spec.md
    inputs:
      - user_goal
      - repo_context
    outputs:
      - output.md
```

## Key Fields
- `agents`: map of agent ids to provider/model or providers list
- `steps`: ordered list of steps
- `parallel: true` with `substeps`: run substeps concurrently
- `loop.max_rounds`: audit/fix loop control
- `capabilities`: per-agent permissions

## Parallel Steps
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

## Dynamic Agents
If a step outputs:
```json
{ "agents": [ { "id": "security", "role": "audit" } ] }
```
the runner registers the new agent and schedules its steps.

## Red-Team Phase
```yaml
steps:
  - id: red_team
    type: red_team
    agent: audit
    prompt: ../prompts/red_team.md
```

## Test Generation
```yaml
enable_auto_tests: true
steps:
  - id: generate_tests
    type: test_generation
    agent: dev
```

## Arbitration
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

## Capabilities
```yaml
capabilities:
  dev:
    filesystem: read_write
    shell: limited
    network: false
```
