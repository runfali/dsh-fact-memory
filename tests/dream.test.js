import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  DREAM_SCHEMA,
  buildDreamPrompt,
  buildTopicIndex,
  clipTitle,
  collectMaterial,
  decideDream,
  dreamStateLine,
  identifiersOf,
  parseDreamAnswer,
  runDreamPass,
  searchDreams,
  validateDreams,
} from "../src/dream.js";
import { MemoryStore } from "../src/store.js";

test("notes are found by topic words, and the cue's own title ranks first", () => {
  const notes = [
    {
      id: "a",
      topicKey: "release-process",
      title: "发布改成两步走",
      body: "预发环境跑完整回归，通过后由值班的人手动上线。",
      topics: ["发布流程"],
      hitCount: 0,
      updatedAt: "2026-11-01T00:00:00.000Z",
    },
    {
      id: "b",
      topicKey: "nginx-proxy",
      title: "nginx 按 Host 选虚拟主机",
      body: "proxy_pass 带变量要配 resolver，否则整站 502。",
      topics: ["nginx"],
      hitCount: 3,
      updatedAt: "2026-11-02T00:00:00.000Z",
    },
  ];
  assert.equal(searchDreams(notes, "release-process")[0].id, "a");
  // A CJK phrase that never appears verbatim still lands, through bigrams.
  assert.equal(searchDreams(notes, "发布流程")[0].id, "a");
  assert.equal(searchDreams(notes, "nginx Host")[0].id, "b");
  // A word that only lives in the body still counts, one step below the title.
  assert.equal(searchDreams(notes, "resolver")[0].id, "b");
  assert.equal(searchDreams(notes, "量子计算").length, 0);
  assert.deepEqual(searchDreams(notes, "   "), []);
  assert.equal(searchDreams(notes, "nginx", 1).length, 1);
  assert.equal(searchDreams([{ id: "c", topicKey: "empty", title: "空", body: "" }], "空").length, 0, "a note with no body is not readable");
});

const dirs = [];
function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "fm-dreamunit-"));
  dirs.push(dir);
  return { store: MemoryStore.open({ dataDir: dir }), dir };
}
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may keep the WAL handle briefly */
    }
  }
});

const cfg = {
  dreamEnabled: true,
  dreamMinChars: 10000,
  dreamMinSessions: 3,
  dreamMinGapMs: 21600000,
  dreamDailyCap: 2,
  dreamIdleFloorDays: 7,
  dreamIdleFloorChars: 2000,
};

test("decideDream is off by default and says why", () => {
  assert.deepEqual(decideDream({ pendingChars: 999999 }, { ...cfg, dreamEnabled: false }), { run: false, reason: "disabled" });
  assert.equal(decideDream({ pendingChars: 500 }, cfg).reason, "not_enough");
  assert.equal(decideDream({ pendingChars: 10000 }, cfg).reason, "chars");
  assert.equal(decideDream({ pendingChars: 2500, eligibleSessions: 3 }, cfg).reason, "sessions");
  // Waiting sessions alone are not the threshold: they must survive the collector.
  assert.equal(decideDream({ pendingChars: 2500, pendingSessions: 3 }, cfg).reason, "not_enough");
  assert.equal(decideDream({ pendingChars: 2500, pendingSessions: 1, lastRunAt: Date.now() - 8 * 86400000 }, cfg).reason, "idle_floor");
  // Never run is not "quiet for a week": the first pass waits for the real threshold.
  assert.equal(decideDream({ pendingChars: 2500, pendingSessions: 1 }, cfg).reason, "not_enough");
});

test("damping outranks every threshold", () => {
  const now = 1_000_000_000_000;
  assert.equal(decideDream({ pendingChars: 999999, lastRunAt: now - 3600_000 }, cfg, now).reason, "min_gap");
  assert.equal(decideDream({ pendingChars: 999999, runsToday: 2 }, cfg, now).reason, "daily_cap");
  const backoff = decideDream({ pendingChars: 999999, lastRunStatus: "error", lastRunAt: now - 1000 }, cfg, now);
  assert.equal(backoff.reason, "error_backoff");
  assert.equal(backoff.nextAt, now - 1000 + 4 * 3600_000);
  assert.equal(decideDream({ pendingChars: 100, eventPending: true }, cfg, now).reason, "event");
  assert.equal(decideDream({ pendingChars: 100, eventPending: true }, { ...cfg, dreamEventTrigger: false }, now).reason, "not_enough");
});

test("the state line never reads as an empty silence", () => {
  const line = dreamStateLine({ pendingChars: 12345, pendingSessions: 3, lastRunAt: Date.now() - 4 * 3600_000, verdict: { run: false, reason: "min_gap", nextAt: Date.now() + 2 * 3600_000 } });
  assert.match(line, /12345 字符待整理/);
  assert.match(line, /3 个会话/);
  assert.match(line, /下次可自动整理/);
  assert.match(dreamStateLine({}), /没有待整理素材/);
});

const feedRow = (id, sessionId, seq, role, text, at) => ({
  id,
  session_id: sessionId,
  seq,
  role,
  text,
  at: at ?? "2026-11-14T10:00:00.000Z",
});

test("material takes whole sessions, leaves thin ones behind and truncates long messages", () => {
  const rows = [];
  for (let seq = 1; seq <= 4; seq += 1) rows.push(feedRow(seq, "s1", seq, "user", "端口 8080 已确认，这一步很重要。" + "x".repeat(50)));
  rows.push(feedRow(5, "s1", 5, "assistant", "好的"));
  rows.push(feedRow(6, "s2", 1, "user", "只有一条用户消息"));
  const material = collectMaterial(rows, { maxChars: 5000 });
  assert.equal(material.sessions.length, 1);
  assert.equal(material.sessions[0].sessionId, "s1");
  assert.equal(material.sessions[0].label, "S1");
  assert.equal(material.sessions[0].userMessages, 4);
  assert.equal(material.sessions[0].fromSeq, 1);
  assert.equal(material.sessions[0].toSeq, 5);
  assert.equal(material.skipped.thin, 1);
  assert.match(material.text, /\[S1 2026-11-14\] 用户：端口 8080/);
  assert.deepEqual(material.consumedIds, [1, 2, 3, 4, 5]);
});

test("a truncated session consumes only the rows it sent", () => {
  const rows = [];
  for (let seq = 1; seq <= 6; seq += 1) rows.push(feedRow(seq, "s1", seq, "user", "y".repeat(100)));
  const material = collectMaterial(rows, { maxChars: 400 });
  const session = material.sessions[0];
  assert.ok(session.messages < 6, "the budget cut the session short");
  assert.equal(session.ids.length, session.messages);
  assert.deepEqual(material.consumedIds, session.ids, "the cut tail must stay in the feed");
  assert.equal(session.toSeq, session.messages, "a source range stops where the material stops");
});

test("a feed of drafts is taken rather than stranded", () => {
  const drafts = [feedRow(1, "s1", 1, "user", "只有一条用户消息"), feedRow(2, "s2", 1, "user", "另一条")];
  const relaxed = collectMaterial(drafts, { maxChars: 5000 });
  assert.equal(relaxed.sessions.length, 2, "waiting for a third message would strand the whole feed");
  const substantial = [];
  for (let seq = 1; seq <= 3; seq += 1) substantial.push(feedRow(10 + seq, "s3", seq, "user", "第三条会话"));
  const taken = collectMaterial([...drafts, ...substantial], { maxChars: 5000 });
  assert.deepEqual(taken.sessions.map((session) => session.sessionId), ["s3"], "a real session still leaves drafts alone");
});

test("a dream answer is parsed through fences and refuses a non-object", () => {
  const fence = String.fromCharCode(96).repeat(3);
  const ok = parseDreamAnswer("好的：\n\n" + fence + 'json\n{"dreams":[{"topic_key":"a-b"}]}\n' + fence);
  assert.equal(ok.ok, true);
  assert.equal(ok.dreams.length, 1);
  assert.equal(parseDreamAnswer("no json here").ok, false);
  assert.equal(parseDreamAnswer('{"notDreams":[]}').ok, false);
});

test("identifiers are exact tokens, not substrings", () => {
  const found = identifiersOf("把端口 8080 改到 9090，版本 0.7.1，路径 D:/DSH/x，见 https://example.com/a");
  assert.ok(found.includes("8080"));
  assert.ok(found.includes("9090"));
  assert.ok(found.includes("0.7.1"));
  assert.ok(found.some((value) => value.startsWith("D:/DSH")));
  assert.ok(found.some((value) => value.startsWith("https://example.com")));
});

const session = {
  sessionId: "s1",
  label: "S1",
  fromSeq: 1,
  toSeq: 10,
  userText: "端口 8080 已确认，用 pnpm 构建",
};

test("validation drops what it cannot prove and flags what it cannot find", () => {
  const result = validateDreams({
    dreams: [
      { op: "add", topic_key: "Bad Key!", title: "x", lines: ["y"], novelty: "high", sources: [{ session: "S1", from: 1, to: 2 }] },
      { op: "noop", topic_key: "k-noop", title: "x", lines: ["y"], novelty: "high", sources: [{ session: "S1", from: 1, to: 2 }] },
      { op: "add", topic_key: "k-low", title: "x", lines: ["y"], novelty: "low", sources: [{ session: "S1", from: 1, to: 2 }] },
      { op: "add", topic_key: "k-nosrc", title: "x", lines: ["y"], novelty: "high", sources: [{ session: "S9", from: 1, to: 2 }] },
      { op: "add", topic_key: "k-outrange", title: "x", lines: ["y"], novelty: "high", sources: [{ session: "S1", from: 1, to: 99 }] },
      { op: "add", topic_key: "k-rejected", title: "x", lines: ["y"], novelty: "high", sources: [{ session: "S1", from: 1, to: 2 }] },
      { op: "add", topic_key: "k-good", title: "端口配置", lines: ["端口 8080 已确认", "构建用 pnpm"], novelty: "high", sources: [{ session: "S1", from: 1, to: 2 }] },
      { op: "add", topic_key: "k-fake", title: "部署", lines: ["版本 9.9.9 上线"], novelty: "high", sources: [{ session: "S1", from: 1, to: 2 }] },
    ],
    material: "[S1 2026-11-14] 用户：端口 8080 已确认，用 pnpm 构建",
    sessions: [session],
    rejects: [{ topicKey: "k-rejected" }],
    maxDreams: 5,
  });
  const keys = result.accepted.map((dream) => dream.topicKey);
  assert.deepEqual(keys, ["k-good", "k-fake"]);
  const reasons = new Set(result.dropped.map((row) => row.reason));
  for (const reason of ["bad_topic_key", "noop", "low_novelty", "no_valid_source", "rejected_topic"]) {
    assert.ok(reasons.has(reason), reason + " missing");
  }
  const good = result.accepted.find((dream) => dream.topicKey === "k-good");
  assert.equal(good.evidence, "user_stated");
  assert.equal(good.unverified, false);
  const fake = result.accepted.find((dream) => dream.topicKey === "k-fake");
  assert.equal(fake.unverified, true, "9.9.9 does not occur in the material");
});

test("a title past the limit is cut at a break and says so", () => {
  // The two titles that were clipped at 30 characters in the live store: both
  // stay whole now, because 32 characters is inside the accept window.
  const hosting = "nginx 代理按 Host 选虚拟主机，$host 会 404";
  assert.equal(clipTitle(hosting), hosting);
  const resolver = "nginx proxy_pass 带变量必须配 resolver";
  assert.equal(clipTitle(resolver), resolver);
  // The prompt asks for 35; the parser accepts 45. Nothing inside is rewritten.
  assert.equal(Array.from(clipTitle("字".repeat(35))).length, 35);
  assert.equal(Array.from(clipTitle("字".repeat(45))).length, 45);
  // Past the limit the tail is dropped at a boundary, never in the middle of a word.
  const long = "nginx proxy_pass 带变量时必须配合 resolver 使用，否则请求会在解析阶段直接失败并返回 502";
  const cut = clipTitle(long);
  assert.ok(Array.from(cut).length <= 45, "a clipped title stays inside the limit");
  assert.ok(cut.endsWith("…"), "a clipped title says it was clipped");
  assert.ok(!cut.endsWith(" …"), "no dangling space before the ellipsis");
  assert.ok(!cut.includes("否则"), "the cut falls at the break, not mid-clause");
});

test("the prompt names the known topics and the source ranges", () => {
  const prompt = buildDreamPrompt({
    material: "素材",
    sessions: [{ label: "S1", sessionId: "s1", fromSeq: 1, toSeq: 9, messages: 9 }],
    existing: [{ topicKey: "k1", title: "旧主题" }],
    rejects: [{ topicKey: "k2", reason: "不想要" }],
    focus: "只看部署",
  });
  assert.match(prompt, /k1：旧主题/);
  assert.match(prompt, /k2（不想要）/);
  assert.match(prompt, /S1：s1，序号 1-9/);
  assert.match(prompt, /只看部署/);
});

const answer = JSON.stringify({
  dreams: [
    {
      op: "add",
      topic_key: "port-config",
      title: "端口配置",
      lines: ["端口 8080 已确认", "构建用 pnpm"],
      topics: ["端口", "pnpm"],
      sources: [{ session: "S1", from: 1, to: 4 }],
      novelty: "high",
    },
  ],
});

function seedFeed(store) {
  for (let seq = 1; seq <= 4; seq += 1) {
    store.dreamFeedAppend({ sessionId: "s1", seq, at: "2026-11-14T10:0" + seq + ":00.000Z", role: "user", text: "端口 8080 已确认，用 pnpm 构建，第 " + seq + " 步" });
  }
  store.dreamFeedAppend({ sessionId: "s1", seq: 5, at: "2026-11-14T10:05:00.000Z", role: "assistant", text: "好的，已记录" });
}

test("the topic index is a map of live notes, never a summary", () => {
  const dreams = [
    { topicKey: "b", title: "二", sources: [1, 2], hitCount: 3, validFrom: "2026-11-01T00:00:00.000Z" },
    { topicKey: "a", title: "", sources: [], hitCount: 0, validFrom: null },
  ];
  const index = buildTopicIndex(dreams, { limit: 1 });
  assert.equal(index.length, 1);
  assert.deepEqual(index[0], { topicKey: "b", title: "二", sources: 2, hitCount: 3, validFrom: "2026-11-01T00:00:00.000Z", updatedAt: null });
  // A note with no title falls back to its key instead of rendering an empty row.
  assert.equal(buildTopicIndex(dreams)[1].title, "a");
  assert.deepEqual(buildTopicIndex(null), []);
});

test("the material carries the world time of its earliest message", () => {
  const rows = [
    { id: 1, session_id: "s1", seq: 1, at: "2026-11-02T10:00:00.000Z", role: "user", text: "第一句" },
    { id: 2, session_id: "s1", seq: 2, at: "2026-11-02T10:01:00.000Z", role: "assistant", text: "回应" },
    { id: 3, session_id: "s1", seq: 3, at: "2026-11-02T10:02:00.000Z", role: "user", text: "第二句" },
    { id: 4, session_id: "s1", seq: 4, at: "2026-11-02T10:03:00.000Z", role: "user", text: "第三句" },
    { id: 5, session_id: "s2", seq: 1, at: "2026-10-20T08:00:00.000Z", role: "user", text: "更早" },
    { id: 6, session_id: "s2", seq: 2, at: "2026-10-20T08:01:00.000Z", role: "assistant", text: "嗯" },
    { id: 7, session_id: "s2", seq: 3, at: "2026-10-20T08:02:00.000Z", role: "user", text: "还有" },
    { id: 8, session_id: "s2", seq: 4, at: "2026-10-20T08:03:00.000Z", role: "assistant", text: "好" },
    { id: 9, session_id: "s2", seq: 5, at: "2026-10-20T08:04:00.000Z", role: "user", text: "最后一句" },
  ];
  const material = collectMaterial(rows);
  assert.equal(material.firstAt, "2026-10-20T08:00:00.000Z");
});

test("a pass writes dreams, consumes exactly its material and never touches facts", async () => {
  const { store } = freshStore();
  store.writeFact({ entity: { name: "api", type: "service" }, predicate: "端口", value: "8080", cardinality: "single", evidenceLevel: "explicit_user", observedAt: "2026-11-01T00:00:00.000Z" });
  const before = store.stats();
  seedFeed(store);
  const result = await runDreamPass({ store, cfg, callModel: async () => answer, model: "custom/m1" });
  assert.equal(result.status, "ok");
  assert.equal(result.accepted, 1);
  assert.equal(store.dreamPending()[0].model, "custom/m1", "the note records who wrote it");
  assert.equal(result.proposed, 1);
  assert.equal(store.dreamStats().pending, 1);
  assert.equal(store.dreamStats().feedRows, 0, "consumed material is gone");
  const after = store.stats();
  assert.equal(after.facts, before.facts);
  assert.equal(after.generation, before.generation);
  assert.equal(result.cursorId, 5);
  store.close();
});

test("a dry run reads the material, writes nothing and keeps the feed", async () => {
  const { store } = freshStore();
  seedFeed(store);
  const result = await runDreamPass({ store, cfg, callModel: async () => answer, dryRun: true });
  // Nothing is written, but the answer still says what it would have kept.
  assert.equal(result.status, "ok");
  assert.equal(result.accepted, 1);
  assert.equal(result.created.length, 0);
  assert.equal(result.cursorId, 0);
  assert.equal(store.dreamStats().pending, 0);
  assert.equal(store.dreamStats().feedRows, 5);
  store.close();
});

test("a model failure is reported and consumes nothing", async () => {
  const { store } = freshStore();
  seedFeed(store);
  const result = await runDreamPass({ store, cfg, callModel: async () => { throw new Error("timeout"); } });
  assert.equal(result.status, "error");
  assert.equal(result.reason, "model_failed");
  assert.equal(store.dreamStats().feedRows, 5);
  store.close();
});

test("a row the collector can never send is retired with its material", async () => {
  const { store } = freshStore();
  seedFeed(store);
  store.dreamFeedAppend({ sessionId: "s1", seq: 6, at: "2026-11-14T10:06:00.000Z", role: "user", text: "联系邮箱 someone@example.com，先记下" });
  assert.equal(store.dreamStats().feedRows, 6);
  const result = await runDreamPass({ store, cfg, callModel: async () => answer });
  assert.equal(result.status, "ok");
  assert.equal(store.dreamStats().feedRows, 0, "an unfilterable row must not keep the counter lit");
  store.close();
});

test("a feed of nothing but filtered rows clears itself", async () => {
  const { store } = freshStore();
  store.dreamFeedAppend({ sessionId: "s1", seq: 1, role: "user", text: "手机号 13800138000 请记一下" });
  store.dreamFeedAppend({ sessionId: "s1", seq: 2, role: "user", text: "sk-abcdefghijklmnopqrstuvwxyz" });
  const result = await runDreamPass({ store, cfg, callModel: async () => answer });
  assert.equal(result.reason, "no_material");
  assert.equal(store.dreamStats().feedRows, 0, "the queue must not stay lit with rows it will never send");
  store.close();
});

test("an answer that keeps nothing still moves the feed forward", async () => {
  const { store } = freshStore();
  seedFeed(store);
  const result = await runDreamPass({ store, cfg, callModel: async () => '{"dreams":[]}' });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "all_dropped");
  assert.equal(store.dreamStats().feedRows, 0, "otherwise the same words are re-read forever");
  store.close();
});

test("evidence is what the check found, never what the op implies", () => {
  const sessions = [{ label: "S1", sessionId: "s1", fromSeq: 1, toSeq: 9, userText: "用户原话里说的是端口 8080" }];
  const base = { material: "[S1 2026-01-01] 用户：用户原话里说的是端口 8080", sessions, existing: [], rejects: [] };
  const supersede = {
    op: "supersede",
    topic_key: "release-cadence",
    title: "发布节奏",
    lines: ["发布改成了每月一次。"],
    sources: [{ session: "S1", from: 1, to: 2 }],
    novelty: "high",
  };
  // Nothing in the user's words matches this title: op=supersede alone must not
  // turn into "the user said it".
  assert.equal(validateDreams({ ...base, dreams: [supersede] }).accepted[0].evidence, "inferred");
  // The same shape, this time on wording the user really used.
  assert.equal(validateDreams({ ...base, dreams: [{ ...supersede, title: "端口" }] }).accepted[0].evidence, "user_stated");
});

test("the answer schema does not ask for fact ids, which a model cannot know", () => {
  assert.equal("fact_ids" in DREAM_SCHEMA.properties.dreams.items.properties, false);
  // An answer that still carries them is not rejected, it is simply ignored.
  const sessions = [{ label: "S1", sessionId: "s1", fromSeq: 1, toSeq: 9, userText: "端口是 8080" }];
  const out = validateDreams({
    material: "[S1] 用户：端口是 8080",
    sessions,
    existing: [],
    rejects: [],
    dreams: [
      {
        op: "add",
        topic_key: "ports",
        title: "端口",
        lines: ["端口是 8080。"],
        fact_ids: ["f1", "f2"],
        sources: [{ session: "S1", from: 1, to: 2 }],
        novelty: "high",
      },
    ],
  });
  assert.equal(out.accepted[0].factIds, undefined);
});
