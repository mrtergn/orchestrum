# Upgrade Notes

## Schema Version 2
- `run.json` now stores `schemaVersion`.
- Runs gain `pinned` and `tags` defaults.
- The service runs migrations on startup and marks interrupted runs as `interrupted`.

## Productization Changes
- Use `orchestrum ui` for one-command service + UI startup.
- Workspaces and configs are layered via `~/.orchestrum/config.json` and `<repo>/.orchestrum/config.json`.
- Secrets can be stored in `.secrets.enc` with `ORCHESTRUM_SECRETS_PASSPHRASE` or OS keychain in desktop mode.
- `version.json` still defines the current build, while GitHub Releases can now populate the cached update metadata used by the UI and CLI.
- Workspace profiles live at `<repo>/.orchestrum/profile.json`.
- Licensing has been removed; all features are available by default.
