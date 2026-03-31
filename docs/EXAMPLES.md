# Examples

This page contains practical scenarios you can run immediately.

## 1. Fix Failing CI

Use the CI workflow to inspect the repository, produce a fix, and run tests:

```bash
npx orchestrum run packages/core/workflows/ci.yaml \
  --repo /path/to/repo \
  --goal "Fix failing pipeline checks"
```

If the run pauses for approval:

```bash
npx orchestrum approve <TOKEN>
```

Then resume:

```bash
npx orchestrum resume <RUN_ID> --from fix
```

## 2. Review PR Diff

Run a mission focused on auditing changes before merge:

```bash
npx orchestrum mission start \
  --template feature-dev \
  --workspace default \
  --goal "Review current branch diff for regression, security, and test gaps"
```

Useful follow-up commands:

```bash
npx orchestrum runs --workspace default
npx orchestrum logs <RUN_ID>
```

## 3. Generate Tests for a Module

Scope the mission goal narrowly to a specific module:

```bash
npx orchestrum mission start \
  --template feature-dev \
  --workspace default \
  --goal "Add tests for packages/core/src/runner/workflow.ts and keep behavior unchanged"
```

Recommended practice:
- Pin target files in the goal.
- Mention acceptance criteria explicitly.
- Require green tests as completion criteria.

## 4. Multi-Model Audit

Use providers with arbitration to compare outputs:

```yaml
name: Multi-Model Audit
agents:
  audit:
    providers:
      - openai:gpt-5
      - claude:sonnet
arbitration:
  mode: score
  min_models: 2
steps:
  - id: audit
    agent: audit
    phase: verify
    prompt: ../prompts/audit.md
    inputs:
      - repo_context
      - git.diff
    outputs:
      - output.json
```

Run it:

```bash
npx orchestrum run /path/to/multi-model-audit.yaml --repo /path/to/repo --goal "Audit latest changes"
```

## 5. Cursor-Based Dev Loop

Configure an agent to use Cursor CLI transport:

```json
{
  "mission": {
    "agents": {
      "dev": {
        "vendor": "cursor",
        "transport": "cli",
        "profileId": "cursor-cli-sonnet"
      }
    }
  }
}
```

Then run:

```bash
npx orchestrum mission start \
  --template feature-dev \
  --workspace default \
  --goal "Implement requested feature using Cursor-backed dev agent"
```

## 6. Delivery Sprint With Auto-CLI Packets

Start delivery session:

```bash
npx orchestrum delivery run \
  --repo /path/to/repo \
  --workspace default \
  --goal "Prepare sprint handoff packets for API hardening"
```

Export packet for Codex:

```bash
npx orchestrum delivery export <PACKET_ID> --run <RUN_ID> --target codex --format markdown
```

Import completed response:

```bash
npx orchestrum delivery import --run <RUN_ID> --packet <PACKET_ID> --target codex --file /tmp/response.md
```

## 7. Browser QA Canary

Run periodic browser checks:

```bash
npx orchestrum qa canary --repo /path/to/repo --workspace default --base-url http://localhost:3000
```

If you need deterministic cadence, set options in UI run modal or API payload.

## 8. Run in Docker Sandbox

Use sandbox mode for isolated execution:

```bash
npx orchestrum run packages/core/workflows/default.yaml \
  --repo /path/to/repo \
  --goal "Refactor module safely" \
  --sandbox docker
```

## 9. Local LLM Fallback

Point to local provider endpoints:

```json
{
  "local_llm": {
    "provider": "ollama",
    "endpoint": "http://localhost:11434",
    "model": "llama3.1:8b"
  }
}
```

## 10. Cluster Execution

Start worker cluster:

```bash
npx orchestrum cluster start --workers 4 --workspace default
```

Then run workflow with cluster-enabled config.

## 11. Share Run Bundle

Export and import run bundles:

```bash
npx orchestrum share export --run <RUN_ID> --workspace default
npx orchestrum share import --archive /path/to/archive.tar.gz --workspace default
```

## 12. Recovery After Interruptions

Recover interrupted runs:

```bash
npx orchestrum doctor --root /path/to/repo
```

Then resume with:

```bash
npx orchestrum resume <RUN_ID> --from <STEP_ID>
```
