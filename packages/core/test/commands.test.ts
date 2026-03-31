import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommands } from "../src/runner/commands.js";

test("runCommands splits quoted args with shell disabled", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-commands-"));
  const logFile = path.join(tmp, "commands.log");
  await fs.writeFile(logFile, "", "utf8");

  const lines: string[] = [];
  const results = await runCommands({
    commands: ['node -e "console.log(process.argv[1])" "hello world"'],
    cwd: tmp,
    logFile,
    allowlist: ["node"],
    onLine: (line) => lines.push(line)
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.ok, true);
  assert.ok(lines.some((line) => line.includes("hello world")));
});

test("runCommands enforces allowlist when provided", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-commands-"));
  const logFile = path.join(tmp, "commands.log");
  await fs.writeFile(logFile, "", "utf8");

  await assert.rejects(
    () => runCommands({
      commands: ["npm --version"],
      cwd: tmp,
      logFile,
      allowlist: ["node"]
    }),
    /shell_allowlist/
  );
});
