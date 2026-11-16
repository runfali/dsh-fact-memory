import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { backfillSessions, decodeSessionFrames, listSessionFiles, sessionRows } from "../src/backfill.js";

const dirs = [];
const tempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const frame = (events) => zstdCompressSync(Buffer.from(events.map((event) => JSON.stringify(event) + "\n").join(""), "utf8"));

function userEvent(seq, time, text) {
  return { type: "user/message", seq, time, data: { content: [{ type: "text", text }] } };
}
function assistantEvent(seq, time, text) {
  return { type: "assistant/message", seq, time, data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text }] } } };
}

/** A store stub that records what a backfill would write. */
function sinkStore() {
  const rows = [];
  const marks = new Map();
  return {
    rows,
    marks,
    dreamFeedAppend: (row) => {
      rows.push(row);
      return { inserted: true, id: rows.length };
    },
    dreamFeedStateSet: ({ sessionId, lastSeq }) => marks.set(sessionId, lastSeq),
  };
}

function makeArchive(root, project, sessionId, frames) {
  const dir = join(root, project, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.v4.jsonl.zstd"), Buffer.concat(frames));
  return join(dir, "session.v4.jsonl.zstd");
}

test("every zstd frame is decoded, not just the first", () => {
  const buffer = Buffer.concat([
    frame([userEvent(1, 1_700_000_000_000, "第一帧")]),
    frame([assistantEvent(2, 1_700_000_001_000, "第二帧")]),
  ]);
  const text = decodeSessionFrames(buffer);
  assert.ok(text.includes("第一帧"));
  assert.ok(text.includes("第二帧"), "decompressing the whole buffer stops after one frame");
});

test("rows carry seq, world time and role, and injected summaries are dropped", () => {
  const text = [
    JSON.stringify(userEvent(1, 1_700_000_000_000, "用户的真话")),
    JSON.stringify(assistantEvent(2, 1_700_000_001_000, "助手的回答")),
    JSON.stringify(userEvent(3, 1_700_000_002_000, "USER: 旧轮次\nASSISTANT: 摘要")),
    JSON.stringify(userEvent(4, 1_700_000_003_000, "sk-abcdefghijklmnopqrstuvwxyz123456")),
    JSON.stringify({ type: "tool/result", seq: 5, data: { content: "tool output" } }),
  ].join("\n");
  const { rows, skipped } = sessionRows(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { seq: 1, at: "2023-11-14T22:13:20.000Z", role: "user", text: "用户的真话" });
  assert.equal(rows[1].role, "assistant");
  assert.equal(skipped.injected, 1, "a compaction summary is not something the user said");
  assert.equal(skipped.secrets, 1);
});

test("a backfill copies whole sessions, marks them and skips what is already known", () => {
  const root = tempDir("fm-backfill-");
  makeArchive(root, "p1", "s-known", [frame([userEvent(1, 1_700_000_000_000, "已经采集过")])]);
  makeArchive(root, "p1", "s-new", [
    frame([userEvent(1, 1_700_000_000_000, "第一轮"), assistantEvent(2, 1_700_000_001_000, "回应")]),
    frame([userEvent(3, 1_700_000_002_000, "第二轮")]),
  ]);
  const store = sinkStore();
  const known = new Set(["s-known"]);
  const summary = backfillSessions({
    store,
    root,
    maxSessions: 10,
    maxChars: 100000,
    isKnown: (sessionId) => known.has(sessionId),
  });
  assert.equal(summary.files, 2);
  assert.equal(summary.sessions, 1, "a session the layer already collected is skipped");
  assert.equal(summary.skippedKnown, 1);
  assert.equal(summary.rows, 3);
  assert.deepEqual(store.rows.map((row) => row.seq), [1, 2, 3]);
  assert.equal(store.marks.get("s-new"), 3, "the mark is the highest seq that landed");

  // Running it again with the same marks copies nothing.
  const again = backfillSessions({
    store,
    root,
    maxSessions: 10,
    maxChars: 100000,
    isKnown: (id) => store.marks.has(id) || known.has(id),
  });
  assert.equal(again.rows, 0);
  assert.equal(again.sessions, 0);
});

test("the default known-check reads the store's -1 as 'never seen'", () => {
  const root = tempDir("fm-backfill-known-");
  makeArchive(root, "p1", "s-fresh", [frame([userEvent(1, 1_700_000_000_000, "没采集过")])]);
  makeArchive(root, "p1", "s-seen", [frame([userEvent(2, 1_700_000_000_000, "采集过")])]);
  const rows = [];
  // -1 is what MemoryStore.dreamFeedStateGet returns for an unknown session; a
  // null/undefined check would treat every session as already collected.
  const store = {
    rows,
    dreamFeedAppend: (row) => rows.push(row),
    dreamFeedStateSet: () => {},
    dreamFeedStateGet: (sessionId) => (sessionId === "s-seen" ? 9 : -1),
  };
  const summary = backfillSessions({ store, root, maxSessions: 10, maxChars: 100000 });
  assert.equal(summary.sessions, 1);
  assert.equal(summary.skippedKnown, 1);
  assert.deepEqual(store.rows.map((row) => row.sessionId), ["s-fresh"]);
});

test("the character budget stops the copy instead of reading everything", () => {
  const root = tempDir("fm-backfill-budget-");
  for (let i = 0; i < 4; i += 1) {
    makeArchive(root, "p1", "s" + i, [frame([userEvent(1, 1_700_000_000_000 + i, "x".repeat(400))])]);
  }
  const store = sinkStore();
  const summary = backfillSessions({ store, root, maxSessions: 10, maxChars: 900, isKnown: () => false });
  assert.ok(summary.rows >= 1 && summary.rows < 4, "some sessions fit, not all");
  assert.ok(summary.chars <= 900);
});

test("listing finds archives and skips empty projects", () => {
  const root = tempDir("fm-backfill-list-");
  makeArchive(root, "p1", "s1", [frame([userEvent(1, 1, "a")])]);
  mkdirSync(join(root, "empty-project"), { recursive: true });
  const files = listSessionFiles(root);
  assert.equal(files.length, 1);
  assert.equal(files[0].sessionId, "s1");
});
