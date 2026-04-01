# Release Checklist

## Preflight
- Run `npm run bootstrap`.
- Run `npm run verify`.
- Confirm `version.json` and `CHANGELOG.md` match the release.
- If shipping the Electron preview shell, confirm desktop packaging succeeds on macOS, Linux, and Windows.

## Update Feed
- Create a GitHub Release in `mrtergn/orchestrum`.
- Ensure the release notes are final.
- Keep a `.tar.gz` source/archive asset available so `orchestrum update install --remote` can select a portable archive.
- Verify `orchestrum update check --remote` surfaces the new version and release URL.

## Smoke
- Add a workspace.
- Save an OpenAI key in Settings.
- Start a run from the dashboard or `/runs`.
- Open `/runs/[id]` and confirm live stream, logs, artifacts, cancel/resume, and approval flows.
- Open `/diagnostics` and export a bundle.

## Desktop Preview Shell
- Build `npm run build:desktop`.
- Launch the unpacked desktop app and verify service boot, UI boot, dynamic port selection, and graceful shutdown.
- If code signing is intentionally disabled for the build, treat the output as a preview artifact rather than a signed release.
