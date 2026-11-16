import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { privacyHits, secretHits } from "./util.js";

/**
 * Historical backfill: copy past session archives into the dream feed.
 *
 * This is the one code path that reads conversations the layer never saw, so it
 * is deliberately manual (a POST body must say so), bounded by session count and
 * character budget, and idempotent: feed rows are unique per (session, seq) and
 * a session already known to the layer is skipped outright.
 */

const FRAME_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
export const SESSION_FILE = "session.v4.jsonl.zstd";
// A 64 MB archive is already far outside anything a dream pass can consume.
const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const BACKFILL_MAX_PER_MESSAGE = 1200;

/**
 * A session archive is a chain of zstd frames, one per durable append. Splitting
 * on the magic number is the only way to read all of them: decompressing the
 * whole buffer stops after the first frame and silently returns a fraction.
 */
export function decodeSessionFrames(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const cuts = [];
  for (let i = 0; i + 3 < buf.length; i += 1) {
    if (buf[i] === FRAME_MAGIC[0] && buf[i + 1] === FRAME_MAGIC[1] && buf[i + 2] === FRAME_MAGIC[2] && buf[i + 3] === FRAME_MAGIC[3]) {
      cuts.push(i);
    }
  }
  const parts = [];
  for (let k = 0; k < cuts.length; k += 1) {
    const start = cuts[k];
    const end = k + 1 < cuts.length ? cuts[k + 1] : buf.length;
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)).toString("utf8"));
    } catch {
      // One unreadable frame must not discard the rest of the session.
    }
  }
  return parts.join("");
}

function contentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n")
    .trim();
}

/** Turn one decoded session transcript into feed rows. Pure, so it is testable. */
export function sessionRows(text, { maxPerMessage = BACKFILL_MAX_PER_MESSAGE } = {}) {
  const rows = [];
  const skipped = { injected: 0, secrets: 0, private: 0, empty: 0 };
  for (const line of String(text ?? "").split("\n")) {
    if (line.trim() === "") continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    let content = null;
    let role = "";
    if (event?.type === "user/message") {
      content = event?.data?.content;
      role = "user";
    } else if (event?.type === "assistant/message") {
      content = event?.data?.message?.content;
      role = "assistant";
    }
    if (!content) continue;
    const body = contentText(content);
    if (body === "") {
      skipped.empty += 1;
      continue;
    }
    // Compaction writes earlier turns back in as one synthetic user message
    // ("USER: ... ASSISTANT: ..."). That is a summary of a summary: sending it to
    // the dream model would let it quote a paraphrase as if it were said.
    if (body.startsWith("USER:") && body.includes("ASSISTANT")) {
      skipped.injected += 1;
      continue;
    }
    if (secretHits(body).length > 0) {
      skipped.secrets += 1;
      continue;
    }
    if (privacyHits(body).length > 0) {
      skipped.private += 1;
      continue;
    }
    const seq = Number(event.seq);
    if (!Number.isFinite(seq)) continue;
    rows.push({
      seq,
      at: new Date(Number(event.time) || Date.now()).toISOString(),
      role,
      text: body.slice(0, maxPerMessage),
    });
  }
  return { rows, skipped };
}

/** Every session archive under the DSH sessions root, newest first. */
export function listSessionFiles(root) {
  const out = [];
  let projects = [];
  try {
    projects = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  } catch {
    return out;
  }
  for (const project of projects) {
    const dir = join(root, project.name);
    let sessions = [];
    try {
      sessions = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      continue;
    }
    for (const session of sessions) {
      const file = join(dir, session.name, SESSION_FILE);
      try {
        const stat = statSync(file);
        if (stat.size > 0 && stat.size <= MAX_FILE_BYTES) {
          out.push({ sessionId: session.name, file, mtime: stat.mtimeMs, bytes: stat.size });
        }
      } catch {
        // A session with no archive (still open, or already pruned) is simply absent.
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/**
 * Copy history into the feed. Whole sessions only, except the first one, which is
 * cut at the budget: refusing the very first session would mean a big archive
 * blocks backfill entirely, the same trap the collector already avoids.
 */
export function backfillSessions({
  store,
  root,
  maxSessions = 50,
  maxChars = 200000,
  maxPerMessage = BACKFILL_MAX_PER_MESSAGE,
  // The store answers -1 for a session it has never seen, not null: this is the
  // layer's collection high-water mark, and negative means "nothing collected".
  isKnown = (sessionId) => Number(store?.dreamFeedStateGet?.(sessionId) ?? -1) >= 0,
  read = readFileSync,
} = {}) {
  const summary = {
    files: 0,
    sessions: 0,
    rows: 0,
    chars: 0,
    skippedKnown: 0,
    skippedEmpty: 0,
    skipped: { injected: 0, secrets: 0, private: 0, empty: 0 },
    stopped: "",
  };
  const files = listSessionFiles(root);
  summary.files = files.length;
  let used = 0;
  for (const entry of files) {
    if (summary.sessions >= maxSessions) {
      summary.stopped = "sessions";
      break;
    }
    if (used >= maxChars) {
      summary.stopped = "chars";
      break;
    }
    if (isKnown(entry.sessionId)) {
      summary.skippedKnown += 1;
      continue;
    }
    let text = "";
    try {
      text = decodeSessionFrames(read(entry.file));
    } catch {
      continue;
    }
    const { rows, skipped } = sessionRows(text, { maxPerMessage });
    for (const key of Object.keys(skipped)) summary.skipped[key] += skipped[key];
    if (rows.length === 0) {
      summary.skippedEmpty += 1;
      continue;
    }
    const whole = rows.reduce((sum, row) => sum + row.text.length, 0);
    if (summary.sessions > 0 && used + whole > maxChars) continue;
    let kept = 0;
    let lastSeq = -1;
    for (const row of rows) {
      const size = row.text.length;
      if (used + size > maxChars && kept > 0) break;
      store.dreamFeedAppend({ sessionId: entry.sessionId, seq: row.seq, at: row.at, role: row.role, text: row.text });
      used += size;
      kept += 1;
      lastSeq = Math.max(lastSeq, row.seq);
      summary.rows += 1;
    }
    if (kept === 0) continue;
    // The mark is what keeps a second backfill from re-reading this session; it
    // is written only for rows that actually landed, never for a skipped file.
    store.dreamFeedStateSet({ sessionId: entry.sessionId, lastSeq });
    summary.sessions += 1;
  }
  summary.chars = used;
  return summary;
}
