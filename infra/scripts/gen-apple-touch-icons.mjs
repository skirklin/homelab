#!/usr/bin/env node
// Generate apple-touch-icon.png for each PWA from its favicon.svg.
//
// One-shot tool: each frontend app's PWA needs a 180x180 opaque PNG for iOS
// home-screen installs. Source SVG + opaque background per app are listed
// below. Uses `sharp` (run via `npx --yes -p sharp ...`).
//
// Usage:
//   node infra/scripts/gen-apple-touch-icons.mjs
//
// Requires `sharp` to be resolvable; the wrapper script
// (`gen-apple-touch-icons.sh`) handles the npx invocation.
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
// When invoked via the wrapper script, the .mjs is copied next to a temp
// node_modules; HOMELAB_REPO_ROOT points back at the repo. Otherwise assume
// the script lives under infra/scripts/ in the repo.
const repoRoot = process.env.HOMELAB_REPO_ROOT
  ?? resolve(dirname(__filename), "..", "..");

const APPS = [
  { name: "home",     bg: "#7c3aed" },
  { name: "recipes",  bg: "#2ca6a4" },
  { name: "shopping", bg: "#2ca6a4" },
  { name: "travel",   bg: "#1677ff" },
  { name: "upkeep",   bg: "#5c7cfa" },
];

const SIZE = 180;

async function generate({ name, bg }) {
  const publicDir = resolve(repoRoot, "apps", name, "app", "public");
  const src = resolve(publicDir, "favicon.svg");
  const dst = resolve(publicDir, "apple-touch-icon.png");
  mkdirSync(publicDir, { recursive: true });
  await sharp(src)
    .resize(SIZE, SIZE)
    .flatten({ background: bg })
    .png()
    .toFile(dst);
  console.log(`wrote ${dst}`);
}

for (const app of APPS) {
  await generate(app);
}
