import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import plugin from "../index.js";
import { MemoryStore } from "../src/store.js";
import { budgetChars } from "../src/util.js";

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "fm-apply-"));
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

/**
 * A deliberately thin double of the host context: only the surfaces apply()
 * touches, with the same call shapes the 0.2.2 host uses. Anything missing here
 * that apply() reaches for shows up as a TypeError in a test, which is the point.
 */
function fakeContext(config, credentials) {
  const tools = new Map();
  const contexts = [];
  const listeners = new Map();
  const agentListeners = new Map();
  const routes = [];
  const disposers = [];
  const scoped = {
    connection: {
      fetch: {
        register: (spec) => {
          routes.push(spec);
          return () => {};
        },
      },
    },
    effect: (fn) => {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
      return dispose;
    },
  };
  const ctx = {
    config: { get: () => config },
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    effect: (fn) => {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
      return dispose;
    },
    systemPrompt: {
      context: (spec) => {
        contexts.push(spec);
        return () => {};
      },
      section: () => () => {},
    },
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition);
        return () => {};
      },
    },
    on: (event, handler) => {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {};
    },
    get: (service) => {
      if (service === "agents") return { list: () => [...agents.values()] };
      if (service === "credentials") return credentials;
      return undefined;
    },
    inject: (names, callback) => {
      if (names.includes("connection")) callback(scoped);
    },
    // helpers for the test
    __tools: tools,
    __contexts: contexts,
    /** Create one agent and announce it, as the host does after a session starts. */
    __agent: (id) => {
      const agent = {
        id,
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
    /** The `agent/pre-step` hooks installed for that agent. */
    __preStep: (id) => agentListenersFor(id, agentListeners),
    __routes: routes,
    __dispose: () => {
      for (const dispose of disposers) dispose();
    },
  };
  const agents = new Map();
  return ctx;
}

function agentListenersFor(id, map) {
  void id;
  return map.get("agent/pre-step") ?? [];
}

function boot(overrides = {}) {
  const dataDir = tempDir();
  const ctx = fakeContext({
    dataDir,
    injectDirectory: true,
    directoryBudget: 800,
    injectReminder: true,
    autoCapture: false,
    searchLimit: 5,
    backupBeforeExport: true,
    ...overrides,
  });
  plugin.apply(ctx, ctx.config);
  return { ctx, dataDir };
}

test("apply registers the three tools, the context and the routes", () => {
  const { ctx } = boot();
  assert.deepEqual([...ctx.__tools.keys()].sort(), ["dream_read", "memory_forget", "memory_search", "memory_write"]);
  assert.equal(ctx.__contexts.length, 1);
  assert.equal(ctx.__contexts[0].name, "dsh-fact-memory:directory");
  assert.equal(ctx.__contexts[0].required, true);
  assert.equal(ctx.__contexts[0].interpolate, false);
  assert.deepEqual(
    ctx.__routes.map((route) => route.path).sort(),
    [
      "/api/fact-memory/activity",
      "/api/fact-memory/audit",
      "/api/fact-memory/calibrate",
      "/api/fact-memory/conflicts",
      "/api/fact-memory/consolidate",
      "/api/fact-memory/dream",
      "/api/fact-memory/dream-apply",
      "/api/fact-memory/dream-backfill",
      "/api/fact-memory/dream-edit",
      "/api/fact-memory/dream-reject",
      "/api/fact-memory/dream-restore",
      "/api/fact-memory/dreams",
      "/api/fact-memory/entity",
      "/api/fact-memory/export",
      "/api/fact-memory/extract",
      "/api/fact-memory/extract-retry",
      "/api/fact-memory/extract-run",
      "/api/fact-memory/fact",
      "/api/fact-memory/fact-expire",
      "/api/fact-memory/fact-restore",
      "/api/fact-memory/fact-update",
      "/api/fact-memory/facts",
      "/api/fact-memory/graph",
      "/api/fact-memory/import",
      "/api/fact-memory/index-vectors",
      "/api/fact-memory/key",
      "/api/fact-memory/proposal-apply",
      "/api/fact-memory/proposal-prune",
      "/api/fact-memory/proposal-reject",
      "/api/fact-memory/proposal-revise",
      "/api/fact-memory/proposals",
      "/api/fact-memory/queue",
      "/api/fact-memory/rebuild",
      "/api/fact-memory/resolve",
      "/api/fact-memory/review-seen",
      "/api/fact-memory/sessions",
      "/api/fact-memory/status",
      "/api/fact-memory/wipe",
    ],
  );
  ctx.__dispose();
});

test("the master switch silences the tools and the directory, and writes nothing", async () => {
  const { ctx } = boot({ enabled: false });
  const search = ctx.__tools.get("memory_search");
  const write = ctx.__tools.get("memory_write");
  const forget = ctx.__tools.get("memory_forget");
  assert.equal((await search.execute({ query: "端口" })).outcome, "unavailable");
  assert.equal(
    (await write.execute({ entity: "api", predicate: "端口", value: "8080", cardinality: "single" })).outcome,
    "unavailable",
  );
  assert.equal((await forget.execute({ entity: "api" })).outcome, "unavailable");
  // The directory is a model-facing surface too: a switch that still injects
  // facts into every request is not a master switch.
  assert.equal(ctx.__contexts[0].text(), "");
  ctx.__dispose();
});

test("the queue route reports what the scheduler is holding", async () => {
  const { ctx } = boot();
  const queue = await callRoute(ctx, "/api/fact-memory/queue", {});
  assert.equal(queue.body.ok, true);
  assert.ok(queue.body.at, "the queue carries the read time");
  assert.equal(queue.body.totals.active, 0);
  assert.deepEqual(queue.body.running, []);
  assert.deepEqual(queue.body.waiting, []);
  assert.deepEqual(queue.body.recent, []);
  assert.deepEqual(queue.body.pending, []);
  assert.equal(queue.body.config.enabled, false);
  assert.equal(typeof queue.body.config.delayMs, "number");
  assert.ok("configured" in queue.body.config);
  ctx.__dispose();
});

test("the extraction run route refuses an unknown id in words", async () => {
  const { ctx } = boot();
  const missing = await callRoute(ctx, "/api/fact-memory/extract-run", { id: "nope" });
  assert.equal(missing.body.ok, false);
  assert.match(String(missing.body.error), /没有这条抽取记录/);
  ctx.__dispose();
});

test("the entity route hands back a name, not an entity row", async () => {
  const { ctx } = boot();
  const write = ctx.__tools.get("memory_write");
  await write.execute({ entity: "api", predicate: "端口", value: "8080", cardinality: "single" });
  const detail = await callRoute(ctx, "/api/fact-memory/entity", { entity: "api" });
  assert.equal(detail.body.ok, true);
  // The client renders this field as text; an object here blanks the page once
  // React refuses the child ("Objects are not valid as a React child").
  assert.equal(typeof detail.body.entity, "string");
  assert.equal(detail.body.entity, "api");
  assert.ok(Array.isArray(detail.body.facts) && detail.body.facts.length === 1);
  // The row itself stays available for callers that want the metadata.
  assert.equal(detail.body.entityMeta.name, "api");
  ctx.__dispose();
});

test("wipe empties the library and keeps the settings", async () => {
  const { ctx } = boot({ backupBeforeExport: false });
  const write = ctx.__tools.get("memory_write");
  await write.execute({ entity: "api", predicate: "端口", value: "8080", cardinality: "single" });
  const before = await callRoute(ctx, "/api/fact-memory/status", {});
  assert.ok(before.body.stats.facts > 0, "the library has something to wipe");

  // A POST without the confirm token is refused, so a stray call cannot empty it.
  const refused = await callRoute(ctx, "/api/fact-memory/wipe", {});
  assert.equal(refused.body.ok, false);
  assert.equal((await callRoute(ctx, "/api/fact-memory/status", {})).body.stats.facts, before.body.stats.facts);

  const wiped = await callRoute(ctx, "/api/fact-memory/wipe", { confirm: "wipe" });
  assert.equal(wiped.body.ok, true);
  assert.ok(wiped.body.facts >= 1);
  assert.ok(wiped.body.backupPath && existsSync(wiped.body.backupPath), "a wipe backs the database up first");
  const after = await callRoute(ctx, "/api/fact-memory/status", {});
  assert.equal(after.body.stats.facts, 0);
  assert.equal(after.body.stats.entities, 0);
  // Settings belong to the host, not to the database this route clears.
  assert.equal(ctx.config.get().autoCapture, false);
  ctx.__dispose();
});

test("the health check files a card, the queue remembers being read, and a row can be struck out", async () => {
  const { ctx, dataDir } = boot();
  // A pipeline written before write-time folding existed — the shape the health
  // check is the safety net for. Seed it through a second handle with the fold
  // switched off: a fresh write would collapse into one row at the door.
  const legacy = MemoryStore.open({ dataDir });
  const slotFold = legacy.foldLogSlotInSlot;
  const rowFold = legacy.foldLogSlot;
  legacy.foldLogSlotInSlot = () => null;
  legacy.foldLogSlot = () => null;
  try {
    for (const value of ["OK 备份 2026-11-01 23:24", "OK 备份 2026-11-09 00:00", "OK 备份 2026-11-13 00:00"]) {
      legacy.writeFact({ entity: { name: "dsh", type: "project" }, predicate: "备份结果", value, cardinality: "multi" });
    }
  } finally {
    legacy.foldLogSlotInSlot = slotFold;
    legacy.foldLogSlot = rowFold;
    legacy.close();
  }

  const audit = await callRoute(ctx, "/api/fact-memory/audit", { force: true });
  assert.equal(audit.body.ok, true);
  assert.equal(audit.body.status, "ok");
  assert.ok(audit.body.findings >= 1, "the pipeline is found");
  assert.ok(audit.body.proposals >= 1, "and filed as a card");

  const status = await callRoute(ctx, "/api/fact-memory/status", {});
  assert.equal(status.body.audit.lastRun.status, "ok");
  assert.ok(status.body.review.newCount >= 1, "the queue has something unread");

  const queue = await callRoute(ctx, "/api/fact-memory/proposals", {});
  const card = queue.body.items.find((item) => item.kind === "audit" && item.action === "fold_log");
  assert.ok(card, "the folded-log card is in the queue");
  assert.ok(card.details.length >= 3, "with its rows spelled out");
  assert.ok(card.details.every((detail) => detail.kind === "fact" && detail.value));
  const keep = card.targets.findIndex((target) => target.role === "keep");
  const dropId = card.details.find((detail) => detail.role !== "keep").factId;

  // The keep row is what the fold is for; the rest are strikes.
  const keepId = card.targets[keep].factId;
  const refused = await callRoute(ctx, "/api/fact-memory/proposal-prune", { proposalId: card.id, dropFactIds: [keepId] });
  assert.equal(refused.body.ok, false);
  const pruned = await callRoute(ctx, "/api/fact-memory/proposal-prune", { proposalId: card.id, dropFactIds: [dropId] });
  assert.equal(pruned.body.ok, true);
  assert.equal(pruned.body.dropped, 1);

  const seen = await callRoute(ctx, "/api/fact-memory/review-seen", {});
  assert.equal(seen.body.ok, true);
  const after = await callRoute(ctx, "/api/fact-memory/status", {});
  assert.equal(after.body.review.newCount, 0, "opening the queue clears the digest");

  const summary = await callRoute(ctx, "/api/fact-memory/audit", { summary: true });
  assert.equal(summary.body.ok, true);
  assert.ok(summary.body.lastRun, "the ledger is readable without running a sweep");
  ctx.__dispose();
});

test("an expired fact can be put back, and only while its slot is free", async () => {
  const { ctx } = boot();
  const write = ctx.__tools.get("memory_write");
  const saved = await write.execute({ entity: "api", predicate: "端口", value: "8080", cardinality: "single" });
  const factId = saved.factId;

  const expired = await callRoute(ctx, "/api/fact-memory/fact-expire", { factId });
  assert.equal(expired.body.ok, true);
  assert.equal(expired.body.fact.status, "expired");

  // Undo carries the revision the expire returned, so a stale click cannot
  // reopen a row that has already moved on.
  const stale = await callRoute(ctx, "/api/fact-memory/fact-restore", { factId, expectedRevision: 1 });
  assert.equal(stale.body.ok, false);
  assert.equal(stale.body.stale, true);

  const restored = await callRoute(ctx, "/api/fact-memory/fact-restore", {
    factId,
    expectedRevision: expired.body.fact.recordRevision,
  });
  assert.equal(restored.body.ok, true);
  assert.equal(restored.body.fact.status, "active");
  assert.equal(restored.body.fact.validTo, null);

  // Expire again, then let a newer value take the slot: the undo must refuse
  // instead of overwriting the newer truth.
  const again = await callRoute(ctx, "/api/fact-memory/fact-expire", { factId });
  assert.equal(again.body.ok, true);
  await write.execute({ entity: "api", predicate: "端口", value: "9090", cardinality: "single" });
  const blocked = await callRoute(ctx, "/api/fact-memory/fact-restore", {
    factId,
    expectedRevision: again.body.fact.recordRevision,
  });
  assert.equal(blocked.body.ok, false);
  assert.equal(blocked.body.stale, true);
  assert.match(blocked.body.error, /新的值/);
  ctx.__dispose();
});

test("memory_write saves, is idempotent on retry, and refuses credentials", async () => {
  const { ctx } = boot();
  const write = ctx.__tools.get("memory_write");
  const first = await write.execute({ entity: "api", predicate: "端口", value: "8080", cardinality: "single" });
  assert.equal(first.outcome, "saved");
  assert.ok(first.factId);
  const again = await write.execute({ entity: "api", predicate: "端口", value: "8080", cardinality: "single" });
  assert.equal(again.outcome, "saved");
  assert.equal(again.factId, first.factId);
  assert.equal(again.replayed, true);
  const secret = await write.execute({ entity: "openai", predicate: "api_key", value: "sk-abcdefghijklmnopqrstuvwxyz123456" });
  assert.equal(secret.outcome, "refused");
  const sensitive = await write.execute({ entity: "user", predicate: "手机号", value: "13800138000" });
  assert.equal(sensitive.outcome, "saved");
  ctx.__dispose();
});

test("a tool write made inside a conversation belongs to that conversation", async () => {
  const { ctx } = boot();
  const write = ctx.__tools.get("memory_write");
  const exec = { agent: { session: { id: "session-42", seq: 7 } } };
  const saved = await write.execute({ entity: "orders", predicate: "端口", value: "8123", cardinality: "single" }, exec);
  assert.equal(saved.outcome, "saved");
  const activity = await callRoute(ctx, "/api/fact-memory/activity", { sessionId: "session-42" });
  assert.equal(activity.body.count, 1);
  assert.equal(activity.body.facts[0].entity, "orders");
  assert.equal(activity.body.facts[0].value, "8123");
  const sessions = await callRoute(ctx, "/api/fact-memory/sessions", {});
  assert.equal(sessions.body.sessions["session-42"].facts, 1);
  ctx.__dispose();
});

test("a sensitive write never surfaces through memory_search", async () => {
  const { ctx } = boot();
  const write = ctx.__tools.get("memory_write");
  await write.execute({ entity: "user", predicate: "手机号", value: "13800138000" });
  const found = await ctx.__tools.get("memory_search").execute({ query: "手机号 13800138000" });
  assert.equal(found.outcome, "not_found");
  assert.equal(found.count, 0);
  ctx.__dispose();
});

test("search finds a written fact and forget removes it for good", async () => {
  const { ctx } = boot();
  const write = ctx.__tools.get("memory_write");
  const forget = ctx.__tools.get("memory_forget");
  const saved = await write.execute({ entity: "api", predicate: "端口", value: "8080", cardinality: "single" });
  const found = await ctx.__tools.get("memory_search").execute({ query: "端口" });
  assert.equal(found.outcome, "ok");
  assert.equal(found.items[0].value, "8080");
  const gone = await forget.execute({ factId: saved.factId, reason: "测试" });
  assert.equal(gone.outcome, "ok");
  assert.equal(gone.forgotten, 1);
  assert.equal((await ctx.__tools.get("memory_search").execute({ query: "端口" })).outcome, "not_found");
  // The tombstone refuses a replay of the same claim.
  const revived = await write.execute({ entity: "api", predicate: "端口", value: "8080", cardinality: "single" });
  assert.equal(revived.outcome, "refused");
  ctx.__dispose();
});

/** Call one registered route the way the host bridge does. */
async function callRoute(ctx, path, body = {}) {
  const route = ctx.__routes.find((item) => item.path === path);
  assert.ok(route, `route ${path} must be registered`);
  const headers = new Map([
    ["content-type", "application/json"],
    ["host", "127.0.0.1:35411"],
    ["origin", "http://127.0.0.1:35411"],
    ["sec-fetch-site", "same-origin"],
  ]);
  const request = {
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
  const response = await route.fetch(request);
  return { status: response.status, body: await response.json() };
}

test("a conflict can be listed and settled from the settings route", async () => {
  const { ctx, dataDir } = boot();
  const saved = await ctx.__tools.get("memory_write").execute({ entity: "api", predicate: "端口", value: "8080", cardinality: "single" });
  assert.equal(saved.outcome, "saved");

  const listedEmpty = await callRoute(ctx, "/api/fact-memory/conflicts");
  assert.equal(listedEmpty.status, 200);
  assert.deepEqual(listedEmpty.body.groups, []);

  // Nothing to settle yet: resolving an unknown id is refused by name, not silently.
  const refused = await callRoute(ctx, "/api/fact-memory/resolve", { factId: "nope" });
  assert.equal(refused.body.ok, false);
  assert.match(refused.body.error, /冲突组/);

  // Seed a rival the way an import would: same slot, weaker evidence.
  const seed = MemoryStore.open({ dataDir });
  const rival = seed.writeFact({
    entity: { name: "api", type: "project" },
    predicate: "端口",
    value: "7070",
    cardinality: "single",
    evidenceLevel: "observed",
    observedAt: new Date().toISOString(),
  });
  seed.close();
  assert.equal(rival.status, "conflict");

  const listed = await callRoute(ctx, "/api/fact-memory/conflicts");
  assert.equal(listed.body.count, 1);
  assert.equal(listed.body.groups[0].rows.length, 2);
  const keep = listed.body.groups[0].rows.find((row) => String(row.value) === "8080");
  assert.ok(keep, `expected an 8080 row, saw ${JSON.stringify(listed.body.groups[0].rows)}`);
  const resolved = await callRoute(ctx, "/api/fact-memory/resolve", { factId: keep.factId });
  assert.equal(resolved.body.ok, true);
  assert.equal(resolved.body.superseded, 1);

  const after = await callRoute(ctx, "/api/fact-memory/conflicts");
  assert.deepEqual(after.body.groups, []);
  const found = await ctx.__tools.get("memory_search").execute({ query: "端口" });
  assert.equal(found.outcome, "ok");
  assert.equal(found.items.filter((fact) => fact.status === "active").length, 1);
  ctx.__dispose();
});

test("forget by entity name reports not_found for an unknown subject", async () => {
  const { ctx } = boot();
  const out = await ctx.__tools.get("memory_forget").execute({ entity: "nobody" });
  assert.equal(out.outcome, "not_found");
  ctx.__dispose();
});

test("the directory shows what memory knows and stays silent when disabled", async () => {
  const { ctx } = boot();
  await ctx.__tools.get("memory_write").execute({ entity: "user", predicate: "时区", value: "Asia/Shanghai" });
  const text = ctx.__contexts[0].text({});
  // I.1: the resident directory indexes what exists, never the fact body.
  assert.match(text, /user/);
  assert.match(text, /时区/);
  assert.doesNotMatch(text, /Asia\/Shanghai/);
  ctx.__dispose();

  const off = boot({ injectDirectory: false });
  assert.equal(off.ctx.__contexts[0].text({}), "");
  off.ctx.__dispose();
});

test("pre-step injects one notice per turn and honours the switch", async () => {
  const { ctx } = boot();
  ctx.__agent("s1");
  const handler = ctx.__preStep("s1")[0];
  assert.equal(typeof handler, "function");

  const fresh = { id: "m1", role: "user", content: [{ type: "text", text: "你好" }], source: { kind: "user" } };
  const next = async () => ({ kind: "enter", messages: [fresh] });
  const first = await handler({ messages: [fresh], turn: 1, step: 1 }, next);
  assert.equal(first.messages.length, 2, "the first turn gets one notice");
  assert.equal(first.messages[1].source.kind, "plugin:dsh-fact-memory");
  assert.equal(first.messages[1].source.form, "notice");
  assert.ok(first.messages[1].source.summary.length <= 120);

  const second = await handler({ messages: [fresh], turn: 1, step: 2 }, next);
  assert.equal(second.messages.length, 1, "a later step of the same turn repeats nothing");

  // A real next turn carries a new user message, and that is what the notice
  // dedupe keys on.
  const nextMessage = { ...fresh, id: "m2" };
  const third = await handler(
    { messages: [nextMessage], turn: 2, step: 1 },
    async () => ({ kind: "enter", messages: [nextMessage] }),
  );
  assert.equal(third.messages.length, 2, "the next turn gets one again");
  ctx.__dispose();

  const off = boot({ injectReminder: false });
  off.ctx.__agent("s1");
  const quiet = await off.ctx.__preStep("s1")[0](
    { messages: [fresh], turn: 1, step: 1 },
    async () => ({ kind: "enter", messages: [fresh] }),
  );
  assert.equal(quiet.messages.length, 1);
  off.ctx.__dispose();
});

test("a leftover pre-step listener cannot double the notice", async () => {
  const { ctx } = boot();
  ctx.__agent("s1");
  const handler = ctx.__preStep("s1")[0];
  const fresh = { id: "m1", role: "user", content: [{ type: "text", text: "你好" }], source: { kind: "user" } };
  const base = async () => ({ kind: "enter", messages: [fresh] });
  // The host chains listeners: the one registered last runs innermost, so the
  // innermost injects first and the outer one must find the turn already marked.
  const inner = await handler({ messages: [fresh], turn: 1, step: 1 }, base);
  const outer = await handler({ messages: [fresh], turn: 1, step: 1 }, async () => inner);
  assert.equal(outer.messages.length, 2);
  assert.equal(
    outer.messages.filter((message) => message?.source?.kind === "plugin:dsh-fact-memory").length,
    1,
    "exactly one notice per turn even with two live listeners",
  );
  ctx.__dispose();
});

test("two live agents on one session still write one notice for a message", async () => {
  const { ctx } = boot();
  ctx.__agent("s-two");
  // A model switch re-creates the agent while the session and its turn counter
  // carry on, and both agents can reach pre-step for the same user message. That
  // was the duplicate: one notice per agent, two in the transcript.
  ctx.__agent("s-two");
  const [first, second] = ctx.__preStep("s-two");
  assert.equal(ctx.__preStep("s-two").length, 2, "both agents are hooked");
  const fresh = { id: "m-two", role: "user", content: [{ type: "text", text: "你好" }], source: { kind: "user" } };
  const base = async () => ({ kind: "enter", messages: [fresh] });
  const inner = await second({ messages: [fresh], turn: 30, step: 1 }, base);
  const outer = await first({ messages: [fresh], turn: 30, step: 1 }, async () => inner);
  assert.equal(
    outer.messages.filter((message) => message?.source?.kind === "plugin:dsh-fact-memory").length,
    1,
    "one notice for the message, however many agents answer it",
  );
  // The next message still gets its own notice from whichever agent handles it.
  const later = { ...fresh, id: "m-two-later" };
  const again = await first({ messages: [later], turn: 30, step: 1 }, async () => ({ kind: "enter", messages: [later] }));
  assert.equal(again.messages.length, 2, "a new message gets a new notice");
  ctx.__dispose();
});

test("autoCapture is off by default and writes when switched on", async () => {
  const quietBoot = boot();
  quietBoot.ctx.__agent("s-auto-quiet");
  const quietHandler = quietBoot.ctx.__preStep("s-auto-quiet")[0];
  const quietText = { id: "m-auto-quiet", role: "user", content: [{ type: "text", text: "记住：api 的端口是 8080" }], source: { kind: "user" } };
  await quietHandler({ messages: [quietText], step: 0 }, async () => ({ kind: "enter", messages: [quietText] }));
  assert.equal((await quietBoot.ctx.__tools.get("memory_search").execute({ query: "8080" })).outcome, "not_found");
  quietBoot.ctx.__dispose();

  const loud = boot({ autoCapture: true });
  loud.ctx.__agent("s-auto-loud");
  const handler = loud.ctx.__preStep("s-auto-loud")[0];
  const text = { id: "m-auto-loud", role: "user", content: [{ type: "text", text: "记住：api 的端口是 8080" }], source: { kind: "user" } };
  await handler({ messages: [text], step: 0 }, async () => ({ kind: "enter", messages: [text] }));
  const hit = await loud.ctx.__tools.get("memory_search").execute({ query: "8080" });
  assert.equal(hit.outcome, "ok");
  // Re-delivering the same message must not write again.
  await handler({ messages: [text], step: 1 }, async () => ({ kind: "enter", messages: [text] }));
  assert.equal((await loud.ctx.__tools.get("memory_search").execute({ query: "端口" })).count, 1);
  loud.ctx.__dispose();
});

test("a bad data directory degrades to unavailable instead of throwing", async () => {
  const ctx = fakeContext({ dataDir: join(tempDir(), "nested", "\u0000bad"), injectDirectory: true, directoryBudget: 800 });
  assert.doesNotThrow(() => plugin.apply(ctx, ctx.config));
  const out = await ctx.__tools.get("memory_search").execute({ query: "x" });
  assert.equal(out.outcome, "unavailable");
  assert.equal((await ctx.__tools.get("memory_write").execute({ entity: "a", predicate: "b", value: "c" })).outcome, "unavailable");
  ctx.__dispose();
});

test("a configured provider that did not run is stated in the receipt", async () => {
  // The embedding endpoint is configured but nothing listens there: the search
  // must still answer, and the receipt must say the vector channel did not run
  // rather than letting a lexical hit read as a semantic one.
  const { ctx } = boot({
    embeddingSource: "openai",
    embeddingBaseUrl: "http://127.0.0.1:9/v1",
    embeddingModel: "missing-model",
    embeddingDim: 0,
  });
  const write = ctx.__tools.get("memory_write");
  await write.execute({ entity: "api", predicate: "端口", value: "8080", cardinality: "single" });
  const found = await ctx.__tools.get("memory_search").execute({ query: "端口" });
  assert.equal(found.outcome, "ok");
  assert.equal(found.paths.vectorConfigured, true);
  assert.equal(found.paths.vectorUsed, false);
  assert.match(found.message, /未使用向量通道/);
  assert.deepEqual(found.degraded.includes("embedding_failed") || found.degraded.includes("no_vector_match"), true);
  ctx.__dispose();
});

test("a page write carries the generation it saw, so a stale page cannot overwrite", async () => {
  const { ctx } = boot();
  const write = ctx.__tools.get("memory_write");
  const saved = await write.execute({ entity: "api", predicate: "端口", value: "8080", cardinality: "single" });
  const status = await callRoute(ctx, "/api/fact-memory/status");
  const generation = status.body.generation;

  // Another session changes the store between render and click.
  await write.execute({ entity: "api", predicate: "端口", value: "8081", cardinality: "single" });

  const stale = await callRoute(ctx, "/api/fact-memory/fact-update", {
    factId: saved.factId ?? saved.id,
    value: "9999",
    expectedGeneration: generation,
  });
  assert.equal(stale.body.ok, false);
  assert.equal(stale.body.stale, true);
  assert.ok(stale.body.generation > generation);

  // The refused write must not have landed: the fact keeps its old value and no
  // row anywhere carries the rejected 9999.
  const read = await callRoute(ctx, "/api/fact-memory/fact", { factId: saved.factId ?? saved.id });
  assert.notEqual(read.body.fact.value, "9999");
  const history = read.body.history ?? [];
  assert.equal(history.some((row) => row.value === "9999"), false, "no history row may carry the refused value");
  ctx.__dispose();
});

test("the same operationId replays its receipt instead of writing twice", async () => {
  const { ctx } = boot();
  const write = ctx.__tools.get("memory_write");
  const saved = await write.execute({ entity: "api", predicate: "端口", value: "8080", cardinality: "single" });
  const factId = saved.factId ?? saved.id;

  const first = await callRoute(ctx, "/api/fact-memory/fact-update", {
    factId,
    value: "9090",
    operationId: "click-1",
  });
  assert.equal(first.body.ok, true);
  const afterFirst = await callRoute(ctx, "/api/fact-memory/status");

  const second = await callRoute(ctx, "/api/fact-memory/fact-update", {
    factId,
    value: "9090",
    operationId: "click-1",
  });
  assert.equal(second.body.ok, true);
  assert.equal(second.body.replayed, true);
  const afterSecond = await callRoute(ctx, "/api/fact-memory/status");
  assert.equal(afterSecond.body.generation, afterFirst.body.generation, "a replay must not bump the generation");

  const collision = await callRoute(ctx, "/api/fact-memory/fact-update", {
    factId,
    value: "9999",
    operationId: "click-1",
  });
  assert.equal(collision.body.ok, false);
  assert.equal(collision.body.collision, true);
  ctx.__dispose();
});

test("a key typed in the card is stored in the host credential store and never echoed", async () => {
  const saved = new Map();
  const credentials = {
    describe: (ref) => ({ configured: saved.has(ref), source: saved.has(ref) ? "file" : undefined, writable: true }),
    resolve: (ref) => (saved.has(ref) ? { value: saved.get(ref), source: "file" } : undefined),
    set: (ref, value) => {
      saved.set(ref, value);
    },
    unset: (ref) => {
      saved.delete(ref);
    },
  };
  const ctx = fakeContext({ dataDir: tempDir(), embeddingApiKeyEnv: "FACT_MEMORY_EMBEDDING_KEY" }, credentials);
  plugin.apply(ctx, ctx.config);

  const before = await callRoute(ctx, "/api/fact-memory/status");
  assert.equal(before.body.keys.embedding.configured, false);

  const savedRes = await callRoute(ctx, "/api/fact-memory/key", { slot: "embedding", value: "sk-live-test" });
  assert.equal(savedRes.status, 200);
  assert.equal(savedRes.body.ok, true);
  assert.equal(savedRes.body.configured, true);
  assert.equal(savedRes.body.source, "file");
  assert.equal(saved.get("FACT_MEMORY_EMBEDDING_KEY"), "sk-live-test");
  assert.equal(JSON.stringify(savedRes.body).includes("sk-live-test"), false, "the response must not echo the key");

  const after = await callRoute(ctx, "/api/fact-memory/status");
  assert.equal(after.body.keys.embedding.configured, true);
  assert.equal(after.body.keys.embedding.source, "file");
  assert.equal(JSON.stringify(after.body).includes("sk-live-test"), false, "status must not leak the key");

  const cleared = await callRoute(ctx, "/api/fact-memory/key", { slot: "embedding", clear: true });
  assert.equal(cleared.body.ok, true);
  assert.equal(cleared.body.configured, false);
  assert.equal(saved.has("FACT_MEMORY_EMBEDDING_KEY"), false);
});

test("saving a key without a credential store or with a bad slot says why", async () => {
  const noStore = fakeContext({ dataDir: tempDir(), embeddingApiKeyEnv: "FACT_MEMORY_EMBEDDING_KEY" });
  plugin.apply(noStore, noStore.config);
  const refused = await callRoute(noStore, "/api/fact-memory/key", { slot: "embedding", value: "sk-x" });
  assert.equal(refused.body.ok, false);
  assert.match(refused.body.error, /凭据库/);

  const ctx = fakeContext({ dataDir: tempDir() }, { describe: () => ({ configured: false }), resolve: () => undefined, set: () => {}, unset: () => {} });
  plugin.apply(ctx, ctx.config);
  const badSlot = await callRoute(ctx, "/api/fact-memory/key", { slot: "nope", value: "sk-x" });
  assert.equal(badSlot.body.ok, false);
  const noRef = await callRoute(ctx, "/api/fact-memory/key", { slot: "embedding", value: "sk-x" });
  assert.equal(noRef.body.ok, false);
  assert.match(noRef.body.error, /embeddingApiKeyEnv/);
});

test("a saved key is what the embedding provider actually sends", async () => {
  const saved = new Map([["FACT_MEMORY_EMBEDDING_KEY", "sk-from-store"]]);
  const credentials = {
    describe: (ref) => ({ configured: saved.has(ref), source: "file", writable: true }),
    resolve: (ref) => (saved.has(ref) ? { value: saved.get(ref), source: "file" } : undefined),
    set: () => {},
    unset: () => {},
  };
  const ctx = fakeContext(
    {
      dataDir: tempDir(),
      embeddingSource: "openai",
      embeddingBaseUrl: "http://127.0.0.1:9/v1",
      embeddingModel: "fake-embed",
      embeddingDim: 3,
      embeddingApiKeyEnv: "FACT_MEMORY_EMBEDDING_KEY",
    },
    credentials,
  );
  plugin.apply(ctx, ctx.config);
  await ctx.__tools.get("memory_write").execute({ entity: "svc", predicate: "port", value: "7000" });

  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const headers = init?.headers ?? {};
    seen.push({ url: String(url), auth: headers.authorization ?? headers.Authorization });
    return { ok: false, status: 500, text: async () => "nope", json: async () => ({}) };
  };
  try {
    const res = await callRoute(ctx, "/api/fact-memory/index-vectors", {});
    assert.equal(res.body.ok, false);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /127\.0\.0\.1:9\/v1\/embeddings/);
  assert.equal(seen[0].auth, "Bearer sk-from-store");
});

test("a credential-shaped value is refused by default", async () => {
  const { ctx } = boot();
  const write = ctx.__tools.get("memory_write");
  const refused = await write.execute({
    entity: "api",
    predicate: "令牌",
    value: "sk-live-0123456789abcdef0123456789abcdef",
  });
  assert.equal(refused.outcome, "refused");
  assert.match(refused.message, /凭据/);
  const search = await ctx.__tools.get("memory_search").execute({ query: "令牌" });
  assert.equal(search.outcome, "not_found");
  ctx.__dispose();
});

test("with the credential guard off, the value is kept but stays out of model context", async () => {
  const { ctx } = boot({ refuseCredentials: false });
  const write = ctx.__tools.get("memory_write");
  const saved = await write.execute({
    entity: "api",
    predicate: "令牌",
    value: "sk-live-0123456789abcdef0123456789abcdef",
  });
  assert.equal(saved.outcome, "saved");
  assert.match(saved.message, /敏感事实/);
  // Model-facing recall must still not return it.
  const search = await ctx.__tools.get("memory_search").execute({ query: "令牌" });
  assert.equal(search.outcome, "not_found", "a stored credential must never enter model-facing recall");
  // The page can still read it: the fact exists and is marked sensitive.
  const facts = await callRoute(ctx, "/api/fact-memory/facts", { query: "令牌" });
  assert.equal(facts.body.items.length, 1);
  assert.equal(facts.body.items[0].privacyClass, "sensitive");
  ctx.__dispose();
});

test("sensitiveModelVisible decides whether personal data reaches the model", async () => {
  const hidden = boot();
  const hiddenWrite = hidden.ctx.__tools.get("memory_write");
  const first = await hiddenWrite.execute({ entity: "user", predicate: "手机号", value: "13800001111" });
  assert.equal(first.outcome, "saved");
  const hiddenSearch = await hidden.ctx.__tools.get("memory_search").execute({ query: "手机号" });
  assert.equal(hiddenSearch.outcome, "not_found", "sensitive facts stay out of model recall by default");
  hidden.ctx.__dispose();

  const visible = boot({ sensitiveModelVisible: true });
  const visibleWrite = visible.ctx.__tools.get("memory_write");
  await visibleWrite.execute({ entity: "user", predicate: "手机号", value: "13800001111" });
  const visibleSearch = await visible.ctx.__tools.get("memory_search").execute({ query: "手机号" });
  assert.equal(visibleSearch.outcome, "ok");
  assert.equal(visibleSearch.items[0].value, "13800001111");
  // The directory is a model surface too: the subject must appear when the
  // switch is on, and stay absent when it is off.
  assert.match(hidden.ctx.__contexts[0].text({}), /【事实记忆】|【事实记忆目录】/);
  assert.match(visible.ctx.__contexts[0].text({}), /user/, "the visible switch puts the subject back in the directory");
  visible.ctx.__dispose();
});

test("a retried click replays its receipt even after the store moved on", async () => {
  const { ctx } = boot();
  const write = ctx.__tools.get("memory_write");
  const saved = await write.execute({ entity: "api", predicate: "端口", value: "8080", cardinality: "single" });
  const generation = (await callRoute(ctx, "/api/fact-memory/status")).body.generation;

  const first = await callRoute(ctx, "/api/fact-memory/fact-update", {
    factId: saved.factId ?? saved.id,
    value: "9090",
    operationId: "click-2",
    expectedGeneration: generation,
  });
  assert.equal(first.body.ok, true);

  // Something else changes the store, so the page's generation is now stale.
  await write.execute({ entity: "api", predicate: "端口", value: "9091", cardinality: "single" });

  // The user's browser retries the very same click: it must get the original
  // answer, not a bogus "stale" error, because nothing new would be written.
  const retry = await callRoute(ctx, "/api/fact-memory/fact-update", {
    factId: saved.factId ?? saved.id,
    value: "9090",
    operationId: "click-2",
    expectedGeneration: generation,
  });
  assert.equal(retry.body.ok, true);
  assert.equal(retry.body.replayed, true);
  ctx.__dispose();
});

test("the fact detail redacts the evidence quote of a credential", async () => {
  const { ctx } = boot({ refuseCredentials: false });
  const secret = "sk-live-0123456789abcdef0123456789abcdef";
  const saved = await ctx.__tools.get("memory_write").execute({
    entity: "api",
    predicate: "令牌",
    value: secret,
    text: `记住：api 的令牌是 ${secret}`,
  });
  assert.equal(saved.outcome, "saved");

  const detail = await callRoute(ctx, "/api/fact-memory/fact", { factId: saved.factId });
  assert.equal(detail.body.fact.secret, true);
  assert.equal(detail.body.fact.value, secret, "the owner still sees the stored value");
  const quote = detail.body.sources?.[0]?.quote ?? "";
  assert.equal(quote.includes(secret), false, "the evidence quote must not repeat the credential");
  assert.match(quote, /已隐去/);
  ctx.__dispose();
});

test("an entity detail only returns that entity's own facts", async () => {
  const { ctx } = boot();
  const write = ctx.__tools.get("memory_write");
  await write.execute({ entity: "api", predicate: "端口", value: "8080", cardinality: "single" });
  await write.execute({ entity: "api-gateway", predicate: "端口", value: "8081", cardinality: "single" });

  const detail = await callRoute(ctx, "/api/fact-memory/entity", { entity: "api" });
  assert.equal(detail.body.ok, true);
  assert.equal(detail.body.facts.length, 1);
  assert.equal(detail.body.facts[0].value, "8080");
  ctx.__dispose();
});

test("forget by text never echoes a personal value back to the model", async () => {
  const { ctx } = boot({ sensitiveModelVisible: false });
  const write = ctx.__tools.get("memory_write");
  await write.execute({ entity: "user", predicate: "手机号", value: "13900002222", cardinality: "single" });
  await write.execute({ entity: "user", predicate: "备用手机号", value: "13800001111", cardinality: "single" });

  const result = await ctx.__tools.get("memory_forget").execute({ text: "手机号" });
  assert.equal(result.outcome, "needs_selection");
  for (const candidate of result.candidates ?? []) {
    assert.equal(String(candidate.value).includes("13900002222"), false);
    assert.equal(String(candidate.value).includes("13800001111"), false);
    assert.match(String(candidate.value), /•/);
  }
  ctx.__dispose();
});

test("the reminder body is cut to the configured character budget", async () => {
  // A zero budget is the documented "no body" setting, and a small one must
  // actually shrink the notice — it used to be read by nothing at all.
  const mute = boot({ injectReminder: true, reminderBudgetTokens: 0 });
  mute.ctx.__agent("s-budget-mute");
  const cue = (id) => ({ id, role: "user", content: [{ type: "text", text: "你记得我的偏好吗" }], source: { kind: "user" } });
  const silent = await mute.ctx.__preStep("s-budget-mute")[0]({ messages: [cue("m-budget-mute")], step: 0 }, async () => ({ kind: "enter", messages: [cue("m-budget-mute")] }));
  assert.equal(silent.messages.length, 1, "a zero budget injects nothing");
  mute.ctx.__dispose();

  // The setting counts tokens, and the panel's own conversion is 2 characters per
  // token (budgetChars), so 8 tokens = 16 code points.
  const tiny = boot({ injectReminder: true, reminderBudgetTokens: 8 });
  tiny.ctx.__agent("s-budget-tiny");
  const short = await tiny.ctx.__preStep("s-budget-tiny")[0]({ messages: [cue("m-budget-tiny")], step: 0 }, async () => ({ kind: "enter", messages: [cue("m-budget-tiny")] }));
  assert.equal(short.messages.length, 2);
  const body = short.messages[1].content.map((part) => part.text ?? "").join("");
  assert.ok(Array.from(body).length <= budgetChars(8), `notice body stays inside the budget, saw ${Array.from(body).length}`);
  tiny.ctx.__dispose();

  const roomy = boot({ injectReminder: true, reminderBudgetTokens: 300 });
  roomy.ctx.__agent("s-budget-roomy");
  const long = await roomy.ctx.__preStep("s-budget-roomy")[0]({ messages: [cue("m-budget-roomy")], step: 0 }, async () => ({ kind: "enter", messages: [cue("m-budget-roomy")] }));
  const full = long.messages[1].content.map((part) => part.text ?? "").join("");
  assert.ok(Array.from(full).length > Array.from(body).length, "a small budget really cuts the text");
  roomy.ctx.__dispose();
});

test("resolve refuses a decision it does not understand instead of defaulting to keep", async () => {
  const { ctx } = boot();
  await ctx.__tools.get("memory_write").execute({ entity: "api", predicate: "端口", value: "8080", cardinality: "single" });
  const refused = await callRoute(ctx, "/api/fact-memory/resolve", { factId: "nope", decision: "drop-everything" });
  assert.equal(refused.body.ok, false);
  assert.match(refused.body.error, /keep \/ multi \/ drop/);
  ctx.__dispose();
});

test("a non-numeric search limit is ignored, not reported as an outage", async () => {
  const { ctx } = boot();
  await ctx.__tools.get("memory_write").execute({ entity: "api", predicate: "端口", value: "8080" });
  const found = await ctx.__tools.get("memory_search").execute({ query: "端口", limit: "many" });
  assert.equal(found.outcome, "ok");
  assert.equal(found.count, 1);
  const capped = await ctx.__tools.get("memory_search").execute({ query: "端口", limit: 99 });
  assert.equal(capped.outcome, "ok", "an out-of-range limit is clamped, not passed to SQL");
  ctx.__dispose();
});

test("a credential-only sentence is refused instead of parked in the queue", async () => {
  const { ctx, dataDir } = boot();
  const write = await ctx.__tools.get("memory_write").execute({ text: "password: Hunter2Hunter2Hunter2" });
  assert.equal(write.outcome, "refused");
  const store = MemoryStore.open({ dataDir });
  const pending = Number(store.db.prepare("SELECT COUNT(*) AS count FROM pending_items").get().count);
  assert.equal(pending, 0, "nothing was stored for review");
  store.close();
  ctx.__dispose();
});

test("the export fence refuses a directory that only looks like it is inside the data directory", async () => {
  const { ctx, dataDir } = boot();
  const inside = await callRoute(ctx, "/api/fact-memory/export", { dir: join(dataDir, "out") });
  assert.equal(inside.body.ok, true, "a plain subdirectory is allowed");
  const outside = await callRoute(ctx, "/api/fact-memory/export", { dir: join(dataDir, "..", "escape") });
  assert.equal(outside.body.ok, false);
  assert.match(outside.body.error, /数据目录/);
  ctx.__dispose();
});

test("the dream layer is off by default, and its routes answer without touching facts", async () => {
  const { ctx } = boot();
  const status = await callRoute(ctx, "/api/fact-memory/status", {});
  assert.equal(status.body.dream.enabled, false);
  assert.equal(status.body.dream.pendingChars, 0);
  assert.equal(typeof status.body.dream.line, "string");
  assert.equal(status.body.dream.counts.pending, 0);
  const list = await callRoute(ctx, "/api/fact-memory/dreams", {});
  assert.equal(list.body.ok, true);
  assert.deepEqual(list.body.items, []);
  assert.deepEqual(list.body.pending, []);
  assert.deepEqual(list.body.runs, []);
  // The panel disables the button while the layer is off; the route must agree.
  const run = await callRoute(ctx, "/api/fact-memory/dream", {});
  assert.equal(run.body.status, "skipped");
  assert.equal(run.body.reason, "disabled");
  // An empty request is refused, never read as "all of them".
  assert.equal((await callRoute(ctx, "/api/fact-memory/dream-apply", {})).body.ok, false);
  assert.equal((await callRoute(ctx, "/api/fact-memory/dream-reject", {})).body.ok, false);
  assert.equal((await callRoute(ctx, "/api/fact-memory/dream-edit", {})).body.ok, false);
  assert.equal((await callRoute(ctx, "/api/fact-memory/status", {})).body.stats.facts, 0);
  ctx.__dispose();
});

