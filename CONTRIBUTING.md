# Contributing to Orchestrum

Thanks for considering a contribution. Orchestrum is a local-first, TypeScript-first system that aims to stay reliable, easy to run, and safe by default.

## Code of Conduct
Please read and follow `CODE_OF_CONDUCT.md`.

## Development Setup
Prerequisites:
- Node.js 18+
- npm 9+
- Git
- Optional: Docker (for sandboxed steps)

Install dependencies:
```bash
npm install
```

Run service + UI:
```bash
npx orchestrum ui
```

Run service and UI separately:
```bash
npm run service
npm run dev
```

## Project Structure
- `apps/ui` — Next.js UI (App Router)
- `apps/desktop` — Electron wrapper
- `packages/core` — runner, orchestration, policy, sandbox, storage
- `packages/service` — local API + SSE + indexing
- `packages/*` — arbitration, analytics, cluster, security, roadmap, plugins
- `runs/` — run artifacts (generated at runtime)

## Tests
Core tests:
```bash
cd packages/core
npm run test
```

Typecheck:
```bash
cd packages/core
npm run typecheck
```

## Pull Requests
- Keep changes focused.
- Add or update tests when behavior changes.
- Avoid breaking existing local-first behavior.
- Document new CLI flags, config, or UI additions in `README.md`.

## Style & Conventions
- TypeScript `strict` everywhere.
- Prefer small, testable modules.
- Use `zod` for config/schema validation.
- Keep filesystem persistence under `./runs`.

## Adding a Workflow Example
Add YAML under `packages/core/workflows/` and prompts under `packages/core/prompts/`.
Include an example in `docs/WORKFLOWS.md` if it showcases new features.

## Reporting Bugs
Open a GitHub issue with:
- reproduction steps
- OS / Node / npm versions
- logs or screenshots
