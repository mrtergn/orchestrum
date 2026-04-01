# Plugins

Plugins run locally and are loaded per workspace from `.orchestrum/control/plugins/`.
Enabled plugins receive lifecycle hooks for mission runs and browser runs.
Plugins are registry-only: install them into the current workspace, then enable them by name.

## Plugin Interface
```ts
export interface OrchestrumPlugin {
  name: string;
  onRunStart?(runState)
  onStepStart?(stepState)
  onStepFinish?(stepState)
  onRunFinish?(runState)
}
```

## Manifest (`plugin.json`)
```json
{
  "name": "security-audit-plus",
  "version": "1.0.0",
  "entry": "index.js",
  "capabilities_required": ["run.start", "step.finish"]
}
```

## Install / Enable / Remove
```bash
orchestrum plugin install /path/to/plugin
orchestrum plugin list
orchestrum plugin enable security-audit-plus
orchestrum plugin disable security-audit-plus
orchestrum plugin remove security-audit-plus
```

## Notes
- Plugins are trusted workspace-local JavaScript hooks, not sandboxed extensions.
- Direct path plugin imports are not supported in runtime config.
- Plugin hook failures are non-fatal, but they are recorded in workspace signals and visible in observability surfaces.
- `capabilities_required` is validated at install and enable time; unsupported capabilities are rejected.
