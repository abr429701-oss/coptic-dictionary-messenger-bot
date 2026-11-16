// scripts/convert-recorded.mjs
//
// OPTIONAL — convert a recorded human voice (the raw file a /record
// session stored in R2 recorded/<id>.<ext>) into the two playback
// formats and upload them next to it:
//
//   recorded/<id>.mp3  — the playback file for clients that cannot play
//                        the raw format (WhatsApp plays MP3 natively;
//                        Telegram needs the .ogg below).
//   recorded/<id>.ogg  — the Opus original, for archival parity with the
//                        Telegram export (Telegram plays OGG file_ids).
//
// This is NOT part of the /record path and NOT a deploy dependency:
// a fresh recording plays as-is on Messenger (MP4/AAC natively, and
// OGG already plays fine on Messenger as-is — the user stopped the
// prebuilt-voice MP3 upload on 2026-11-16). Run this only when a
// recording must also play on WhatsApp or Telegram, or when the admin
// wants the archival OGG. Playback prefers the .mp3 sibling
// automatically when one exists, so the converter needs no
// Worker/DO/manifest coordination to take effect.
//
// The Worker cannot run ffmpeg, so this runs on the VM (the same machine
// the WhatsApp port runs on, where ffmpeg exists). It never touches
// voices-mp3/ (the 485 prebuilt Polly MP3s the stopped upload left
// there) and never rewrites the manifest — the DO overlay already makes
// a fresh recording live before its manifest line lands.
//
// Usage (one word at a time; repeat for more):
//   node scripts/convert-recorded.mjs --id 155
//   node scripts/convert-recorded.mjs --id 155 --from ./55.ogg   # local file instead of R2
//   node scripts/convert-recorded.mjs --id 155 --only-mp3        # skip the .ogg
//   node scripts/convert-recorded.mjs --id 155 --skip-upload     # convert only, print paths
//
// Env / flags:
//   --r2-base   public base URL (default
//               https://pub-e39b5be260724e0ea1bbf6a7db089987.r2.dev/recorded)
//   --bucket    R2 bucket for the upload (default coptic-lessons)
//   --remote    pass --remote to wrangler (default: remote, because a
//               local miniflare put proves nothing and is invisible to
//               the Worker — the same trap as the MP3 batch)
//   --skip-ogg  alias of --only-mp3
//   --force     re-convert and re-upload even when the outputs exist
//
// Requires: ffmpeg + wrangler on PATH. Uploads with
// `wrangler r2 object put --remote`, which needs the deploy token's
// "Workers R2 Storage: Edit" permission (the same permission the
// voices-mp3/ batch needed).
//
// Exit code: 0 on success, 1 when anything failed.

import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const R2_BASE_DEFAULT = "https://pub-e39b5be260724e0ea1bbf6a7db089987.r2.dev/recorded";
const BUCKET_DEFAULT = "coptic-lessons";

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
if (!id || !/^\d+$/.test(String(id))) {
  console.error("usage: node scripts/convert-recorded.mjs --id <word-id> [--from <path>] [--only-mp3] [--skip-upload] [--force]");
  process.exit(1);
}
const r2Base = String(args.get("r2-base") ?? R2_BASE_DEFAULT).replace(/\/+$/, "");
const bucket = String(args.get("bucket") ?? BUCKET_DEFAULT);
const onlyMp3 = Boolean(args.get("only-mp3") || args.get("skip-ogg"));
const skipUpload = Boolean(args.get("skip-upload"));
const force = Boolean(args.get("force"));
const from = args.get("from") ? String(args.get("from")) : null;

const tmp = mkdtempSync(join(tmpdir(), `convert-recorded-${id}-`));
// ffmpeg probes the container from the bytes, so the input needs no
// extension (Messenger voice notes arrive as MP4/AAC, WhatsApp as OGG).
const inputPath = join(tmp, "input");
const mp3Path = join(tmp, `${id}.mp3`);
const oggPath = join(tmp, `${id}.ogg`);

function fail(message) {
  console.error(`convert-recorded: ${message}`);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

async function run(command, argv) {
  try {
    const { stdout, stderr } = await execFileAsync(command, argv, { maxBuffer: 10 * 1024 * 1024 });
    if (stderr) process.stderr.write(stderr);
    return stdout;
  } catch (error) {
    fail(`${command} ${argv.join(" ")} failed: ${error instanceof Error ? error.message : "unknown"}`);
  }
}

async function headExists(url) {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10000) });
    return res.ok;
  } catch {
    return false;
  }
}

// 1. Fetch the raw recording (from R2, or from a local file for the two
//    existing Telegram recordings, which live only in the WhatsApp port's
//    data/recorded-voices/).
let inputBytes;
if (from) {
  if (!existsSync(from)) fail(`local file not found: ${from}`);
  inputBytes = readFileSync(from);
  console.log(`convert-recorded: read ${inputBytes.byteLength} bytes from ${from}`);
} else {
  const candidates = [`${r2Base}/${id}.mp4`, `${r2Base}/${id}.mp3`, `${r2Base}/${id}.ogg`, `${r2Base}/${id}.m4a`, `${r2Base}/${id}.wav`];
  let found = null;
  for (const url of candidates) {
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    } catch {
      continue;
    }
    if (res.ok) { found = { url, res }; break; }
  }
  if (!found) fail(`no raw recording found for ${id} under ${r2Base}/ (tried .mp4/.mp3/.ogg/.m4a/.wav)`);
  const buf = await found.res.arrayBuffer();
  inputBytes = new Uint8Array(buf);
  console.log(`convert-recorded: fetched ${inputBytes.byteLength} bytes from ${found.url}`);
}
if (inputBytes.byteLength < 100) fail(`recording for ${id} is empty or too short (${inputBytes.byteLength} bytes)`);
writeFileSync(inputPath, inputBytes);

// 2. Convert. ffmpeg writes to a real file (not a pipe) so the MP3
//    carries a Xing/Info seek header — pipe-encoded MP3s cannot be
//    replayed, which is the same trap the WhatsApp port's oggToMp3 hit.
const mp3Url = `${r2Base}/${id}.mp3`;
const oggUrl = `${r2Base}/${id}.ogg`;
const mp3Exists = !force && (await headExists(mp3Url));
const oggExists = !force && !onlyMp3 && (await headExists(oggUrl));
if (!mp3Exists) {
  console.log(`convert-recorded: ffmpeg -> ${id}.mp3`);
  await run("ffmpeg", ["-y", "-v", "error", "-i", inputPath, "-vn", "-c:a", "libmp3lame", "-b:a", "96k", mp3Path]);
  if (!existsSync(mp3Path) || readFileSync(mp3Path).byteLength < 1000) fail("mp3 output missing or too small");
} else {
  console.log(`convert-recorded: ${id}.mp3 already exists, skipping (use --force to redo)`);
}
if (!onlyMp3 && !oggExists) {
  console.log(`convert-recorded: ffmpeg -> ${id}.ogg`);
  await run("ffmpeg", ["-y", "-v", "error", "-i", inputPath, "-vn", "-c:a", "libopus", "-b:a", "96k", oggPath]);
  if (!existsSync(oggPath) || readFileSync(oggPath).byteLength < 1000) fail("ogg output missing or too small");
} else if (!onlyMp3) {
  console.log(`convert-recorded: ${id}.ogg already exists, skipping (use --force to redo)`);
}

// 3. Upload to R2 recorded/ (remote — a local miniflare put is invisible
//    to the Worker). Never touches voices-mp3/.
if (skipUpload) {
  console.log(`convert-recorded: --skip-upload, outputs left in ${tmp}`);
  console.log(`  mp3: ${mp3Path}${onlyMp3 ? "" : `\n  ogg: ${oggPath}`}`);
  process.exit(0);
}
if (!mp3Exists) {
  await run("wrangler", ["r2", "object", "put", `${bucket}/recorded/${id}.mp3`, "--file", mp3Path, "--remote"]);
  console.log(`convert-recorded: uploaded recorded/${id}.mp3`);
}
if (!onlyMp3 && !oggExists) {
  await run("wrangler", ["r2", "object", "put", `${bucket}/recorded/${id}.ogg`, "--file", oggPath, "--remote"]);
  console.log(`convert-recorded: uploaded recorded/${id}.ogg`);
}
rmSync(tmp, { recursive: true, force: true });
console.log(`convert-recorded: done for ${id} (mp3: ${mp3Url}${onlyMp3 ? "" : `, ogg: ${oggUrl}`})`);
