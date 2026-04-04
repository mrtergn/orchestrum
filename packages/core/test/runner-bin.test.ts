import { test } from "vitest";
import assert from "node:assert/strict";
import { runBinary } from "../src/runner/bin.js";

test("runBinary timeout errors redact oversized arguments", async () => {
  const oversizedPromptArg = [
    "# Role: AUDIT",
    "Review the repo and produce JSON only.",
    "x".repeat(4_096)
  ].join("\n\n");

  await assert.rejects(
    runBinary(process.execPath, ["-e", "setTimeout(() => {}, 250)", oversizedPromptArg], { timeoutMs: 25 }),
    (error: Error) => {
      assert.match(error.message, /timed out after 25ms/i);
      assert.match(error.message, /arg 3 omitted/i);
      assert.doesNotMatch(error.message, /# Role: AUDIT/);
      return true;
    }
  );
});