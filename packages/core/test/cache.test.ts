import { test } from "vitest";
import assert from "node:assert/strict";
import { computeInputHash } from "../src/runner/cache.js";

test("computeInputHash is stable", () => {
  const a = computeInputHash({
    renderedPrompt: "hello",
    model: "gpt-5",
    agent: "pm",
    headSha: "abc"
  });
  const b = computeInputHash({
    renderedPrompt: "hello",
    model: "gpt-5",
    agent: "pm",
    headSha: "abc"
  });
  const c = computeInputHash({
    renderedPrompt: "hello world",
    model: "gpt-5",
    agent: "pm",
    headSha: "abc"
  });
  assert.equal(a, b);
  assert.notEqual(a, c);
});
