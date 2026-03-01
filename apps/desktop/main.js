const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const UI_PORT = Number(process.env.ORCHESTRUM_UI_PORT || 3000);
const SERVICE_PORT = Number(process.env.ORCHESTRUM_SERVICE_PORT || 4137);
const ROOT_DIR = path.resolve(__dirname, "..", "..");

let serviceProcess = null;
let uiProcess = null;

function startService() {
  const serviceEntry = path.join(ROOT_DIR, "packages", "service", "dist", "server.js");
  const devEntry = path.join(ROOT_DIR, "packages", "service", "src", "server.ts");
  const isProd = process.env.NODE_ENV === "production";
  const args = isProd ? [serviceEntry] : ["--import", "tsx", devEntry];
  serviceProcess = spawn(process.execPath, args, {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ORCHESTRUM_SERVICE_PORT: String(SERVICE_PORT),
      ORCHESTRUM_USE_KEYCHAIN: "1"
    },
    stdio: "inherit"
  });
}

function startUI() {
  const isProd = process.env.NODE_ENV === "production";
  const cmd = isProd ? "npm" : "npm";
  const args = isProd
    ? ["run", "start", "-w", "@orchestrum/ui", "--", "-p", String(UI_PORT)]
    : ["run", "dev", "-w", "@orchestrum/ui", "--", "-p", String(UI_PORT)];
  uiProcess = spawn(cmd, args, {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PORT: String(UI_PORT),
      NEXT_PUBLIC_ORCHESTRUM_SERVICE_URL: `http://localhost:${SERVICE_PORT}`,
      ORCHESTRUM_USE_KEYCHAIN: "1"
    },
    stdio: "inherit",
    shell: true
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
            reject(new Error("Timed out waiting for UI"));
          } else {
            setTimeout(poll, 500);
          }
        });
    };
    poll();
  });
}

function createWindow() {
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
  win.loadURL(`http://localhost:${UI_PORT}`);
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
    startService();
    startUI();
    await waitForUrl(`http://localhost:${UI_PORT}`);
    createWindow();
  } catch (err) {
    dialog.showErrorBox("Orchestrum", err.message || String(err));
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
  if (serviceProcess) serviceProcess.kill();
  if (uiProcess) uiProcess.kill();
});
