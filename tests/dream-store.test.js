import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { MemoryStore } from "../src/store.js";
import { SCHEMA_VERSION } from "../src/util.js";

const dirs = [];
function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "fm-dream-"));
  dirs.push(dir);
  return { store: MemoryStore.open({ dataDir: dir }), dir };
}
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may keep the WAL handle briefly; the temp dir is disposable */
    }
  }
});

const fact = (overrides = {}) => ({
  entity: { name: "api", type: "service" },
  predicate: "端口",
  value: "8080",
  cardinality: "single",
  evidenceLevel: "explicit_user",
  observedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

test("the dream generation exists alongside the fact tables", () => {
  const { store } = freshStore();
  assert.equal(SCHEMA_VERSION, 14);
  assert.equal(store.meta.schemaVersion, 14);
  const names = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => String(row.name));
  for (const table of ["dream_feed", "dream_feed_state", "dreams", "dream_runs", "dream_rejects"]) {
    assert.ok(names.includes(table), table + " is missing");
  }
  assert.equal(store.integrity().ok, true);
  assert.deepEqual(store.dreamStats(), { pending: 0, active: 0, superseded: 0, rejected: 0, archived: 0, feedRows: 0, rejects: 0 });
  store.close();
});

test("feed append is idempotent per (session, seq) and a cursor reports only what is new", () => {
  const { store } = freshStore();
  assert.equal(store.dreamFeedAppend({ sessionId: "s1", seq: 1, at: "2026-11-14T10:00:00.000Z", role: "user", text: "hello world" }).inserted, true);
  assert.equal(store.dreamFeedAppend({ sessionId: "s1", seq: 1, at: "2026-11-14T10:00:00.000Z", role: "user", text: "hello world" }).inserted, false);
  store.dreamFeedAppend({ sessionId: "s1", seq: 2, at: "2026-11-14T10:01:00.000Z", role: "assistant", text: "hi" });
  store.dreamFeedAppend({ sessionId: "s2", seq: 1, at: "2026-11-15T09:00:00.000Z", role: "user", text: "第二条会话" });

  const all = store.dreamFeedStats({ afterId: 0 });
  assert.equal(all.messages, 3);
  assert.equal(all.sessions, 2);
  assert.equal(all.chars, "hello world".length + "hi".length + "第二条会话".length);

  // The cursor is exclusive: rows at or below it are already consumed.
  const cursor = store.dreamFeedStats().maxId - 1;
  const rest = store.dreamFeedStats({ afterId: cursor });
  assert.equal(rest.messages, 1);
  assert.equal(rest.sessions, 1);

  const sessions = store.dreamFeedSessions({ afterId: 0 });
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].sessionId, "s1");
  assert.equal(sessions[0].userMessages, 1);
  store.close();
});

test("a dream is idempotent by content, and accepting or rejecting never touches facts", () => {
  const { store } = freshStore();
  store.writeFact(fact());
  const before = store.stats();

  const first = store.dreamCreate({ topicKey: "k1", title: "部署", body: "服务端口固定在 8080。" });
  assert.equal(first.status, "created");
  const again = store.dreamCreate({ topicKey: "k1", title: "部署", body: "服务端口固定在 8080。" });
  assert.equal(again.status, "duplicate");
  assert.equal(again.id, first.id);
  // Same topic, different prose: a second row, because the content is the identity.
  assert.equal(store.dreamCreate({ topicKey: "k1", title: "部署", body: "服务端口固定在 8081。" }).status, "created");

  const pending = store.dreamPending();
  assert.equal(pending.length, 2);
  assert.equal(pending[0].status, "pending");
  assert.deepEqual(pending[0].topics, []);

  const applied = store.dreamApply({ id: first.id, body: "服务端口固定在 8080（已确认）。" });
  assert.equal(applied.status, "ok");
  assert.equal(applied.dream.status, "active");
  assert.notEqual(applied.dream.digest, first.digest);
  assert.equal(store.dreamApply({ id: first.id }).status, "already_active");

  const rejected = store.dreamReject({ id: again.id, reason: "不需要" });
  assert.equal(rejected.status, "ok");
  assert.equal(store.dreamStats().rejected, 1);
  const rejects = store.dreamRejects();
  assert.equal(rejects.length, 1);
  assert.equal(rejects[0].topicKey, "k1");

  const after = store.stats();
  assert.equal(after.facts, before.facts);
  assert.equal(after.active, before.active);
  assert.equal(after.generation, before.generation, "dreaming must not bump the fact generation");
  store.close();
});

test("superseding points one dream at another and deletes nothing", () => {
  const { store } = freshStore();
  const old = store.dreamCreate({ topicKey: "k", title: "旧", body: "旧结论", status: "active" });
  const next = store.dreamCreate({ topicKey: "k", title: "新", body: "新结论", status: "active" });
  assert.deepEqual(store.dreamSupersede({ id: old.id, byId: next.id }), { status: "ok" });
  const closed = store.dream(old.id);
  assert.equal(closed.status, "superseded");
  assert.equal(closed.supersededBy, next.id);
  assert.equal(store.dream(next.id).supersedesId, old.id);
  assert.equal(store.dreamStats().active, 1);
  assert.equal(store.dreamStats().superseded, 1);
  store.close();
});

test("accepting a replacement closes the note it replaces", () => {
  const { store } = freshStore();
  const old = store.dreamCreate({ topicKey: "k", title: "旧", body: "旧结论", status: "active" });
  const next = store.dreamCreate({ topicKey: "k", title: "新", body: "新结论", supersedesId: old.id });
  assert.equal(store.dream(old.id).status, "active", "a pending draft leaves the live note alone");
  assert.equal(store.dreamApply({ id: next.id }).status, "ok");
  assert.equal(store.dream(old.id).status, "superseded", "accepting is what closes the old note");
  assert.equal(store.dream(old.id).supersededBy, next.id);
  assert.equal(store.dreamStats().active, 1, "one topic keeps one live note");
  store.close();
});

test("a note carries world time, and a replacement closes the old window", () => {
  const { store } = freshStore();
  const old = store.dreamCreate({ topicKey: "k", title: "旧", body: "旧结论", validFrom: "2026-11-01T00:00:00.000Z" });
  const next = store.dreamCreate({ topicKey: "k", title: "新", body: "新结论", validFrom: "2026-11-10T00:00:00.000Z", supersedesId: old.id });
  assert.equal(store.dream(old.id).validFrom, "2026-11-01T00:00:00.000Z");
  assert.equal(store.dream(old.id).validTo, null, "a pending replacement does not end the old window");
  store.dreamApply({ id: next.id });
  const closed = store.dream(old.id);
  assert.equal(closed.status, "superseded");
  assert.equal(closed.validTo, "2026-11-10T00:00:00.000Z", "the old claim ended when the new one was said");
  assert.equal(store.dream(next.id).validFrom, "2026-11-10T00:00:00.000Z");
  store.close();
});

test("heat counts real mentions and orders the cue list", () => {
  const { store } = freshStore();
  const cold = store.dreamCreate({ topicKey: "cold", title: "冷", body: "b1", status: "active" });
  const warm = store.dreamCreate({ topicKey: "warm", title: "热", body: "b2", status: "active" });
  store.dreamTouch({ ids: [warm.id] });
  store.dreamTouch({ ids: [warm.id] });
  assert.equal(store.dream(warm.id).hitCount, 2);
  assert.equal(store.dream(cold.id).hitCount, 0);
  assert.ok(store.dream(warm.id).lastHitAt);
  assert.equal(store.dreams({ status: ["active"], order: "heat" })[0].id, warm.id);
  // Touching a pending note is not a hit: nothing is live yet.
  const draft = store.dreamCreate({ topicKey: "draft", title: "草", body: "b3" });
  store.dreamTouch({ ids: [draft.id] });
  assert.equal(store.dream(draft.id).hitCount, 0);
  store.close();
});

test("stale notes are archived rather than deleted, and a restore brings them back", () => {
  const { store } = freshStore();
  const stale = store.dreamCreate({ topicKey: "stale", title: "旧", body: "b", status: "active", at: "2026-01-01T00:00:00.000Z" });
  const hot = store.dreamCreate({ topicKey: "hot", title: "新", body: "b2", status: "active" });
  store.dreamTouch({ ids: [hot.id] });
  const archived = store.dreamArchiveStale({ before: "2026-06-01T00:00:00.000Z" });
  assert.equal(archived.archived, 1, "a recent hit keeps a note alive");
  assert.equal(store.dream(stale.id).status, "archived");
  assert.equal(store.dream(hot.id).status, "active");
  assert.equal(store.dreamStats().archived, 1);
  assert.equal(store.dreams({ status: ["active"] }).length, 1, "an archived note is not cued");
  assert.equal(store.dreamRestore({ id: stale.id }).status, "ok");
  assert.equal(store.dream(stale.id).status, "active");
  assert.equal(store.dreamRestore({ id: hot.id }).status, "refused");
  store.close();
});

test("retention prunes old feed rows and leaves the dreams alone", () => {
  const { store } = freshStore();
  store.dreamFeedAppend({ sessionId: "s", seq: 1, at: "2026-01-01T00:00:00.000Z", role: "user", text: "old" });
  store.dreamFeedAppend({ sessionId: "s", seq: 2, at: "2026-11-15T00:00:00.000Z", role: "user", text: "new" });
  store.dreamCreate({ topicKey: "k", title: "t", body: "b" });
  const pruned = store.dreamFeedPrune({ before: "2026-06-01T00:00:00.000Z" });
  assert.equal(pruned.deleted, 1);
  assert.equal(store.dreamStats().feedRows, 1);
  assert.equal(store.dreamStats().pending, 1);
  // AUTOINCREMENT keeps ids moving forward after a prune, so a cursor never
  // points past freshly written rows.
  assert.ok(store.dreamFeedStats().maxId > 1);
  store.close();
});

test("the run ledger records what each pass read and what it produced", () => {
  const { store } = freshStore();
  store.dreamFeedAppend({ sessionId: "s", seq: 1, role: "user", text: "abc" });
  const cursor = store.dreamFeedStats().maxId;
  store.recordDreamRun({ status: "error", reason: "boom", cursorId: 0, error: "boom" });
  assert.equal(store.recentDreamRuns({ limit: 1 })[0].cursorId, 0, "a failed run consumed nothing");
  assert.equal(store.dreamFeedStats().messages, 1, "and the material is still waiting");
  store.recordDreamRun({ status: "ok", trigger: "threshold", chars: 3, messages: 1, proposed: 1, accepted: 1, cursorId: cursor, model: "m" });
  const [last, previous] = store.recentDreamRuns({ limit: 5 });
  assert.equal(last.status, "ok");
  assert.equal(last.trigger, "threshold");
  assert.equal(last.cursorId, cursor);
  assert.equal(previous.status, "error");
  store.close();
});

test("the per-session collection mark survives the feed rows being consumed", () => {
  const { store } = freshStore();
  assert.equal(store.dreamFeedStateGet("s"), -1, "an unknown session starts behind its first turn");
  store.dreamFeedAppend({ sessionId: "s", seq: 1, at: "2026-01-01T00:00:00.000Z", role: "user", text: "abc" });
  store.dreamFeedAppend({ sessionId: "s", seq: 2, at: "2026-01-01T00:00:01.000Z", role: "assistant", text: "def" });
  store.dreamFeedStateSet({ sessionId: "s", lastSeq: 2 });
  assert.equal(store.dreamFeedStateGet("s"), 2);
  // A dream pass deletes the rows it consumed; the mark must not rewind with
  // them, or the next restart would collect the same turns all over again.
  store.dreamFeedPrune({ before: "2999-01-01T00:00:00.000Z" });
  assert.equal(store.dreamFeedStats().messages, 0);
  assert.equal(store.dreamFeedStateGet("s"), 2);
  store.dreamFeedStateSet({ sessionId: "s", lastSeq: 5, at: "2026-01-02T00:00:00.000Z" });
  assert.equal(store.dreamFeedStateGet("s"), 5, "a later turn moves the mark forward");
  store.close();
});

test("a store that migrated with the draft v12 index loses it, then gains world time", () => {
  const { store, dir } = freshStore();
  // Recreate the state an early 0.8.0 build left behind: schema version 12 with the
  // dream full-text index that no code path ever queried.
  store.db.exec("CREATE VIRTUAL TABLE dreams_fts USING fts5 (dream_id UNINDEXED, tokens)");
  store.db.exec("PRAGMA user_version = 12");
  store.db.prepare("UPDATE store_meta SET schema_version = 12").run();
  store.close();
  const reopened = MemoryStore.open({ dataDir: dir });
  const names = reopened.db
    .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'dreams_fts%'")
    .all()
    .map((row) => String(row.name));
  assert.deepEqual(names, []);
  assert.equal(reopened.meta.schemaVersion, 14);
  const columns = reopened.db.prepare("PRAGMA table_info(dreams)").all().map((row) => String(row.name));
  for (const name of ["valid_from", "valid_to", "hit_count", "last_hit_at"]) {
    assert.ok(columns.includes(name), "v14 adds " + name);
  }
  assert.equal(reopened.integrity().ok, true);
  reopened.close();
});
