# Troubleshooting

## Service Does Not Start

Symptoms:
- `ECONNREFUSED` from UI
- Health endpoint unavailable

Checks:
1. Verify the service process is running.
2. Confirm `ORCHESTRUM_SERVICE_PORT`.
3. Check port conflicts.

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
2. Confirm local proxy or API route configuration.
3. Ensure CORS is enabled for your setup.

## Mission Cannot Start

Symptoms:
- provider key errors
- template or workspace lookup failures

Checks:
1. Confirm the workspace exists.
2. Set provider secrets such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.
3. Verify the mission template id is one of the built-in templates.

## Delivery Import Does Not Match a Packet

Symptoms:
- import exits non-zero
- UI shows unmatched import attempts

Checks:
1. Export the packet again and keep the packet id in the response.
2. Import against the correct run id and target tool.
3. Inspect the packet text to ensure the response still includes the expected context.

## Approval Token Not Found

Symptoms:
- `Approval token not found`

Checks:
1. Use the exact token shown in logs.
2. Confirm the run directory and workspace.
3. Verify token TTL has not expired.

## Patch Apply Failures

Symptoms:
- `Patch apply failed`

Checks:
1. Ensure the repository has no conflicting local edits.
2. Re-run with a narrower goal.
3. Re-open the run detail page and inspect artifacts before retrying.

## SSE or Event Stream Issues

Symptoms:
- stale run status in UI

Checks:
1. Verify `/events` is reachable.
2. Confirm no proxy strips `text/event-stream`.
3. Inspect the browser network tab for disconnects.

## Cluster Timeout

Symptoms:
- task timeout errors from cluster execution

Checks:
1. Confirm worker processes are alive.
2. Inspect queue and results directories.
3. Increase timeout if the workload is large.
