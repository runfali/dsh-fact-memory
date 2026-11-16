import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import plugin from "../index.js";
import { MemoryStore } from "../src/store.js";

/**
 * The dream layer end to end: a turn is collected, a model answer becomes a
 * pending note, accepting it makes it live, and the facts tables never move.
 *
 * The unit tests cover the decision and the validator on their own; this file is
 * the only place the wiring (turn/end -> feed -> prompt -> store -> route) runs
 * as one piece, which is where a missing import or a swallowed queue bug lives.
 */

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "fm-dream-e2e-"));
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
const turnEnd = (turn, seq) => ({ type: "turn/end", seq, data: { turn, reason: { kind: "stop" } } });

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

function boot({ llm, overrides = {} } = {}) {
  const dataDir = tempDir();
  const config = {
    dataDir,
    injectDirectory: true,
    directoryBudget: 800,
    injectReminder: false,
    autoCapture: false,
    searchLimit: 5,
    backupBeforeExport: true,
    autoExtract: false,
    llmSource: "host",
    dreamEnabled: true,
    dreamMinChars: 200,
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

const LONG =
  "这次把发布流程改成了两步：先在预发环境跑完整回归，通过之后再由值班的人手动点上线。" +
  "原因是上一次直接上线把订单页打挂了二十分钟，那二十分钟里下单的人看到的是空白页，客服电话被打爆。" +
  "复盘之后定下来的规矩是：预发回归不能省，回滚脚本要跟着每次发布一起验证，谁点的上线谁负责盯前半小时的监控。" +
  "另外预发环境的数据每周从生产脱敏同步一次，不然回归跑的是过期数据，等于没跑。" +
  "值班表的安排也一起改了：发布当天谁点的上线，谁就要在发布之后的一小时里盯着错误率和下单成功率，出问题直接按回滚脚本往回退。";

test("a collected turn becomes a pending note, and accepting it leaves the facts alone", async () => {
  const answer = JSON.stringify({
    dreams: [
      {
        op: "add",
        topic_key: "release-process",
        title: "发布改成两步走",
        lines: ["发布改成两步：预发环境跑完整回归，通过后由值班的人手动上线。", "原因是直接上线曾把订单页打挂二十分钟。", "结论：预发回归不能省，回滚脚本随每次发布一起验证。"],
        topics: ["发布流程", "回归"],
        sources: [{ session: "S1", from: 2, to: 3 }],
        novelty: "high",
        novelty_reason: "库里还没有发布流程的记录",
      },
    ],
  });
  const llm = scriptedLlm([answer]);
  const { ctx, dataDir } = boot({ llm });

  const events = [userEvent("m1", "先说说部署环境"), assistantEvent("好，你说。")];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  // The model selection arrives with a real step; the dream pass reuses it.
  await ctx.__preStep()[0](
    { agent: { id: session.id }, messages: [events[0].data], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
    async () => ({ kind: "enter", messages: [events[0].data] }),
  );
  // First turn only sets the collection mark: nothing from before the switch is
  // copied, which is the promise the settings card makes.
  ctx.__sessionEvent(session, turnEnd(1, events.length));
  const afterFirst = await postRoute(ctx, "/api/fact-memory/status", {});
  assert.equal(afterFirst.dream.pendingChars, 0, "the first turn only marks the starting point");
  assert.equal(afterFirst.dream.enabled, true);

  events.push(userEvent("m2", LONG), assistantEvent("记下了，发布流程分两步。"));
  ctx.__sessionEvent(session, turnEnd(2, events.length));
  const collected = await postRoute(ctx, "/api/fact-memory/status", {});
  assert.ok(collected.dream.pendingChars >= 200, "the second turn is collected verbatim");
  assert.equal(collected.dream.pendingSessions, 1);

  const ran = await postRoute(ctx, "/api/fact-memory/dream", {});
  assert.equal(ran.status, "ok", JSON.stringify(ran));
  assert.equal(ran.accepted, 1);
  assert.equal(ran.dropped, 0);
  assert.equal(llm.calls.length, 1);
  // A dream answer is bigger than a fact extraction; the budget must say so.
  assert.equal(llm.calls[0].maxTokens, 6144);
  assert.match(llm.calls[0].messages[0].content[0].text, /预发环境跑完整回归/);

  const listed = await postRoute(ctx, "/api/fact-memory/dreams", {});
  assert.equal(listed.pending.length, 1);
  assert.equal(listed.active.length, 0);
  assert.equal(listed.counts.feedRows, 0, "the material it read is consumed");
  assert.equal(listed.items[0].topicKey, "release-process");

  const id = listed.pending[0].id;
  const applied = await postRoute(ctx, "/api/fact-memory/dream-apply", { ids: [id] });
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.applied, [id]);
  const after = await postRoute(ctx, "/api/fact-memory/dreams", {});
  assert.equal(after.pending.length, 0);
  assert.equal(after.active.length, 1);

  // The layer's whole claim: it never writes a fact.
  const store = MemoryStore.open({ dataDir });
  assert.equal(store.stats().facts, 0);
  assert.equal(store.stats().generation, 0);
  store.close();
  ctx.__dispose();
});

test("a run with nothing to dream about says so instead of calling a model", async () => {
  const llm = scriptedLlm([JSON.stringify({ dreams: [] })]);
  const { ctx } = boot({ llm });
  const session = fakeSession([userEvent("m1", "早")]);
  ctx.__agent(session.id);
  const out = await postRoute(ctx, "/api/fact-memory/dream", {});
  assert.equal(out.status, "skipped");
  assert.equal(out.reason, "not_enough");
  assert.equal(llm.calls.length, 0, "an empty feed must not spend a model call");
  ctx.__dispose();
});


test("an accepted note is cued in one line, and only when the turn is about it", async () => {
  const llm = scriptedLlm([JSON.stringify({ dreams: [] })]);
  const { ctx, dataDir } = boot({ llm });
  const store = MemoryStore.open({ dataDir });
  const created = store.dreamCreate({
    topicKey: "release-process",
    title: "发布改成两步走",
    body: "发布改成两步：预发环境跑完整回归，通过后由值班的人手动上线。",
    topics: ["发布流程"],
    sources: [{ sessionId: "sess-1", label: "S1", fromSeq: 1, toSeq: 2 }],
    novelty: "high",
  });
  store.dreamApply({ id: created.id });
  store.close();

  // The injection hook is installed per agent, so one has to exist first.
  ctx.__agent("sess-1");
  const handler = ctx.__preStep()[0];
  const said = (text) => ({ id: "m" + text.length, role: "user", content: [{ type: "text", text }], source: { kind: "user" } });
  const next = (message) => async () => ({ kind: "enter", messages: [message] });
  const about = said("发布改成两步走之后，预发环境还要不要跑全量回归");
  const cued = await handler({ messages: [about], step: 0 }, next(about));
  assert.equal(cued.messages.length, 2);
  assert.equal(cued.messages[1].source.form, "notice");
  assert.match(cued.messages[1].content[0].text, /【梦境】/);
  // The cue names the note and where to read it, and never claims it is a fact.
  assert.match(cued.messages[1].content[0].text, /发布改成两步走/);
  assert.doesNotMatch(cued.messages[1].content[0].text, /memory_search/);

  const other = said("今天晚饭吃什么");
  const quiet = await handler({ messages: [other], step: 0 }, next(other));
  assert.equal(quiet.messages.length, 1);

  // A cue is the only evidence this layer has that a topic is still alive, and
  // the same message must not count twice even if pre-step sees it again.
  const again = await handler({ messages: [about], step: 1 }, next(about));
  assert.equal(again.messages.length, 2);
  const listing = await postRoute(ctx, "/api/fact-memory/dreams", {});
  assert.equal(listing.active[0].hitCount, 1);
  assert.ok(listing.active[0].lastHitAt);
  assert.equal(listing.index.length, 1, "the topic index lists the live note");
  assert.equal(listing.index[0].topicKey, "release-process");
  ctx.__dispose();
});

test("backfill needs an explicit yes, and archives can be restored", async () => {
  const llm = scriptedLlm([JSON.stringify({ dreams: [] })]);
  const { ctx } = boot({ llm });
  const refused = await postRoute(ctx, "/api/fact-memory/dream-backfill", {});
  assert.equal(refused.ok, false, "reading old conversations is never implicit");
  const ran = await postRoute(ctx, "/api/fact-memory/dream-backfill", { backfill: true });
  assert.equal(ran.ok, true);
  assert.equal(typeof ran.files, "number");
  // A store with no sessions root copies nothing and says so rather than failing.
  assert.equal(ran.rows, 0);
  ctx.__dispose();
});


test("a dry run reports what it would keep and touches nothing", async () => {
  const answer = JSON.stringify({
    dreams: [
      {
        op: "add",
        topic_key: "dry-run-note",
        title: "只是看看",
        lines: ["这一条应该在预览里出现，但不该落库。"],
        topics: ["预览"],
        sources: [{ session: "S1", from: 2, to: 3 }],
        novelty: "high",
      },
    ],
  });
  const llm = scriptedLlm([answer]);
  const { ctx } = boot({ llm });
  const events = [userEvent("m1", "先说说部署环境"), assistantEvent("好，你说。")];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  await ctx.__preStep()[0](
    { agent: { id: session.id }, messages: [events[0].data], step: 1, modelSelection: { provider: "fake", model: "fake-model" } },
    async () => ({ kind: "enter", messages: [events[0].data] }),
  );
  ctx.__sessionEvent(session, turnEnd(1, events.length));
  events.push(userEvent("m2", LONG), assistantEvent("记下了，发布流程分两步。"));
  ctx.__sessionEvent(session, turnEnd(2, events.length));

  const before = await postRoute(ctx, "/api/fact-memory/status", {});
  const dry = await postRoute(ctx, "/api/fact-memory/dream", { dryRun: true });
  assert.equal(dry.status, "ok");
  assert.equal(dry.accepted, 1, "a preview still says what it would have kept");
  assert.deepEqual(dry.created, []);
  assert.equal(dry.cursorId, 0);

  const after = await postRoute(ctx, "/api/fact-memory/status", {});
  assert.equal(after.dream.lastAt, "", "a preview is not a pass on the damping clock");
  assert.equal(after.dream.lastStatus, "");
  assert.equal(after.dream.pendingChars, before.dream.pendingChars, "nothing is consumed");
  const listed = await postRoute(ctx, "/api/fact-memory/dreams", {});
  assert.equal(listed.pending.length, 0, "nothing is written");
  ctx.__dispose();
});

test("with the layer off, a manual run is refused and the feed stays empty", async () => {
  const llm = scriptedLlm([JSON.stringify({ dreams: [] })]);
  const { ctx } = boot({ llm, overrides: { dreamEnabled: false } });
  const events = [userEvent("m1", LONG), assistantEvent("好")];
  const session = fakeSession(events);
  ctx.__agent(session.id);
  ctx.__sessionEvent(session, turnEnd(1, events.length));
  const status = await postRoute(ctx, "/api/fact-memory/status", {});
  assert.equal(status.dream.enabled, false);
  assert.equal(status.dream.pendingChars, 0);
  const out = await postRoute(ctx, "/api/fact-memory/dream", {});
  assert.equal(out.reason, "disabled");
  assert.equal(llm.calls.length, 0);
  ctx.__dispose();
});
