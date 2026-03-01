#!/usr/bin/env node
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliPath = path.join(__dirname, "..", "src", "cli.ts");

const require = createRequire(import.meta.url);
const tsxPkgPath = require.resolve("tsx/package.json");
const tsxPkg = JSON.parse(fs.readFileSync(tsxPkgPath, "utf8"));
const binRel =
  typeof tsxPkg.bin === "string"
    ? tsxPkg.bin
    : tsxPkg.bin?.tsx ?? Object.values(tsxPkg.bin ?? {})[0];
const tsxBin = path.resolve(path.dirname(tsxPkgPath), binRel);

const child = spawn(process.execPath, [tsxBin, cliPath, ...process.argv.slice(2)], {
  stdio: "inherit"
});

child.on("exit", (code) => process.exit(code ?? 1));
