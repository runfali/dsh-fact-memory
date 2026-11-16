import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { MemoryStore } from "../src/store.js";
import { claimKeyOf } from "../src/store.js";

const dirs = [];
function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "fm-store-"));
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

test("creates schema generation 3 and reports its identity", () => {
  const { store } = freshStore();
  const meta = store.meta;
  assert.equal(meta.schemaVersion, 14);
  assert.match(meta.storeId, /[0-9a-f-]{36}/);
  assert.equal(meta.generation, 0);
  assert.equal(store.integrity().ok, true);
  store.close();
});

test("duplicate write is idempotent and does not create a second row", () => {
  const { store } = freshStore();
  const first = store.writeFact(fact());
  assert.equal(first.status, "inserted");
  const second = store.writeFact(fact({ observedAt: "2026-01-02T00:00:00.000Z" }));
  assert.equal(second.status, "duplicate");
  assert.equal(second.fact.id, first.fact.id);
  assert.equal(store.stats().facts, 1);
  store.close();
});

test("a trusted single-slot write supersedes the old value bi-temporally", () => {
  const { store } = freshStore();
  const first = store.writeFact(fact());
  const next = store.writeFact(fact({ value: "9090", observedAt: "2026-02-01T00:00:00.000Z" }));
  assert.equal(next.status, "superseded");
  assert.equal(next.previous.id, first.fact.id);
  const old = store.getFact(first.fact.id);
  assert.equal(old.status, "superseded");
  assert.equal(old.supersededBy, next.fact.id);
  assert.equal(old.validTo, "2026-02-01T00:00:00.000Z");
  assert.equal(store.stats().active, 1);
  store.close();
});

test("an untrusted contradiction keeps both rows and opens a conflict group", () => {
  const { store } = freshStore();
  const first = store.writeFact(fact());
  const rival = store.writeFact(fact({ value: "7070", evidenceLevel: "observed" }));
  assert.equal(rival.status, "conflict");
  assert.ok(rival.conflictGroupId);
  // C.5.8: no side of a conflict may keep looking authoritative.
  assert.equal(store.getFact(first.fact.id).status, "conflict");
  assert.equal(store.getFact(rival.fact.id).status, "conflict");
  const resolved = store.resolveConflict({ factId: rival.fact.id });
  assert.equal(resolved.status, "ok");
  assert.equal(store.getFact(rival.fact.id).status, "active");
  assert.equal(store.getFact(first.fact.id).status, "superseded");
  store.close();
});

test("a user statement settles the slot and closes the conflict group", () => {
  const { store } = freshStore();
  store.writeFact(fact());
  const rival = store.writeFact(fact({ value: "7070", evidenceLevel: "observed" }));
  assert.equal(rival.status, "conflict");
  // The user now states the guessed value themselves: the slot has an
  // authoritative answer, so the parked rivals must stop shadowing it.
  const settled = store.writeFact(fact({ value: "7070", evidenceLevel: "explicit_user" }));
  assert.equal(settled.status, "inserted");
  assert.equal(store.stats().conflict, 0);
  assert.equal(store.stats().active, 1);
  const group = store.db.prepare("SELECT status FROM conflict_groups WHERE id = ?").get(rival.conflictGroupId);
  assert.equal(group.status, "resolved");
  const rows = store.db.prepare("SELECT status FROM facts ORDER BY created_at").all();
  assert.deepEqual(rows.map((row) => row.status).sort(), ["active", "superseded", "superseded"]);
  store.close();
});

test("forget leaves the row, removes it from the index and writes a tombstone", () => {
  const { store } = freshStore();
  const { fact: saved } = store.writeFact(fact());
  const claim = claimKeyOf({ entityName: "api", predicate: "端口", qualifiers: {}, value: "8080" });
  const result = store.forget({ factId: saved.id, originStoreId: store.meta.storeId });
  assert.equal(result.status, "ok");
  assert.equal(store.getFact(saved.id).status, "forgotten");
  assert.equal(store.isTombstoned({ namespace: "tool", claimKey: claim }), true);
  assert.equal(store.isTombstoned({ namespace: "auto", claimKey: claim }), true);
  const ftsRow = store.db.prepare("SELECT COUNT(*) AS count FROM facts_fts WHERE fact_id = ?").get(saved.id);
  assert.equal(ftsRow.count, 0);
  store.close();
});

test("operation keys replay a receipt instead of writing twice", () => {
  const { store } = freshStore();
  const args = { operationKey: "write:abc", fingerprint: "fp", actor: "tool", action: "memory.write" };
  const begun = store.beginOperation(args);
  assert.equal(begun.status, "started");
  store.commitOperation({ operationId: begun.operationId, operationKey: "write:abc", fingerprint: "fp", receipt: { outcome: "saved" } });
  const again = store.beginOperation(args);
  assert.equal(again.status, "replay");
  assert.deepEqual(again.receipt, { outcome: "saved" });
  const collision = store.beginOperation({ ...args, fingerprint: "other" });
  assert.equal(collision.status, "collision");
  store.close();
});

test("FTS index is rebuildable and named-parameter binding works", () => {
  const { store } = freshStore();
  store.writeFact(fact({ entity: { name: "发哥的服务器", type: "host" }, predicate: "端口", value: "8080" }));
  assert.equal(store.rebuildAllFts(), 1);
  const hit = store.db.prepare("SELECT fact_id FROM facts_fts WHERE facts_fts MATCH ?").all('"端口"');
  assert.equal(hit.length, 1);
  const row = store.db.prepare("SELECT value_text FROM facts WHERE entity_id = :id").get({ id: hit[0].fact_id });
  assert.equal(row, undefined);
  store.close();
});

test("a generation 1 store migrates to the current schema in place, keeping its facts", () => {
  const { store, dir } = freshStore();
  store.writeFact(fact());
  // Simulate a store written by the previous build: generation 1 tables only.
  store.db.exec("DROP TABLE extract_runs");
  store.db.exec("DROP TABLE turn_summaries");
  store.db.exec("DROP TABLE fact_secrets");
  store.db.exec("DROP TABLE calibrations");
  store.db.exec("DROP TABLE fact_vectors");
  store.db.exec("DROP TABLE proposals");
  store.db.exec("PRAGMA user_version = 1");
  store.db.prepare("UPDATE store_meta SET schema_version = 1").run();
  store.close();

  const migrated = MemoryStore.open({ dataDir: dir });
  assert.equal(migrated.meta.schemaVersion, 14);
  assert.equal(migrated.stats().active, 1);
  const tables = migrated.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('proposals','fact_vectors','calibrations')")
    .all()
    .map((row) => row.name)
    .sort();
  assert.deepEqual(tables, ["calibrations", "fact_vectors", "proposals"]);
  assert.equal(migrated.integrity().ok, true);
  migrated.close();
});

test("session facts carry the entity name the drawer prints", () => {
  const { store } = freshStore();
  const written = store.writeFact(
    fact({
      source: {
        sourceType: "session",
        namespace: "session",
        sessionId: "s-9",
        seq: 5,
        role: "user",
        quote: "订单服务的端口是 8123",
        evidenceHash: "abc",
      },
    }),
  );
  assert.equal(written.status, "inserted");
  assert.ok(written.fact.id);
  const rows = store.sessionFacts({ sessionId: "s-9" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity, "api");
  assert.equal(store.sessionFacts({ sessionId: "s-9", sinceSeq: 9 }).length, 0);
  assert.equal(store.sessionsWithFacts()[0].sessionId, "s-9");
});

test("a turn summary outlives the process that wrote it", () => {
  const { store, dir } = freshStore();
  store.recordTurnSummary({ sessionId: "s-1", seq: 12, fromSeq: 3, saved: 2, proposals: 1, conflicts: 1, status: "ok" });
  assert.equal(store.turnSummary({ sessionId: "s-1", seq: 12 }).saved, 2);
  // Re-recording the same turn replaces it instead of stacking duplicates.
  store.recordTurnSummary({ sessionId: "s-1", seq: 12, fromSeq: 3, saved: 3, proposals: 0 });
  assert.equal(store.turnSummary({ sessionId: "s-1", seq: 12 }).saved, 3);
  assert.equal(store.turnSummary({ sessionId: "s-1", seq: 40 }), null);
  store.close();

  const reopened = MemoryStore.open({ dataDir: dir });
  const summary = reopened.turnSummary({ sessionId: "s-1", seq: 12 });
  assert.equal(summary.saved, 3);
  assert.equal(summary.proposals, 0);
  assert.equal(summary.fromSeq, 3);
  reopened.close();
});

test("the extraction run log survives a restart and keeps only the newest rows", () => {
  const { store, dir } = freshStore();
  for (let index = 0; index < 25; index += 1) {
    store.recordExtractRun({
      sessionId: "s-run",
      sessionTitle: "事实记忆",
      status: "ok",
      fromSeq: index * 10,
      toSeq: index * 10 + 10,
      saved: index,
      chars: 120,
      chunks: 1,
      model: "fake-model",
      durationMs: 400,
      at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      keep: 20,
    });
  }
  assert.equal(store.extractRuns({ limit: 50 }).length, 20, "the log is trimmed to its bound");
  const newest = store.extractRuns({ limit: 10 });
  assert.equal(newest.length, 10);
  assert.equal(newest[0].saved, 24, "newest first");
  assert.equal(newest[0].title, "事实记忆");
  assert.equal(newest[0].durationMs, 400);
  assert.equal(newest[0].toSeq, 250);
  assert.equal(store.recordExtractRun({ sessionId: "" }), null, "a row without a session is not a run");
  store.close();

  const reopened = MemoryStore.open({ dataDir: dir });
  const afterRestart = reopened.extractRuns({ limit: 10 });
  assert.equal(afterRestart.length, 10, "a restart does not empty the queue page");
  assert.equal(afterRestart[0].saved, 24);
  // The log is operational, not memory content: clearing the library is exactly
  // when the user wants to watch the next pass run.
  reopened.wipe();
  assert.equal(reopened.extractRuns({ limit: 10 }).length, 10, "a wipe keeps the run history");
  reopened.close();
});

test("wipe clears the vector projection along with the facts", () => {
  const { store } = freshStore();
  const written = store.writeFact(fact());
  store.db
    .prepare("INSERT INTO fact_vectors (fact_id, fingerprint, dim, vector, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(written.fact.id, "fp", 3, Buffer.from(new Float32Array([1, 2, 3]).buffer), new Date().toISOString());
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM fact_vectors").get().n, 1);
  const result = store.wipe();
  assert.equal(result.cleared.fact_vectors, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM fact_vectors").get().n, 0, "a stale vector must not survive the wipe");
  store.close();
});

test("a run keeps the text it read and what it refused, bounded", () => {
  const { store } = freshStore();
  const run = store.recordExtractRun({
    sessionId: "s-text",
    status: "skipped",
    reason: "no_signal",
    chars: 30,
    inputText: "照一下 别乱记",
    rejected: [
      { reason: "quote_not_in_source", count: 2 },
      { reason: "missing_field", count: 1 },
    ],
  });
  // The list view stays small: it says a detail exists instead of carrying it.
  const listed = store.extractRuns({ limit: 1 })[0];
  assert.equal(listed.hasDetail, true);
  assert.equal(listed.inputText, undefined);
  const detail = store.extractRun({ id: run.id });
  assert.equal(detail.inputText, "照一下 别乱记");
  assert.deepEqual(detail.rejected, [
    { reason: "quote_not_in_source", count: 2 },
    { reason: "missing_field", count: 1 },
  ]);
  assert.equal(detail.inputTruncated, false, "a short text is kept whole");
  assert.equal(store.extractRun({ id: "nope" }), null);
  // Even a hostile caller cannot grow one row into a second copy of the chat.
  const capped = store.recordExtractRun({ sessionId: "s-text-2", chars: 25_000, inputText: "x".repeat(25_000) });
  const cappedDetail = store.extractRun({ id: capped.id });
  assert.equal(cappedDetail.inputText.length, 20_000);
  assert.equal(cappedDetail.inputTruncated, true, "the cap is recorded instead of silently guessed");
  store.close();
});

test("backup rotation keeps only the newest files it created", async () => {
  const { store, dir } = freshStore();
  const backups = join(dir, "backups");
  for (const stamp of ["2026-01-01T00-00-00-000Z", "2026-01-02T00-00-00-000Z", "2026-01-03T00-00-00-000Z"]) {
    await store.backup(join(backups, `memory-${stamp}.sqlite3`), { keep: 2 });
  }
  const { readdirSync } = await import("node:fs");
  const kept = readdirSync(backups).filter((name) => name.endsWith(".sqlite3"));
  assert.equal(kept.length, 2);
  assert.ok(kept.some((name) => name.includes("2026-01-03")));
  assert.equal(kept.some((name) => name.includes("2026-01-01")), false);
});

test("editing a plain fact into a phone number does not make it model-visible", () => {
  const { store } = freshStore();
  const first = store.writeFact(fact({ value: "8080" }));
  const updated = store.updateFact({ factId: first.fact.id, value: "13900002222" });
  assert.equal(updated.status, "ok");
  const row = store.db.prepare("SELECT privacy_class AS privacy, model_use_allowed AS visible FROM facts WHERE id = ?").get(updated.result.fact.id);
  assert.equal(row.privacy, "sensitive");
  assert.equal(row.visible, 0);
});

test("a re-spelling of one subject does not create a second entity", () => {
  const { store } = freshStore();
  const first = store.writeFact(fact({ entity: { name: "DSH Fact Memory", type: "project" }, predicate: "首轮开发状态", value: "首轮开发完成，基础功能已实现（2026-11-13）" }));
  assert.equal(first.status, "inserted");
  store.writeFact(fact({ entity: { name: "dsh-fact-memory插件", type: "project" }, predicate: "开发状态", value: "首轮开发完成，基础功能已实现" }));
  const entities = store.db.prepare("SELECT name, aliases FROM entities").all();
  assert.equal(entities.length, 1);
  assert.ok(JSON.parse(entities[0].aliases).includes("dsh-fact-memory插件"));
});

test("one subject cannot hold the same value under two property words", () => {
  const { store } = freshStore();
  store.writeFact(fact({ entity: { name: "DSH Fact Memory" }, predicate: "首轮开发状态", value: "首轮开发完成" }));
  const again = store.writeFact(fact({ entity: { name: "DSH Fact Memory" }, predicate: "开发状态", value: "首轮开发完成" }));
  assert.equal(again.status, "duplicate");
  assert.equal(again.matchedBy, "same_value");
});

test("two services that share a port are not merged", () => {
  const { store } = freshStore();
  store.writeFact(fact({ entity: { name: "api", type: "service" }, predicate: "端口", value: "7801" }));
  const other = store.writeFact(fact({ entity: { name: "web", type: "service" }, predicate: "端口", value: "7801" }));
  assert.equal(other.status, "inserted");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM facts WHERE status = 'active'").get().count, 2);
});


test("a restore refuses a slot that a newer value already took", () => {
  const { store } = freshStore();
  const first = store.writeFact(fact({ value: "8080" }));
  assert.equal(store.expireFact({ factId: first.fact.id }).status, "ok");
  const newer = store.writeFact(fact({ value: "9090", observedAt: "2026-02-01T00:00:00.000Z" }));
  const restored = store.restoreFact({ factId: first.fact.id });
  assert.equal(restored.status, "occupied");
  assert.equal(restored.fact.id, newer.fact.id);
  assert.equal(store.getFact(first.fact.id).status, "expired", "the undo must not resurrect a shadow truth");
});

test("listFacts treats LIKE metacharacters literally and clamps a NaN limit", () => {
  const { store } = freshStore();
  store.writeFact(fact({ entity: { name: "50% service" }, predicate: "状态", value: "ok" }));
  store.writeFact(fact({ entity: { name: "500 service" }, predicate: "状态", value: "ok" }));
  store.writeFact(fact({ entity: { name: "a_b service" }, predicate: "状态", value: "ok" }));
  store.writeFact(fact({ entity: { name: "axb service" }, predicate: "状态", value: "ok" }));
  assert.deepEqual(store.listFacts({ query: "50%" }).map((row) => row.entity), ["50% service"]);
  assert.deepEqual(store.listFacts({ query: "a_b" }).map((row) => row.entity), ["a_b service"]);
  for (let index = 0; index < 101; index += 1) {
    store.writeFact(fact({ entity: { name: "bulk" }, predicate: `编号${index}`, value: String(index), cardinality: "multi" }));
  }
  assert.equal(store.listFacts({ query: "bulk", limit: Number.NaN }).length, 100, "NaN must not become LIMIT NULL");
});

test("a reworded statement merges once the corpus is large enough", () => {
  const { store } = freshStore();
  store.writeFact(fact({ entity: { name: "DSH Fact Memory", type: "project" }, predicate: "首轮开发状态", value: "首轮开发完成，基础功能已实现（2026-11-13）" }));
  for (let index = 0; index < 12; index += 1) {
    store.writeFact(fact({ entity: { name: `svc${index}`, type: "service" }, predicate: "端口", value: String(9000 + index) }));
  }
  const again = store.writeFact(fact({ entity: { name: "dsh-fact-memory插件", type: "project" }, predicate: "开发状态", value: "首轮开发完成，基础功能已实现" }));
  assert.equal(again.status, "duplicate");
  assert.equal(again.matchedBy, "candidate");
});

test("a property spelled with different case is still the same single-valued slot", () => {
  const { store } = freshStore();
  const base = { entity: { name: "api", type: "service" }, cardinality: "single", evidenceLevel: "explicit_user" };
  const first = store.writeFact({ ...base, predicate: "Port", value: "8080", observedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(first.status, "inserted");
  // claim_key already folds case; the slot lookup has to agree, or the same
  // property ends up holding two live values (and the unique index never notices).
  const second = store.writeFact({ ...base, predicate: "port", value: "9090", observedAt: "2026-01-02T00:00:00.000Z" });
  assert.equal(second.status, "superseded", "a case variant replaces instead of adding a row");
  const live = store.db
    .prepare("SELECT COUNT(*) AS n FROM facts WHERE status = 'active' AND cardinality = 'single' AND LOWER(predicate) = 'port'")
    .get();
  assert.equal(Number(live.n), 1, "one live value for the slot");
  const duplicate = store.writeFact({ ...base, predicate: "PORT", value: "9090", observedAt: "2026-01-03T00:00:00.000Z" });
  assert.equal(duplicate.status, "duplicate", "the same value under another spelling is not a new fact");
});

