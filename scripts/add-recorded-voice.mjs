// scripts/add-recorded-voice.mjs
//
// Add one recorded voice to the baked-in manifest (data/recorded-voices.json)
// so it survives the 30-min sync and plays on every platform even after
// the DO overlay is cleared:
//
//   node scripts/add-recorded-voice.mjs --id 155 --file 155.mp4
//   node scripts/add-recorded-voice.mjs --id 155 --file 155.ogg --check
//
// The file name is stored as-is (recorded/<id>.<ext>); the playback path
// prefers the .mp3 sibling when the converter produced it, so the stored
// name is usually the RAW recording (e.g. 155.mp4) and the converter
// script adds 155.mp3 next to it.
//
// --check only verifies the raw file exists on the R2 public base and
// the .mp3 sibling is (or is not) there yet; it writes nothing.
//
// After running this, commit data/recorded-voices.json and push to the
// Telegram repo (its main branch is the source the other two pull from
// every 30 min); the Messenger repo picks it up on the next sync
// (scripts/sync-data-from-telegram.mjs) and the WhatsApp port on the
// next auto-sync. The recording itself is already live on Messenger
// through the DO overlay from the moment /record saved it — this step
// only makes it permanent.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const R2_BASE_DEFAULT = "https://pub-e39b5be260724e0ea1bbf6a7db089987.r2.dev/recorded";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) { args.set(key, next); i += 1; }
  else args.set(key, true);
}

const id = args.get("id");
const file = args.get("file") ? String(args.get("file")) : null;
const checkOnly = Boolean(args.get("check"));
const r2Base = String(args.get("r2-base") ?? R2_BASE_DEFAULT).replace(/\/+$/, "");

if (!id || !/^\d+$/.test(String(id))) {
  console.error("usage: node scripts/add-recorded-voice.mjs --id <word-id> --file <filename> [--check]");
  process.exit(1);
}
if (!checkOnly && (!file || !/^\d+\.(mp3|ogg|mp4|m4a|wav)$/.test(file))) {
  console.error("usage: --file must be <id>.<ext> (mp3|ogg|mp4|m4a|wav), e.g. 155.mp4");
  process.exit(1);
}
if (!checkOnly && !file.startsWith(`${id}.`)) {
  console.error(`usage: --file must start with the word id (${id}.), got ${file}`);
  process.exit(1);
}

async function headExists(url) {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10000) });
    return res.ok;
  } catch {
    return false;
  }
}

const rawUrl = `${r2Base}/${file ?? `${id}.mp4`}`;
const mp3Url = `${r2Base}/${id}.mp3`;
const rawExists = await headExists(rawUrl);
const mp3Exists = await headExists(mp3Url);
console.log(`add-recorded-voice: raw ${rawUrl} -> ${rawExists ? "exists" : "MISSING"}`);
console.log(`add-recorded-voice: mp3 ${mp3Url} -> ${mp3Exists ? "exists" : "not yet (run scripts/convert-recorded.mjs --id " + id + ")"}`);
if (checkOnly) process.exit(rawExists ? 0 : 1);
if (!rawExists) {
  console.error(`add-recorded-voice: refusing to write the manifest — the raw file is not on R2 yet (upload it first, or check the file name)`);
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "data", "recorded-voices.json");
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch {
  console.error(`add-recorded-voice: cannot read ${manifestPath}`);
  process.exit(1);
}
if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
  console.error(`add-recorded-voice: ${manifestPath} is not an object`);
  process.exit(1);
}
const previous = manifest[String(id)] ?? null;
manifest[String(id)] = file;
const keys = Object.keys(manifest).sort((a, b) => Number(a) - Number(b));
const sorted = {};
for (const key of keys) sorted[key] = manifest[key];
writeFileSync(manifestPath, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`add-recorded-voice: data/recorded-voices.json ${id}: ${previous ?? "(none)"} -> ${file}`);
console.log("add-recorded-voice: commit + push this file to the Telegram repo; the Messenger and WhatsApp syncs pick it up within ~30 min each.");
