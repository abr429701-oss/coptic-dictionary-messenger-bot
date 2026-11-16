// Voice recording (/record) — unit tests for the pure helpers in
// src/record-voice.js. No network, no DO, no R2: every helper is pure.
import test from "node:test";
import assert from "node:assert/strict";
import {
  RECORDED_R2_PREFIX,
  RECORDED_OVERLAY_KEY,
  MAX_RECORD_BYTES,
  RECORD_AUDIO_TIMEOUT_MS,
  cleanMimeType,
  mimeToExt,
  extFromUrl,
  recordedFileName,
  nextUnrecordedWord,
  recordPrompt,
  mergeRecordedIds,
  recordedFilenameFor,
  mp3Sibling,
  recordedPlaybackUrl,
  resolveRecordedPlayback,
} from "../src/record-voice.js";

test("record-voice: mime and extension helpers", () => {
  assert.equal(cleanMimeType("Audio/MP4; codecs=mp4a.40.2"), "audio/mp4");
  assert.equal(cleanMimeType("  audio/ogg  "), "audio/ogg");
  assert.equal(cleanMimeType(null), "");
  assert.equal(cleanMimeType(""), "");
  assert.equal(mimeToExt("audio/mp4"), "mp4");
  assert.equal(mimeToExt("audio/x-m4a"), "m4a");
  assert.equal(mimeToExt("audio/mpeg"), "mp3");
  assert.equal(mimeToExt("audio/ogg"), "ogg");
  assert.equal(mimeToExt("audio/opus"), "ogg");
  assert.equal(mimeToExt("audio/wav"), "wav");
  assert.equal(mimeToExt("audio/x-wav"), "wav");
  assert.equal(mimeToExt("video/mp4"), null, "a video mime is not a voice recording");
  assert.equal(mimeToExt("application/octet-stream"), null);
  assert.equal(extFromUrl("https://cdn.test/voice.mp4?x=1"), "mp4");
  assert.equal(extFromUrl("https://cdn.test/voice.MP3"), "mp3");
  assert.equal(extFromUrl("https://cdn.test/voice"), null);
  assert.equal(extFromUrl("https://cdn.test/voice.exe"), null, "only audio extensions count");
  assert.equal(extFromUrl(null), null);
});

test("record-voice: recordedFileName prefers the mime, falls back to the URL, then to mp4", () => {
  assert.equal(recordedFileName(155, "audio/mp4", "https://cdn.test/x.ogg"), "155.mp4");
  assert.equal(recordedFileName(155, "audio/ogg", "https://cdn.test/x.mp4"), "155.ogg");
  assert.equal(recordedFileName(155, "audio/x-m4a", "https://cdn.test/x.mp4"), "155.m4a");
  assert.equal(recordedFileName(155, "application/octet-stream", "https://cdn.test/x.mp3"), "155.mp3");
  assert.equal(recordedFileName(155, "", "https://cdn.test/x"), "155.mp4", "no mime and no extension: Messenger default (voice notes are MP4)");
  assert.equal(recordedFileName(155, "video/mp4", "https://cdn.test/x.mp4"), "155.mp4", "the URL saves a wrong mime");
  assert.equal(recordedFileName("155", "audio/mp4", null), "155.mp4");
  assert.equal(recordedFileName("abc", "audio/mp4", null), null, "a non-numeric id is not a word id");
});

test("record-voice: nextUnrecordedWord scans in dictionary order", () => {
  const records = [
    { id: 155, coptic: "ⲁⲑⲙⲟϣⲓ" },
    { id: 55, coptic: "ⲁⲅⲅⲉⲗⲉⲓⲛ" },
    { id: 25344, coptic: "ⲁ ⲁⲗⲫⲁ" },
  ];
  const first = nextUnrecordedWord(records, new Set());
  assert.equal(first.id, 155);
  assert.equal(first.recorded, 0);
  assert.equal(first.total, 3);
  const second = nextUnrecordedWord(records, new Set(["155"]));
  assert.equal(second.id, 55);
  assert.equal(second.recorded, 1);
  assert.equal(nextUnrecordedWord(records, new Set(["155", "55", "25344"])), null);
  assert.equal(nextUnrecordedWord([], new Set()), null);
  assert.equal(nextUnrecordedWord(null, new Set()), null);
  // A row with no id is skipped, never chosen.
  assert.equal(nextUnrecordedWord([{ coptic: "ⲁ" }, { id: 7, coptic: "ⲃ" }], new Set()).id, 7);
});

test("record-voice: recordPrompt asks for the word 3 times in one recording", () => {
  const prompt = recordPrompt({ coptic: "ⲁⲑⲙⲟϣⲓ", pronunciation: "athmoshi", english: "sneeze", meaning: "عطسة" }, { recorded: 4, total: 17226 });
  assert.match(prompt, /ⲁⲑⲙⲟϣⲓ/u);
  assert.match(prompt, /3 مرات/u);
  assert.match(prompt, /4 من 17226/u, "progress is shown when known");
  assert.match(prompt, /\/record_stop/u, "the prompt names the stop command");
  assert.equal(recordPrompt(null), "✅ اكتمل تسجيل النطق لكل كلمات القاموس.");
  const bare = recordPrompt({ coptic: "ⲁⲑⲙⲟϣⲓ" });
  assert.match(bare, /ⲁⲑⲙⲟϣⲓ/u);
  assert.doesNotMatch(bare, /المسجّل/u, "no progress line without counts");
});

test("record-voice: manifest + overlay merge, overlay wins", () => {
  const manifest = { 55: "55.ogg", 25344: "25344.ogg" };
  const overlay = { 155: "155.mp4" };
  assert.deepEqual([...mergeRecordedIds(manifest, overlay)].sort(), ["155", "25344", "55"]);
  assert.deepEqual([...mergeRecordedIds(["55"], overlay)].sort(), ["155", "55"], "array sources are accepted too");
  assert.deepEqual([...mergeRecordedIds(null, null)], []);
  assert.equal(recordedFilenameFor(155, manifest, overlay), "155.mp4");
  assert.equal(recordedFilenameFor(55, manifest, overlay), "55.ogg");
  assert.equal(recordedFilenameFor("55", manifest, {}), "55.ogg", "string ids coerce");
  assert.equal(recordedFilenameFor(999, manifest, overlay), null);
  // An overlay entry for a word the manifest already has replaces it.
  assert.equal(recordedFilenameFor(55, manifest, { 55: "55.mp4" }), "55.mp4");
});

test("record-voice: mp3 sibling and playback URL resolution", () => {
  assert.equal(mp3Sibling("155.mp4"), "155.mp3");
  assert.equal(mp3Sibling("155.ogg"), "155.mp3");
  assert.equal(mp3Sibling("155.mp3"), null, "an mp3 has no sibling");
  assert.equal(mp3Sibling("155"), null);
  assert.equal(mp3Sibling(null), null);
  const base = "https://pub-e39b5be260724e0ea1bbf6a7db089987.r2.dev/recorded/";
  assert.equal(recordedPlaybackUrl(base, "155.mp4"), "https://pub-e39b5be260724e0ea1bbf6a7db089987.r2.dev/recorded/155.mp4");
  assert.equal(recordedPlaybackUrl(base, null), null);
  assert.equal(recordedPlaybackUrl(null, "155.mp4"), null);
  // resolveRecordedPlayback takes a FILENAME (not an id) and returns a
  // filename: the raw file, or its .mp3 sibling when one exists.
  assert.equal(resolveRecordedPlayback("55.ogg", false), "55.ogg", "without an mp3 sibling the raw recording plays as-is");
  assert.equal(resolveRecordedPlayback("55.ogg", true), "55.mp3", "an mp3 sibling is preferred when the converter produced it (optional — see the 2026-11-16 MP3 stop)");
  assert.equal(resolveRecordedPlayback("55.mp3", true), "55.mp3");
  assert.equal(resolveRecordedPlayback(null, false), null);
});

test("record-voice: storage constants", () => {
  assert.equal(RECORDED_R2_PREFIX, "recorded");
  assert.equal(RECORDED_OVERLAY_KEY, "recorded:overlay");
  assert.equal(MAX_RECORD_BYTES, 10 * 1024 * 1024);
  assert.equal(RECORD_AUDIO_TIMEOUT_MS, 15000);
});
