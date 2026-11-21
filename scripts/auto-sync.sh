#!/bin/bash
# Messenger bot auto-sync: pull fresh data files from the Telegram bot repo
# (raw.githubusercontent.com, public) and redeploy the Worker ONLY when
# something actually changed. Mirrors the GitHub workflow (deploy.yml) but
# runs here, because the workflow's deploy step is blocked on GitHub secrets
# (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID) that were never added to
# the repo. The Cloudflare deploy token here comes from the connected
# Cloudflare account via deploy_messenger.py, so no GitHub secret is needed.
# Syncs: data/dictionary.json, data/word_ids.json, data/audio-manifest.json,
# data/audio-versions.json, data/recorded-voices.json, src/learn-manifest.js.
# Usage: auto-sync.sh [--check-only]   (check-only: compare, change nothing)
set -u
REPO="$HOME/workspace/messenger-bot-split"
LOG="$REPO/data/sync.log"
CHECK_ONLY=0
[ "${1:-}" = "--check-only" ] && CHECK_ONLY=1

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] $*" | tee -a "$LOG"; }

cd "$REPO" || { log "SYNC FAIL: cannot cd to $REPO"; exit 1; }

# Pull the fresh data files from the Telegram repo (public raw URLs).
node scripts/sync-data-from-telegram.mjs >> "$LOG" 2>&1 || { log "SYNC FAIL: sync-data-from-telegram.mjs failed"; exit 1; }

# Did anything actually change? (data files + learn manifest only — code
# changes are deployed by hand, never by this job.)
if git diff --quiet -- data src/learn-manifest.js; then
  if [ "$CHECK_ONLY" = 1 ]; then log "SYNC CHECK: no changes"; else log "SYNC: no changes"; fi
  exit 0
fi

if [ "$CHECK_ONLY" = 1 ]; then
  log "SYNC CHECK: data would change:"
  git diff --stat -- data src/learn-manifest.js | tee -a "$LOG"
  # Restore the downloaded files: check-only must change nothing.
  git checkout -- data src/learn-manifest.js
  exit 0
fi

log "SYNC: data changed:"
git diff --stat -- data src/learn-manifest.js | tee -a "$LOG"

# Safety: never deploy a tree that does not pass its own tests, and never
# deploy while a source file is half-written (another job may be mid-edit).
node --test >> "$LOG" 2>&1 || { log "SYNC FAIL: tests failed, deploy aborted (data files left updated on disk)"; exit 1; }

# Deploy the Worker (Cloudflare token via the connected account).
python3 "$HOME/workspace/deploy_messenger.py" >> "$LOG" 2>&1 || { log "SYNC FAIL: wrangler deploy failed"; exit 1; }

# Verify the live Worker answers.
if curl -fsS --max-time 30 "https://coptic-dictionary-messenger-bot.abr429701.workers.dev/health" >> "$LOG" 2>&1; then
  log "SYNC: deployed and healthy"
  exit 0
else
  log "SYNC FAIL: deployed but /health did not answer"
  exit 1
fi
