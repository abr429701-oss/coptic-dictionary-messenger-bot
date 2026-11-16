// scripts/sync-data-from-telegram.mjs
//
// Mirror the derived data files from the Telegram bot repo
// (abr429701-oss/coptic-dictionary-bot, branch main) into this repo.
//
// The Telegram repo remains the single pipeline: the Google Sheet is read
// there every 30 minutes and dictionary.json / learn-manifest.js are
// regenerated from it. This repo only copies the outputs — it never reads
// the Sheet itself, so the two repos can never diverge in logic. The
// Telegram repo is public, so raw.githubusercontent.com needs no token.
//
// Files synced (never hand-edited here):
//   data/dictionary.json, data/word_ids.json, data/audio-manifest.json,
//   data/audio-versions.json, data/recorded-voices.json,
//   src/learn-manifest.js
//
// Exit code: 0 when every file downloaded and at least the dictionary
// parses as JSON; 1 otherwise (the CI sync job must not commit a
// half-synced tree).

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "abr429701-oss/coptic-dictionary-bot";
const BRANCH = "main";
const BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;

const FILES = [
  "data/dictionary.json",
  "data/word_ids.json",
  "data/audio-manifest.json",
  "data/audio-versions.json",
  "data/recorded-voices.json",
  "src/learn-manifest.js",
];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let failed = false;
for (const rel of FILES) {
  const url = `${BASE}/${rel}`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  } catch (error) {
    console.error(`sync: fetch failed for ${rel}: ${error instanceof Error ? error.message : "unknown"}`);
    failed = true;
    continue;
  }
  if (!res.ok) {
    console.error(`sync: ${rel} -> HTTP ${res.status}`);
    failed = true;
    continue;
  }
  const text = await res.text();
  if (rel.endsWith(".json")) {
    try {
      JSON.parse(text);
    } catch {
      console.error(`sync: ${rel} is not valid JSON, refusing to write it`);
      failed = true;
      continue;
    }
  }
  const dest = join(root, rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text);
  console.log(`sync: ${rel} (${Buffer.byteLength(text)} bytes)`);
}

if (failed) {
  console.error("sync: one or more files failed; nothing was committed");
  process.exit(1);
}
console.log("sync: all files up to date");
