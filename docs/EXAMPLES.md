# Examples

## Start a Mission

```bash
orchestrum mission start \
  --template feature-dev \
  --workspace demo \
  --goal "Add search filters to the runs page"
```

## Start a Delivery Session

```bash
orchestrum delivery run \
  --repo /path/to/repo \
  --workspace demo \
  --goal "Sprint 12 hardening" \
  --sprint "Sprint 12"
```

## Export a Packet for ChatGPT

```bash
orchestrum delivery export packet-1 \
  --run delivery-123 \
  --workspace demo \
  --target chatgpt \
  --format markdown
```

## Import a Packet Response

```bash
orchestrum delivery import \
  --run delivery-123 \
  --workspace demo \
  --target chatgpt \
  --file response.txt
```

## Run Browser Smoke

```bash
orchestrum qa \
  --repo /path/to/repo \
  --workspace demo \
  --base-url http://localhost:3000
```

## Sync Workspace Docs

```bash
orchestrum docs sync --repo /path/to/repo
```

## Export Diagnostics

```bash
orchestrum diagnostics export \
  --workspace demo \
  --run mission-123
```
