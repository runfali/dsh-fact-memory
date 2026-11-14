import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { MemoryStore } from "../src/store.js";
import { applyProposal } from "../src/proposals.js";
import { collectDuplicatePairs, pairKeyOf, parseJudgeAnswer, preferredKeep, runConsolidation } from "../src/consolidate.js";
import { vectorToBlob } from "../src/semantic.js";
import { uuid } from "../src/util.js";

const dirs = [];
function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "fm-consolidate-"));
  dirs.push(dir);
  return { store: MemoryStore.open({ dataDir: dir }), dir };
}
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may hold the WAL handle briefly; the temp dir is disposable */
    }
  }
});

const FINGERPRINT = "fp-test";

/** A unit vector whose cosine with [1, 0] is exactly `value`. */
const atCosine = (value) => [value, Math.sqrt(Math.max(0, 1 - value * value))];
const LEFT = [1, 0];

function putVector(store, factId, vector, fingerprint = FINGERPRINT) {
  store.db
    .prepare(
      `INSERT INTO fact_vectors (fact_id, fingerprint, dim, vector, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (fact_id, fingerprint) DO UPDATE SET dim = excluded.dim, vector = excluded.vector`,
    )
    .run(factId, fingerprint, vector.length, vectorToBlob(vector), new Date().toISOString());
}

const fact = (overrides = {}) => ({
  entity: { name: "插件", type: "project" },
  predicate: "正式上线",
  value: "已上线",
  cardinality: "unknown",
  evidenceLevel: "observed",
  observedAt: "2026-11-01T00:00:00.000Z",
  ...overrides,
});

/** A row shape collectDuplicatePairs reads, inserted without the write rules. */
function insertRawFact(store, { entity, predicate, value, scope = "global", observedAt = "2026-11-01T00:00:00.000Z", evidenceLevel = "observed" }) {
  const { id: entityId } = store.ensureEntity({ name: entity });
  const id = uuid();
  const at = new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO facts (id, entity_id, predicate, value_text, norm_text, cardinality, scope, qualifiers, qualifiers_key,
         status, evidence_level, privacy_class, model_use_allowed, observed_at, time_precision, claim_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'unknown', ?, '{}', '{}', 'active', ?, 'standard', 1, ?, 'unknown', ?, ?, ?)`,
    )
    .run(id, entityId, predicate, value, String(value).toLowerCase(), scope, evidenceLevel, observedAt, `claim-${id}`, at, at);
  return id;
}

test("vector recall finds a re-phrasing whose words share nothing", () => {
  const { store } = freshStore();
  const a = store.writeFact(fact({ predicate: "正式上线", value: "插件已经可以用了" })).fact;
  const b = store.writeFact(fact({ predicate: "上线状态", value: "现在处于已发布阶段" })).fact;
  putVector(store, a.id, LEFT);
  putVector(store, b.id, atCosine(0.92));
  const pairs = collectDuplicatePairs(store, { fingerprint: FINGERPRINT });
  assert.equal(pairs.length, 1, "the vector leg is the only one that can see this pair");
  assert.ok(pairs[0].cosine >= 0.9);
  assert.equal(pairs[0].pairKey, pairKeyOf({ fingerprint: FINGERPRINT, leftId: a.id, rightId: b.id }));
  store.close();
});

test("a cosine under the floor is not a candidate, however alike the topics", () => {
  const { store } = freshStore();
  const a = store.writeFact(fact({ predicate: "磁盘空间", value: "12%" })).fact;
  const b = store.writeFact(fact({ predicate: "内存占用", value: "21%" })).fact;
  putVector(store, a.id, LEFT);
  putVector(store, b.id, atCosine(0.8));
  assert.deepEqual(collectDuplicatePairs(store, { fingerprint: FINGERPRINT }), []);
  store.close();
});

test("recall stays inside one entity and one scope", () => {
  const { store } = freshStore();
  const a = store.writeFact(fact({ entity: { name: "api", type: "service" }, predicate: "端口", value: "7801" })).fact;
  const other = store.writeFact(fact({ entity: { name: "web", type: "service" }, predicate: "端口", value: "7801" })).fact;
  putVector(store, a.id, LEFT);
  putVector(store, other.id, LEFT);
  assert.deepEqual(collectDuplicatePairs(store, { fingerprint: FINGERPRINT }), [], "two services sharing a value are two facts");

  // Same subject, different scope: still never comparable.
  const scoped = insertRawFact(store, { entity: "api", predicate: "端口", value: "7801", scope: "project-x" });
  putVector(store, scoped, LEFT);
  assert.deepEqual(collectDuplicatePairs(store, { fingerprint: FINGERPRINT }), []);
  store.close();
});

test("a sensitive row never enters a comparison", () => {
  const { store } = freshStore();
  const plain = store.writeFact(fact({ predicate: "联系方式", value: "见工单" })).fact;
  const sensitive = store.writeFact(fact({ predicate: "手机号", value: "13800000000", privacyClass: "sensitive", modelUseAllowed: false })).fact;
  putVector(store, plain.id, LEFT);
  putVector(store, sensitive.id, LEFT);
  assert.deepEqual(collectDuplicatePairs(store, { fingerprint: FINGERPRINT }), [], "the model must not be asked about personal data");
  store.close();
});

test("the lexical leg still recalls a restatement with no vectors at all", () => {
  const { store } = freshStore();
  insertRawFact(store, { entity: "账单服务", predicate: "首轮开发完成", value: "基础功能已实现" });
  insertRawFact(store, { entity: "账单服务", predicate: "首轮开发完成", value: "基础功能已实现" });
  const pairs = collectDuplicatePairs(store, { fingerprint: FINGERPRINT });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].cosine, null, "no vector generation, so the pair is lexical only");
  assert.equal(pairs[0].tier, "exact");
  store.close();
});

test("the keeper is chosen by evidence, then by age — never by the model", () => {
  const older = { id: "a", evidence_level: "observed", observed_at: "2026-11-01T00:00:00.000Z" };
  const newer = { id: "b", evidence_level: "observed", observed_at: "2026-11-02T00:00:00.000Z" };
  assert.equal(preferredKeep(older, newer), "a", "between equal evidence the original statement is the memory");
  assert.equal(preferredKeep({ ...older, evidence_level: "unverified" }, newer), "b");
  assert.equal(preferredKeep(older, { ...newer, evidence_level: "explicit_user" }), "b", "the user's own words win");
  // Deterministic even when everything ties.
  assert.equal(preferredKeep({ ...older, observed_at: null }, { ...newer, observed_at: null }), "a");
});

test("a model answer outside the closed enum is not a verdict", () => {
  assert.deepEqual(parseJudgeAnswer('{"decision":"same","keep":"left","reason":"同义"}'), { decision: "same", keep: "left", reason: "同义" });
  assert.deepEqual(parseJudgeAnswer('好的：\n```json\n{"decision":"distinct","keep":"neither","reason":"值不同"}\n```'), {
    decision: "distinct",
    keep: "neither",
    reason: "值不同",
  });
  assert.equal(parseJudgeAnswer('{"decision":"merge","keep":"left","reason":"x"}'), null);
  assert.equal(parseJudgeAnswer('{"decision":"same"}').keep, "neither");
  assert.equal(parseJudgeAnswer("不是 JSON"), null);
  assert.equal(parseJudgeAnswer(""), null);
});

test("a same verdict files one pending proposal and is never paid for twice", async () => {
  const { store } = freshStore();
  // The user's own statement is the keeper; the derived one is the echo.
  const a = store.writeFact(fact({ predicate: "正式上线", value: "插件已经可以用了", evidenceLevel: "explicit_user" })).fact;
  const b = store.writeFact(fact({ predicate: "上线状态", value: "现在处于已发布阶段", evidenceLevel: "observed" })).fact;
  putVector(store, a.id, LEFT);
  putVector(store, b.id, atCosine(0.93));
  let calls = 0;
  const judge = async () => {
    calls += 1;
    return { decision: "same", keep: "left", reason: "两种说法同一个状态" };
  };
  const first = await runConsolidation({ store, judge, fingerprint: FINGERPRINT });
  assert.equal(first.judged, 1);
  assert.equal(first.proposals, 1);
  assert.equal(calls, 1);

  const proposals = store.db.prepare("SELECT * FROM proposals").all();
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].kind, "merge");
  assert.equal(proposals[0].action, "merge");
  const targets = JSON.parse(proposals[0].targets);
  assert.equal(targets.length, 2);
  assert.equal(targets.find((target) => target.role === "keep").factId, a.id, "the earlier observation is kept");
  assert.equal(targets.find((target) => target.role === "drop").factId, b.id);

  const second = await runConsolidation({ store, judge, fingerprint: FINGERPRINT });
  assert.equal(calls, 1, "a decided pair is not sent to the model again");
  assert.equal(second.proposals, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM proposals").get().count, 1);
  store.close();
});

test("a distinct verdict is remembered and files nothing", async () => {
  const { store } = freshStore();
  const a = store.writeFact(fact({ predicate: "测试结果", value: "187 个通过" })).fact;
  const b = store.writeFact(fact({ predicate: "测试结果", value: "188 个通过" })).fact;
  putVector(store, a.id, LEFT);
  putVector(store, b.id, atCosine(0.89));
  let calls = 0;
  const judge = async () => {
    calls += 1;
    return { decision: "distinct", keep: "neither", reason: "数字不同，是两次不同的结果" };
  };
  const result = await runConsolidation({ store, judge, fingerprint: FINGERPRINT });
  assert.equal(result.distinct, 1);
  assert.equal(result.proposals, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM proposals").get().count, 0);
  const judgement = store.dedupJudgement(pairKeyOf({ fingerprint: FINGERPRINT, leftId: a.id, rightId: b.id }));
  assert.equal(judgement.status, "resolved");
  await runConsolidation({ store, judge, fingerprint: FINGERPRINT });
  assert.equal(calls, 1);
  store.close();
});

test("a failed judgement changes nothing and counts its attempt", async () => {
  const { store } = freshStore();
  const a = store.writeFact(fact({ predicate: "正式上线", value: "插件已经可以用了" })).fact;
  const b = store.writeFact(fact({ predicate: "上线状态", value: "现在处于已发布阶段" })).fact;
  putVector(store, a.id, LEFT);
  putVector(store, b.id, atCosine(0.95));
  const result = await runConsolidation({
    store,
    judge: async () => {
      throw new Error("model unavailable");
    },
    fingerprint: FINGERPRINT,
  });
  assert.equal(result.failed, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM proposals").get().count, 0);
  const judgement = store.dedupJudgement(pairKeyOf({ fingerprint: FINGERPRINT, leftId: a.id, rightId: b.id }));
  assert.equal(judgement.status, "failed");
  assert.equal(judgement.attempts, 1);
  assert.match(judgement.reason, /model unavailable/);
  // Still live: the next sweep may ask again.
  assert.equal(store.getFact(b.id).status, "active");
  store.close();
});

test("a new vector generation re-opens a pair that was already decided", async () => {
  const { store } = freshStore();
  const a = store.writeFact(fact({ predicate: "正式上线", value: "插件已经可以用了" })).fact;
  const b = store.writeFact(fact({ predicate: "上线状态", value: "现在处于已发布阶段" })).fact;
  putVector(store, a.id, LEFT, "fp-old");
  putVector(store, b.id, atCosine(0.93), "fp-old");
  let calls = 0;
  const judge = async () => {
    calls += 1;
    return { decision: "distinct", keep: "neither", reason: "旧向量空间" };
  };
  await runConsolidation({ store, judge, fingerprint: "fp-old" });
  assert.equal(calls, 1);
  // A different embedding model: the same two rows may now look different.
  putVector(store, a.id, LEFT, "fp-new");
  putVector(store, b.id, atCosine(0.93), "fp-new");
  await runConsolidation({ store, judge, fingerprint: "fp-new" });
  assert.equal(calls, 2, "a stale verdict must not silence the question");
  store.close();
});

test("accepting a merge retires the loser and keeps its evidence", async () => {
  const { store } = freshStore();
  const a = store.writeFact(fact({ predicate: "正式上线", value: "插件已经可以用了", evidenceLevel: "explicit_user" })).fact;
  const b = store.writeFact(
    fact({
      predicate: "上线状态",
      value: "现在处于已发布阶段",
      evidenceLevel: "observed",
      source: {
        sourceType: "session",
        namespace: "session",
        sessionId: "session-1",
        seq: 12,
        messageId: "m1",
        role: "user",
        textRange: null,
        evidenceHash: "hash-b",
        quote: "现在处于已发布阶段",
      },
    }),
  ).fact;
  putVector(store, a.id, LEFT);
  putVector(store, b.id, atCosine(0.93));
  await runConsolidation({
    store,
    judge: async () => ({ decision: "same", keep: "left", reason: "同一个上线状态" }),
    fingerprint: FINGERPRINT,
  });
  const proposal = store.db.prepare("SELECT * FROM proposals").get();
  const applied = applyProposal(store, { proposalId: proposal.id });
  assert.equal(applied.status, "applied");
  assert.equal(applied.written, "merged");
  assert.equal(applied.factId, a.id);
  assert.equal(store.getFact(b.id).status, "superseded", "the loser is retired, never deleted");
  assert.equal(store.getFact(b.id).supersededBy, a.id);
  const winnerSources = store.db.prepare("SELECT COUNT(*) AS count FROM fact_sources WHERE fact_id = ?").get(a.id).count;
  assert.equal(winnerSources, 1, "the loser's evidence moved to the survivor");
  assert.equal(store.db.prepare("SELECT status FROM proposals WHERE id = ?").get(proposal.id).status, "applied");
  store.close();
});

test("a spelling already recorded as an alias is the same subject", () => {
  const { store } = freshStore();
  const { id } = store.ensureEntity({ name: "内存服务" });
  store.db.prepare("UPDATE entities SET aliases = ? WHERE id = ?").run(JSON.stringify(["mem-svc"]), id);
  const same = store.ensureEntity({ name: "mem-svc" });
  assert.equal(same.id, id, "an alias must resolve to its entity instead of creating a second one");
  assert.equal(same.created, false);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM entities").get().count, 1);
  store.close();
});

test("one subject's pile of near-duplicates cannot starve another subject", async () => {
  const { store } = freshStore();
  // A nightly backup log writes one row per night: all near-identical, all from
  // one subject, and high enough to fill every judgement a run may spend.
  for (let i = 0; i < 6; i += 1) {
    const row = store.writeFact(
      fact({ predicate: `备份结果${i}`, value: `OK 2026-11-0${i + 1}`, entity: { name: "dsh", type: "service" } }),
    ).fact;
    putVector(store, row.id, LEFT);
  }
  // The pair that matters lives in another subject and would otherwise wait for a
  // later sweep, because the noisy subject owns every higher cosine.
  const left = store.writeFact(fact({ predicate: "生效方式", value: "刷新页面即可" })).fact;
  const right = store.writeFact(fact({ predicate: "index.js的改动生效方式", value: "需要重启DSH" })).fact;
  putVector(store, left.id, LEFT);
  putVector(store, right.id, atCosine(0.87));

  const seen = [];
  const judge = async (pair) => {
    seen.push(pair.left.entity_name);
    return { decision: "distinct", keep: "neither", reason: "测试用，判不同" };
  };
  const result = await runConsolidation({ store, judge, fingerprint: FINGERPRINT, limits: { maxJudgements: 3 } });
  assert.equal(result.judged, 3);
  assert.ok(seen.includes("插件"), "the other subject's pair is judged inside the same budget");
  store.close();
});

