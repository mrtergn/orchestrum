import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import * as tar from "tar";
import { ensureDir } from "../runner/fs.js";
import { getAppHome } from "../appHome.js";

export type ReleaseAssetKind = "archive" | "installer" | "package" | "checksum" | "unknown";
export type ReleaseAssetPlatform = NodeJS.Platform | "any";
export type ReleaseAssetArch = NodeJS.Architecture | "universal" | "any";

export type ReleaseAsset = {
  name: string;
  url: string;
  kind: ReleaseAssetKind;
  platform: ReleaseAssetPlatform;
  arch: ReleaseAssetArch;
  sha256?: string;
  size?: number;
  contentType?: string;
};

export type VersionInfo = {
  version: string;
  channel: "stable" | "beta";
  buildDate?: string;
  notes?: string;
  publishedAt?: string;
  tag?: string;
  source?: "local" | "github-release";
  releaseUrl?: string;
  assets?: ReleaseAsset[];
};

export type UpdateStatus = {
  current: VersionInfo | null;
  available: VersionInfo | null;
  updateAvailable: boolean;
  selectedAsset?: ReleaseAsset | null;
  checkedRemotely?: boolean;
  reason?: string;
};

export type UpdateQuery = {
  sourcePath?: string;
  remote?: boolean;
  repo?: string;
  channel?: VersionInfo["channel"];
  releaseApiUrl?: string;
  githubToken?: string;
  allowPrerelease?: boolean;
};

const DEFAULT_CHANNEL: VersionInfo["channel"] = "stable";
const DEFAULT_UPDATE_REPO = process.env.ORCHESTRUM_UPDATE_REPO ?? "mrtergn/orchestrum";

export function getVersionPath(rootDir: string): string {
  return path.join(rootDir, "version.json");
}

export function getCachedVersionPath(): string {
  return path.join(getAppHome(), "updates", "version.json");
}

export async function getCurrentVersion(rootDir: string): Promise<VersionInfo | null> {
  const filePath = getVersionPath(rootDir);
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw) return null;
  return normalizeVersion(JSON.parse(raw), "local");
}

export async function getAvailableVersion(options: UpdateQuery = {}): Promise<VersionInfo | null> {
  if (options.sourcePath) {
    const raw = await fs.readFile(options.sourcePath, "utf8").catch(() => "");
    if (!raw) return null;
    return normalizeVersion(JSON.parse(raw), "local");
  }

  if (options.remote) {
    const release = await fetchReleaseVersion(options);
    if (release) {
      await cacheAvailableVersion(release);
    }
    return release;
  }

  const filePath = getCachedVersionPath();
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw) return null;
  return normalizeVersion(JSON.parse(raw), "local");
}

export async function cacheAvailableVersion(version: VersionInfo): Promise<void> {
  const filePath = getCachedVersionPath();
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(version, null, 2)}\n`, "utf8");
}

export async function checkForUpdates(options: { rootDir: string } & UpdateQuery):
  Promise<UpdateStatus> {
  const current = await getCurrentVersion(options.rootDir);
  const available = await getAvailableVersion({
    sourcePath: options.sourcePath,
    remote: options.remote,
    repo: options.repo,
    channel: options.channel ?? current?.channel,
    releaseApiUrl: options.releaseApiUrl,
    githubToken: options.githubToken,
    allowPrerelease: options.allowPrerelease
  });
  if (!current || !available) {
    return {
      current,
      available,
      updateAvailable: false,
      checkedRemotely: Boolean(options.remote),
      reason: !current ? "Current version metadata missing." : "No update metadata found."
    };
  }
  const updateAvailable = compareVersions(available.version, current.version) > 0;
  const selectedAsset = selectUpdateAsset(available, {
    platform: process.platform,
    arch: process.arch,
    kind: "archive"
  });
  return {
    current,
    available,
    updateAvailable,
    selectedAsset,
    checkedRemotely: Boolean(options.remote)
  };
}

export async function installUpdate(options: {
  archivePath?: string;
  downloadUrl?: string;
  expectedSha256?: string;
  assetName?: string;
  targetDir: string;
}): Promise<{ ok: boolean; updatedFiles: number; archivePath: string; downloaded: boolean }> {
  let archivePath = options.archivePath ? path.resolve(options.archivePath) : "";
  const targetDir = path.resolve(options.targetDir);

  if (!archivePath) {
    if (!options.downloadUrl) {
      throw new Error("Update package not found.");
    }
    const tempDir = path.join(os.tmpdir(), `orchestrum-update-download-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`);
    await ensureDir(tempDir);
    archivePath = path.join(tempDir, `update${inferArchiveSuffix(options.assetName ?? options.downloadUrl)}`);
    await downloadToFile({
      url: options.downloadUrl,
      filePath: archivePath,
      expectedSha256: options.expectedSha256
    });
  }

  if (!fsSync.existsSync(archivePath)) {
    throw new Error("Update package not found.");
  }
  if (!isTarArchiveName(archivePath)) {
    throw new Error("Only .tar.gz and .tgz update archives are currently supported.");
  }

  const tempDir = path.join(os.tmpdir(), `orchestrum-update-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`);
  await ensureDir(tempDir);

  await tar.x({
    file: archivePath,
    cwd: tempDir,
    strict: true,
    filter: (entryPath) => isSafeArchivePath(entryPath)
  });

  const sourceRoot = await resolveArchiveRoot(tempDir);
  const files = await collectFiles(sourceRoot);
  for (const file of files) {
    const rel = path.relative(sourceRoot, file);
    const dest = path.join(targetDir, rel);
    await ensureDir(path.dirname(dest));
    await fs.copyFile(file, dest);
  }
  return { ok: true, updatedFiles: files.length, archivePath, downloaded: !options.archivePath };
}

export function selectUpdateAsset(
  version: VersionInfo,
  options: {
    platform?: ReleaseAssetPlatform;
    arch?: ReleaseAssetArch;
    kind?: ReleaseAssetKind;
  } = {}
): ReleaseAsset | null {
  const assets = Array.isArray(version.assets) ? version.assets : [];
  if (assets.length === 0) return null;

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const preferredKind = options.kind ?? "archive";
  const candidatePool =
    preferredKind === "archive"
      ? (() => {
          const tarCandidates = assets.filter((asset) => asset.kind === "archive" && isTarArchiveName(asset.name));
          return tarCandidates.length > 0 ? tarCandidates : assets;
        })()
      : assets;
  const scored = candidatePool
    .filter((asset) => {
      if (preferredKind && asset.kind !== preferredKind) return false;
      if (asset.platform !== "any" && asset.platform !== platform) return false;
      if (asset.arch !== "any" && asset.arch !== "universal" && asset.arch !== arch) return false;
      return true;
    })
    .map((asset) => ({
      asset,
      score:
        scorePlatform(asset.platform, platform) * 100 +
        scoreArch(asset.arch, arch) * 10 +
        (asset.sha256 ? 5 : 0) +
        (asset.kind === preferredKind ? 3 : 0)
    }))
    .sort((a, b) => b.score - a.score);

  return scored[0]?.asset ?? null;
}

export async function fetchReleaseVersion(options: UpdateQuery = {}): Promise<VersionInfo | null> {
  const channel = options.channel ?? DEFAULT_CHANNEL;
  const repo = options.repo ?? DEFAULT_UPDATE_REPO;
  const apiUrl = options.releaseApiUrl ?? `https://api.github.com/repos/${repo}/releases?per_page=12`;
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "User-Agent": "orchestrum-updater"
  });
  const token = options.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.ORCHESTRUM_GITHUB_TOKEN;
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(apiUrl, { headers });
  if (!response.ok) {
    throw new Error(`Update check failed (${response.status}).`);
  }
  const payload = await response.json();
  const releases = Array.isArray(payload) ? payload : payload ? [payload] : [];
  const selected = pickRelease(releases, channel, Boolean(options.allowPrerelease));
  if (!selected) return null;
  return normalizeGitHubRelease(selected, channel);
}

function normalizeVersion(data: any, source: VersionInfo["source"] = "local"): VersionInfo {
  const assets = Array.isArray(data.assets) ? data.assets.map((asset: any) => normalizeAsset(asset)) : undefined;
  return {
    version: String(data.version ?? "0.0.0"),
    channel: data.channel === "beta" ? "beta" : DEFAULT_CHANNEL,
    buildDate: data.buildDate ? String(data.buildDate) : undefined,
    notes: data.notes ? String(data.notes) : undefined,
    publishedAt: data.publishedAt ? String(data.publishedAt) : undefined,
    tag: data.tag ? String(data.tag) : undefined,
    source,
    releaseUrl: data.releaseUrl ? String(data.releaseUrl) : undefined,
    assets
  };
}

function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split(".").map((part) => Number(part.replace(/[^0-9]/g, "")) || 0);
  const av = parse(a);
  const bv = parse(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function isSafeArchivePath(entryPath: string): boolean {
  if (!entryPath) return false;
  if (entryPath.startsWith("/") || entryPath.startsWith("\\")) return false;
  const normalized = entryPath.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) return false;
  return true;
}

async function resolveArchiveRoot(root: string): Promise<string> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const directories = entries.filter((entry) => entry.isDirectory());
  const files = entries.filter((entry) => entry.isFile());
  if (files.length === 0 && directories.length === 1) {
    return path.join(root, directories[0]!.name);
  }
  return root;
}

async function collectFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  };
  await walk(root);
  return results;
}

function normalizeGitHubRelease(release: any, requestedChannel: VersionInfo["channel"]): VersionInfo {
  const version = extractReleaseVersion(release.tag_name ?? release.name ?? "0.0.0");
  const tag = String(release.tag_name ?? `v${version}`);
  const assets: ReleaseAsset[] = [];

  if (release.tarball_url) {
    assets.push({
      name: `orchestrum-${version}.tar.gz`,
      url: String(release.tarball_url),
      kind: "archive",
      platform: "any",
      arch: "any"
    });
  }

  if (Array.isArray(release.assets)) {
    for (const asset of release.assets) {
      assets.push(
        normalizeAsset({
          name: asset?.name,
          url: asset?.browser_download_url,
          size: asset?.size,
          contentType: asset?.content_type
        })
      );
    }
  }

  return normalizeVersion(
    {
      version,
      channel: release.prerelease ? "beta" : requestedChannel,
      buildDate: release.published_at,
      publishedAt: release.published_at,
      notes: release.body,
      tag,
      releaseUrl: release.html_url,
      assets
    },
    "github-release"
  );
}

function normalizeAsset(data: any): ReleaseAsset {
  const name = String(data?.name ?? "update");
  const url = String(data?.url ?? data?.browser_download_url ?? "");
  const contentType = data?.contentType ? String(data.contentType) : undefined;
  return {
    name,
    url,
    kind: inferAssetKind(name, contentType),
    platform: inferAssetPlatform(name),
    arch: inferAssetArch(name),
    sha256: data?.sha256 ? String(data.sha256) : undefined,
    size: Number.isFinite(Number(data?.size)) ? Number(data.size) : undefined,
    contentType
  };
}

function pickRelease(releases: any[], channel: VersionInfo["channel"], allowPrerelease: boolean): any | null {
  const published = releases.filter((release) => !release?.draft);
  if (channel === "beta" || allowPrerelease) {
    return published[0] ?? null;
  }
  return published.find((release) => !release?.prerelease) ?? null;
}

function extractReleaseVersion(raw: string): string {
  return String(raw).trim().replace(/^v/i, "") || "0.0.0";
}

function inferAssetKind(name: string, contentType?: string): ReleaseAssetKind {
  const lower = name.toLowerCase();
  const type = contentType?.toLowerCase() ?? "";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz") || type.includes("gzip")) return "archive";
  if (lower.endsWith(".zip")) return "archive";
  if (lower.endsWith(".appimage") || lower.endsWith(".msi") || lower.endsWith(".exe") || lower.endsWith(".dmg")) return "installer";
  if (lower.endsWith(".deb") || lower.endsWith(".rpm") || lower.endsWith(".pkg")) return "package";
  if (lower.endsWith(".sha256") || lower.endsWith(".sha256sum")) return "checksum";
  return "unknown";
}

function inferAssetPlatform(name: string): ReleaseAssetPlatform {
  const lower = name.toLowerCase();
  if (lower.includes("darwin") || lower.includes("macos") || lower.includes("osx") || lower.endsWith(".dmg") || lower.endsWith(".pkg")) {
    return "darwin";
  }
  if (lower.includes("linux") || lower.endsWith(".appimage") || lower.endsWith(".deb") || lower.endsWith(".rpm")) {
    return "linux";
  }
  if (lower.includes("win") || lower.endsWith(".msi") || lower.endsWith(".exe")) {
    return "win32";
  }
  return "any";
}

function inferAssetArch(name: string): ReleaseAssetArch {
  const lower = name.toLowerCase();
  if (lower.includes("universal")) return "universal";
  if (lower.includes("arm64") || lower.includes("aarch64")) return "arm64";
  if (lower.includes("x64") || lower.includes("amd64") || lower.includes("x86_64")) return "x64";
  if (lower.includes("ia32") || lower.includes("x86")) return "ia32";
  return "any";
}

function scorePlatform(candidate: ReleaseAssetPlatform, target: ReleaseAssetPlatform): number {
  if (candidate === target) return 3;
  if (candidate === "any") return 1;
  return 0;
}

function scoreArch(candidate: ReleaseAssetArch, target: ReleaseAssetArch): number {
  if (candidate === target) return 3;
  if (candidate === "universal") return 2;
  if (candidate === "any") return 1;
  return 0;
}

function inferArchiveSuffix(nameOrUrl: string): string {
  const lower = nameOrUrl.toLowerCase();
  if (lower.endsWith(".tar.gz")) return ".tar.gz";
  if (lower.endsWith(".tgz")) return ".tgz";
  if (lower.endsWith(".zip")) return ".zip";
  return ".tar.gz";
}

async function downloadToFile(options: {
  url: string;
  filePath: string;
  expectedSha256?: string;
}): Promise<void> {
  const response = await fetch(options.url, {
    headers: {
      "User-Agent": "orchestrum-updater"
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to download update (${response.status}).`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (options.expectedSha256) {
    const actual = crypto.createHash("sha256").update(buffer).digest("hex");
    if (actual !== options.expectedSha256.toLowerCase()) {
      throw new Error("Update checksum verification failed.");
    }
  }
  await fs.writeFile(options.filePath, buffer);
}

function isTarArchiveName(nameOrUrl: string): boolean {
  const lower = nameOrUrl.toLowerCase();
  return lower.endsWith(".tar.gz") || lower.endsWith(".tgz");
}
