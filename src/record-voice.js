// src/record-voice.js
//
// Admin voice recording (/record) — shared pure helpers for the Messenger
// bot. Mirrors Telegram's /record flow (final-code-fix src/index.js:
// beginVoiceRecording / captureVoiceRecording / voiceNext / voiceClaim):
//   /record            — next word with no recording yet (sequential)
//   /record_choose     — admin sends a word, picks it, then records it
//   /record_stop       — stop the session
//   /record_voice      — alias of /record (Telegram parity)
//
// The recording prompt asks the admin to say the word THREE times in a
// row with short pauses, in ONE voice message. The file then contains
// the word 3× natively, so it plays 3× on every platform with zero
// repetition processing: Telegram, WhatsApp and Messenger all send
// recorded human voices as-is today (never repeated), and Messenger's
// "one message, word 3× inside" rule is satisfied by the recording
// itself. No ffmpeg step runs in the request path — the Worker cannot
// run ffmpeg at all.
//
// What arrives, what is stored (R2 bucket `coptic-lessons`, prefix
// `recorded/`, public base
// https://pub-e39b5be260724e0ea1bbf6a7db089987.r2.dev/recorded):
//   Messenger voice message -> audio attachment URL, no mime type in the
//     webhook payload; the extension comes from the download's
//     Content-Type header (Messenger voice notes are MP4/AAC).
//     Stored as recorded/<id>.mp4 (or .mp3/.ogg when that is what
//     arrived). Messenger plays MP4 natively; WhatsApp transcodes it to
//     MP3 on demand (ffmpeg on the VM); Telegram needs the OGG (the
//     converter script produces it — see scripts/convert-recorded.mjs).
//   A converter (scripts/convert-recorded.mjs, VM-side, OPTIONAL) can
//     upgrade any raw recording to recorded/<id>.mp3 (+ .ogg) when the
//     recording must play somewhere the raw file cannot. It is NOT part
//     of the /record path: the raw file plays as-is on Messenger, and
//     the user stopped the prebuilt-voice MP3 upload on 2026-11-16
//     (OGG already plays fine on Messenger as-is), so MP3 here is an
//     optional later fallback only. Playback prefers the .mp3 sibling
//     whenever one happens to exist (resolveRecordedPlayback) — the
//     converter needs no Worker/DO coordination to take effect.
//
// Manifest story: Telegram repo data/recorded-voices.json ({id: filename})
// stays the baked-in index (synced into this repo every 30 min). A fresh
// recording is live on Messenger immediately through a Durable Object
// overlay (RECORDED_OVERLAY_KEY, via the parity module's adminStore):
// the overlay wins over the manifest, and the manifest line is added
// afterwards (scripts/add-recorded-voice.mjs) so the next sync bakes it
// in. The overlay is also what /voicecoverage counts.

export const RECORDED_R2_PREFIX = "recorded";
export const RECORDED_OVERLAY_KEY = "recorded:overlay";
// Tombstone for a deleted recording: the overlay value that means "this
// word's recording was deleted — fall back to the prebuilt voice". It
// exists because the baked-in manifest cannot be un-baked: an id in
// data/recorded-voices.json still yields a recorded URL unless the live
// overlay overrides it with this marker (recordedFilenameFor returns
// null for it, mergeRecordedIds skips it). A fresh /record for the word
// replaces the tombstone with the new filename.
export const RECORDED_DELETED = "__deleted__";
// Public base for the recorded prefix. The Worker var
// RECORDED_AUDIO_BASE_URL must point here (with the /recorded suffix);
// the default below is used when the var is unset.
export const RECORDED_AUDIO_BASE_URL_DEFAULT =
  "https://pub-e39b5be260724e0ea1bbf6a7db089987.r2.dev/recorded";
// A voice note longer than this is rejected, not stored (Telegram voice
// messages are short; 10 MB is far above a word said 3×).
export const MAX_RECORD_BYTES = 10 * 1024 * 1024;
// Downloading the admin's attachment must not stall the webhook.
export const RECORD_AUDIO_TIMEOUT_MS = 15000;

const MIME_TO_EXT = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "mp4",
  "audio/x-mp4": "mp4",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/webm": "webm",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

// "audio/mp4; codecs=mp4a.40.2" -> "audio/mp4".
export function cleanMimeType(mimeType) {
  return String(mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

export function mimeToExt(mimeType) {
  return MIME_TO_EXT[cleanMimeType(mimeType)] ?? null;
}

const KNOWN_EXTS = new Set(["mp3", "mp4", "m4a", "ogg", "aac", "webm", "wav"]);

export function extFromUrl(url) {
  try {
    const path = new URL(String(url)).pathname;
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    return KNOWN_EXTS.has(ext) ? ext : null;
  } catch {
    return null;
  }
}

function safeRecordId(id) {
  const digits = String(id ?? "").replace(/[^0-9]/gu, "");
  return digits || null;
}

// File name for a fresh recording: <word-id>.<ext>. The extension comes
// from the download's Content-Type, then the attachment URL, then the
// Messenger default (voice notes are MP4). Null when the id is not a
// word id or no usable extension can be found.
export function recordedFileName(id, mimeType, url) {
  const safe = safeRecordId(id);
  if (!safe) return null;
  const ext = mimeToExt(mimeType) ?? extFromUrl(url) ?? "mp4";
  return `${safe}.${ext}`;
}

// Telegram's voiceNext (DO op, final-code-fix src/index.js): scan the
// dictionary in order, first record whose id has no recording. Returns
// the record plus progress counts, or null when every word is recorded.
// `total` is the whole dictionary size (counted in full), so the prompt's
// "المسجّل: X من Y" line is honest — the scan position is not the total.
export function nextUnrecordedWord(records, recordedIds) {
  const recorded = recordedIds instanceof Set ? recordedIds : new Set(recordedIds ?? []);
  const list = Array.isArray(records) ? records : [];
  let total = 0;
  let first = null;
  for (const record of list) {
    if (record?.id == null) continue;
    total += 1;
    if (!first && !recorded.has(String(record.id))) first = record;
  }
  if (!first) return null;
  return {
    id: first.id,
    coptic: first.coptic ?? "",
    pronunciation: first.pronunciation ?? "",
    english: first.english ?? "",
    meaning: first.meaning ?? "",
    recorded: recorded.size,
    total,
  };
}

// Telegram's voicePrompt, plain text (no HTML — Messenger strips markup
// and WhatsApp reuses this text verbatim). The 3× instruction is the
// whole repeat mechanism: the admin says the word three times in the
// recording, so the file plays 3× everywhere with no processing.
export function recordPrompt(item, { recorded = 0, total = 0 } = {}) {
  if (!item) return "✅ اكتمل تسجيل النطق لكل كلمات القاموس.";
  const lines = ["🎙️ تسجيل نطق كلمة جديدة", `الكلمة: ${item.coptic || "—"}`];
  if (total) lines.push(`المسجّل: ${recorded ?? 0} من ${total}`);
  if (item.pronunciation) lines.push(`النطق المكتوب: ${item.pronunciation}`);
  if (item.english) lines.push(`الإنجليزية: ${item.english}`);
  if (item.meaning) lines.push(`المعنى: ${String(item.meaning).split(/\s*[،,]\s*/u)[0]}`);
  lines.push("قول الكلمة 3 مرات ورا بعض بوقفات قصيرة، ثم أرسلها كرسالة صوتية. لإيقاف الجلسة أرسل /record_stop.");
  return lines.join("\n");
}

// All recorded word ids: the baked-in manifest plus the live DO overlay.
// Each source is an object { id: filename } or an array of id strings.
// A tombstoned id (overlay value RECORDED_DELETED, see /voice_delete)
// counts as NOT recorded, even when the manifest still names it —
// otherwise /record would never offer the word again and /voicecoverage
// would keep counting a deleted voice.
export function mergeRecordedIds(manifest, overlay) {
  const ids = new Set();
  const tombstoned = new Set();
  if (overlay && typeof overlay === "object" && !Array.isArray(overlay)) {
    for (const [key, value] of Object.entries(overlay)) {
      if (value === RECORDED_DELETED) tombstoned.add(String(key));
    }
  }
  for (const source of [manifest, overlay]) {
    if (!source || typeof source !== "object") continue;
    const keys = Array.isArray(source) ? source : Object.keys(source);
    for (const key of keys) {
      if (!tombstoned.has(String(key))) ids.add(String(key));
    }
  }
  return ids;
}

// Which file plays for a word: the live overlay wins over the baked-in
// manifest (a fresh recording is live before its manifest line lands).
// A tombstoned overlay entry (RECORDED_DELETED, see /voice_delete)
// returns null, so playback falls back to the prebuilt voice instead
// of the dead recorded URL.
export function recordedFilenameFor(id, manifest, overlay) {
  if (id == null) return null;
  const key = String(id);
  if (overlay && Object.hasOwn(overlay, key)) {
    const value = overlay[key];
    if (value === RECORDED_DELETED) return null;
    return value;
  }
  if (manifest && Object.hasOwn(manifest, key)) return manifest[key];
  return null;
}

// Plan a /voice_delete: which R2 file to remove and what the overlay
// becomes. Pure (no DO/R2): the caller saves nextOverlay and deletes
// the keys. An id in the baked-in manifest gets a tombstone (the manifest
// still names it, so removing the overlay key alone would resurrect the
// dead URL); an overlay-only id simply loses its key. A stale tombstone
// for an id the manifest no longer has is cleaned up. Returns
// { nextOverlay, filename, hadRecording, inManifest } — hadRecording is
// false when nothing was stored anywhere (overlay or manifest).
export function applyVoiceDelete(overlay, id, manifestFilename = null) {
  const key = String(id);
  const base = overlay && typeof overlay === "object" && !Array.isArray(overlay) ? { ...overlay } : {};
  const overlayValue = Object.hasOwn(base, key) ? base[key] : undefined;
  const overlayFile = overlayValue && overlayValue !== RECORDED_DELETED ? overlayValue : null;
  const filename = overlayFile ?? manifestFilename ?? null;
  if (!filename) {
    if (overlayValue === RECORDED_DELETED) delete base[key];
    return { nextOverlay: base, filename: null, hadRecording: false, inManifest: Boolean(manifestFilename) };
  }
  if (manifestFilename) base[key] = RECORDED_DELETED;
  else delete base[key];
  return { nextOverlay: base, filename, hadRecording: true, inManifest: Boolean(manifestFilename) };
}

// R2 keys a delete must remove for one stored recording: the raw file
// plus its .mp3 sibling when one could exist. The sibling matters: a
// stale recorded/<id>.mp3 would win over a later re-recording, because
// playback prefers the .mp3 sibling whenever it exists
// (resolveRecordedPlayback). Deleting a missing key is a no-op on R2.
export function voiceDeleteR2Keys(filename) {
  if (!filename || typeof filename !== "string") return [];
  const keys = [`${RECORDED_R2_PREFIX}/${filename}`];
  const sibling = mp3Sibling(filename);
  if (sibling) keys.push(`${RECORDED_R2_PREFIX}/${sibling}`);
  return keys;
}

// The .mp3 sibling of a stored recording: recorded/55.ogg ->
// recorded/55.mp3. Null when the file already is MP3.
export function mp3Sibling(filename) {
  if (!filename || typeof filename !== "string") return null;
  if (filename.toLowerCase().endsWith(".mp3")) return null;
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return null;
  return `${filename.slice(0, dot)}.mp3`;
}

// Playback prefers the MP3 sibling whenever one exists (the optional
// converter script produces it after the fact): a raw recording whose
// format some client cannot play is upgraded to its MP3 transparently,
// with no Worker/DO/manifest coordination. mp3Exists is the caller's
// check (HEAD on the public URL, cached) — pure here so tests need no
// network. With no MP3 sibling the raw file plays as-is (Messenger
// plays MP4/AAC natively, and OGG already plays fine on Messenger
// as-is — the prebuilt-voice MP3 upload was stopped by the user on
// 2026-11-16, so MP3 is an optional fallback, not a dependency).
export function resolveRecordedPlayback(filename, mp3Exists) {
  if (!filename) return null;
  if (mp3Exists) {
    const sibling = mp3Sibling(filename);
    if (sibling) return sibling;
  }
  return filename;
}

export function recordedPlaybackUrl(base, filename) {
  if (!base || !filename) return null;
  return `${String(base).replace(/\/+$/u, "")}/${encodeURIComponent(filename)}`;
}
