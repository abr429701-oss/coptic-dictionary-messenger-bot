# Coptic Dictionary — Messenger / Facebook Bot

Standalone Cloudflare Worker serving the Facebook Page
**القاموس القبطي Ⲭⲏⲙⲓ** over the Messenger Platform. Split out of the
Telegram bot (`abr429701-oss/coptic-dictionary-bot`) on 2026-11-16: the
Telegram repo is Telegram-only now, this repo is Messenger-only.

Worker: `https://coptic-dictionary-messenger-bot.abr429701.workers.dev`

## What it does

The same bot the Page ran before the split — dictionary search with
word cards and voice (recorded human first, then prebuilt Polly, then
Joanna), paginated suggestion lists (15 per page), first-time name
registration, learn (27 lessons, R2 media), in-chat exam code gate,
certificates, get-code, and the admin subset. Live monitoring
(`/livemon`, `/conversations`, `/userchat`, admin-only, OFF by default)
mirrors Telegram: every private message from a non-admin is logged to
the Durable Object (`msgr:conv:<PSID>`, capped at 100 per user, plus
the `msgr:conv:active` recency index), `/livemon` toggles a live feed
that forwards each message to the first admin PSID as it arrives, and
the admin replies with `/msg <PSID> <text>` — bot replies and admin
messages are never logged or forwarded. No inline keyboards, ever:
quick replies are the only tap mechanism.

## Voice recording (/record)

The admin records human voices for words, mirroring Telegram's
`/record`: `/record` walks the dictionary in order (first word with
no recording yet), `/record_choose` records a chosen word,
`/record_stop` stops the session. The prompt asks the admin to say
the word **3 times in one voice message** — the file then contains
the word 3× natively, so it plays 3× everywhere with no repetition
processing. A Messenger voice message arrives as an MP4/AAC audio
attachment; the Worker downloads it and stores it in the public R2
bucket `coptic-lessons` under `recorded/<word-id>.<ext>` (binding
`RECORDINGS` in `wrangler.jsonc`). The recording plays on Messenger
immediately through a Durable Object overlay (`recorded:overlay`) —
before its manifest line lands — and the manifest is made permanent
afterwards with `scripts/add-recorded-voice.mjs` (commit
`data/recorded-voices.json` to the Telegram repo; the syncs pick it
up). `scripts/convert-recorded.mjs` is OPTIONAL: it produces the
`.mp3` (+ `.ogg`) siblings for WhatsApp/Telegram playback. MP3 is an
optional fallback only — the raw recording plays as-is on Messenger,
and the prebuilt-voice MP3 upload was stopped by the user on
2026-11-16 (OGG already plays fine on Messenger as-is). A recording
reaches Telegram only by sending the audio to the Telegram bot (it
plays Telegram `file_id`s, which only it can mint).

`/voice_delete <id>` removes one recording: the overlay entry (or a
`__deleted__` tombstone when the id is in the baked-in manifest, so
playback falls back to the prebuilt voice instead of the dead recorded
URL) plus the R2 object and its `.mp3` sibling. A failed R2 delete
still clears the voice and warns — the overlay alone decides playback.

## Routes

- `GET /` — ready text
- `GET /health` — `{ status: "ready", records: 17226, ... }`
- `GET /messenger-webhook` — Meta verification handshake
- `POST /messenger-webhook` — incoming Page events (HMAC-verified)
- everything else — 404

The learn web app and the privacy page still live on the Telegram
Worker (`https://coptic-dictionary-bot.abr429701.workers.dev/learn-app/`,
`/learn-app/privacy`) — that URL is also the one in Meta's Basic
settings, so no Meta settings change was needed for the split.

## Layout

- `src/index.js` — slim entry: router + the Messenger wiring (moved
  verbatim from the Telegram bot's fetch handler).
- `src/messenger.js` — transport: signature verify, Send API, typing,
  quick replies, voice attachments.
- `src/messenger-parity.js` — learn / certs / get-code / admin.
- `src/dispatch-commands.js` — the 57 dispatch commands that sit in
  admin categories (dictionary features, voice prefs, favorites, WOD,
  support): 44 implemented, 12 quiz/game commands parked by the user's
  decision (honest "not built" message), /lang answered as not
  applicable (Arabic-only interface). Search history is now recorded
  (`history:msgr:<PSID>`, cap 20) so /recent, /fav and /mystats have
  real data.
- `src/record-voice.js` — `/record` pure helpers (prompt, file names,
  next-unrecorded-word, manifest + DO overlay merge, MP3-sibling
  preference). `src/neural-voice.js` resolves playback through the
  overlay (`messengerVoiceUrlWithOverlay`).
- `src/messenger-core.js` — shared helpers extracted verbatim from the
  Telegram bot: search, cards, user state, Sheets/macro, exam codes,
  usage counting. `notifyAdmins` is a no-op here (no Telegram channel);
  `executeMessengerTask` has no `/importlearn` branch (that job runs
  from the Telegram bot).
- `src/userstore.js` — slim Durable Object: only the ops Messenger uses
  (`get` / `put` / `delete` / `userpage` / `usage` / `usageReport` /
  `voiceIds` / `bcstatus`).
- `src/neural-voice.js`, `src/ogg-repeat.js`, `src/certificates.js`,
  `src/getcode.js`, `src/exam-pattern.js`, `src/learn-manifest.js`,
  `src/new-features.js`, `src/features.js`,
  `src/field-translations.js`, `src/learn-text.js` — verbatim copies
  (plus the two parity edits: `WORKER_BASE_URL` and the `/about` text).
- `data/` — synced copies, never hand-edited (see below).
- `scripts/sync-data-from-telegram.mjs` — the mirror job.
- `test/messenger.test.js`, `test/messenger-parity.test.js` — the
  Messenger suites (`npm test`).

## Data sync

The Telegram repo remains the single pipeline: the Google Sheet is read
there every 30 minutes and `dictionary.json` / `learn-manifest.js` are
regenerated from it. This repo only mirrors the outputs via
`scripts/sync-data-from-telegram.mjs` (public raw URLs, no token). A
Sheet edit lands here within ~60 minutes (30 + 30). Voices still live
on the Telegram repo's `audio` / `audio-human` branches (stable public
URLs) — that is the one remaining cross-repo coupling.

## Worker secrets

Set with `wrangler secret put --name coptic-dictionary-messenger-bot`:

| Secret | Source |
|---|---|
| `MESSENGER_VERIFY_TOKEN` | Meta app dashboard (Messenger settings) or a fresh random token (then update the dashboard too) |
| `MESSENGER_APP_SECRET` | Meta app dashboard → Settings → Basic → App Secret |
| `MESSENGER_PAGE_TOKEN` | Meta app dashboard → Messenger settings → Generate (Page: القاموس القبطي Ⲭⲏⲙⲓ) |
| `MESSENGER_ADMIN_PSID` | The admin's page-scoped id |
| `APPS_SCRIPT_URL` | The get-code Apps Script web app `/exec` URL (bootstrap for `drive-config`; without it get-code fails closed) |

Worker vars (in `wrangler.jsonc`, not secrets — they are public):

| Var | Value |
|---|---|
| `RECORDED_AUDIO_BASE_URL` | Public base for recorded voices: `https://pub-e39b5be260724e0ea1bbf6a7db089987.r2.dev/recorded` (without it, recorded voices fall back to the prebuilt voice) |

GitHub secrets for CI deploys: `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID` (same values as the Telegram repo — same
Cloudflare account). The 100k/day Worker-request limit is per account,
shared with the Telegram Worker; `/usage` on this Worker counts
Messenger requests only.

## Fresh state after the split

The new Worker's Durable Object starts empty: every Messenger user is
asked for their name again on their next `/start` (same as a fresh
install), bans must be re-applied, and `users:total` restarts from 0.
The temporary Meta send restriction (if still active) follows the bot
to this Worker — same Page, same token — the split does not fix it.

## Deploy

Push to `main` deploys automatically (tests run first). The 30-minute
schedule syncs data from the Telegram repo and deploys only on change.
