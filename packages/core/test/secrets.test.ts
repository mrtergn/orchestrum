import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setSecret, getSecret, listSecrets } from "../src/runner/secrets.js";

const PASSPHRASE = "test-passphrase";

test("secrets are encrypted and retrievable", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrum-secrets-"));
  process.env.ORCHESTRUM_SECRETS_PASSPHRASE = PASSPHRASE;

  await setSecret({
    name: "OPENAI_API_KEY",
    value: "super-secret",
    scope: "workspace",
    repoPath: tmp
  });

  const names = await listSecrets("workspace", tmp);
  assert.ok(names.includes("OPENAI_API_KEY"));

  const stored = await fs.readFile(path.join(tmp, ".orchestrum", ".secrets.enc"), "utf8");
  assert.equal(stored.includes("super-secret"), false);

  const value = await getSecret({ name: "OPENAI_API_KEY", scope: "workspace", repoPath: tmp });
  assert.equal(value, "super-secret");
});
