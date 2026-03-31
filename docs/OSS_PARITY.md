# OSS Parity Checklist

- README install path matches the real bootstrap flow.
- README and CLI docs describe the delivery loop, repo team preset, and multi-tool handoff flow.
- First-run onboarding is delivery-first: workspace, provider check, capability discovery, team preset confirm, first delivery session.
- Delivery export requires an explicit target tool and produces tool-specific text variants plus JSON sidecars.
- Delivery import analysis never silently first-matches ambiguous responses; UI prompts for packet choice and CLI exits non-zero with candidates.
- Delivery summary surface exists for the UI and diagnostics: sessions, findings, manual packets, unmatched imports, and tool usage.
- UI route surface is complete for runs, diagnostics, changelog, about, help, and settings.
- Run API proxy surface exists for list, detail, logs, steps, stream, resume, cancel, share, import, and approve.
- Runtime status naming is canonicalized to `queued|running|succeeded|failed|cancelled`.
- Plugin, roadmap, analytics, and tournament surfaces are available without license gating.
- Update checks are explicit remote actions and cache their metadata locally for later install.
- Desktop packaging includes the local service plus a standalone UI server.
- CI validates install, tests, UI build, service build, and desktop packaging on all supported OS targets.
