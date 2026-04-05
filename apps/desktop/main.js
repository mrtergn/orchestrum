const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const path = require("path");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_UI_PORT = Number(process.env.ORCHESTRUM_UI_PORT || 3000);
const DEFAULT_SERVICE_PORT = Number(process.env.ORCHESTRUM_SERVICE_PORT || 4137);
const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS_PER_WINDOW = 3;

let isQuitting = false;
let mainWindow = null;
let servicePort = DEFAULT_SERVICE_PORT;
let uiPort = DEFAULT_UI_PORT;
let runtimePaths = null;
let desktopLaunchEnv = null;

const runtimeState = {
  boot: {
    status: "idle",
    startedAt: null,
    completedAt: null,
    lastError: null
  },
  service: createChildRuntimeState("service"),
  ui: createChildRuntimeState("ui")
};

function createChildRuntimeState(kind) {
  return {
    kind,
    process: null,
    status: "stopped",
    pid: null,
    stopping: false,
    restarting: false,
    lastStartedAt: null,
    lastExitAt: null,
    lastExitCode: null,
    lastExitSignal: null,
    lastError: null,
    restartTimestamps: []
  };
}

function getRuntimePaths() {
  if (app.isPackaged) {
    const bundleRoot = path.join(process.resourcesPath, "bundle");
    const packagedUiRoot = resolvePackagedUiRoot(bundleRoot);
    const operatorRoot = path.join(app.getPath("userData"), "runtime");
    return {
      rootDir: bundleRoot,
      operatorRoot,
      serviceRoot: path.join(bundleRoot, "service"),
      uiRoot: packagedUiRoot,
      statePath: path.join(operatorRoot, "desktop-state.json")
    };
  }
  const rootDir = path.resolve(__dirname, "..", "..");
  const operatorRoot = process.env.ORCHESTRUM_DESKTOP_RUNTIME_ROOT || rootDir;
  return {
    rootDir,
    operatorRoot,
    serviceRoot: path.join(rootDir, "packages", "service"),
    uiRoot: path.join(rootDir, "apps", "ui"),
    statePath: path.join(operatorRoot, ".orchestrum", "control", "desktop-state.json")
  };
}

function resolvePackagedUiRoot(bundleRoot) {
  const uiBundleRoot = path.join(bundleRoot, "ui");
  const candidates = [
    path.join(uiBundleRoot, "apps", "ui"),
    uiBundleRoot
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "server.js"))) {
      return candidate;
    }
  }
  return candidates[0];
}

function ensurePathExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} not found: ${targetPath}`);
  }
}

function resolveTsxBin(serviceRoot) {
  const tsxPkgPath = require.resolve("tsx/package.json", { paths: [serviceRoot] });
  const tsxPkg = JSON.parse(fs.readFileSync(tsxPkgPath, "utf8"));
  const binRel =
    typeof tsxPkg.bin === "string"
      ? tsxPkg.bin
      : tsxPkg.bin?.tsx || Object.values(tsxPkg.bin || {})[0];
  if (!binRel) {
    throw new Error("tsx binary not found.");
  }
  return path.resolve(path.dirname(tsxPkgPath), String(binRel));
}

function resolveNextBin(uiRoot) {
  return require.resolve("next/dist/bin/next", { paths: [uiRoot] });
}

function resolvePackagedHelperExecPath() {
  const helperName = `${app.name} Helper`;
  return path.join(
    path.dirname(process.execPath),
    "..",
    "Frameworks",
    `${helperName}.app`,
    "Contents",
    "MacOS",
    helperName
  );
}

function resolveChildExecPath() {
  if (app.isPackaged) {
    if (process.helperExecPath && process.helperExecPath !== process.execPath && fs.existsSync(process.helperExecPath)) {
      return process.helperExecPath;
    }
    const helperExecPath = resolvePackagedHelperExecPath();
    if (fs.existsSync(helperExecPath)) {
      return helperExecPath;
    }
  }
  return process.execPath;
}

function spawnNode(entryPath, args, cwd, extraEnv = {}) {
  const baseEnv = desktopLaunchEnv ?? process.env;
  return spawn(resolveChildExecPath(), [entryPath, ...args], {
    cwd,
    env: {
      ...baseEnv,
      ...extraEnv,
      ELECTRON_RUN_AS_NODE: "1"
    },
    stdio: "inherit",
    windowsHide: true
  });
}

function canHydrateShellEnv() {
  if (process.env.ORCHESTRUM_DESKTOP_USE_LOGIN_SHELL_ENV === "0") return false;
  return process.platform === "darwin";
}

function parseShellEnvOutput(raw) {
  const marker = "__ORCHESTRUM_SHELL_ENV__";
  const markerIndex = raw.lastIndexOf(marker);
  if (markerIndex === -1) {
    throw new Error("Shell environment marker not found.");
  }
  const jsonText = raw.slice(markerIndex + marker.length).trim();
  if (!jsonText) {
    throw new Error("Shell environment payload was empty.");
  }
  return JSON.parse(jsonText);
}

function loadLoginShellEnvironment() {
  const shell = process.env.SHELL || "/bin/zsh";
  const args = [
    "-ilc",
    "command /usr/bin/python3 - <<'PY'\nimport json, os, sys\nsys.stdout.write('__ORCHESTRUM_SHELL_ENV__')\njson.dump(dict(os.environ), sys.stdout)\nPY"
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, {
      cwd: os.homedir(),
      env: {
        ...process.env
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      if (settled) return;
      settled = true;
      reject(new Error("Timed out while loading login shell environment."));
    }, 12_000);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Shell environment probe exited with code ${code}.`));
        return;
      }
      try {
        const shellEnv = parseShellEnvOutput(stdout);
        resolve(shellEnv);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function resolveDesktopLaunchEnv() {
  if (!canHydrateShellEnv()) {
    return {
      ...process.env
    };
  }
  try {
    const shellEnv = await loadLoginShellEnvironment();
    const mergedEnv = {
      ...process.env,
      ...shellEnv
    };
    if (typeof shellEnv.PATH === "string" && shellEnv.PATH.trim()) {
      mergedEnv.PATH = shellEnv.PATH;
    }
    return mergedEnv;
  } catch (error) {
    console.warn("[orchestrum-desktop] failed to load login shell environment:", error?.message || String(error));
    return {
      ...process.env
    };
  }
}

function findAvailablePort(startPort, host) {
  return new Promise((resolve) => {
    const tryPort = (port) => {
      const server = net.createServer();
      server.unref();
      server.on("error", () => tryPort(port + 1));
      const listenOptions = host
        ? { port, host, exclusive: true }
        : { port, exclusive: true };
      server.listen(listenOptions, () => {
        const resolvedPort = server.address()?.port ?? port;
        server.close(() => resolve(resolvedPort));
      });
    };
    tryPort(startPort);
  });
}

function buildChildStartupError(kind, detail) {
  const state = getChildState(kind);
  const label = kind === "service" ? "Service" : "UI";
  const parts = [detail];
  if (state.lastError) {
    parts.push(state.lastError);
  }
  return new Error(`${label} failed to become healthy. ${parts.filter(Boolean).join(" ")}`.trim());
}

function isChildLaunchActive(kind, child) {
  const state = getChildState(kind);
  return state.process === child && child.exitCode == null && child.signalCode == null;
}

function waitForManagedChildUrl(kind, child, url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const expectedHealthToken = options.expectedHealthToken ?? null;
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (!isChildLaunchActive(kind, child)) {
        reject(buildChildStartupError(kind, "The child process exited before the readiness probe passed."));
        return;
      }
      http
        .get(url, (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            if (body.length < 16_384) {
              body += String(chunk);
            }
          });
          response.on("end", () => {
            if (!isChildLaunchActive(kind, child)) {
              reject(buildChildStartupError(kind, "The child process exited before the readiness probe passed."));
              return;
            }
            if (expectedHealthToken) {
              let payload = null;
              try {
                payload = body ? JSON.parse(body) : null;
              } catch {
                payload = null;
              }
              if (payload?.bootToken !== expectedHealthToken) {
                if (Date.now() - start > timeoutMs) {
                  reject(buildChildStartupError(kind, `Readiness probes reached the wrong runtime at ${url}.`));
                } else {
                  setTimeout(poll, 500);
                }
                return;
              }
            }
            resolve(true);
          });
        })
        .on("error", () => {
          if (!isChildLaunchActive(kind, child)) {
            reject(buildChildStartupError(kind, "The child process exited before the readiness probe passed."));
            return;
          }
          if (Date.now() - start > timeoutMs) {
            reject(new Error(`Timed out waiting for ${url}. Check local runtime prerequisites, ports, and provider/auth setup.`));
          } else {
            setTimeout(poll, 500);
          }
        });
    };
    poll();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getChildState(kind) {
  return kind === "service" ? runtimeState.service : runtimeState.ui;
}

function buildRuntimeStatus() {
  return {
    boot: {
      ...runtimeState.boot
    },
    ports: {
      service: servicePort,
      ui: uiPort
    },
    paths: runtimePaths
      ? {
          operatorRoot: runtimePaths.operatorRoot,
          installRoot: runtimePaths.rootDir,
          serviceRoot: runtimePaths.serviceRoot,
          uiRoot: runtimePaths.uiRoot
        }
      : null,
    service: serializeChildState(runtimeState.service),
    ui: serializeChildState(runtimeState.ui)
  };
}

function serializeChildState(state) {
  return {
    kind: state.kind,
    status: state.status,
    pid: state.pid,
    lastStartedAt: state.lastStartedAt,
    lastExitAt: state.lastExitAt,
    lastExitCode: state.lastExitCode,
    lastExitSignal: state.lastExitSignal,
    lastError: state.lastError,
    restartCountInWindow: state.restartTimestamps.length
  };
}

function writeRuntimeState() {
  if (!runtimePaths) return;
  fs.mkdirSync(path.dirname(runtimePaths.statePath), { recursive: true });
  fs.writeFileSync(runtimePaths.statePath, `${JSON.stringify(buildRuntimeStatus(), null, 2)}\n`, "utf8");
}

function createRuntimeErrorMarkup(title, message) {
  const safeTitle = String(title || "Orchestrum Error")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const safeMessage = String(message || "Unknown error")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${safeTitle}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: radial-gradient(circle at top right, rgba(34,211,238,0.16), transparent 30%), #0f172a;
        color: #e2e8f0;
        display: grid;
        place-items: center;
      }
      .panel {
        width: min(760px, calc(100vw - 48px));
        border: 1px solid rgba(148,163,184,0.22);
        background: rgba(2, 6, 23, 0.72);
        border-radius: 20px;
        padding: 24px;
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.45);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 20px;
      }
      p, pre {
        margin: 0;
        font-size: 13px;
        line-height: 1.7;
        color: #cbd5e1;
      }
      pre {
        margin-top: 16px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
    </style>
  </head>
  <body>
    <section class="panel">
      <h1>${safeTitle}</h1>
      <p>Desktop runtime failed to load the operator surface. Check the packaged bundle layout, service/UI child process health, and runtime paths.</p>
      <pre>${safeMessage}</pre>
    </section>
  </body>
</html>`;
}

function showRuntimeErrorWindow(title, message) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      backgroundColor: "#0f172a",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "preload.js")
      }
    });
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  }
  const markup = createRuntimeErrorMarkup(title, message);
  void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(markup)}`);
}

function assertRuntimeWriteSafety(paths) {
  ensurePathExists(paths.rootDir, "Install root");
  ensurePathExists(paths.serviceRoot, "Service root");
  ensurePathExists(paths.uiRoot, "UI root");
  if (app.isPackaged) {
    const resolvedOperatorRoot = path.resolve(paths.operatorRoot);
    const resolvedInstallRoot = path.resolve(paths.rootDir);
    if (resolvedOperatorRoot.startsWith(resolvedInstallRoot)) {
      throw new Error("Desktop runtime root must live outside the packaged bundle.");
    }
  }
  fs.mkdirSync(paths.operatorRoot, { recursive: true });
  const probePath = path.join(paths.operatorRoot, ".desktop-write-test");
  fs.writeFileSync(probePath, "ok", "utf8");
  fs.rmSync(probePath, { force: true });
}

function noteRestart(kind) {
  const state = getChildState(kind);
  const now = Date.now();
  state.restartTimestamps = state.restartTimestamps.filter((timestamp) => now - timestamp < RESTART_WINDOW_MS);
  state.restartTimestamps.push(now);
  return state.restartTimestamps.length <= MAX_RESTARTS_PER_WINDOW;
}

function describeExit(code, signal) {
  if (signal) return signal;
  if (typeof code === "number") return String(code);
  return "unknown";
}

function registerChildLifecycle(kind, child) {
  const state = getChildState(kind);
  state.process = child;
  state.stopping = false;
  state.lastError = null;
  state.lastStartedAt = new Date().toISOString();
  state.pid = child.pid ?? null;
  writeRuntimeState();

  child.on("error", (err) => {
    state.lastError = err.message || String(err);
    writeRuntimeState();
    if (!isQuitting) {
      dialog.showErrorBox("Orchestrum", `${kind === "service" ? "Service" : "UI"} failed to start: ${state.lastError}`);
    }
  });

  child.on("exit", (code, signal) => {
    const wasStopping = state.stopping || isQuitting;
    state.process = null;
    state.pid = null;
    state.lastExitAt = new Date().toISOString();
    state.lastExitCode = typeof code === "number" ? code : null;
    state.lastExitSignal = signal ?? null;
    state.status = wasStopping ? "stopped" : "crashed";
    writeRuntimeState();
    if (!wasStopping) {
      void restartChild(kind, `unexpected exit (${describeExit(code, signal)})`);
    }
  });
}

function stopChild(kind) {
  const state = getChildState(kind);
  if (!state.process) return;
  state.stopping = true;
  state.status = "stopping";
  writeRuntimeState();
  state.process.kill();
}

async function stopChildAndWait(kind, timeoutMs = 5_000) {
  const state = getChildState(kind);
  if (!state.process) return;
  stopChild(kind);
  const started = Date.now();
  while (state.process && Date.now() - started < timeoutMs) {
    await delay(50);
  }
}

async function launchService(paths, reason = "startup") {
  const state = getChildState("service");
  const healthToken = randomUUID();
  const serviceEntry = app.isPackaged
    ? path.join(paths.serviceRoot, "dist", "server.js")
    : path.join(paths.serviceRoot, "src", "server.ts");
  ensurePathExists(serviceEntry, "Service entry");
  fs.mkdirSync(paths.operatorRoot, { recursive: true });
  state.status = reason === "startup" ? "starting" : "restarting";
  writeRuntimeState();
  const serviceEnv = {
    ORCHESTRUM_SERVICE_PORT: String(servicePort),
    ORCHESTRUM_SERVICE_HOST: LOOPBACK_HOST,
    ORCHESTRUM_BOOT_TOKEN: healthToken,
    ORCHESTRUM_ROOT_DIR: paths.operatorRoot,
    ORCHESTRUM_RUNS_DIR: path.join(paths.operatorRoot, "runs"),
    ORCHESTRUM_INSTALL_ROOT: paths.rootDir
  };
  const child = app.isPackaged
    ? spawnNode(serviceEntry, [], paths.operatorRoot, serviceEnv)
    : spawnNode(resolveTsxBin(paths.serviceRoot), [serviceEntry], paths.operatorRoot, serviceEnv);
  registerChildLifecycle("service", child);
  await waitForManagedChildUrl("service", child, `http://${LOOPBACK_HOST}:${servicePort}/health`, {
    timeoutMs: 30_000,
    expectedHealthToken: healthToken
  });
  state.status = "running";
  state.lastError = null;
  writeRuntimeState();
}

async function launchUi(paths, reason = "startup") {
  const state = getChildState("ui");
  state.status = reason === "startup" ? "starting" : "restarting";
  writeRuntimeState();

  let child;
  if (app.isPackaged) {
    const standaloneEntry = path.join(paths.uiRoot, "server.js");
    ensurePathExists(standaloneEntry, "Standalone UI server");
    child = spawnNode(standaloneEntry, [], paths.uiRoot, {
      PORT: String(uiPort),
      HOSTNAME: LOOPBACK_HOST,
      NEXT_PUBLIC_ORCHESTRUM_SERVICE_URL: `http://${LOOPBACK_HOST}:${servicePort}`,
      ORCHESTRUM_SERVICE_URL: `http://${LOOPBACK_HOST}:${servicePort}`
    });
  } else {
    const nextBin = resolveNextBin(paths.uiRoot);
    child = spawnNode(nextBin, ["dev", "-p", String(uiPort)], paths.uiRoot, {
      PORT: String(uiPort),
      NEXT_PUBLIC_ORCHESTRUM_SERVICE_URL: `http://${LOOPBACK_HOST}:${servicePort}`,
      ORCHESTRUM_SERVICE_URL: `http://${LOOPBACK_HOST}:${servicePort}`
    });
  }
  registerChildLifecycle("ui", child);
  await waitForManagedChildUrl("ui", child, `http://${LOOPBACK_HOST}:${uiPort}`, { timeoutMs: 40_000 });
  state.status = "running";
  state.lastError = null;
  writeRuntimeState();

  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL(`http://127.0.0.1:${uiPort}`);
  }
}

async function restartChild(kind, reason) {
  if (!runtimePaths || isQuitting) return;
  const state = getChildState(kind);
  if (state.restarting) return;
  if (!noteRestart(kind)) {
    state.status = "crashed";
    state.lastError = `${kind} exceeded the automatic restart limit.`;
    writeRuntimeState();
    dialog.showErrorBox("Orchestrum", `${kind === "service" ? "Service" : "UI"} crashed repeatedly and will not be restarted automatically.`);
    return;
  }
  state.restarting = true;
  state.lastError = `Restarting after ${reason}.`;
  writeRuntimeState();
  try {
    await stopChildAndWait(kind);
    if (kind === "service") {
      await delay(700);
      await launchService(runtimePaths, "restart");
    } else {
      await delay(700);
      await launchUi(runtimePaths, "restart");
    }
  } catch (error) {
    state.status = "crashed";
    state.lastError = error instanceof Error ? error.message : String(error);
    writeRuntimeState();
    if (!isQuitting) {
      dialog.showErrorBox("Orchestrum", `${kind === "service" ? "Service" : "UI"} restart failed: ${state.lastError}`);
    }
  } finally {
    state.restarting = false;
    writeRuntimeState();
  }
}

function createWindow(targetUiPort) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#0f172a",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js")
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    if (String(validatedURL || "").startsWith("data:")) return;
    showRuntimeErrorWindow(
      "Operator UI failed to load",
      `URL: ${validatedURL || `http://127.0.0.1:${targetUiPort}`}\nCode: ${errorCode}\nReason: ${errorDescription || "Unknown error"}`
    );
  });
  void mainWindow.loadURL(`http://127.0.0.1:${targetUiPort}`);
}

async function bootDesktopRuntime() {
  runtimePaths = getRuntimePaths();
  runtimeState.boot.status = "booting";
  runtimeState.boot.startedAt = new Date().toISOString();
  runtimeState.boot.lastError = null;
  desktopLaunchEnv = await resolveDesktopLaunchEnv();
  assertRuntimeWriteSafety(runtimePaths);
  servicePort = await findAvailablePort(DEFAULT_SERVICE_PORT);
  uiPort = await findAvailablePort(DEFAULT_UI_PORT, LOOPBACK_HOST);
  writeRuntimeState();
  await launchService(runtimePaths, "startup");
  await launchUi(runtimePaths, "startup");
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(uiPort);
  }
  runtimeState.boot.status = "running";
  runtimeState.boot.completedAt = new Date().toISOString();
  writeRuntimeState();
}

function shutdownDesktopRuntime() {
  isQuitting = true;
  runtimeState.boot.status = "stopping";
  writeRuntimeState();
  stopChild("ui");
  stopChild("service");
}

ipcMain.handle("orchestrum:pick-directory", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"]
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle("orchestrum:runtime-status", async () => buildRuntimeStatus());
ipcMain.handle("orchestrum:restart-service", async () => {
  await restartChild("service", "operator request");
  return buildRuntimeStatus();
});
ipcMain.handle("orchestrum:restart-ui", async () => {
  await restartChild("ui", "operator request");
  return buildRuntimeStatus();
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      await bootDesktopRuntime();
    } catch (err) {
      runtimeState.boot.status = "crashed";
      runtimeState.boot.lastError = err.message || String(err);
      writeRuntimeState();
      showRuntimeErrorWindow("Desktop boot failed", err.message || String(err));
      dialog.showErrorBox("Orchestrum", err.message || String(err));
    }
  });
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && runtimeState.ui.status === "running") {
    createWindow(uiPort);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

process.on("uncaughtException", (err) => {
  runtimeState.boot.status = "crashed";
  runtimeState.boot.lastError = err.stack || err.message || String(err);
  writeRuntimeState();
  showRuntimeErrorWindow("Desktop runtime crashed", err.stack || err.message || String(err));
  dialog.showErrorBox("Orchestrum Crash", err.stack || err.message || String(err));
});

app.on("before-quit", () => {
  shutdownDesktopRuntime();
});
