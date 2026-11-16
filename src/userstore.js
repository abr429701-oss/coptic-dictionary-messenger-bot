// src/userstore.js
//
// Slim Durable Object for the Messenger-only Worker.
//
// The Telegram bot's UserStore (~3,300 lines) is mostly poller / alarm /
// broadcast / voice-migration machinery. This Worker is webhook-only, so
// the DO implements exactly the storage ops the Messenger path uses:
//
//   get / put / delete — generic key/value (user records, last lists,
//     bans, drive-config, snapshots, broadcast control)
//   userpage — one page of `user:` records (admin user lists, broadcast
//     recipients)
//   usage — request counter per UTC day (flushed in batches by the Worker)
//   usageReport — the /usage breakdown the admin sees
//   voiceIds — ids of recorded human voices (stats / audit)
//   bcstatus — broadcast job status (admin)
//
// Key names and response shapes are identical to the original so the
// Worker code works unchanged. There is no migration: this is a fresh DO
// (all Messenger user records start empty by design — see README.md).

const FEATURE_FLAGS_KEY = "admin:features";
const USAGE_ALERT_LEVELS = [50000, 80000, 95000, 100000];
const VOICE_PREFIX = "voiceid:";

function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export class UserStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // No poller on this Worker; the fields exist only so usageReport's
    // in-memory merge expression (copied from the original) stays valid.
    this.pollDetailDay = "";
    this.pollDetail = null;
  }

  async fetch(request) {
    const body = await request.json();
    const { op, key, value, limit, cursor, profile, id, detail } = body;
    const storage = this.state.storage;
    if (op === "get") return Response.json({ value: (await storage.get(key)) ?? null });
    if (op === "put") {
      await storage.put(key, value);
      return Response.json({ ok: true });
    }
    if (op === "delete") {
      await storage.delete(key);
      return Response.json({ ok: true });
    }
    if (op === "userpage") {
      const size = limit ?? 40;
      const page = await storage.list({ prefix: "user:", ...(cursor ? { startAfter: cursor } : {}), limit: size });
      const users = [...page].map(([storedKey, record]) => ({ key: storedKey, id: storedKey.slice("user:".length), record }));
      return Response.json({ users, next: users.length === size ? users.at(-1).key : null });
    }
    if (op === "usage") {
      // Request counter per UTC day (flushed in batches by the Worker so it stays cheap).
      const dayKey = `usage:${profile?.day ?? id}`;
      const day = String(profile?.day ?? id);
      const total = ((await storage.get(dayKey)) ?? 0) + Number(limit ?? 0);
      await storage.put(dayKey, total);
      // Detailed breakdown (Worker requests by endpoint kind) for /usage.
      const detailByPath = detail?.byPath ?? {};
      if (Object.keys(detailByPath).length) {
        const detailKey = `usage-detail:${day}`;
        const prev = (await storage.get(detailKey)) ?? {};
        const byPath = { ...(prev.byPath ?? {}) };
        for (const [kind, count] of Object.entries(detailByPath)) byPath[kind] = (byPath[kind] ?? 0) + Number(count ?? 0);
        await storage.put(detailKey, { byPath });
      }
      if (total === Number(limit ?? 0)) {
        // First write of a new day: forget counters older than 40 days.
        const old = [...(await storage.list({ prefix: "usage:" })).keys()].sort().slice(0, -40);
        for (const oldKey of old) await storage.delete(oldKey);
        for (const prefix of ["usage-detail:", "usage-poll:"]) {
          const oldDetail = [...(await storage.list({ prefix })).keys()].sort().slice(0, -40);
          for (const oldKey of oldDetail) await storage.delete(oldKey);
        }
      }
      const alertKey = `usage-alert:${day}`;
      const alerted = (await storage.get(alertKey)) ?? 0;
      const level = USAGE_ALERT_LEVELS.filter((threshold) => total >= threshold).at(-1) ?? 0;
      if (level > alerted) {
        await storage.put(alertKey, level);
        return Response.json({ total, alert: level });
      }
      return Response.json({ total });
    }
    if (op === "usageReport") {
      const all = await storage.list({ prefix: "usage:" });
      const days = [...all].map(([storedKey, count]) => ({ day: storedKey.slice("usage:".length), count }))
        .sort((a, b) => (a.day < b.day ? 1 : -1));
      // Detailed /usage: Worker breakdown (flushed) + poller counters.
      // There is no poller on this Worker, so the poll part is always 0.
      const today = utcDay();
      const storedDetail = (await storage.get(`usage-detail:${today}`)) ?? {};
      const storedPoll = (await storage.get(`usage-poll:${today}`)) ?? {};
      const livePoll = (this.pollDetailDay === today && this.pollDetail) ? this.pollDetail : null;
      const poll = {
        alarms: Math.max(Number(storedPoll.alarms ?? 0), Number(livePoll?.alarms ?? 0)),
        messages: Math.max(Number(storedPoll.messages ?? 0), Number(livePoll?.messages ?? 0)),
      };
      const flags = (await storage.get(FEATURE_FLAGS_KEY)) ?? {};
      return Response.json({ days: days.slice(0, Number(limit ?? 8)), detail: { byPath: storedDetail.byPath ?? {} }, poll, pollerOn: flags?.poller === true });
    }
    if (op === "voiceIds") {
      const voiced = await storage.list({ prefix: VOICE_PREFIX });
      return Response.json({ ids: [...voiced.keys()].map((key) => Number(key.slice(VOICE_PREFIX.length))).filter(Number.isFinite) });
    }
    if (op === "bcstatus") {
      const job = await storage.get("broadcast");
      return Response.json(job ? { running: true, total: job.total, sent: job.sent, failed: job.failed } : { running: false });
    }
    return Response.json({ ok: false, error: `unknown op: ${op}` }, { status: 400 });
  }
}
