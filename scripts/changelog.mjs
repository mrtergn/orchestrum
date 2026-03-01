import fs from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const versionFlag = args.indexOf("--version");
const notesFlag = args.indexOf("--notes");

const version = versionFlag !== -1 && args[versionFlag + 1]
  ? args[versionFlag + 1]
  : (await readVersion());

const notes = notesFlag !== -1 && args[notesFlag + 1]
  ? args[notesFlag + 1]
  : "Notes pending.";

const date = new Date().toISOString().slice(0, 10);
const entry = `## ${version} - ${date}\n- ${notes}\n\n`;

const filePath = path.resolve("CHANGELOG.md");
let content = "# Changelog\n\n";
try {
  content = await fs.readFile(filePath, "utf8");
} catch {
  // create new
}

if (!content.includes("# Changelog")) {
  content = `# Changelog\n\n${content}`;
}

content = content.trimEnd() + "\n\n" + entry;
await fs.writeFile(filePath, content, "utf8");
console.log(`Updated ${filePath} with version ${version}.`);

async function readVersion() {
  try {
    const pkg = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8"));
    return pkg.version ?? "Unreleased";
  } catch {
    return "Unreleased";
  }
}
