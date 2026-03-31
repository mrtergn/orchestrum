import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type express from "express";
import {
  getCurrentVersion,
  readTailLines
} from "@orchestrum/core";

export function registerMetaOpsRoutes(
  app: express.Express,
  options: {
    rootDir: string;
    runsDir: string;
  }
): void {
  app.get("/health", (_req, res) => {
    res.json({ ok: true, runsDir: options.runsDir });
  });

  app.get("/meta/version", async (_req, res) => {
    const version = await getCurrentVersion(options.rootDir).catch(() => null);
    res.json({ version });
  });

  app.get("/meta/changelog", async (_req, res) => {
    const filePath = path.join(options.rootDir, "CHANGELOG.md");
    const content = await fs.readFile(filePath, "utf8").catch(() => "");
    res.json({ content });
  });

  app.get("/meta/eula", async (_req, res) => {
    const licensePath = path.join(options.rootDir, "LICENSE");
    const fallbackPath = path.join(options.rootDir, "EULA.md");
    const content =
      (await fs.readFile(licensePath, "utf8").catch(() => "")) ||
      (await fs.readFile(fallbackPath, "utf8").catch(() => ""));
    res.json({ content });
  });

  app.get("/meta/about", async (_req, res) => {
    const version = await getCurrentVersion(options.rootDir).catch(() => null);
    res.json({ version, edition: "Open Source", license: { name: "MIT" } });
  });

  app.get("/logs/service", async (req, res) => {
    const tailRaw = req.query.tail ? Number(req.query.tail) : 200;
    const tail = Number.isFinite(tailRaw) && tailRaw > 0 ? tailRaw : 200;
    const logPath = path.join(options.rootDir, "logs", "service.ndjson");
    const lines = fsSync.existsSync(logPath) ? await readTailLines(logPath, tail) : [];
    res.json({ lines });
  });
}
