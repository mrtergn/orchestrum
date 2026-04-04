import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const appPath = process.argv[2] || path.join(desktopRoot, "dist", "mac-arm64", "Orchestrum.app");
const statePathCandidates = [
  path.join(os.homedir(), "Library", "Application Support", "@orchestrum", "desktop", "runtime", "desktop-state.json"),
  path.join(os.homedir(), "Library", "Application Support", "Orchestrum", "runtime", "desktop-state.json")
];
const processPattern = appPath;

if (process.platform !== "darwin") {
  console.log("[desktop-smoke] Skipping packaged desktop smoke on non-macOS host.");
  process.exit(0);
}

await assertExists(appPath, "Packaged app");
await stopExistingDesktop();

const previousStates = await Promise.all(statePathCandidates.map(async (candidate) => ({
  path: candidate,
  state: await readJson(candidate).catch(() => null)
})));
const previousStartedAtByPath = new Map(
  previousStates.map(({ path: candidate, state }) => [
    candidate,
    typeof state?.boot?.startedAt === "string" ? state.boot.startedAt : null
  ])
);

await openDesktopApp(appPath);

const state = await waitFor(async () => {
  for (const candidate of statePathCandidates) {
    const next = await readJson(candidate).catch(() => null);
    if (!next) continue;
    const bootStartedAt = typeof next?.boot?.startedAt === "string" ? next.boot.startedAt : null;
    const previousStartedAt = previousStartedAtByPath.get(candidate) ?? null;
    if (bootStartedAt && bootStartedAt === previousStartedAt) continue;
    if (next?.boot?.status !== "running") continue;
    if (next?.service?.status !== "running" || next?.ui?.status !== "running") continue;
    if (!next?.ports?.service || !next?.ports?.ui) continue;
    return { candidate, state: next };
  }
  return null;
}, 45_000, "Desktop runtime did not reach running state.");

const rootHtml = await fetchText(`http://127.0.0.1:${state.state.ports.ui}`);
if (!/<html/i.test(rootHtml)) {
  throw new Error("UI root did not return HTML.");
}
const cssMatch = rootHtml.match(/\/_next\/static\/css\/[^"' )]+\.css/);
if (!cssMatch) {
  throw new Error("Could not find a packaged CSS asset in the UI HTML.");
}
await fetchText(`http://127.0.0.1:${state.state.ports.ui}${cssMatch[0]}`);
await fetchText(`http://127.0.0.1:${state.state.ports.service}/health`);

await quitDesktopApp();
await waitFor(async () => {
  const alive = await isProcessAlive(processPattern);
  return alive ? null : true;
}, 20_000, "Desktop process did not exit after quit.");

console.log(`[desktop-smoke] Fresh launch, runtime state, UI asset load, service health, and shutdown passed via ${state.candidate}.`);

async function assertExists(targetPath, label) {
  try {
    await fs.access(targetPath);
  } catch {
    throw new Error(`${label} not found: ${targetPath}`);
  }
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function openDesktopApp(targetPath) {
  await runCommand("open", ["-na", targetPath], {
    ELECTRON_RUN_AS_NODE: undefined
  });
}

async function quitDesktopApp() {
  await runCommand("osascript", ["-e", 'tell application "Orchestrum" to quit']).catch(() => undefined);
  await delay(1800);
  if (await isProcessAlive(processPattern)) {
    await runCommand("pkill", ["-f", processPattern]).catch(() => undefined);
    await delay(1200);
  }
  if (await isProcessAlive(processPattern)) {
    await runCommand("pkill", ["-9", "-f", processPattern]).catch(() => undefined);
  }
}

async function stopExistingDesktop() {
  await runCommand("pkill", ["-f", processPattern]).catch(() => undefined);
  await delay(1200);
  if (await isProcessAlive(processPattern)) {
    await runCommand("pkill", ["-9", "-f", processPattern]).catch(() => undefined);
  }
  await waitFor(async () => {
    const alive = await isProcessAlive(processPattern);
    return alive ? null : true;
  }, 10_000, "Previous desktop processes did not stop.");
}

async function isProcessAlive(pattern) {
  try {
    await runCommand("pgrep", ["-f", pattern]);
    return true;
  } catch {
    return false;
  }
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }
  return response.text();
}

async function waitFor(check, timeoutMs, message) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value) return value;
    await delay(500);
  }
  throw new Error(message);
}

async function runCommand(command, args, envOverrides = {}) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: "ignore"
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
