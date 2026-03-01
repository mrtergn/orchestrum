#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// Resolve the core CLI entry point
let cliPath;
try {
  // Try to resolve core package (for npm-installed case)
  const coreModulePath = require.resolve("@orchestrum/core");
  const coreDir = path.dirname(coreModulePath);
  cliPath = path.join(coreDir, "cli.ts");
} catch {
  // Fallback for workspace development
  cliPath = path.resolve(__dirname, "../../core/src/cli.ts");
}

const args = process.argv.slice(2);

const child = spawn(process.execPath, ["--import", "tsx", cliPath, ...args], {
  stdio: "inherit",
  env: process.env
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
