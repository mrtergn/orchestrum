import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, writeJson, readJsonIfExists } from "./fs.js";
import { getAppHome } from "../appHome.js";
import { SecretError } from "../errors.js";

type EncryptedStore = {
  version: number;
  salt: string;
  items: Record<
    string,
    {
      iv: string;
      tag: string;
      data: string;
    }
  >;
};

const STORE_VERSION = 1;

export type SecretScope = "global" | "workspace";

export function getGlobalSecretsPath(): string {
  return path.join(getAppHome(), ".secrets.enc");
}

export function getWorkspaceSecretsPath(repoPath: string): string {
  return path.join(repoPath, ".orchestrum", ".secrets.enc");
}

const KEYCHAIN_SERVICE = "orchestrum";

export async function listSecrets(scope: SecretScope, repoPath?: string): Promise<string[]> {
  const store = await loadEncryptedStore(scope, repoPath);
  return Object.keys(store?.items ?? {});
}

export async function setSecret(options: {
  name: string;
  value: string;
  scope: SecretScope;
  repoPath?: string;
  passphrase?: string;
  useKeychain?: boolean;
}): Promise<void> {
  if (options.useKeychain) {
    const keytar = await requireKeytar("set");
    await keytar.setPassword(KEYCHAIN_SERVICE, options.name, options.value);
    return;
  }
  const passphrase = options.passphrase ?? process.env.ORCHESTRUM_SECRETS_PASSPHRASE;
  if (!passphrase) {
    throw new SecretError("ORCHESTRUM_SECRETS_PASSPHRASE is required to set encrypted secrets.", "secret.missing_passphrase");
  }
  const store = (await loadEncryptedStore(options.scope, options.repoPath, passphrase)) ?? {
    version: STORE_VERSION,
    salt: crypto.randomBytes(16).toString("base64"),
    items: {}
  };
  const key = await deriveKey(passphrase, store.salt);
  const encrypted = encryptSecret(options.value, key);
  store.items[options.name] = encrypted;
  await saveEncryptedStore(options.scope, options.repoPath, store);
}

export async function unsetSecret(options: {
  name: string;
  scope: SecretScope;
  repoPath?: string;
  passphrase?: string;
  useKeychain?: boolean;
}): Promise<void> {
  if (options.useKeychain) {
    const keytar = await requireKeytar("unset");
    await keytar.deletePassword(KEYCHAIN_SERVICE, options.name);
  }
  const passphrase = options.passphrase ?? process.env.ORCHESTRUM_SECRETS_PASSPHRASE;
  if (!passphrase) return;
  const store = await loadEncryptedStore(options.scope, options.repoPath, passphrase);
  if (!store) return;
  delete store.items[options.name];
  await saveEncryptedStore(options.scope, options.repoPath, store);
}

export async function getSecret(options: {
  name: string;
  scope: SecretScope;
  repoPath?: string;
  passphrase?: string;
  useKeychain?: boolean;
}): Promise<string | null> {
  const envValue = process.env[options.name];
  if (envValue) return envValue;
  if (options.useKeychain) {
    const keytar = await requireKeytar("get");
    const stored = await keytar.getPassword(KEYCHAIN_SERVICE, options.name);
    if (stored) return stored;
  }
  const passphrase = options.passphrase ?? process.env.ORCHESTRUM_SECRETS_PASSPHRASE;
  if (!passphrase) return null;
  const store = await loadEncryptedStore(options.scope, options.repoPath, passphrase);
  if (!store) return null;
  const entry = store.items[options.name];
  if (!entry) return null;
  const key = await deriveKey(passphrase, store.salt);
  return decryptSecret(entry, key);
}

export async function applySecretsToEnv(options: {
  names: string[];
  scope: SecretScope;
  repoPath?: string;
  passphrase?: string;
  useKeychain?: boolean;
}): Promise<void> {
  for (const name of options.names) {
    const value = await getSecret({
      name,
      scope: options.scope,
      repoPath: options.repoPath,
      passphrase: options.passphrase,
      useKeychain: options.useKeychain
    });
    if (value && !process.env[name]) {
      process.env[name] = value;
    }
  }
}

async function loadEncryptedStore(scope: SecretScope, repoPath?: string, passphrase?: string): Promise<EncryptedStore | null> {
  const filePath = resolveSecretsPath(scope, repoPath);
  const store = await readJsonIfExists<EncryptedStore>(filePath);
  if (!store) return null;
  if (!store.salt) {
    if (!passphrase) return store;
    store.salt = crypto.randomBytes(16).toString("base64");
  }
  return store;
}

async function saveEncryptedStore(scope: SecretScope, repoPath: string | undefined, store: EncryptedStore): Promise<void> {
  const filePath = resolveSecretsPath(scope, repoPath);
  await ensureDir(path.dirname(filePath));
  await writeJson(filePath, store);
}

function resolveSecretsPath(scope: SecretScope, repoPath?: string): string {
  if (scope === "workspace") {
    if (!repoPath) throw new SecretError("repoPath required for workspace secrets", "secret.repo_path_required");
    return getWorkspaceSecretsPath(repoPath);
  }
  return getGlobalSecretsPath();
}

async function deriveKey(passphrase: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(passphrase, Buffer.from(salt, "base64"), 32, (err, key) => {
      if (err) reject(err);
      else resolve(key as Buffer);
    });
  });
}

function encryptSecret(value: string, key: Buffer): EncryptedStore["items"][string] {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: data.toString("base64")
  };
}

function decryptSecret(entry: EncryptedStore["items"][string], key: Buffer): string {
  const iv = Buffer.from(entry.iv, "base64");
  const tag = Buffer.from(entry.tag, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(entry.data, "base64")),
    decipher.final()
  ]);
  return decrypted.toString("utf8");
}

async function tryLoadKeytar(): Promise<any | null> {
  try {
    const mod = await import("keytar");
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

async function requireKeytar(action: "set" | "unset" | "get"): Promise<any> {
  const keytar = await tryLoadKeytar();
  if (keytar) return keytar;
  throw new SecretError(
    `Cannot ${action} secret via keychain because keytar is unavailable. Install optional dependency "keytar" and system keychain libraries, or disable keychain mode and use ORCHESTRUM_SECRETS_PASSPHRASE.`,
    "secret.keychain_unavailable",
    { action }
  );
}
