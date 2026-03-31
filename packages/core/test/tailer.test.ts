import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readAppendedLines } from "../src/runner/tailer.js";

test("readAppendedLines reads only new lines", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-tail-"));
  const filePath = path.join(tmp, "events.ndjson");
  await fs.writeFile(filePath, "first\n", "utf8");

  let state = { position: 0, buffer: "" };
  let result = await readAppendedLines(filePath, state);
  assert.deepEqual(result.lines, ["first"]);
  state = result.state;

  await fs.appendFile(filePath, "second\nthird\n", "utf8");
  result = await readAppendedLines(filePath, state);
  assert.deepEqual(result.lines, ["second", "third"]);
});
