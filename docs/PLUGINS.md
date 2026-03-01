# Plugins

Plugins run locally and are loaded from `~/.orchestrum/plugins`.

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
  "capabilities_required": ["audit"]
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
- Plugins are sandboxed and do not have direct access to secrets.
- Use explicit capabilities to declare what a plugin requires.
