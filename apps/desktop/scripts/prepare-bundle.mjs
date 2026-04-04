import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const uiRoot = path.join(repoRoot, "apps", "ui");
const stagedUiRoot = path.join(desktopRoot, "build", "runtime-bundle", "ui");

await fs.rm(stagedUiRoot, { recursive: true, force: true });
await fs.mkdir(stagedUiRoot, { recursive: true });

await copyTree(path.join(uiRoot, ".next", "standalone"), stagedUiRoot);
await copyTree(
  path.join(uiRoot, ".next", "static"),
  path.join(stagedUiRoot, "apps", "ui", ".next", "static")
);
await copyTree(
  path.join(uiRoot, "public"),
  path.join(stagedUiRoot, "apps", "ui", "public")
);

async function copyTree(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.cp(from, to, { recursive: true, force: true });
}
