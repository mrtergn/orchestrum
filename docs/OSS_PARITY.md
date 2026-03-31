# OSS Parity Checklist

- README install path matches the real bootstrap flow.
- UI route surface is complete for runs, diagnostics, changelog, about, help, and settings.
- Run API proxy surface exists for list, detail, logs, steps, stream, resume, cancel, share, import, and approve.
- Runtime status naming is canonicalized to `queued|running|succeeded|failed|cancelled`.
- Plugin, roadmap, analytics, and tournament surfaces are available without license gating.
- Update checks are explicit remote actions and cache their metadata locally for later install.
- Desktop packaging includes the local service plus a standalone UI server.
- CI validates install, tests, UI build, service build, and desktop packaging on all supported OS targets.
