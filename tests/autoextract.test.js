import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import plugin from "../index.js";
import { MemoryStore } from "../src/store.js";
import { MERGE_SCHEMA, buildExtractPrompt, mergeCandidates, normalizeCandidates, packChunks, parseExtraction, parseMerge, shouldExtract, splitText } from "../src/autoextract.js";
import { callCustomText } from "../src/llm.js";

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "fm-extract-"));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may hold the WAL handle briefly */
    }
  }
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition not reached");
    await wait(20);
  }
}

// ── pure helpers ─────────────────────────────────────────────────────────

test("the signal prefilter keeps a decision and drops small talk", () => {
  assert.equal(shouldExtract("记住：e2e 服务的端口是 9911"), true);
  assert.equal(shouldExtract("以后都用 pnpm 而不是 npm"), true);
  assert.equal(shouldExtract("你好"), false);
  assert.equal(shouldExtract("今天天气不错，适合散步"), false);
  // The same cues in English, plus the peer-system categories (standing
  // decisions, conventions, preferences, property-value bindings).
  assert.equal(shouldExtract("Remember: the e2e service port is 9911"), true);
  assert.equal(shouldExtract("From now on we use pnpm instead of npm"), true);
  assert.equal(shouldExtract("We decided to deploy the api on 10.0.0.5"), true);
  assert.equal(shouldExtract("统一用 pnpm，别再装 npm 了"), true);
  assert.equal(shouldExtract("the api port is 9911"), true);
  assert.equal(shouldExtract("订单服务的端口是 8123"), true);
  assert.equal(shouldExtract("这个版本看起来有点乱"), false);
  assert.equal(shouldExtract("hello there, how are you?"), false);
});

test("model output is parsed strictly and a broken answer is not a partial success", () => {
  const ok = parseExtraction('```json\n{"facts":[]}\n```');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.facts, []);
  assert.equal(parseExtraction("no json here").ok, false);
  assert.equal(parseExtraction('{"facts":["nope"]}').ok, true);
  assert.equal(parseExtraction('{"items":[]}').ok, false);
});

test("a candidate whose quote is not in the input is dropped", () => {
  const source = "记住：e2e 服务的端口是 9911，以后不要再改了。";
  const { candidates, rejected } = normalizeCandidates(
    [
      { entity: "e2e", predicate: "端口", value: "9911", quote: "e2e 服务的端口是 9911", confidence: 0.9 },
      { entity: "e2e", predicate: "端口", value: "8080", quote: "端口改成 8080 了", confidence: 0.9 },
      { entity: "e2e", predicate: "端口", value: "9911", quote: "e2e 服务的端口是 9911", confidence: 0.9 },
      { entity: "", predicate: "端口", value: "9911", quote: "e2e 服务的端口是 9911" },
    ],
    source,
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].value, "9911");
  assert.deepEqual(
    rejected.map((entry) => entry.reason),
    ["quote_not_in_source", "duplicate_in_batch", "missing_field"],
  );
});

test("low confidence becomes a proposal candidate, not a fact", () => {
  const source = "我觉得端口大概可能是 9911 吧";
  const { candidates } = normalizeCandidates(
    [{ entity: "e2e", predicate: "端口", value: "9911", quote: "端口大概可能是 9911", confidence: 0.4 }],
    source,
    { confidenceMin: 0.6 },
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].pendingOnly, true);
  assert.equal(candidates[0].evidenceLevel, "inferred");
});

test("chunks keep whole messages and split on the budget", () => {
  const chunks = packChunks(
    [
      { seq: 1, text: "a".repeat(40) },
      { seq: 2, text: "b".repeat(40) },
      { seq: 3, text: "c".repeat(10) },
    ],
    { maxChars: 60 },
  );
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0].items.map((item) => item.seq), [1]);
  assert.deepEqual(chunks[1].items.map((item) => item.seq), [2, 3]);
});

// ── host context double ─────────────────────────────────────────────────

function fakeContext(config, { llm } = {}) {
  const contexts = [];
  const tools = new Map();
  const listeners = new Map();
  const agentListeners = new Map();
  const routes = [];
  const disposers = [];
  const agents = new Map();
  const scoped = {
    connection: { fetch: { register: (spec) => (routes.push(spec), () => {}) } },
    effect: (fn) => {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
      return dispose;
    },
  };
  const ctx = {
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    effect: (fn) => {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
      return dispose;
    },
    systemPrompt: { context: (spec) => (contexts.push(spec), () => {}), section: () => () => {} },
    tools: { register: (definition) => (tools.set(definition.name, definition), () => {}) },
    on: (event, handler) => {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {};
    },
    get: (service) => {
      if (service === "agents") return { list: () => [...agents.values()] };
      if (service === "llm") return llm;
      return undefined;
    },
    inject: (names, callback) => {
      if (names.includes("connection")) callback(scoped);
    },
    __contexts: contexts,
    __tools: tools,
    __routes: routes,
    __agent: (id, session) => {
      const agent = {
        id,
        session,
        ctx: {
          on: (event, handler) => {
            const list = agentListeners.get(event) ?? [];
            list.push(handler);
            agentListeners.set(event, list);
            return () => {};
          },
        },
      };
      agents.set(id, agent);
      for (const handler of listeners.get("agent/created") ?? []) handler({ agent });
      return agent;
    },
    __preStep: () => agentListeners.get("agent/pre-step") ?? [],
    __agentDisposed: (id) => {
      for (const handler of listeners.get("agent/disposed") ?? []) handler({ agent: agents.get(id) ?? { id } });
    },
    __sessionEvent: (session, event) => {
      for (const handler of listeners.get("session/event") ?? []) handler(session, event);
    },
    __dispose: () => {
      for (const dispose of disposers) dispose();
    },
  };
  return ctx;
}

function fakeSession(events, header = {}) {
  const id = header.id ?? "sess-1";
  return {
    id,
    header: { id, ...header },
    get seq() {
      return events.length;
    },
    eventAt: (seq) => events[seq],
  };
}

const userEvent = (id, text) => ({ type: "user/message", data: { id, role: "user", content: [{ type: "text", text }], source: { kind: "user" } } });
const assistantEvent = (text) => ({ type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text }] } }, surfaceOp: "append" });
const turnEnd = (turn = 1, seq = 0) => ({ type: "turn/end", seq, data: { turn, reason: { kind: "stop" } } });

function slowLlm(answers, delayMs) {
  const calls = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  return {
    calls,
    get maxConcurrent() {
      return maxConcurrent;
    },
    stream(options) {
      calls.push(options);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
      return (async function* streamed() {
        await wait(delayMs);
        yield { type: "text-delta", text: answer };
        yield { type: "finish", reason: { kind: "stop" } };
        concurrent -= 1;
      })();
    },
  };
}

function scriptedLlm(answers) {
  const calls = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
      return (async function* streamed() {
        yield { type: "text-delta", text: answer };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    },
  };
}

function boot({ llm, overrides = {}, dataDir = tempDir() } = {}) {
  const config = {
    dataDir,
    injectDirectory: true,
    directoryBudget: 800,
    injectReminder: false,
    autoCapture: false,
    searchLimit: 5,
    backupBeforeExport: true,
    autoExtract: true,
    llmSource: "host",
    extractDelayMs: 0,
    extractConfidenceMin: 0.6,
    extractMaxChars: 24_000,
    ...overrides,
  };
  const ctx = fakeContext(config, { llm });
  plugin.apply(ctx, { get: () => config });
  return { ctx, dataDir, config };
}

async function postRoute(ctx, path, body) {
  const route = ctx.__routes.find((item) => item.path === path);
  const response = await route.fetch({
    headers: {
      get: (name) =>
        ({
          "content-type": "application/json",
          host: "127.0.0.1:1",
          origin: "http://127.0.0.1:1",
          "sec-fetch-site": "same-origin",
        })[name] ?? null,
    },
    text: async () => JSON.stringify(body ?? {}),
    json: async () => body ?? {},
  });
  return response.json();
}

const status = (ctx) => postRoute(ctx, "/api/fact-memory/status", {});

test("a turn ending in an answer triggers one extraction that writes a fact", async () => {
  const llm = scriptedLlm([
    JSON.stringify({
      facts: [
        {
          entity: "e2e",
          entityType: "service",
          predicate: "端口",
          value: "9911",
          cardinality: "single",
          confidence: 0.9,
          quote: "e2e 服务的端口是 9911",
        },
      ],
    }),
  ]);
  const { ctx, dataDir } = boot({ llm });
  const events = [
    userEvent("m1", "记住：e2e 服务的端口是 9911"),
    assistantEvent("好的，已记下。"),
  ];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  // The model selection arrives with a real step; extraction reuses it.
  await ctx.__preStep()[0](
    { agent: { id: session.id }, messages: events[0].data.content ? [events[0].data] : [], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
    async () => ({ kind: "enter", messages: [events[0].data] }),
  );
  ctx.__sessionEvent(session, events[1]);
  ctx.__sessionEvent(session, turnEnd(1, events.length));
  await until(async () => (await status(ctx)).extraction.lastRun?.status === "ok");

  const snapshot = await status(ctx);
  assert.equal(snapshot.extraction.enabled, true);
  assert.equal(snapshot.extraction.lastRun.saved, 1);

  // The turn-tail card reads this route: the summary must be anchored to the
  // seq the host hands the slot (the turn's closing node seq), or the card
  // silently disappears even though the pass saved facts.
  const turnSeq = events.length;
  // The queue tab reads its own route: once the pass settled, nothing may still
  // look in flight, and the finished pass must be listed with the same boundary.
  const queue = await postRoute(ctx, "/api/fact-memory/queue", {});
  assert.equal(queue.ok, true);
  assert.equal(queue.totals.active, 0, "a settled pass leaves nothing running");
  assert.equal(queue.recent[0]?.state, "ok");
  assert.equal(queue.recent[0]?.seq, turnSeq);
  assert.equal(queue.recent[0]?.saved, 1, "the finished row carries what the pass wrote");
  assert.ok(Number(queue.recent[0]?.durationMs) >= 0, "and how long it took");
  const activity = await postRoute(ctx, "/api/fact-memory/activity", { sessionId: session.id, seq: turnSeq, limit: 3 });
  assert.equal(activity.lastRun?.saved, 1);
  assert.equal(activity.lastRun?.toSeq, turnSeq);

  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].maxTokens, 2048);
  assert.equal(llm.calls[0].temperature, 0);
  assert.equal(llm.calls[0].provider, "fake");
  assert.equal(llm.calls[0].tools, undefined);
  assert.match(llm.calls[0].messages[0].content[0].text, /e2e 服务的端口是 9911/);

  const store = MemoryStore.open({ dataDir });
  const rows = store.db.prepare("SELECT * FROM facts WHERE status = 'active'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value_text, "9911");
  assert.equal(store.cursor("session", session.id).next_seq, 2);
  store.close();

  // A later turn's pass must not steal the earlier turn's card: the store is
  // authoritative and the in-memory "latest run" is only a fallback.
  events.push(userEvent("m2", "记住：e2e 服务的端口是 9911"));
  const secondSeq = session.seq;
  ctx.__sessionEvent(session, turnEnd(2, secondSeq));
  await until(async () => (await status(ctx)).extraction.lastRun?.snapshot?.toSeq === secondSeq);
  const again = await postRoute(ctx, "/api/fact-memory/activity", { sessionId: session.id, seq: turnSeq, limit: 3 });
  assert.equal(again.lastRun?.toSeq, turnSeq, "the earlier turn keeps its own summary");
});

test("the queue shows a pass inside the debounce window before it runs", async () => {
  const llm = scriptedLlm([JSON.stringify({ facts: [] })]);
  const { ctx } = boot({ llm, overrides: { extractDelayMs: 15_000 } });
  const events = [userEvent("m1", "记住：e2e 服务的端口是 9911"), assistantEvent("好的")];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  await ctx.__preStep()[0](
    { agent: { id: session.id }, messages: [], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
    async () => ({ kind: "enter", messages: [] }),
  );
  ctx.__sessionEvent(session, events[1]);
  ctx.__sessionEvent(session, turnEnd(1, events.length));
  const queue = await postRoute(ctx, "/api/fact-memory/queue", {});
  assert.equal(queue.config.enabled, true);
  assert.equal(queue.config.delayMs, 15000);
  assert.equal(queue.totals.waiting, 1, "the pass sits in the debounce window");
  assert.equal(queue.waiting[0].sessionId, session.id);
  assert.ok(queue.waiting[0].dueInMs > 0, "the page can count down to the pass");
  assert.equal(queue.totals.running, 0);
  // The turn card polls the activity route while the pass is still armed: the
  // debounce has to read as pending there too, or the card sees "nothing running,
  // nothing queued" and stops asking before the pass has started.
  const waitingActivity = await postRoute(ctx, "/api/fact-memory/activity", { sessionId: session.id, seq: events.length, limit: 3 });
  assert.equal(waitingActivity.extraction.enabled, true);
  assert.equal(waitingActivity.extraction.running, false);
  assert.equal(waitingActivity.extraction.queued, 0);
  assert.ok(waitingActivity.extraction.waiting, "the debounce is reported as pending");
  assert.ok(waitingActivity.extraction.waiting.dueInMs > 0);
  assert.equal(llm.calls.length, 0, "nothing has called the model yet");
  ctx.__dispose();
});

test("a transcript prompt is never captured as user input", async () => {
  const { ctx, dataDir } = boot({ overrides: { autoCapture: true } });
  ctx.__agent("session-summary");
  const transcript = [
    "USER: 记一下，dsh-fact-memory插件首轮开发完成，基础功能已实现",
    "",
    "ASSISTANT[tools: run_code]",
    "",
    "ASSISTANT: 已记录。页签上的数字是这四项之和，不打开页签也能看到「有没有东西在跑」。",
  ].join("\n");
  await ctx.__preStep()[0](
    {
      agent: { id: "session-summary" },
      messages: [{ id: "m1", source: { kind: "user" }, content: [{ type: "text", text: transcript }] }],
      step: 1,
    },
    async () => ({ kind: "enter", messages: [] }),
  );
  const store = MemoryStore.open({ dataDir });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM facts").get().n, 0, "a transcript is not the user speaking");
  store.close();
  ctx.__dispose();
});

test("the model pass never reads a transcript prompt, but does read the reply", async () => {
  const llm = scriptedLlm([JSON.stringify({ facts: [] })]);
  const { ctx, dataDir } = boot({ llm });
  const transcript = [
    "USER: 记一下，dsh-fact-memory插件首轮开发完成",
    "",
    "ASSISTANT: 已记录。e2e 服务的端口是 9911。",
  ].join("\n");
  const events = [userEvent("m1", transcript), assistantEvent("已确认，e2e 服务的端口是 9911。")];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  await ctx.__preStep()[0](
    { agent: { id: session.id }, messages: [], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
    async () => ({ kind: "enter", messages: [] }),
  );
  ctx.__sessionEvent(session, turnEnd(1, events.length));
  await until(async () => llm.calls.length > 0);
  const prompt = llm.calls[0].messages[0].content[0].text;
  assert.doesNotMatch(prompt, /USER:|ASSISTANT:|首轮开发完成/, "the compaction transcript is not conversation");
  assert.match(prompt, /助手：已确认/, "the assistant's own report is read");
  await until(async () => ["ok", "skipped"].includes((await status(ctx)).extraction.lastRun?.status));
  const store = MemoryStore.open({ dataDir });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM facts").get().n, 0);
  const run = store.extractRuns({ limit: 1 })[0];
  if (run) assert.doesNotMatch(String(store.extractRun({ id: run.id })?.inputText ?? ""), /USER:/);
  store.close();
  ctx.__dispose();
});

test("a session without eventAt is reported, not skipped past", async () => {
  const { ctx, dataDir } = boot({ llm: scriptedLlm([JSON.stringify({ facts: [] })]) });
  const session = { id: "sess-no-event", get seq() { return 1; } };
  ctx.__sessionEvent(session, turnEnd(1, 1));
  await until(async () => (await status(ctx)).extraction.lastRun?.status === "error");
  const st = await status(ctx);
  assert.match(String(st.extraction.lastRun.error), /session_events_unavailable/);
  const store = MemoryStore.open({ dataDir });
  assert.equal(store.cursor("session", "sess-no-event")?.next_seq ?? null, null, "the cursor must not move past unread messages");
  store.close();
  ctx.__dispose();
});

test("a write failure keeps the range for a retry instead of consuming it", async () => {
  const answer = JSON.stringify({ facts: [{ entity: "svc", entityType: "service", predicate: "端口", value: "9901", cardinality: "single", confidence: 0.9, quote: "svc 的端口是 9901" }] });
  const { ctx, dataDir } = boot({ llm: scriptedLlm([answer]) });
  const events = [userEvent("m1", "记住：svc 的端口是 9901")];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  await ctx.__preStep()[0](
    { agent: { id: session.id }, messages: [], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
    async () => ({ kind: "enter", messages: [] }),
  );
  const original = MemoryStore.prototype.writeFact;
  MemoryStore.prototype.writeFact = () => { throw new Error("disk full"); };
  try {
    ctx.__sessionEvent(session, turnEnd(1, 1));
    await until(async () => (await status(ctx)).extraction.lastRun?.status === "error");
    const store = MemoryStore.open({ dataDir });
    assert.equal(store.cursor("session", session.id)?.next_seq ?? null, null, "the range was not written, so it is not consumed");
    const run = store.extractRuns({ limit: 1 })[0];
    assert.match(String(run?.reason), /write_failed/);
    store.close();
  } finally {
    MemoryStore.prototype.writeFact = original;
    ctx.__dispose();
  }
});

test("a fact in the assistant's report is extracted even when the user only asked for work", async () => {
  const answer = JSON.stringify({
    facts: [
      {
        entity: "orders",
        entityType: "service",
        predicate: "端口",
        value: "8123",
        cardinality: "single",
        confidence: 0.9,
        quote: "订单服务的端口是 8123",
      },
    ],
  });
  const llm = scriptedLlm([answer]);
  const { ctx, dataDir } = boot({ llm });
  const events = [userEvent("m1", "帮我看下订单服务跑在哪个端口"), assistantEvent("查到了，订单服务的端口是 8123")];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  await ctx.__preStep()[0](
    { agent: { id: session.id }, messages: [], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
    async () => ({ kind: "enter", messages: [] }),
  );
  ctx.__sessionEvent(session, turnEnd(1, events.length));
  await until(async () => (await status(ctx)).extraction.lastRun?.status === "ok");
  const prompt = llm.calls[0].messages[0].content[0].text;
  assert.match(prompt, /用户：帮我看下/, "the user's instruction is kept as context");
  assert.match(prompt, /助手：查到了/, "the assistant's report is read too");
  const store = MemoryStore.open({ dataDir });
  const row = store.db
    .prepare("SELECT e.name AS entity, f.predicate AS predicate, f.value_text AS value FROM facts f JOIN entities e ON e.id = f.entity_id")
    .get();
  assert.equal(row?.entity, "orders");
  assert.equal(row?.value, "8123");
  const source = store.db
    .prepare("SELECT s.role AS role FROM fact_sources s JOIN facts f ON f.id = s.fact_id LIMIT 1")
    .get();
  assert.equal(source?.role, "assistant", "the trail says who actually said it");
  store.close();
  ctx.__dispose();
});

test("with the assistant switch off only the user's words are read", async () => {
  const llm = scriptedLlm([JSON.stringify({ facts: [] })]);
  const { ctx, dataDir } = boot({ llm, overrides: { extractIncludeAssistant: false } });
  const events = [userEvent("m1", "帮我看下订单服务跑在哪个端口"), assistantEvent("查到了，订单服务的端口是 8123")];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  ctx.__sessionEvent(session, turnEnd(1, events.length));
  await until(async () => (await status(ctx)).extraction.lastRun?.status === "skipped");
  assert.equal(llm.calls.length, 0, "the assistant's report alone must not trigger a pass");
  assert.equal((await status(ctx)).extraction.lastRun.reason, "no_signal");
  const store = MemoryStore.open({ dataDir });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM facts").get().n, 0);
  store.close();
  ctx.__dispose();
});

test("when the model will read a message, the rule path stays silent", async () => {
  const llm = scriptedLlm([
    JSON.stringify({
      facts: [
        { entity: "e2e", entityType: "service", predicate: "端口", value: "9911", cardinality: "single", confidence: 0.9, quote: "e2e 服务的端口是 9911" },
      ],
    }),
  ]);
  const { ctx, dataDir } = boot({ llm, overrides: { autoCapture: true } });
  const events = [userEvent("m1", "e2e 服务的端口是 9911"), assistantEvent("好的")];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  await ctx.__preStep()[0](
    {
      agent: { id: session.id },
      messages: [{ id: "m1", source: { kind: "user" }, content: [{ type: "text", text: "e2e 服务的端口是 9911" }] }],
      step: 1,
      modelSelection: { provider: "fake", model: "fake-model" },
    },
    async () => ({ kind: "enter", messages: [] }),
  );
  const before = MemoryStore.open({ dataDir });
  assert.equal(
    before.db.prepare("SELECT COUNT(*) AS n FROM facts").get().n,
    0,
    "the rule path must not write what the model pass will read",
  );
  before.close();
  ctx.__sessionEvent(session, events[1]);
  ctx.__sessionEvent(session, turnEnd(1, events.length));
  await until(async () => (await status(ctx)).extraction.lastRun?.status === "ok");
  const after = MemoryStore.open({ dataDir });
  const rows = after.db.prepare("SELECT value_text, evidence_level FROM facts WHERE status = 'active'").all();
  assert.equal(rows.length, 1, "one statement is one fact");
  assert.equal(rows[0].value_text, "9911");
  assert.equal(rows[0].evidence_level, "observed");
  after.close();
  ctx.__dispose();
});

test("a real user message still captures with autoCapture on", async () => {
  const { ctx, dataDir } = boot({ overrides: { autoCapture: true } });
  ctx.__agent("session-1");
  await ctx.__preStep()[0](
    {
      agent: { id: "session-1" },
      messages: [{ id: "m1", source: { kind: "user" }, content: [{ type: "text", text: "记住：e2e 服务的端口是 9911" }] }],
      step: 1,
    },
    async () => ({ kind: "enter", messages: [] }),
  );
  const store = MemoryStore.open({ dataDir });
  const rows = store.db.prepare("SELECT value_text FROM facts WHERE status = 'active'").all();
  assert.equal(rows.length, 1, "the transcript guard must not block real input");
  assert.equal(rows[0].value_text, "9911");
  store.close();
  ctx.__dispose();
});

test("a delegated subagent session is neither auto-captured nor auto-extracted", async () => {
  const llm = scriptedLlm([JSON.stringify({ facts: [{ entity: "alpha", predicate: "端口", value: "7001", quote: "alpha 的端口是 7001", confidence: 0.9 }] })]);
  const { ctx, dataDir } = boot({ llm, overrides: { autoCapture: true } });
  const events = [userEvent("m1", "记住：alpha 的端口是 7001"), assistantEvent("好")];
  const session = fakeSession(events, { origin: "subagent", delegationDepth: 1, parentSession: "parent-1" });
  ctx.__agent(session.id, session);
  await ctx.__preStep()[0](
    { agent: { id: session.id }, messages: [events[0].data], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
    async () => ({ kind: "enter", messages: [] }),
  );
  ctx.__sessionEvent(session, turnEnd(1, events.length));
  await wait(50);
  assert.equal(llm.calls.length, 0, "a worker transcript must not reach the extractor");
  assert.equal((await status(ctx)).extraction.lastRun, null);
  const store = MemoryStore.open({ dataDir });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE status='active'").get().n, 0, "the rule path must stay silent too");
  store.close();
  ctx.__dispose();
});

test("a second turn only sends the new text", async () => {
  const llm = scriptedLlm([JSON.stringify({ facts: [] })]);
  const { ctx } = boot({ llm });
  const events = [userEvent("m1", "记住：e2e 服务的端口是 9911"), assistantEvent("好")];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  await ctx.__preStep()[0](
    { agent: { id: session.id }, messages: [], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
    async () => ({ kind: "enter", messages: [] }),
  );
  ctx.__sessionEvent(session, events[1]);
  ctx.__sessionEvent(session, turnEnd(1, events.length));
  await until(async () => (await status(ctx)).extraction.lastRun?.status === "ok");
  const firstPrompt = llm.calls[0].messages[0].content[0].text;

  events.push(userEvent("m2", "以后都用 pnpm 装依赖"), assistantEvent("好"));
  ctx.__sessionEvent(session, turnEnd(2, session.seq));
  await until(async () => llm.calls.length === 2);
  const secondPrompt = llm.calls[1].messages[0].content[0].text;
  assert.match(firstPrompt, /9911/);
  assert.match(secondPrompt, /pnpm/);
  assert.doesNotMatch(secondPrompt, /9911/);
});

test("small talk is skipped without a model call and still advances the cursor", async () => {
  const llm = scriptedLlm([JSON.stringify({ facts: [] })]);
  // Pure prefilter: the fallback pass is covered by its own test below.
  const { ctx } = boot({ llm, overrides: { extractFallbackTurns: 0 } });
  const events = [userEvent("m1", "你好，随便聊聊"), assistantEvent("你好")];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  ctx.__sessionEvent(session, turnEnd(1, events.length));
  await until(async () => (await status(ctx)).extraction.lastRun?.status === "skipped");
  assert.equal(llm.calls.length, 0);
  const snapshot = await status(ctx);
  assert.equal(snapshot.extraction.lastRun.reason, "no_signal");

  // A pass that saved nothing is still a finished pass: the turn card has to
  // see that so it can stop waiting instead of polling forever.
  const activity = await postRoute(ctx, "/api/fact-memory/activity", { sessionId: session.id, seq: events.length, limit: 3 });
  assert.equal(activity.lastRun, null);
  assert.equal(activity.extraction.running, false);
  assert.ok(activity.extraction.settledSeq >= events.length, "the settled seq covers the triggering turn");
});

test("signal-free text is kept and read by the model once the fallback turns run out", async () => {
  const llm = scriptedLlm([JSON.stringify({ facts: [] })]);
  const { ctx } = boot({ llm });
  const events = [userEvent("m1", "我们用的是 8123"), assistantEvent("好")];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  // The provider comes from the agent's own model selection, so a pass with no
  // pre-step has nobody to ask; register it the way a real turn would.
  await ctx.__preStep()[0](
    { agent: { id: session.id }, messages: [], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
    async () => ({ kind: "enter", messages: [] }),
  );
  ctx.__sessionEvent(session, turnEnd(1, events.length));
  await until(async () => (await status(ctx)).extraction.lastRun?.status === "skipped");
  assert.equal(llm.calls.length, 0, "the first signal-free turn is deferred, not sent");

  events.push(userEvent("m2", "这台机器跑得还行"), assistantEvent("嗯"));
  const secondSeq = session.seq;
  ctx.__sessionEvent(session, turnEnd(2, secondSeq));
  await until(async () => (await status(ctx)).extraction.lastRun?.snapshot?.toSeq === secondSeq);
  assert.equal(llm.calls.length, 0, "the second one still waits");

  // The third pass is the safety net: the model finally reads the whole stretch
  // instead of the words being dropped for lacking a magic word.
  events.push(userEvent("m3", "今天先这样"), assistantEvent("好"));
  const thirdSeq = session.seq;
  ctx.__sessionEvent(session, turnEnd(3, thirdSeq));
  await until(async () => llm.calls.length > 0);
  assert.match(llm.calls[0].messages[0].content[0].text, /8123/);
});

test("after three failures the range becomes a pending item and the cursor advances", async () => {
  const failing = {
    calls: 0,
    stream() {
      this.calls += 1;
      return (async function* broken() {
        yield { type: "finish", reason: { kind: "error", failure: { message: "connection reset" } } };
      })();
    },
  };
  const { ctx, dataDir } = boot({ llm: failing });
  const events = [userEvent("m1", "记住：e2e 服务的端口是 9911"), assistantEvent("好")];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  await ctx.__preStep()[0](
    { agent: { id: session.id }, messages: [], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
    async () => ({ kind: "enter", messages: [] }),
  );
  // createExtraction fails before the cursor moves; the retry is a new trigger.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    ctx.__sessionEvent(session, turnEnd(attempt + 1, session.seq));
    await wait(60);
  }
  const store = MemoryStore.open({ dataDir });
  const pending = store.pending({ status: "waiting" });
  assert.equal(pending.length, 1);
  assert.match(pending[0].reason, /auto_extract_failed/);
  assert.equal(store.cursor("session", session.id).next_seq, 2);
  store.close();
});

test("the manual route extracts a pasted text through the same validation", async () => {
  const llm = scriptedLlm([
    JSON.stringify({
      facts: [
        { entity: "aml", predicate: "端口", value: "7803", confidence: 0.9, quote: "aml 的端口是 7803" },
        { entity: "aml", predicate: "端口", value: "7801", confidence: 0.9, quote: "这句话原文里没有" },
      ],
    }),
  ]);
  const { ctx } = boot({ llm });
  ctx.__agent("sess-manual");
  await ctx.__preStep()[0](
    { agent: { id: "sess-manual" }, messages: [], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
    async () => ({ kind: "enter", messages: [] }),
  );
  const payload = await postRoute(ctx, "/api/fact-memory/extract", { text: "记住：aml 的端口是 7803" });
  assert.equal(payload.ok, true);
  assert.equal(payload.status, "ok");
  assert.equal(payload.saved, 1);
  assert.equal(payload.rejected, 1);
});

test("two turns in one session run FIFO: no overlap, second sees only its own text", async () => {
  const llm = slowLlm([JSON.stringify({ facts: [] }), JSON.stringify({ facts: [] })], 80);
  const { ctx } = boot({ llm });
  const events = [userEvent("m1", "记住：e2e 服务的端口是 9911"), assistantEvent("好")];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  await ctx.__preStep()[0](
    { agent: { id: session.id }, messages: [], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
    async () => ({ kind: "enter", messages: [] }),
  );
  ctx.__sessionEvent(session, turnEnd(1, events.length));
  events.push(userEvent("m2", "以后都用 pnpm 装依赖"), assistantEvent("好"));
  ctx.__sessionEvent(session, turnEnd(2, events.length));

  await until(async () => {
    const snapshot = await status(ctx);
    return llm.calls.length === 2 && snapshot.extraction.running === 0 && snapshot.extraction.queued === 0;
  });
  assert.equal(llm.maxConcurrent, 1, "a session must not run two passes at once");
  assert.match(llm.calls[0].messages[0].content[0].text, /9911/);
  assert.match(llm.calls[1].messages[0].content[0].text, /pnpm/);
  assert.doesNotMatch(llm.calls[1].messages[0].content[0].text, /9911/);
});

test("different sessions are allowed to run in parallel", async () => {
  const llm = slowLlm([JSON.stringify({ facts: [] }), JSON.stringify({ facts: [] })], 80);
  const { ctx } = boot({ llm });
  const eventsA = [userEvent("a1", "记住：alpha 的端口是 7001"), assistantEvent("好")];
  const eventsB = [userEvent("b1", "记住：beta 的端口是 7002"), assistantEvent("好")];
  const sessionA = fakeSession(eventsA);
  const sessionB = fakeSession(eventsB);
  sessionA.id = "sess-a";
  sessionB.id = "sess-b";
  for (const session of [sessionA, sessionB]) {
    ctx.__agent(session.id);
    await ctx.__preStep()[0](
      { agent: { id: session.id }, messages: [], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
      async () => ({ kind: "enter", messages: [] }),
    );
    ctx.__sessionEvent(session, turnEnd(1, session.seq));
  }
  await until(() => llm.calls.length === 2);
  assert.equal(llm.maxConcurrent, 2, "sessions must not serialise against each other");
});

test("disposing an agent flushes a pass that is still waiting on the delay", async () => {
  const llm = scriptedLlm([JSON.stringify({ facts: [] })]);
  const { ctx } = boot({ llm, overrides: { extractDelayMs: 60_000 } });
  const events = [userEvent("m1", "记住：e2e 服务的端口是 9911"), assistantEvent("好")];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  await ctx.__preStep()[0](
    { agent: { id: session.id }, messages: [], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
    async () => ({ kind: "enter", messages: [] }),
  );
  ctx.__sessionEvent(session, turnEnd(1, events.length));
  ctx.__agentDisposed(session.id);
  await until(() => llm.calls.length === 1);
});

// ── custom endpoint ─────────────────────────────────────────────────────

test("a custom endpoint that streams anyway still yields its text", async () => {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"facts"' } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ":[]}" } }] })}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const text = await callCustomText(
      { baseUrl: `http://127.0.0.1:${port}/v1`, model: "small", apiKeyEnv: "" },
      { system: "s", prompt: "p", timeoutMs: 5000 },
    );
    assert.equal(text, '{"facts":[]}');
  } finally {
    server.close();
  }
});

test("the custom endpoint is called with JSON mode and its text comes back", async () => {
  let seen = null;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen = JSON.parse(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: '{"facts":[]}' } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const text = await callCustomText(
      { baseUrl: `http://127.0.0.1:${port}/v1`, model: "small", apiKeyEnv: "" },
      { system: "s", prompt: "p", timeoutMs: 5000 },
    );
    assert.equal(text, '{"facts":[]}');
    assert.equal(seen.model, "small");
    assert.equal(seen.temperature, 0);
    assert.deepEqual(seen.response_format, { type: "json_object" });
    assert.equal(seen.messages[0].role, "system");
  } finally {
    server.close();
  }
});

test("one oversized message is cut at the chunk budget instead of becoming one huge prompt", () => {
  const huge = "记住：" + "x".repeat(5000);
  const chunks = packChunks([{ seq: 1, text: huge }], { maxChars: 1000 });
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].text.length <= 1000, `chunk was ${chunks[0].text.length} chars`);
  assert.match(chunks[0].text, /已截断/);
});

test("merging chunks folds duplicates and reports value collisions", () => {
  const base = (value, chunk, confidence = 0.8) => ({
    entity: { name: "svc", type: "service" },
    predicate: "端口",
    value,
    cardinality: "single",
    qualifiers: {},
    scope: "global",
    confidence,
    quote: `svc 端口 ${value}`,
    sources: [chunk],
  });
  const merged = mergeCandidates([base("8080", 0, 0.6), base("8080", 1, 0.9), base("9090", 1)]);
  assert.equal(merged.candidates.length, 2);
  assert.equal(merged.duplicates, 1);
  assert.equal(merged.collisions.length, 1);
  const first = merged.candidates.find((candidate) => candidate.value === "8080");
  assert.deepEqual(first.sources, [0, 1]);
  assert.equal(first.confidence, 0.9);
  assert.equal(first.quotes.length, 1);
});

test("a merge answer may not invent a value outside the candidates it cites", () => {
  const candidates = [
    { entity: { name: "svc", type: "service" }, predicate: "端口", value: "8080", cardinality: "single", qualifiers: {}, confidence: 0.8, sources: [0], quotes: [] },
  ];
  const invented = parseMerge(JSON.stringify({ facts: [{ entity: "svc", predicate: "端口", value: "9999", sources: [0] }] }), candidates);
  assert.equal(invented.ok, false);
  const outOfRange = parseMerge(JSON.stringify({ facts: [{ entity: "svc", predicate: "端口", value: "8080", sources: [3] }] }), candidates);
  assert.equal(outOfRange.ok, false);
  const good = parseMerge(JSON.stringify({ facts: [{ entity: "svc", predicate: "端口", value: "8080", sources: [0], confidence: 0.7 }] }), candidates);
  assert.equal(good.ok, true);
  assert.equal(good.candidates[0].value, "8080");
  // A bare array is documented as acceptable; it must not crash on `parsed.facts`.
  const bare = parseMerge(JSON.stringify([{ entity: "svc", predicate: "端口", value: "8080", sources: [0] }]), candidates);
  assert.equal(bare.ok, true);
  // The strict schema must require sources: without them the merge is unusable.
  assert.deepEqual(MERGE_SCHEMA.properties.facts.items.required, ["entity", "predicate", "value", "sources"]);
});

test("one pass covers two chunks, applies once, and advances past both", async () => {
  const llm = scriptedLlm([
    JSON.stringify({ facts: [{ entity: "alpha", entityType: "project", predicate: "端口", value: "7001", cardinality: "single", confidence: 0.9, quote: "alpha 的端口是 7001" }] }),
    JSON.stringify({ facts: [{ entity: "beta", entityType: "project", predicate: "端口", value: "7002", cardinality: "single", confidence: 0.9, quote: "beta 的端口是 7002" }] }),
  ]);
  const { ctx, dataDir } = boot({ llm, overrides: { extractMaxChars: 500, extractChunksPerPass: 2 } });
  const pad = "说明文字".repeat(160);
  const events = [
    userEvent("m1", `记住：alpha 的端口是 7001。${pad}`),
    userEvent("m2", `记住：beta 的端口是 7002。${pad}`),
  ];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  await ctx.__preStep()[0](
    { agent: { id: session.id }, messages: [], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
    async () => ({ kind: "enter", messages: [] }),
  );
  ctx.__sessionEvent(session, turnEnd(2, 2));
  await until(async () => (await status(ctx)).extraction.lastRun?.status === "ok");

  assert.equal(llm.calls.length, 2, "one model call per chunk");
  assert.equal((await status(ctx)).extraction.lastRun.snapshot.chunks, 2);
  const store = MemoryStore.open({ dataDir });
  const rows = store.db.prepare("SELECT value_text FROM facts WHERE status = 'active' ORDER BY value_text").all();
  assert.deepEqual(rows.map((row) => row.value_text), ["7001", "7002"]);
  assert.equal(store.cursor("session", session.id).next_seq, 2);
  store.close();
});


test("a model merge runs on duplicated chunks and reports modelMerged", async () => {
  const first = JSON.stringify({
    facts: [
      { entity: "alpha", entityType: "project", predicate: "端口", value: "7001", cardinality: "single", confidence: 0.9, quote: "alpha 的端口是 7001" },
      { entity: "beta", entityType: "project", predicate: "端口", value: "7002", cardinality: "single", confidence: 0.9, quote: "beta 的端口是 7002" },
    ],
  });
  const second = JSON.stringify({
    facts: [{ entity: "alpha", entityType: "project", predicate: "端口", value: "7001", cardinality: "single", confidence: 0.9, quote: "alpha 的端口是 7001" }],
  });
  const merge = JSON.stringify({
    facts: [
      { entity: "alpha", predicate: "端口", value: "7001", sources: [0], confidence: 0.9 },
      { entity: "beta", predicate: "端口", value: "7002", sources: [1], confidence: 0.9 },
    ],
  });
  const llm = scriptedLlm([first, second, merge]);
  const { ctx, dataDir } = boot({ llm, overrides: { extractMaxChars: 500, extractChunksPerPass: 2, extractMerge: true } });
  const pad = "说明文字".repeat(160);
  const events = [
    userEvent("m1", `记住：alpha 的端口是 7001，beta 的端口是 7002。${pad}`),
    userEvent("m2", `记住：alpha 的端口是 7001。${pad}`),
  ];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  await ctx.__preStep()[0](
    { agent: { id: session.id }, messages: [], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
    async () => ({ kind: "enter", messages: [] }),
  );
  ctx.__sessionEvent(session, turnEnd(2, 2));
  await until(async () => (await status(ctx)).extraction.lastRun?.status === "ok");
  assert.equal(llm.calls.length, 3, "two extraction calls plus one merge call");
  assert.equal((await status(ctx)).extraction.lastRun.modelMerged, true, "the merge answer must be the one applied");
  const store = MemoryStore.open({ dataDir });
  const rows = store.db.prepare("SELECT value_text FROM facts WHERE status = 'active' ORDER BY value_text").all();
  assert.deepEqual(rows.map((row) => row.value_text), ["7001", "7002"]);
  store.close();
  ctx.__dispose();
});

test("a signal in one chunk does not drop the signal-free chunks of the same range", async () => {
  const llm = scriptedLlm([
    JSON.stringify({ facts: [{ entity: "alpha", entityType: "project", predicate: "端口", value: "7001", cardinality: "single", confidence: 0.9, quote: "alpha 的端口是 7001" }] }),
    JSON.stringify({ facts: [{ entity: "beta", entityType: "project", predicate: "端口", value: "7002", cardinality: "single", confidence: 0.9, quote: "beta 用的是 7002" }] }),
  ]);
  const { ctx, dataDir } = boot({ llm, overrides: { extractMaxChars: 500, extractChunksPerPass: 2 } });
  const pad = "说明文字".repeat(60);
  const events = [
    userEvent("m1", `记住：alpha 的端口是 7001。${pad}`),
    userEvent("m2", `beta 用的是 7002。${pad}`),
  ];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  await ctx.__preStep()[0](
    { agent: { id: session.id }, messages: [], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
    async () => ({ kind: "enter", messages: [] }),
  );
  ctx.__sessionEvent(session, turnEnd(2, 2));
  await until(async () => (await status(ctx)).extraction.lastRun?.status === "ok");

  assert.equal(llm.calls.length, 2, "the whole range is read once a signal is found");
  const store = MemoryStore.open({ dataDir });
  const rows = store.db.prepare("SELECT value_text FROM facts WHERE status = 'active' ORDER BY value_text").all();
  assert.deepEqual(rows.map((row) => row.value_text), ["7001", "7002"]);
  store.close();
  ctx.__dispose();
});

test("with thinking off the host is asked for the cheapest effort and falls back when refused", async () => {
  const calls = [];
  let attempt = 0;
  const llm = {
    stream(options) {
      calls.push(options);
      attempt += 1;
      const refuse = attempt === 1;
      return (async function* streamed() {
        if (refuse) {
          const error = new Error("reasoning effort unsupported");
          error.code = "UNSUPPORTED_REASONING_EFFORT";
          throw error;
        }
        yield { type: "text-delta", text: JSON.stringify({ facts: [{ entity: "svc", entityType: "service", predicate: "端口", value: "6001", cardinality: "single", confidence: 0.9, quote: "svc 端口 6001" }] }) };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    },
  };
  const { ctx, dataDir } = boot({ llm, overrides: { extractThinking: false } });
  const events = [userEvent("m1", "记住：svc 端口 6001"), assistantEvent("好")];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  await ctx.__preStep()[0](
    { agent: { id: session.id }, messages: [], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
    async () => ({ kind: "enter", messages: [] }),
  );
  ctx.__sessionEvent(session, turnEnd(1, events.length));
  await until(async () => (await status(ctx)).extraction.lastRun?.status === "ok");

  assert.equal(calls[0].reasoningEffort, "none");
  assert.equal(calls[1].reasoningEffort, "off");
  const store = MemoryStore.open({ dataDir });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE status='active'").get().n, 1);
  store.close();
});

test("a custom endpoint is told not to think and retried without that field when rejected", async () => {
  const bodies = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const parsed = JSON.parse(body);
      bodies.push(parsed);
      if (parsed.enable_thinking !== undefined || parsed.reasoning_effort !== undefined) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "unknown field enable_thinking" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: '{"facts":[]}' } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const text = await callCustomText(
      { baseUrl: `http://127.0.0.1:${port}/v1`, model: "small", apiKeyEnv: "" },
      { system: "s", prompt: "p", timeoutMs: 5000, thinking: false },
    );
    assert.equal(text, '{"facts":[]}');
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].enable_thinking, false);
    assert.equal(bodies[0].reasoning_effort, "none");
    assert.equal(bodies[1].enable_thinking, undefined);
  } finally {
    server.close();
  }
});

test("splitting a long text keeps every character and stays under the budget", () => {
  const text = `${"甲".repeat(300)}。${"乙".repeat(300)}。${"丙".repeat(300)}。`;
  const parts = splitText(text, 350);
  assert.ok(parts.length >= 3);
  assert.equal(parts.join(""), text);
  assert.ok(parts.every((part) => part.length <= 350));
});

test("an unusable answer gets exactly one repair call before the range is marked invalid", async () => {
  const llm = scriptedLlm([
    "我抽到了两条事实：svc 的端口是 6101。",
    JSON.stringify({ facts: [{ entity: "svc", entityType: "service", predicate: "端口", value: "6101", cardinality: "single", confidence: 0.9, quote: "svc 的端口是 6101" }] }),
  ]);
  const { ctx, dataDir } = boot({ llm });
  const events = [userEvent("m1", "记住：svc 的端口是 6101"), assistantEvent("好")];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  await ctx.__preStep()[0](
    { agent: { id: session.id }, messages: [], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
    async () => ({ kind: "enter", messages: [] }),
  );
  ctx.__sessionEvent(session, turnEnd(1, events.length));
  await until(async () => (await status(ctx)).extraction.lastRun?.status === "ok");
  assert.equal(llm.calls.length, 2, "one extraction call plus one repair");
  assert.match(llm.calls[1].messages[0].content[0].text, /不是约定的 JSON 对象/);
  const store = MemoryStore.open({ dataDir });
  assert.equal(store.db.prepare("SELECT value_text FROM facts WHERE status='active'").get().value_text, "6101");
  store.close();
});

test("the queue page still lists the last ten passes after a restart", async () => {
  // The queue page is read when the user suspects the plugin is dead — usually
  // right after a restart. The list therefore has to come from the store, not
  // from the in-memory counters that the restart just wiped.
  const dataDir = tempDir();
  const seed = MemoryStore.open({ dataDir });
  for (let index = 0; index < 12; index += 1) {
    seed.recordExtractRun({
      sessionId: `s-${index}`,
      sessionTitle: `会话 ${index}`,
      status: index === 11 ? "skipped" : "ok",
      reason: index === 11 ? "no_candidates" : "",
      saved: index,
      toSeq: index * 10,
      durationMs: 1200,
      at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    });
  }
  seed.close();

  const { ctx } = boot({ dataDir });
  const queue = await postRoute(ctx, "/api/fact-memory/queue", {});
  assert.equal(queue.ok, true);
  assert.equal(queue.recent.length, 10, "ten persisted rows, not an empty page");
  assert.equal(queue.recent[0].sessionId, "s-11", "newest first");
  assert.equal(queue.recent[0].state, "skipped");
  assert.equal(queue.recent[0].reason, "no_candidates");
  assert.equal(queue.recent[0].title, "会话 11", "the title survives the restart too");
  assert.equal(queue.recent[0].durationMs, 1200);
  assert.equal(queue.recent[9].sessionId, "s-2");
  ctx.__dispose();
});

test("the extraction prompt reuses the subjects that already exist", () => {
  const prompt = buildExtractPrompt({ text: "端口从 7801 改成 7802", knownEntities: ["支付服务", "  ", "支付服务", "订单服务"] });
  assert.match(prompt, /【已经记过的主体/);
  assert.equal((prompt.match(/支付服务/g) ?? []).length, 1, "a repeated known name is listed once");
  assert.equal((prompt.match(/订单服务/g) ?? []).length, 1);
  assert.equal(buildExtractPrompt({ text: "端口从 7801 改成 7802" }).includes("已经记过"), false, "no hint when nothing is known");
  const many = Array.from({ length: 100 }, (_, index) => `服务${index}`);
  const capped = buildExtractPrompt({ text: "x", knownEntities: many });
  assert.ok((capped.match(/服务\d+/g) ?? []).length <= 40, "the hint list is capped");
});

test("autoExtract with no usable model does not silence the rule path", async () => {
  const { ctx, dataDir } = boot({ overrides: { autoCapture: true, autoExtract: true } });
  ctx.__agent("session-1");
  await ctx.__preStep()[0](
    {
      agent: { id: "session-1" },
      messages: [{ id: "m1", source: { kind: "user" }, content: [{ type: "text", text: "e2e 服务的端口是 9911" }] }],
      step: 1,
    },
    async () => ({ kind: "enter", messages: [] }),
  );
  const store = MemoryStore.open({ dataDir });
  const rows = store.db.prepare("SELECT value_text FROM facts WHERE status = 'active'").all();
  assert.equal(rows.length, 1, "a switch without a model must not lose the sentence");
  assert.equal(rows[0].value_text, "9911");
  store.close();
  ctx.__dispose();
});

// ── a schema verdict is not a failed pass ────────────────────────────────
// The model answered, every field was there and the quote was verbatim; the
// ledger's own shape gate refused the property name. Retrying that range cannot
// change the verdict, and doing it anyway is what kept the queue badge on 1 with
// the cursor frozen behind the refused text.
test("a candidate the shape gate refuses is consumed, not retried forever", async () => {
  const refused = JSON.stringify({
    facts: [
      {
        entity: "事实记忆插件",
        entityType: "project",
        // "修复" is still a change event: it reports what a commit did. The state
        // form of the same verb ("上线状态") is a property and is covered below.
        predicate: "修复",
        value: "2026-11-13 正式开始上线使用",
        cardinality: "single",
        confidence: 0.9,
        quote: "事实记忆插件经过多轮开发",
      },
    ],
  });
  // One refused pass spends two calls: the answer, then the repair attempt.
  const llm = scriptedLlm([refused, refused]);
  const { ctx, dataDir } = boot({ llm });
  const events = [
    userEvent("m1", "记住：事实记忆插件经过多轮开发、调试、测试，于今天正式开始上线使用。"),
    assistantEvent("记下了。"),
  ];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  await ctx.__preStep()[0](
    { agent: { id: session.id }, messages: [], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
    async () => ({ kind: "enter", messages: [] }),
  );
  ctx.__sessionEvent(session, events[1]);
  ctx.__sessionEvent(session, turnEnd(1, events.length));

  const run = await until(async () => {
    const queue = await postRoute(ctx, "/api/fact-memory/queue", {});
    return (queue.recent ?? []).find((row) => row.sessionId === session.id && row.seq === events.length) ?? null;
  });
  assert.equal(run.state, "skipped", "a shape refusal is a decision about the text, not a failed pass");
  assert.equal(run.reason, "policy_rejected");

  const queue = await postRoute(ctx, "/api/fact-memory/queue", {});
  assert.equal(queue.totals.retrying, 0, "no retry is armed for text the same model will refuse again");
  assert.equal(queue.totals.active, 0, "and nothing looks in flight on the queue tab");

  const detail = await postRoute(ctx, "/api/fact-memory/extract-run", { id: run.id });
  assert.equal(detail.ok, true);
  assert.deepEqual(
    detail.run.rejected,
    [{ reason: "predicate_is_change_event", count: 1 }],
    "the reason the scope refused it is still readable",
  );

  const store = MemoryStore.open({ dataDir });
  assert.equal(store.cursor("session", session.id).next_seq, events.length, "the refused range sits behind the cursor");
  store.close();
  ctx.__dispose();
});

// The compound form is the fact the changelog was standing in for: a pass that finds
// it must store it instead of refusing the answer as a change event.
test("a state property is stored, not refused as a change event", async () => {
  const answer = JSON.stringify({
    facts: [
      {
        entity: "dsh-fact-memory",
        entityType: "project",
        predicate: "上线状态",
        value: "2026-11-13 正式开始上线使用",
        cardinality: "single",
        confidence: 0.9,
        quote: "于今天正式开始上线使用",
      },
    ],
  });
  const llm = scriptedLlm([answer]);
  const { ctx } = boot({ llm });
  const events = [
    userEvent("m1", "记住：事实记忆插件经过多轮开发、调试、测试，于今天正式开始上线使用。"),
    assistantEvent("记下了。"),
  ];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  await ctx.__preStep()[0](
    { agent: { id: session.id }, messages: [], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
    async () => ({ kind: "enter", messages: [] }),
  );
  ctx.__sessionEvent(session, events[1]);
  ctx.__sessionEvent(session, turnEnd(1, events.length));

  const run = await until(async () => {
    const queue = await postRoute(ctx, "/api/fact-memory/queue", {});
    return (queue.recent ?? []).find((row) => row.sessionId === session.id && row.seq === events.length) ?? null;
  });
  assert.equal(run.state, "ok", "the candidate is a property, so the pass succeeds");
  assert.equal(run.saved, 1);
  const facts = await postRoute(ctx, "/api/fact-memory/facts", { query: "dsh-fact-memory", limit: 5 });
  assert.ok(
    (facts.items ?? []).some((fact) => fact.predicate === "上线状态"),
    "the state reaches the library instead of dying on the gate",
  );
  ctx.__dispose();
});

test("a fabricated quote is still a model failure and still retries", async () => {
  const bad = JSON.stringify({
    facts: [{ entity: "e2e", predicate: "端口", value: "9911", confidence: 0.9, quote: "这句原文里根本没有" }],
  });
  const llm = scriptedLlm([bad, bad]);
  const { ctx } = boot({ llm });
  const events = [userEvent("m1", "记住：e2e 服务的端口是 9911"), assistantEvent("好的")];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  await ctx.__preStep()[0](
    { agent: { id: session.id }, messages: [], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
    async () => ({ kind: "enter", messages: [] }),
  );
  ctx.__sessionEvent(session, events[1]);
  ctx.__sessionEvent(session, turnEnd(1, events.length));
  const run = await until(async () => {
    const queue = await postRoute(ctx, "/api/fact-memory/queue", {});
    return (queue.recent ?? []).find((row) => row.sessionId === session.id && row.seq === events.length) ?? null;
  });
  assert.equal(run.state, "invalid", "an unverifiable answer is not a verdict about the text");
  const queue = await postRoute(ctx, "/api/fact-memory/queue", {});
  assert.equal(queue.totals.retrying, 1, "a genuine model failure still waits out its retry");
  ctx.__dispose();
});

// ── a turn the assistant classified itself ───────────────────────────────
// memory_write already decided what this turn was worth keeping, so asking a second
// model about the same text is how the library ends up with two spellings of one
// fact — the near-identical pair the user then sees twice.
test("a turn the tool wrote into is consumed without a second model pass", async () => {
  // The only scripted answer is for the *second* turn: the first turn must never
  // reach the model at all, so the answer at index 0 is the one turn two consumes.
  const llm = scriptedLlm([
    JSON.stringify({
      facts: [
        {
          entity: "e2e-2",
          entityType: "service",
          predicate: "端口",
          value: "7801",
          cardinality: "single",
          confidence: 0.9,
          quote: "另一个端口是 7801",
        },
      ],
    }),
  ]);
  const { ctx, dataDir } = boot({ llm });
  const events = [userEvent("m1", "记住：e2e 服务的端口是 9911")];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  await ctx.__preStep()[0](
    { agent: { id: session.id }, messages: [events[0].data], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
    async () => ({ kind: "enter", messages: [events[0].data] }),
  );
  // The assistant stores the triple itself, then finishes the turn.
  const write = ctx.__tools.get("memory_write");
  const receipt = await write.execute({ entity: "事实记忆插件", predicate: "环境", value: "生产" }, { agent: { session } });
  assert.equal(receipt.outcome, "saved");
  events.push(assistantEvent("好的，已记下。"));
  ctx.__sessionEvent(session, events[1]);
  const turnSeq = events.length;
  ctx.__sessionEvent(session, turnEnd(1, turnSeq));

  const snapshot = await until(async () => {
    const value = await status(ctx);
    return value.extraction.lastRun?.reason === "manual_capture" ? value : null;
  });
  assert.equal(snapshot.extraction.lastRun.status, "skipped");
  assert.equal(llm.calls.length, 0, "the model is never asked about a turn the assistant already stored");
  assert.equal(
    MemoryStore.open({ dataDir }).cursor("session", session.id).next_seq,
    turnSeq,
    "the turn is consumed, so no later pass can re-read it",
  );

  // The card still reports what the turn kept; the count comes from the tool.
  const activity = await postRoute(ctx, "/api/fact-memory/activity", { sessionId: session.id, seq: turnSeq, limit: 3 });
  assert.equal(activity.lastRun?.status, "manual_capture");
  assert.equal(activity.lastRun?.saved, 1);
  assert.equal(activity.lastRun?.toSeq, turnSeq);
  assert.equal(activity.extraction.lastStatus, "manual_capture");

  // One shot: a turn with no tool write goes back to the normal pass.
  events.push(userEvent("m2", "记住：另一个端口是 7801"), assistantEvent("好"));
  ctx.__sessionEvent(session, turnEnd(2, session.seq));
  const second = await until(async () => {
    const value = await status(ctx);
    return value.extraction.lastRun?.snapshot?.toSeq === session.seq ? value : null;
  });
  assert.equal(llm.calls.length, 1, "the next turn goes back to the model");
  assert.equal(second.extraction.lastRun.saved, 1, "and the pass writes what it finds");
  ctx.__dispose();
});

// ── the turn card for a fact written through the tool ────────────────────
test("a fact written by the tool still gets its turn card", async () => {
  const accepted = JSON.stringify({
    facts: [
      {
        entity: "e2e",
        entityType: "service",
        predicate: "端口",
        value: "9911",
        cardinality: "single",
        confidence: 0.9,
        quote: "e2e 服务的端口是 9911",
      },
    ],
  });
  const llm = scriptedLlm([accepted]);
  const { ctx } = boot({ llm });
  const events = [userEvent("m1", "记住：e2e 服务的端口是 9911"), assistantEvent("好的")];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  await ctx.__preStep()[0](
    { agent: { id: session.id }, messages: [], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
    async () => ({ kind: "enter", messages: [] }),
  );
  ctx.__sessionEvent(session, events[1]);
  ctx.__sessionEvent(session, turnEnd(1, events.length));
  await until(async () => (await status(ctx)).extraction.lastRun?.status === "ok");

  // The next turn writes its fact through the tool after many messages, so no pass
  // has run over this turn and there is no summary for it at all. The session's
  // *latest* run is the previous turn's pass — returning that unconditionally is
  // what made the card compare two distant seqs and draw nothing.
  for (let index = 0; index < 38; index += 1) events.push(assistantEvent("调用工具"));
  const write = ctx.__tools.get("memory_write");
  const receipt = await write.execute({ entity: "事实记忆插件", predicate: "环境", value: "生产" }, { agent: { session } });
  assert.equal(receipt.outcome, "saved");

  const turnSeq = session.seq;
  const activity = await postRoute(ctx, "/api/fact-memory/activity", { sessionId: session.id, seq: turnSeq, limit: 3 });
  assert.equal(activity.lastRun?.status, "derived", "the card is derived from the facts this turn wrote");
  assert.equal(activity.lastRun?.toSeq, turnSeq, "and is anchored to this turn so the card accepts it");
  assert.equal(activity.lastRun?.saved, 1);
  ctx.__dispose();
});
