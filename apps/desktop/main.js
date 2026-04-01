const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");
const net = require("net");

const DEFAULT_UI_PORT = Number(process.env.ORCHESTRUM_UI_PORT || 3000);
const DEFAULT_SERVICE_PORT = Number(process.env.ORCHESTRUM_SERVICE_PORT || 4137);

let serviceProcess = null;
let uiProcess = null;
let isQuitting = false;
let servicePort = DEFAULT_SERVICE_PORT;
let uiPort = DEFAULT_UI_PORT;

function getRuntimePaths() {
  if (app.isPackaged) {
    const bundleRoot = path.join(process.resourcesPath, "bundle");
    const operatorRoot = path.join(app.getPath("userData"), "runtime");
    return {
      rootDir: bundleRoot,
      operatorRoot,
      serviceRoot: path.join(bundleRoot, "service"),
      uiRoot: path.join(bundleRoot, "ui")
    };
  }
  const rootDir = path.resolve(__dirname, "..", "..");
  return {
    rootDir,
    operatorRoot: rootDir,
    serviceRoot: path.join(rootDir, "packages", "service"),
    uiRoot: path.join(rootDir, "apps", "ui")
  };
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

function spawnNode(entryPath, args, cwd, extraEnv = {}) {
  return spawn(process.execPath, [entryPath, ...args], {
    cwd,
    env: {
      ...process.env,
      ...extraEnv,
      ELECTRON_RUN_AS_NODE: "1"
    },
    stdio: "inherit"
  });
}

function findAvailablePort(startPort) {
  return new Promise((resolve) => {
    const tryPort = (port) => {
      const server = net.createServer();
      server.unref();
      server.on("error", () => tryPort(port + 1));
      server.listen(port, "127.0.0.1", () => {
        const resolvedPort = server.address()?.port ?? port;
        server.close(() => resolve(resolvedPort));
      });
    };
    tryPort(startPort);
  });
}

function waitForUrl(url, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      http
        .get(url, () => resolve(true))
        .on("error", () => {
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

function startService(paths, targetPort) {
  const serviceEntry = app.isPackaged
    ? path.join(paths.serviceRoot, "dist", "server.js")
    : path.join(paths.serviceRoot, "src", "server.ts");
  ensurePathExists(serviceEntry, "Service entry");
  const tsxBin = resolveTsxBin(paths.serviceRoot);
  if (!fs.existsSync(paths.operatorRoot)) {
    fs.mkdirSync(paths.operatorRoot, { recursive: true });
  }
  serviceProcess = spawnNode(tsxBin, [serviceEntry], paths.operatorRoot, {
    ORCHESTRUM_SERVICE_PORT: String(targetPort),
    ORCHESTRUM_ROOT_DIR: paths.operatorRoot,
    ORCHESTRUM_RUNS_DIR: path.join(paths.operatorRoot, "runs"),
    ORCHESTRUM_INSTALL_ROOT: paths.rootDir
  });
  bindChildLifecycle(serviceProcess, "Service");
}

function startUI(paths, targetServicePort, targetUiPort) {
  if (app.isPackaged) {
    const standaloneEntry = path.join(paths.uiRoot, "server.js");
    ensurePathExists(standaloneEntry, "Standalone UI server");
    uiProcess = spawnNode(standaloneEntry, [], paths.uiRoot, {
      PORT: String(targetUiPort),
      HOSTNAME: "127.0.0.1",
      NEXT_PUBLIC_ORCHESTRUM_SERVICE_URL: `http://127.0.0.1:${targetServicePort}`,
      ORCHESTRUM_SERVICE_URL: `http://127.0.0.1:${targetServicePort}`
    });
  } else {
    const nextBin = resolveNextBin(paths.uiRoot);
    uiProcess = spawnNode(nextBin, ["dev", "-p", String(targetUiPort)], paths.uiRoot, {
      PORT: String(targetUiPort),
      NEXT_PUBLIC_ORCHESTRUM_SERVICE_URL: `http://127.0.0.1:${targetServicePort}`,
      ORCHESTRUM_SERVICE_URL: `http://127.0.0.1:${targetServicePort}`
    });
  }
  bindChildLifecycle(uiProcess, "UI");
}

function bindChildLifecycle(child, label) {
  child.on("error", (err) => {
    if (!isQuitting) {
      dialog.showErrorBox("Orchestrum", `${label} failed to start: ${err.message || String(err)}`);
    }
  });
  child.on("exit", (code, signal) => {
    if (!isQuitting && code !== 0) {
      dialog.showErrorBox("Orchestrum", `${label} exited unexpectedly (${signal || code}).`);
    }
  });
}

function createWindow(targetUiPort) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#0f172a",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js")
    }
  });
  win.loadURL(`http://127.0.0.1:${targetUiPort}`);
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

app.whenReady().then(async () => {
  try {
    const paths = getRuntimePaths();
    servicePort = await findAvailablePort(DEFAULT_SERVICE_PORT);
    uiPort = await findAvailablePort(DEFAULT_UI_PORT);
    startService(paths, servicePort);
    await waitForUrl(`http://127.0.0.1:${servicePort}/health`);
    startUI(paths, servicePort, uiPort);
    await waitForUrl(`http://127.0.0.1:${uiPort}`);
    createWindow(uiPort);
  } catch (err) {
    dialog.showErrorBox("Orchestrum", err.message || String(err));
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow(uiPort);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

process.on("uncaughtException", (err) => {
  dialog.showErrorBox("Orchestrum Crash", err.stack || err.message || String(err));
});

app.on("before-quit", () => {
  isQuitting = true;
  if (serviceProcess) serviceProcess.kill();
  if (uiProcess) uiProcess.kill();
});
