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

// Transient GitHub blips (HTTP 503/429/5xx, network resets) used to fail the
// whole sync even though the next run succeeded. Retry each file a few times
// with backoff before giving up, so one brief GitHub hiccup no longer
// produces a SYNC FAIL.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4; // 1 try + 3 retries
const RETRY_DELAYS_MS = [2000, 5000, 10000];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fetchWithRetry(url, rel) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (res.ok) return res;
      lastError = new Error(`HTTP ${res.status}`);
      if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_ATTEMPTS) {
        console.error(`sync: ${rel} -> HTTP ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS})`);
        return null;
      }
      console.error(`sync: ${rel} -> HTTP ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS}); retrying in ${RETRY_DELAYS_MS[attempt - 1] / 1000}s`);
    } catch (error) {
      lastError = error;
      if (attempt === MAX_ATTEMPTS) {
        console.error(`sync: fetch failed for ${rel}: ${error instanceof Error ? error.message : "unknown"} (attempt ${attempt}/${MAX_ATTEMPTS})`);
        return null;
      }
      console.error(`sync: fetch failed for ${rel}: ${error instanceof Error ? error.message : "unknown"} (attempt ${attempt}/${MAX_ATTEMPTS}); retrying in ${RETRY_DELAYS_MS[attempt - 1] / 1000}s`);
    }
    await sleep(RETRY_DELAYS_MS[attempt - 1]);
  }
  console.error(`sync: ${rel} failed after ${MAX_ATTEMPTS} attempts: ${lastError instanceof Error ? lastError.message : "unknown"}`);
  return null;
}

let failed = false;
for (const rel of FILES) {
  const url = `${BASE}/${rel}`;
  const res = await fetchWithRetry(url, rel);
  if (!res) {
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
