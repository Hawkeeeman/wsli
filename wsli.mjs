#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist", "index.js");
const src = path.join(root, "src", "index.ts");
const tscBin = path.join(root, "node_modules", ".bin", "tsc");
const OLD_PING_SNIPPET = "print({ status: response.status, payload }";
const OLD_LOOKUP_SNIPPET = "Lookup endpoint is currently unavailable";

function distSnippet(path, snippet) {
  if (!fs.existsSync(path)) return false;
  try {
    return fs.readFileSync(path, "utf8").includes(snippet);
  } catch {
    return false;
  }
}

function distHasOldPing() {
  return distSnippet(dist, OLD_PING_SNIPPET);
}

function distHasOldLookup() {
  return distSnippet(dist, OLD_LOOKUP_SNIPPET);
}

function needBuild() {
  if (!fs.existsSync(dist)) return true;
  if (distHasOldPing() || distHasOldLookup()) return true;
  if (!fs.existsSync(src)) return false;
  return fs.statSync(src).mtimeMs > fs.statSync(dist).mtimeMs;
}

if (fs.existsSync(tscBin) && needBuild()) {
  const r = spawnSync(tscBin, ["-p", "tsconfig.json"], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (distHasOldPing() || distHasOldLookup()) {
  const issue = distHasOldLookup()
    ? "lookup still uses the removed trade-service /securities endpoint"
    : "ping still prints token/info";
  console.error(
    `wsli: outdated build (${issue}). From this repo run: npm install && npm run build. ` +
      "If you use a global install, run npm install -g . here or npm update -g wsli after a new release."
  );
  process.exit(1);
}

if (!fs.existsSync(dist)) {
  console.error(`wsli: missing ${dist}. Run: npm install && npm run build`);
  process.exit(1);
}

const r = spawnSync(process.execPath, [dist, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 0);
