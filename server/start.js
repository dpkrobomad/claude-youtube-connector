#!/usr/bin/env node
// Launcher: installs dependencies on first run (output to stderr — stdout is the MCP channel), then starts the server.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!fs.existsSync(path.join(root, "node_modules", "@modelcontextprotocol", "sdk"))) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(npm, ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: root, stdio: ["ignore", 2, 2] });
  if (r.status !== 0) { console.error("youtube plugin: npm install failed"); process.exit(1); }
}
await import("./index.js");
