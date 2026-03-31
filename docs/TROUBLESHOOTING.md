# Troubleshooting

## Service Does Not Start

Symptoms:
- `ECONNREFUSED` from UI
- Health endpoint unavailable

Checks:
1. Verify service process is running.
2. Confirm `ORCHESTRUM_SERVICE_PORT` value.
3. Check port conflicts.

Commands:
```bash
lsof -i :4137
npx orchestrum doctor
```

## UI Cannot Reach API

Symptoms:
- Empty dashboards
- `Failed to fetch` in browser console

Checks:
1. Verify `ORCHESTRUM_SERVICE_URL` or `NEXT_PUBLIC_ORCHESTRUM_SERVICE_URL`.
2. Confirm reverse proxy/API route configuration.
3. Ensure CORS is enabled for your local setup.

## Approval Token Not Found

Symptoms:
- `Approval token not found`

Checks:
1. Use the exact token shown in logs.
2. Confirm the run directory and workspace.
3. Verify token TTL has not expired.

## Keychain Secrets Not Working

Symptoms:
- keychain operation errors

Resolution:
1. Install optional dependency `keytar` and required OS keychain libraries.
2. Or disable keychain mode and use `ORCHESTRUM_SECRETS_PASSPHRASE`.

## Workflow Parse Fails

Symptoms:
- `Invalid workflow YAML`
- `Loop audit_step_id not found`

Checks:
1. Validate YAML syntax.
2. Ensure step IDs referenced by `loop` exist.
3. If using `extends`, verify base path is correct and not circular.

## Cluster Timeout

Symptoms:
- task timeout errors from cluster execution

Checks:
1. Confirm worker processes are alive.
2. Inspect queue and results directories.
3. Increase timeout when workload is large.

## Patch Apply Failures

Symptoms:
- `Patch apply failed`

Checks:
1. Ensure repository has no conflicting local edits.
2. Re-run with a narrower goal.
3. Resume from the failed step after fixing conflicts.

## SSE/Event Stream Issues

Symptoms:
- stale run status in UI

Checks:
1. Verify `/events` endpoint is reachable.
2. Confirm no proxy strips `text/event-stream`.
3. Inspect browser network tab for stream disconnects.

## Vitest Migration Problems

Symptoms:
- test runner command not found
- coverage provider missing

Resolution:
1. Run install/bootstrap again.
2. Verify `vitest` and `@vitest/coverage-v8` are installed.
3. Run `npm test` from repo root.

## Release and Update Script Errors

Symptoms:
- changelog duplicate version
- install script exits early

Checks:
1. Ensure version does not already exist in `CHANGELOG.md`.
2. Verify update package path exists.
3. Re-run script with absolute path when in doubt.
