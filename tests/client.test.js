/**
 * Loads client.js the way the host does: through window.__ModuleLoader__, with
 * react / react/jsx-runtime resolved by the loader rather than by node. The card
 * is then rendered once with a fake projection, which catches the class of bug
 * that a syntax check cannot see — a hook name that does not match its `hooks`
 * key, or an action the card calls but the controller never exports.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]):/, "$1:");

let loadCount = 0;

function loadCard() {
  let loaded = null;
  loadCount += 1;
  const runtime = {
    jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
    jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
  };
  const react = {
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useMemo: (fn) => fn(),
    useEffect: (fn) => {
      const dispose = fn();
      return typeof dispose === "function" ? dispose : undefined;
    },
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  };
  globalThis.window = {
    __ModuleLoader__: {
      load: (spec) => {
        assert.equal(spec.id, "dsh-fact-memory");
        loaded = spec.factory((id) => {
          if (id === "react") return react;
          if (id === "react/jsx-runtime") return runtime;
          throw new Error(`unexpected require(${id})`);
        });
      },
    },
  };
  // The module-level side effect runs once per URL: a unique query re-executes it.
  return import(`${pathToFileURL(join(here, "..", "client.js")).href}?v=${loadCount}`).then(() => loaded);
}

function fakeClientContext() {
  const slots = [];
  const dictionaries = {};
  const effects = [];
  const scope = {
    snapshot: { status: "ready", writable: true, value: { injectDirectory: true, directoryBudget: 800, autoCapture: false }, user: {} },
    getSnapshot() {
      return this.snapshot;
    },
    subscribe() {
      return () => {};
    },
    async set(key, value) {
      if (this.acceptWrites === false) return false;
      this.snapshot = { ...this.snapshot, value: { ...this.snapshot.value, [key]: value }, user: { ...this.snapshot.user, [key]: value } };
      return true;
    },
    async unset(key) {
      const value = { ...this.snapshot.value };
      delete value[key];
      this.snapshot = { ...this.snapshot, value };
    },
  };
  const ctx = {
    effect: (fn) => {
      const dispose = fn();
      effects.push(dispose);
      return dispose;
    },
    locale: {
      register: (ns, dict) => {
        dictionaries[ns] = dict;
        return () => {};
      },
      // Host locale format: {name} placeholders interpolated from the params object.
      bind: (ns) => (key, params = {}) => {
        const dict = dictionaries[ns] ?? {};
        const template = (dict.zh ?? {})[key] ?? key;
        return String(template).replace(/\{(\w+)\}/g, (_all, name) => String(params[name] ?? ""));
      },
    },
    configForms: {
      get: () => scope,
      whileServed: (_namespaces, callback) => callback(),
    },
    // Wait-style service injection: the callback runs as if the services exist.
    inject: (_names, callback) => callback({ ...ctx, sidebarRightTabs: ctx.get("sidebarRightTabs") }),
    slots: {
      inject: (_name, callback) => callback(),
      register: (spec, component) => {
        slots.push({ spec, component });
        return () => {};
      },
    },
    // Services the plugin reaches for lazily on click, never at apply time.
    get: (name) => {
      if (name === "sidebarRightTabs") {
        return {
          register: (definition) => {
            ctx.__tabDefinitions.push(definition);
            return () => {};
          },
        };
      }
      if (name === "layout") return { selectPanel: (id) => ctx.__panelCalls.push(id) };
      if (name === "sidebarRight") return { openTab: (kind, options) => ctx.__tabOpens.push({ kind, ...options }) };
      return undefined;
    },
    __slots: slots,
    __scope: scope,
    __tabDefinitions: [],
    __tabOpens: [],
    __panelCalls: [],
  };
  return ctx;
}

/** The settings card is one of several slots the plugin registers. */
function cardSlot(ctx) {
  const slot = ctx.__slots.find((entry) => entry.spec.name === "plugins.item");
  assert.ok(slot, "the plugin must register a plugins.item card");
  return slot;
}

/** A plain object where a child belongs is the shape React refuses to render. */
function findObjectChild(node) {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findObjectChild(item);
      if (hit) return hit;
    }
    return null;
  }
  if (!("type" in node) || !("props" in node)) return node;
  return findObjectChild(node.props?.children);
}

/** Depth-first search over the fake jsx tree. */
function findElement(node, predicate) {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findElement(item, predicate);
      if (hit) return hit;
    }
    return null;
  }
  if (predicate(node)) return node;
  return findElement(node.props?.children, predicate);
}

const statusPayload = {
  version: 1,
  ok: true,
  dataDir: "D:/tmp/fact-memory",
  schemaVersion: 8,
  stats: { facts: 12, active: 9, scheduled: 1, pending: 2, conflict: 1 },
  proposals: { pending: 1 },
  semantic: {
    embeddingConfigured: true,
    embeddingModel: "bge-m3",
    rerankConfigured: true,
    rerankModel: "bge-reranker",
    vectors: 9,
    calibrations: 0,
    vectorIndex: { intervalMs: 600000, running: false, lastAt: "2026-11-13T09:00:00.000Z", lastIndexed: 5, lastError: "" },
  },
  meta: { generation: 7, storeId: "store-1" },
  // The queue tab's badge counts every state the scheduler can hold.
  extraction: { enabled: true, delayMs: 15000, running: 1, queued: 0, waiting: 1, retrying: 0, pending: 0 },
  integrity: { ok: true },
  keys: {
    embedding: { ref: "FACT_MEMORY_EMBEDDING_KEY", configured: true, source: "file", writable: true },
    rerank: { ref: "FACT_MEMORY_RERANK_KEY", configured: false, source: "none", writable: true },
    llm: { ref: "", configured: false, source: "none", writable: false },
  },
};

const proposalPayload = {
  ok: true,
  count: 1,
  status: "pending",
  items: [
    {
      id: "p1",
      kind: "low_confidence",
      action: "replace",
      entity: "api",
      predicate: "端口",
      value: "7070",
      current: "8080",
      confidence: 0.42,
      reason: "用户没有直接确认",
      revision: 1,
      status: "pending",
      targets: [{ factId: "f-active", entity: "api", predicate: "端口", value: "8080", status: "active", recordRevision: 3 }],
    },
  ],
};

const graphPayload = {
  ok: true,
  view: "current",
  seeds: [{ id: "e1", name: "api" }],
  nodes: [
    { id: "e:1", kind: "entity", label: "api" },
    { id: "v:7070", kind: "value", label: "7070" },
  ],
  edges: [
    {
      source: "e:1",
      predicate: "端口",
      target: "v:7070",
      factIds: ["f-active"],
      status: "active",
      evidenceLevel: "explicit_user",
      observedAt: "2026-01-01T00:00:00.000Z",
      confirmed: true,
      facts: [{ id: "f-active", entity: "api", predicate: "端口", value: "7070", status: "active" }],
    },
  ],
  truncated: { nodes: 0, edges: 0 },
  totals: { nodes: 2, edges: 1 },
};

const nebulaPayload = {
  ok: true,
  mode: "nebula",
  view: "current",
  seeds: ["api", "user"],
  nodes: [
    { id: "e:1", kind: "entity", label: "api", factCount: 2, entityType: "service", status: "active", degree: 2 },
    { id: "e:2", kind: "entity", label: "user", factCount: 1, entityType: "person", status: "active", degree: 1 },
    { id: "v:8080", kind: "value", label: "8080", factCount: 1, entityType: null, status: "active", degree: 1 },
    { id: "v:中文回答", kind: "value", label: "中文回答", factCount: 1, entityType: null, status: "scheduled", degree: 1 },
  ],
  edges: [
    { id: "nbe:1", source: "e:1", predicate: "端口", target: "v:8080", status: "active", factCount: 1, factIds: ["f-active"] },
    { id: "nbe:2", source: "e:2", predicate: "偏好", target: "v:中文回答", status: "scheduled", factCount: 1, factIds: ["f-scheduled"] },
  ],
  totals: { nodes: 4, edges: 2 },
  truncated: { nodes: 0, edges: 0 },
};

const queuePayload = {
  ok: true,
  at: "2026-01-01T00:05:00.000Z",
  generation: 7,
  config: { enabled: true, delayMs: 15000, chunksPerPass: 3, model: "cbcn/minimax-m3.1-flash", configured: true },
  running: [{ sessionId: "session-1", title: "事实记忆", state: "running", since: "2026-01-01T00:04:58.000Z" }],
  queued: [],
  waiting: [{ sessionId: "session-2", title: "", state: "waiting", toSeq: 40, dueInMs: 9000 }],
  retrying: [{ sessionId: "session-3", title: "", state: "retrying", toSeq: 12, attempt: 1, dueInMs: 60000 }],
  recent: [
    {
      id: "run-1",
      hasDetail: true,
      sessionId: "session-1",
      title: "事实记忆",
      state: "ok",
      seq: 38,
      fromSeq: 30,
      reason: "",
      saved: 2,
      proposals: 1,
      conflicts: 0,
      chars: 420,
      chunks: 1,
      durationMs: 3400,
      model: "fake-model",
      at: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
    },
    {
      id: "run-2",
      hasDetail: true,
      sessionId: "session-2",
      title: "别的话题",
      state: "skipped",
      seq: 12,
      reason: "no_user_text",
      saved: 0,
      durationMs: 12,
      at: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: "run-3",
      hasDetail: true,
      sessionId: "session-4",
      title: "界面调整",
      state: "skipped",
      seq: 8,
      reason: "no_signal",
      saved: 0,
      durationMs: 5,
      at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: "run-4",
      hasDetail: true,
      sessionId: "session-5",
      title: "抽取失败的那次",
      state: "error",
      seq: 9,
      reason: "custom model returned no text (finish_reason=length: the whole budget went to reasoning_content (13009 chars) and no answer came back)",
      saved: 0,
      durationMs: 33700,
      model: "unisound_give/u2-flash",
      at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    },
  ],
  pending: [{ id: "p1", reason: "auto_extract_failed: timeout", at: "2026-01-01T00:03:00.000Z", chars: 320, preview: "结论先说：核心闭环能用了" }],
  totals: { running: 1, queued: 0, waiting: 1, retrying: 1, pending: 1, active: 3 },
};

test("the card mounts, renders, and drives config writes and actions", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init.body });
    if (url.endsWith("/status")) return { status: 200, ok: true, json: async () => statusPayload };
    if (url.endsWith("/export")) return { status: 200, ok: true, json: async () => ({ ok: true, count: 12, path: "D:/tmp/fact-memory/exports/facts.jsonl" }) };
    if (url.endsWith("/rebuild")) return { status: 200, ok: true, json: async () => ({ ok: true, indexed: 12 }) };
    if (url.endsWith("/conflicts"))
      return {
        status: 200,
        ok: true,
        json: async () => ({
          ok: true,
          count: 1,
          groups: [
            {
              id: "g1",
              reason: "contradiction:端口",
              createdAt: "2026-01-03T00:00:00.000Z",
              rows: [
                { factId: "f-active", entity: "api", predicate: "端口", value: "8080", status: "active", evidenceLevel: "explicit_user", observedAt: "2026-01-01T00:00:00.000Z" },
                { factId: "f-rival", entity: "api", predicate: "端口", value: "7070", status: "conflict", evidenceLevel: "observed", observedAt: "2026-01-02T00:00:00.000Z" },
              ],
            },
          ],
        }),
      };
    if (url.endsWith("/resolve")) return { status: 200, ok: true, json: async () => ({ ok: true, superseded: 1 }) };
    if (url.endsWith("/proposals")) return { status: 200, ok: true, json: async () => proposalPayload };
    if (url.endsWith("/proposal-apply")) return { status: 200, ok: true, json: async () => ({ ok: true, factId: "f-new", written: true }) };
    if (url.endsWith("/proposal-reject")) return { status: 200, ok: true, json: async () => ({ ok: true, proposalId: "p1" }) };
    if (url.endsWith("/graph"))
      return {
        status: 200,
        ok: true,
        json: async () => {
          const body = init && init.body ? JSON.parse(init.body) : {};
          return body.mode === "nebula" ? nebulaPayload : graphPayload;
        },
      };
    if (url.endsWith("/queue")) return { status: 200, ok: true, json: async () => queuePayload };
    if (url.endsWith("/extract-retry")) return { status: 200, ok: true, json: async () => ({ ok: true, saved: 2, retried: true }) };
    if (url.endsWith("/extract-run"))
      return {
        status: 200,
        ok: true,
        json: async () => {
          // The row that was opened decides what comes back: a failed pass has
          // to render its own status and reason, not the fixture of run-1.
          const body = init && init.body ? JSON.parse(init.body) : {};
          const listed = queuePayload.recent.find((row) => row.id === body.id);
          return {
            ok: true,
            run: {
              id: body.id ?? "run-1",
              sessionId: listed?.sessionId ?? "session-1",
              status: listed?.state ?? "ok",
              reason: listed?.reason ?? "",
              messages: 2,
              chunks: 1,
              chars: 420,
              saved: listed?.saved ?? 2,
              durationMs: listed?.durationMs ?? 3400,
              model: listed?.model ?? "fake-model",
              inputText: "USER: 记一下抽取队列要记录最近 10 条记录" + "甲".repeat(9000),
              inputTruncated: false,
              rejected: [{ reason: "quote_not_in_source", count: 2 }],
            },
          };
        },
      };
    if (url.endsWith("/index-vectors")) return { status: 200, ok: true, json: async () => ({ ok: true, indexed: 9 }) };
    if (url.endsWith("/consolidate")) return { status: 200, ok: true, json: async () => ({ ok: true, status: "ok", judged: 3, proposals: 2, pending: 2 }) };
    if (url.endsWith("/wipe"))
      return { status: 200, ok: true, json: async () => ({ ok: true, facts: 12, entities: 3, backupPath: "D:/tmp/fact-memory/backups/pre-wipe.sqlite3" }) };
    if (url.endsWith("/key"))
      return { status: 200, ok: true, json: async () => ({ ok: true, saved: true, configured: true, source: "file" }) };
    return { status: 404, ok: false, json: async () => ({ ok: false }) };
  };

  const loaded = await loadCard();
  const ctx = fakeClientContext();
  loaded.apply(ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Every seat the plugin claims: the keyed main page, the sidebar row, the
  // chat-header entry, the turn card, the row mark, the settings card and the
  // right drawer's body + title. Each must be registered exactly once.
  assert.deepEqual(
    ctx.__slots.map((slot) => slot.spec.name).sort(),
    [
      "conversation.chat.turnTail",
      "conversation.session.header.utilities",
      "main",
      "plugins.item",
      "sidebar.panellist",
      "sidebar.right.pane.tab",
      "sidebar.right.pane.tab.title",
      "sidebar.session.row.leading",
    ],
  );
  assert.equal(ctx.__tabDefinitions.length, 1, "the right drawer needs one tab kind");
  assert.equal(ctx.__tabDefinitions[0].kind, "factMemory");
  const pageSlot = ctx.__slots.find((slot) => slot.spec.name === "main");
  assert.equal(pageSlot.spec.key, "dsh-fact-memory");
  const pageProps = pageSlot.spec.inject();
  assert.ok(pageProps.hooks.memoryPage, "the page needs its own store");
  for (const action of ["refreshAll", "setTab", "openFact", "loadGraph", "updateValue", "resolveConflict"]) {
    assert.equal(typeof pageProps.actions[action], "function", `${action} must be exposed to the page`);
  }
  const pageTree = pageSlot.component({
    ...pageProps,
    t: ctx.locale.bind("dsh-fact-memory"),
    // The host turns each hooks key into a use<Name> hook; the fake supplies it.
    useMemoryPage: (selector) => selector(pageProps.hooks.memoryPage.getSnapshot()),
  });
  assert.match(JSON.stringify(pageTree), /事实记忆/);
  // The graph tab asks for the bounded nebula projection and mounts the 3D
  // canvas; this process has no DOM, so the same component must degrade to the
  // SVG tree instead of throwing or painting an empty rectangle.
  pageProps.actions.setGraphEntity("api");
  pageProps.actions.setTab("graph");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const pageT = ctx.locale.bind("dsh-fact-memory");
  const graphBodies = calls.filter((call) => call.url === "/api/fact-memory/graph").map((call) => JSON.parse(call.body));
  assert.ok(
    graphBodies.some((body) => body.mode === "nebula" && body.maxNodes === 600 && body.maxEdges === 1200),
    "the page asks for the nebula projection, bounded to the renderer caps",
  );
  const pageSnapshot = pageProps.hooks.memoryPage.getSnapshot();
  assert.equal(pageSnapshot.graph.data?.mode, "nebula");
  const pageTreeGraph = pageSlot.component({
    ...pageProps,
    t: pageT,
    useMemoryPage: (selector) => selector(pageSnapshot),
  });
  const nebulaElement = findElement(pageTreeGraph, (element) => element?.type?.name === "NebulaCanvas");
  assert.ok(nebulaElement, "the graph tab must mount NebulaCanvas");
  assert.ok(
    findElement(pageTreeGraph, (element) => element?.props?.title === "刷新图谱"),
    "the graph toolbar carries an explicit refresh button",
  );
  const fallbackTree = nebulaElement.type(nebulaElement.props);
  const fallbackText = JSON.stringify(fallbackTree);
  assert.match(fallbackText, /FM_pgNebulaFallback/);
  assert.match(fallbackText, /WebGL/, "the fallback explains why it degraded");
  const treeElement = findElement(fallbackTree, (element) => element?.type?.name === "GraphTree");
  assert.ok(treeElement, "without WebGL the SVG tree must render");
  const svgTree = treeElement.type(treeElement.props);
  assert.equal(svgTree.type, "div");
  assert.match(JSON.stringify(svgTree), /"svg"/);
  // Reopening the tab must re-read the projection: a cached graph survived a
  // wipe once and kept drawing nodes for a store that was already empty.
  const graphCalls = () => calls.filter((call) => call.url === "/api/fact-memory/graph").length;
  const before = graphCalls();
  pageProps.actions.setTab("facts");
  pageProps.actions.setTab("graph");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(graphCalls() > before, "reopening the graph tab re-reads the projection");
  // The toolbar's refresh button is the same action, callable on demand.
  const beforeRefresh = graphCalls();
  pageProps.actions.loadGraph("", pageSnapshot.graph.view);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(graphCalls(), beforeRefresh + 1);

  // ── extraction queue tab ────────────────────────────────────────────────
  // The page has to be able to answer "is anything actually running?" without
  // reading the logs: a fifth tab, off-by-default auto refresh, manual refresh.
  assert.equal(typeof pageProps.actions.loadQueue, "function");
  assert.equal(typeof pageProps.actions.setQueueAuto, "function");
  const queueCalls = () => calls.filter((call) => call.url === "/api/fact-memory/queue").length;
  pageProps.actions.setTab("queue");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(queueCalls() > 0, "opening the queue tab reads the queue");
  const queueSnapshot = pageProps.hooks.memoryPage.getSnapshot();
  assert.equal(queueSnapshot.tab, "queue");
  assert.equal(queueSnapshot.queue.data?.totals.active, 3);
  assert.equal(queueSnapshot.queue.auto, 0, "auto refresh is off by default");
  const queueTree = pageSlot.component({
    ...pageProps,
    t: pageT,
    useMemoryPage: (selector) => selector(queueSnapshot),
  });
  // The panel is a component, so its toolbar only exists after rendering it.
  const queuePanelElement = findElement(queueTree, (element) => element?.type?.name === "QueuePanel");
  assert.ok(queuePanelElement, "the queue tab mounts the queue panel");
  const queuePanelTree = queuePanelElement.type(queuePanelElement.props);
  assert.ok(
    findElement(queuePanelTree, (element) => element?.props?.title === "刷新队列"),
    "the queue toolbar has a manual refresh button",
  );
  assert.match(JSON.stringify(queueTree), /抽取队列/, "the tab row carries the new tab");
  const queueText = JSON.stringify(queuePanelTree);
  assert.match(queueText, /自动刷新/);
  assert.match(queueText, /运行中 1/);
  assert.match(queueText, /等待 1/);
  assert.match(queueText, /重试 1/);
  assert.match(queueText, /事实记忆/, "a row shows the session title");
  // The finished list must say what the pass did, not just its seq: this is the
  // section that answers "is the plugin alive and working?".
  assert.match(queueText, /最近完成/);
  assert.match(queueText, /写入 2 条/);
  assert.match(queueText, /待确认 1 条/);
  assert.match(queueText, /用时 3\.4 秒/);
  assert.match(queueText, /3 分钟前/, "a fresh run reads as time ago, not a raw timestamp");
  assert.match(queueText, /这一轮没有新的对话文本/, "a skipped pass explains itself in words");
  assert.match(queueText, /1 天前/);
  assert.match(queueText, /没有发现记忆信号/, "a prefilter skip says the model was never called");
  assert.equal(typeof pageProps.actions.toggleExtractRun, "function", "a finished row can be opened");

  // Clicking a finished row asks for the text it read; the panel then shows the
  // source and the refused candidates instead of leaving the row unexplained.
  const queueRow = findElement(
    queuePanelTree,
    (element) => typeof element?.props?.className === "string" && element.props.className.includes("FM_pgQueueRowClick"),
  );
  assert.ok(queueRow, "a stored run row is clickable");
  queueRow.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(pageProps.hooks.memoryPage.getSnapshot().queue.expanded.data?.id, "run-1");
  const expandedTree = pageSlot.component({
    ...pageProps,
    t: pageT,
    useMemoryPage: (selector) => selector(pageProps.hooks.memoryPage.getSnapshot()),
  });
  const expandedPanel = findElement(expandedTree, (element) => element?.type?.name === "QueuePanel");
  const expandedPanelTree = expandedPanel.type(expandedPanel.props);
  // The detail block is its own component; render it so its text is visible here.
  const detailElement = findElement(expandedPanelTree, (element) => element?.type?.name === "ExtractRunDetail");
  assert.ok(detailElement, "an opened row mounts the run detail");
  const expandedText = JSON.stringify(detailElement.type(detailElement.props));
  assert.match(expandedText, /发给模型的原文/);
  assert.match(expandedText, /抽取队列要记录最近 10 条记录/, "the stored input text is shown verbatim");
  assert.match(expandedText, /引用不在原文里 ×2/, "refused candidates carry a human reason");
  // A long record must not render in one go: the panel shows a chunk and asks.
  const detailTree = detailElement.type(detailElement.props);
  const pre = findElement(detailTree, (element) => element?.props?.className === "FM_pgQueueInput");
  assert.equal(pre.props.children.length, 4000, "one chunk is rendered, not the whole 9k chars");
  const more = findElement(detailTree, (element) => element?.props?.className === "FM_pgQueueMore");
  assert.ok(more, "a long text offers load more");
  assert.match(JSON.stringify(more), /加载更多（已显示 4000/);
  more.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const grownTree = pageSlot.component({
    ...pageProps,
    t: pageT,
    useMemoryPage: (selector) => selector(pageProps.hooks.memoryPage.getSnapshot()),
  });
  const grownPanel = findElement(grownTree, (element) => element?.type?.name === "QueuePanel");
  const grownDetail = findElement(grownPanel.type(grownPanel.props), (element) => element?.type?.name === "ExtractRunDetail");
  assert.equal(
    findElement(grownDetail.type(grownDetail.props), (element) => element?.props?.className === "FM_pgQueueInput").props.children.length,
    8000,
    "load more doubles the visible slice",
  );
  // A parked batch carries the manual retry: automatic attempts stop by design,
  // so the human needs one click that works with the current configuration.
  const retryButton = findElement(
    queuePanelTree,
    (element) => element?.props?.className === "FM_pgQueueRetry" && element?.props?.children === "重试抽取",
  );
  assert.ok(retryButton, "a parked row carries a retry button");
  retryButton.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const retryCall = calls.filter((call) => call.url === "/api/fact-memory/extract-retry").at(-1);
  assert.ok(retryCall, "the button posts to the retry route");
  assert.deepEqual(JSON.parse(retryCall.body), { pendingId: "p1" });
  assert.equal(pageProps.hooks.memoryPage.getSnapshot().queue.retry?.state, "ok");
  assert.equal(pageProps.hooks.memoryPage.getSnapshot().queue.retry?.saved, 2);
  const retriedPanel = findElement(
    pageSlot.component({ ...pageProps, t: pageT, useMemoryPage: (selector) => selector(pageProps.hooks.memoryPage.getSnapshot()) }),
    (element) => element?.type?.name === "QueuePanel",
  );
  assert.match(JSON.stringify(retriedPanel.type(retriedPanel.props)), /已重抽：写入 2 条/);

  // The failed pass keeps its own retry inside the detail block, next to the
  // reason it could not answer.
  pageProps.actions.toggleExtractRun("run-4");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const failedTree = pageSlot.component({ ...pageProps, t: pageT, useMemoryPage: (selector) => selector(pageProps.hooks.memoryPage.getSnapshot()) });
  const failedPanel = findElement(failedTree, (element) => element?.type?.name === "QueuePanel");
  const failedDetail = findElement(failedPanel.type(failedPanel.props), (element) => element?.type?.name === "ExtractRunDetail");
  assert.ok(failedDetail, "the failed run opens");
  const failedDetailTree = failedDetail.type(failedDetail.props);
  assert.match(JSON.stringify(failedDetailTree), /reasoning_content/, "the failure reason reaches the detail block");
  const failedRetry = findElement(failedDetailTree, (element) => element?.props?.className === "FM_pgQueueRetry");
  assert.ok(failedRetry, "a failed pass offers a retry");
  failedRetry.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const runRetry = calls.filter((call) => call.url === "/api/fact-memory/extract-retry").at(-1);
  assert.deepEqual(JSON.parse(runRetry.body), { runId: "run-4" });

  assert.ok(
    findElement(queuePanelTree, (element) => element?.props?.children === "15 秒"),
    "the 15s interval is one of the choices",
  );
  // The section is drawn even with nothing in it: a missing block reads as a
  // broken page, an explained empty block reads as an idle plugin.
  queuePayload.recent = [];
  await pageProps.actions.loadQueue();
  const emptyTree = pageSlot.component({
    ...pageProps,
    t: pageT,
    useMemoryPage: (selector) => selector(pageProps.hooks.memoryPage.getSnapshot()),
  });
  const emptyPanelElement = findElement(emptyTree, (element) => element?.type?.name === "QueuePanel");
  const emptyPanelText = JSON.stringify(emptyPanelElement.type(emptyPanelElement.props));
  assert.match(emptyPanelText, /最近完成/);
  assert.match(emptyPanelText, /还没有运行记录/);
  assert.match(emptyPanelText, /发一条消息/, "the empty state tells the user what to do next");

  // Manual refresh is the same action the button calls.
  const beforeQueue = queueCalls();
  await pageProps.actions.loadQueue();
  assert.equal(queueCalls(), beforeQueue + 1);

  // Auto refresh arms a real interval, and leaving the tab stops it: a hidden
  // poll would keep asking the server while nobody is looking at the numbers.
  const { mock } = await import("node:test");
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    pageProps.actions.setQueueAuto(5);
    assert.equal(pageProps.hooks.memoryPage.getSnapshot().queue.auto, 5);
    const beforeTick = queueCalls();
    mock.timers.tick(5000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(queueCalls() > beforeTick, "5s auto refresh re-reads the queue");
    pageProps.actions.setTab("facts");
    const afterLeave = queueCalls();
    mock.timers.tick(5000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(queueCalls(), afterLeave, "leaving the tab stops polling");
  } finally {
    mock.timers.reset();
    pageProps.actions.setQueueAuto(0);
  }
  // The chat-header entry: label, badge count and the click that opens the page.
  const headerSlot = ctx.__slots.find((slot) => slot.spec.name === "conversation.session.header.utilities");
  assert.equal(headerSlot.spec.id, "fact-memory-entry");
  const headerProps = headerSlot.spec.inject("session-1");
  assert.equal(typeof headerProps.open, "function");
  const badge = { proposals: { pending: 1 }, conflicts: { open: 2 } };
  const headerTree = headerSlot.component({
    ...headerProps,
    t: ctx.locale.bind("dsh-fact-memory"),
    // page.store's snapshot is {status, ...}; the entry only reads status.
    useMemoryBadge: (selector) => selector({ status: badge }),
  });
  const headerText = JSON.stringify(headerTree);
  assert.match(headerText, /事实记忆/);
  assert.match(headerText, /"3"/, "the badge counts pending proposals plus open conflicts");
  headerTree.props.onClick();
  assert.deepEqual(ctx.__panelCalls, ["dsh-fact-memory"], "clicking the header entry opens the page");

  const { spec, component } = cardSlot(ctx);
  assert.equal(spec.name, "plugins.item");
  assert.equal(spec.id, "dsh-fact-memory");
  const props = spec.inject();
  assert.ok(props.hooks.factMemory);
  for (const action of ["edit", "save", "discard", "resetField", "exportNow", "rebuildNow", "resolveFact", "applyProposal", "rejectProposal", "indexVectorsNow", "dedupNow", "wipeNow", "loadGraph", "saveKey", "clearKey"]) {
    assert.equal(typeof props[action], "function", `${action} must be exposed to the card`);
  }

  const t = ctx.locale.bind("dsh-fact-memory");
  const base = { ...props, t, useFactMemory: (selector) => selector(props.hooks.factMemory.getSnapshot()) };

  // summary view stays one line
  assert.equal(typeof component({ ...base, view: "summary" }), "string");

  // detail view renders the fields and the live status
  const tree = component({ ...base, view: "detail" });
  const text = JSON.stringify(tree);
  assert.match(text, /事实记忆/);
  assert.match(text, /12 条事实/);
  assert.match(text, /D:\/tmp\/fact-memory/);
  assert.match(text, /一键清空/, "the card offers the factory-reset button");
  assert.match(text, /只保留配置项/, "and says what survives it");
  // Store format and revision are diagnosis, not a decision: they must read as
  // one quiet line, not as two bare pills next to the fact count.
  const statusElement = findElement(tree, (element) => element?.type?.name === "StatusLine");
  assert.ok(statusElement, "the card renders the live status line");
  const statusText = JSON.stringify(statusElement.type(statusElement.props));
  assert.match(statusText, /库格式 v8/, "the schema is named in human words");
  assert.match(statusText, /数据版本 7/, "the transaction counter is named, not shown raw");
  assert.doesNotMatch(statusText, /"schema v7"/, "the raw identifier is gone from the pill row");
  assert.match(statusText, /向量自动索引 · 每 10 分钟/, "the automatic sweep states its own cadence");
  assert.match(statusText, /新增 5 条/, "and how many vectors the last sweep built");
  assert.match(
    statusText,
    /向量 9 条 · 重排：未校准，仅用于排序/,
    "the rerank state names the channel once and says what it does",
  );
  assert.doesNotMatch(statusText, /重排重排/, "the rerank label is not doubled in the pill");
  const calibratedStatus = {
    ...statusElement.props.status,
    semantic: { ...statusElement.props.status.semantic, calibrations: 2 },
  };
  const calibratedText = JSON.stringify(statusElement.type({ ...statusElement.props, status: calibratedStatus }));
  assert.match(calibratedText, /重排：已校准/, "a calibrated reranker is reported as calibrated");
  // conflicts > 0 in the status payload -> the card asks for the groups and renders them
  // The section is a child component, so render that one level and inspect it.
  const conflictsElement = findElement(tree, (element) => element?.props?.conflicts?.groups);
  assert.ok(conflictsElement, "the card must mount the conflict section when conflicts exist");
  const conflictsTree = JSON.stringify(conflictsElement.type(conflictsElement.props));
  assert.match(conflictsTree, /待裁决冲突/);
  assert.match(conflictsTree, /8080/);
  assert.match(conflictsTree, /保留这个/);

  // Proposals belong to the library page, which has room for the diff and the
  // accept/reject flow. The settings card stays short: a count pill, no list.
  const proposalsElement = findElement(tree, (element) => Array.isArray(element?.props?.proposals?.items));
  assert.ok(!proposalsElement, "the card must not mount the proposal section any more");
  assert.doesNotMatch(JSON.stringify(tree), /拟改为：7070/, "no proposal diff inside the settings card");

  // A key slot renders its own row: the name, whether the host already has a
  // secret, and the paste-and-save control. The card never receives the value.
  const keyRows = [];
  const collectKeys = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(collectKeys);
    if (node.props && node.props.slot && node.props.saveKey) keyRows.push(node);
    if (node.props && node.props.children) collectKeys(node.props.children);
  };
  collectKeys(tree);
  assert.equal(keyRows.length, 3, "one key row per provider slot");
  const keyTree = JSON.stringify(keyRows[0].type(keyRows[0].props));
  assert.match(keyTree, /嵌入密钥/);
  assert.match(keyTree, /FACT_MEMORY_EMBEDDING_KEY/);
  assert.match(keyTree, /已保存/);
  await props.saveKey("embedding", "sk-typed");
  assert.ok(calls.some((call) => call.url === "/api/fact-memory/key" && call.body.includes("sk-typed")));
  await props.clearKey("rerank");
  assert.ok(calls.some((call) => call.url === "/api/fact-memory/key" && call.body.includes("clear")));

  // The graph loads on demand and shows each edge with its supporting facts.
  await props.loadGraph("api", "current");
  const graphState = props.hooks.factMemory.getSnapshot().graph;
  assert.equal(graphState.loaded, true);
  assert.equal(graphState.edges.length, 1);
  const graphElement = findElement(tree, (element) => Array.isArray(element?.props?.graph?.edges) && element.props.loadGraph);
  assert.ok(graphElement, "the card must mount the graph section");
  const graphTree = JSON.stringify(graphElement.type({ ...graphElement.props, graph: graphState }));
  assert.match(graphTree, /事实图谱/);
  assert.match(graphTree, /api/);
  assert.match(graphTree, /支撑事实 1 条/);
  assert.match(graphTree, /端口/);

  // Number fields accept typing, not only the spinner: a partial value must
  // stay on screen instead of snapping back, and a decimal threshold (0.6)
  // must survive parsing.
  const fieldInput = (node, key) =>
    findElement(node, (element) => element?.props?.field?.key === key && typeof element.props.edit === "function");
  const inputOf = (row) => findElement(row.type(row.props), (element) => element?.props?.type === "number" && typeof element.props.onChange === "function");

  const budgetRow = fieldInput(tree, "directoryBudget");
  assert.ok(budgetRow, "the budget row must be present");
  const budgetInput = inputOf(budgetRow);
  assert.ok(budgetInput, "the budget is a number input");
  budgetInput.props.onChange({ target: { value: "8" } });
  const afterPartial = props.hooks.factMemory.getSnapshot().fields.directoryBudget;
  assert.equal(afterPartial.value, 800, "a partial value is not committed");
  assert.equal(afterPartial.invalid, true, "a partial value is flagged, not silently dropped");

  const confidenceInput = inputOf(fieldInput(tree, "extractConfidenceMin"));
  confidenceInput.props.onChange({ target: { value: "0.6" } });
  const afterDecimal = props.hooks.factMemory.getSnapshot().fields.extractConfidenceMin;
  assert.equal(afterDecimal.value, 0.6, "0.6 is a legal confidence threshold");
  assert.equal(afterDecimal.invalid, false, "a decimal threshold is not rejected by integer rounding");

  // The tuning keys are all reachable, but the card opens short: one native
  // disclosure holds them, and the master switch sits above every group.
  const rowsInOrder = [];
  const collectFieldRows = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(collectFieldRows);
    if (node.props?.field?.key && typeof node.props.edit === "function") rowsInOrder.push(node);
    if (node.props?.children) collectFieldRows(node.props.children);
  };
  collectFieldRows(tree);
  assert.equal(rowsInOrder[0]?.props?.field?.key, "enabled", "the master switch is the first control on the card");
  // The tuning rows live inside a child component, so render that one level.
  const advElement = findElement(tree, (element) => element?.type?.name === "AdvancedFields");
  assert.ok(advElement, "the card mounts the fold for the tuning keys");
  const advTree = advElement.type(advElement.props);
  const advRows = [];
  const collectAdvRows = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(collectAdvRows);
    if (node.props?.field?.key && typeof node.props.edit === "function") advRows.push(node);
    if (node.props?.children) collectAdvRows(node.props.children);
  };
  collectAdvRows(advTree);
  const advancedRowKeys = advRows.map((row) => row.props.field.key);
  assert.equal(advancedRowKeys.length, 11, "every tuning key is on the card");
  for (const key of [
    "reminderBudgetTokens",
    "searchBudgetTokens",
    "queryTimeoutMs",
    "storeTimezone",
    "advanceIntervalMs",
    "backupBeforeWipe",
    "backupKeep",
    "autoConsolidate",
    "consolidateIntervalMs",
    "consolidateCosineFloor",
    "consolidateMaxPairs",
  ]) {
    assert.ok(advancedRowKeys.includes(key), `${key} must be reachable from the card`);
  }
  const disclosure = findElement(advTree, (element) => element?.type === "details");
  assert.ok(disclosure, "the tuning keys hang off a native disclosure");
  assert.equal(disclosure.props.open, undefined, "the disclosure starts folded");
  assert.match(JSON.stringify(advTree), /高级设置/, "and says what is inside");
  // Milliseconds are spelled out: 21600000 is six hours, and 0 reads as "off".
  const intervalRow = advRows.find((row) => row.props.field.key === "consolidateIntervalMs");
  assert.match(JSON.stringify(intervalRow.type(intervalRow.props)), /≈ 6 小时/);
  const advanceRow = advRows.find((row) => row.props.field.key === "advanceIntervalMs");
  const advanceOff = advanceRow.type({ ...advanceRow.props, value: { value: 0, overridden: false, invalid: false } });
  assert.match(JSON.stringify(advanceOff), /不跑（0）/, "0 is written in words, not as a bare zero");
  // The master switch is a real control, not decoration.
  const enabledRow = fieldInput(tree, "enabled");
  const enabledBox = findElement(enabledRow.type(enabledRow.props), (element) => element?.props?.type === "checkbox");
  enabledBox.props.onChange({ target: { checked: false } });
  assert.equal(props.hooks.factMemory.getSnapshot().fields.enabled.value, false, "flipping the master switch stages a change");
  props.resetField("enabled");

  // The two drafts above must not block the rest of the card's save path.
  props.resetField("directoryBudget");
  props.resetField("extractConfidenceMin");

  // editing a switch stages a value, saving writes through the scope
  props.edit("injectDirectory", false);
  await props.save();
  assert.equal(ctx.__scope.snapshot.user.injectDirectory, false);

  // a number out of range is refused instead of being written
  props.edit("searchLimit", "99");
  await props.save();
  assert.equal(ctx.__scope.snapshot.user.searchLimit, undefined);

  // export and rebuild report one human sentence and refresh status
  await props.exportNow();
  const afterExport = props.hooks.factMemory.getSnapshot();
  assert.equal(afterExport.op.status, "done");
  assert.equal(afterExport.op.count, 12);
  await props.rebuildNow();
  assert.equal(props.hooks.factMemory.getSnapshot().op.count, 12);
  assert.ok(calls.some((call) => call.url === "/api/fact-memory/status"));

  // Settling a conflict posts the chosen side and refreshes the counts.
  await props.resolveFact("f-active");
  const settled = props.hooks.factMemory.getSnapshot();
  assert.equal(settled.op.kind, "resolve");
  assert.equal(settled.op.status, "done");
  assert.ok(calls.some((call) => call.url === "/api/fact-memory/resolve" && call.body.includes("f-active")));

  // Accepting a proposal writes through the host route and reports the new fact.
  await props.applyProposal("p1");
  const applied = props.hooks.factMemory.getSnapshot();
  assert.equal(applied.op.kind, "proposal");
  assert.equal(applied.op.status, "done");
  assert.ok(calls.some((call) => call.url === "/api/fact-memory/proposal-apply" && call.body.includes("p1")));
  await props.rejectProposal("p1");
  assert.equal(props.hooks.factMemory.getSnapshot().op.kind, "proposalReject");
  assert.ok(calls.some((call) => call.url === "/api/fact-memory/proposal-reject" && call.body.includes("p1")));

  // The vector button reports the number indexed.
  await props.indexVectorsNow();
  assert.equal(props.hooks.factMemory.getSnapshot().op.count, 9);

  // The duplicate button forces a sweep and reports how many proposals it filed.
  await props.dedupNow();
  const dedupOp = props.hooks.factMemory.getSnapshot().op;
  assert.equal(dedupOp.kind, "dedup");
  assert.equal(dedupOp.status, "done");
  assert.equal(dedupOp.count, 2);
  assert.ok(
    calls.some((call) => call.url === "/api/fact-memory/consolidate" && call.body.includes('"force":true')),
    "the button forces a sweep instead of waiting for the interval",
  );

  // Clearing posts the confirm token and reports how many facts went.
  await props.wipeNow();
  const wiped = props.hooks.factMemory.getSnapshot();
  assert.equal(wiped.op.kind, "wipe");
  assert.equal(wiped.op.status, "done");
  assert.equal(wiped.op.count, 12);
  const wipeCall = calls.find((call) => call.url === "/api/fact-memory/wipe");
  assert.ok(wipeCall && wipeCall.body.includes('"confirm":"wipe"'), "the wipe carries its confirm token");
  // A wipe stales every cached projection, not just the counters: the page must
  // re-ask for the graph (it used to keep drawing the pre-wipe library) and the
  // surface stores must forget what the old store said.
  const wipeAt = calls.indexOf(wipeCall);
  assert.ok(
    calls.slice(wipeAt).some((call) => call.url === "/api/fact-memory/graph"),
    "the graph is reloaded after a wipe",
  );
  // The queue is read state too, and it used to be the one projection a wipe could
  // leave stuck: afterWipe set loading before the read, and the read refused to run
  // while loading was set — the tab sat on its loading text until a page remount.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(calls.slice(wipeAt).some((call) => call.url === "/api/fact-memory/queue"), "the queue is re-read after a wipe");
  assert.equal(
    pageProps.hooks.memoryPage.getSnapshot().queue.loading,
    false,
    "a wipe must not leave the queue tab loading forever",
  );
  const turnSlot = ctx.__slots.find((slot) => slot.spec.name === "conversation.chat.turnTail");
  assert.deepEqual(turnSlot.spec.inject("session-1").hooks.turn.getSnapshot().bySession, {});

  // A host that refuses the write must not leave the card looking saved.
  props.resetField("searchLimit"); // the out-of-range draft still blocks saving
  ctx.__scope.acceptWrites = false;
  props.edit("injectReminder", false);
  await props.save();
  const refused = props.hooks.factMemory.getSnapshot();
  assert.equal(refused.shell.failed, true);
  assert.equal(refused.shell.failureReason, "rejected");
  assert.equal(refused.shell.dirty, true, "a refused write keeps the staged value on screen");
});

test("an unavailable backend leaves the card readable instead of throwing", async () => {
  globalThis.fetch = async () => ({ status: 404, ok: false, json: async () => ({ ok: false }) });
  const loaded = await loadCard();
  const ctx = fakeClientContext();
  loaded.apply(ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const slot = cardSlot(ctx);
  const props = slot.spec.inject();
  const component = slot.component;
  const t = ctx.locale.bind("dsh-fact-memory");
  const base = { ...props, t, useFactMemory: (selector) => selector(props.hooks.factMemory.getSnapshot()) };
  const tree = component({ ...base, view: "detail" });
  assert.ok(tree);
  const snapshot = props.hooks.factMemory.getSnapshot();
  assert.equal(snapshot.status.ok, false);
  // The action buttons are disabled, but calling them must still not throw.
  await props.exportNow();
  assert.equal(props.hooks.factMemory.getSnapshot().op.status, "failed");
});

/**
 * Locale guard: a literal t("key") the dictionaries do not contain renders as
 * the raw key on screen, and nothing else in the suite catches it.
 */
test("every literal translation key exists in both dictionaries", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(join(here, "..", "client.js"), "utf8");
  const dictKeys = (name) => {
    const start = source.indexOf(`const ${name} = {`);
    const end = source.indexOf("\n    };", start);
    return new Set([...source.slice(start, end).matchAll(/^\s*"([^"]+)":/gm)].map((match) => match[1]));
  };
  const zh = new Set([...dictKeys("zh"), ...dictKeys("zhPage")]);
  const en = new Set([...dictKeys("en"), ...dictKeys("enPage")]);
  const used = new Set([...source.matchAll(/\bt\("([^"]+)"\)/g)].map((match) => match[1]));
  const missingZh = [...used].filter((key) => !zh.has(key));
  const missingEn = [...used].filter((key) => !en.has(key));
  assert.deepEqual(missingZh, [], `zh is missing: ${missingZh.join(", ")}`);
  assert.deepEqual(missingEn, [], `en is missing: ${missingEn.join(", ")}`);
  const onlyZh = [...zh].filter((key) => !en.has(key));
  const onlyEn = [...en].filter((key) => !zh.has(key));
  assert.deepEqual(onlyZh, [], `en is missing (declared in zh): ${onlyZh.join(", ")}`);
  assert.deepEqual(onlyEn, [], `zh is missing (declared in en): ${onlyEn.join(", ")}`);
});

test("the turn card, drawer and row mark read the same activity routes", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init.body });
    if (url.endsWith("/status")) return { status: 200, ok: true, json: async () => statusPayload };
    if (url.endsWith("/activity"))
      return {
        status: 200,
        ok: true,
        json: async () => ({
          ok: true,
          sessionId: "session-1",
          facts: [
            { factId: "f-1", entity: "api", predicate: "端口", value: "7070", status: "active", observedAt: "2026-01-01T00:00:00.000Z", secret: false },
            { factId: "f-2", entity: "api", predicate: "令牌", value: "sk-live-123", status: "active", observedAt: "2026-01-01T00:00:00.000Z", secret: true },
          ],
          count: 2,
          lastRun: { at: "2026-01-01T00:00:00.000Z", fromSeq: 3, toSeq: 12, saved: 2, proposals: 1, conflicts: 0, refused: 0, status: "ok" },
        }),
      };
    if (url.endsWith("/sessions"))
      return { status: 200, ok: true, json: async () => ({ ok: true, count: 1, sessions: { "session-1": { facts: 2, lastAt: "2026-01-01T00:00:00.000Z" } } }) };
    return { status: 404, ok: false, json: async () => ({ ok: false }) };
  };

  const loaded = await loadCard();
  const ctx = fakeClientContext();
  loaded.apply(ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const t = ctx.locale.bind("dsh-fact-memory");

  // Turn card: counts from the last run that covers this turn's seq.
  const turnSlot = ctx.__slots.find((slot) => slot.spec.name === "conversation.chat.turnTail");
  const turnProps = turnSlot.spec.inject("session-1");
  assert.equal(turnProps.sessionId, "session-1");
  const turnBase = {
    ...turnProps,
    t,
    seq: 12,
    useTurn: (selector) => selector(turnProps.hooks.turn.getSnapshot()),
  };
  await turnProps.refreshTurn("session-1", 12);
  const turnTree = await turnSlot.component(turnBase);
  const turnText = JSON.stringify(turnTree);
  assert.match(turnText, /本轮记忆/);
  assert.match(turnText, /写入 2 条/);
  assert.match(turnText, /待审 1 条/);
  // A turn whose seq the run does not cover renders nothing.
  assert.equal(await turnSlot.component({ ...turnBase, seq: 99 }), null);

  // The card's "查看" opens the drawer tab and loads that session's facts.
  await turnTree.props.children.at(-1).props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ctx.__tabOpens.length, 1);
  assert.equal(ctx.__tabOpens[0].kind, "factMemory");
  assert.equal(ctx.__tabOpens[0].params.sessionId, "session-1");
  assert.equal(ctx.__tabOpens[0].params.sinceSeq, 3);
  assert.ok(calls.some((call) => call.url.endsWith("/activity") && JSON.parse(call.body).sinceSeq === 3));

  // Drawer body: rows render, credentials stay masked, and a click jumps to the library.
  const drawerSlot = ctx.__slots.find((slot) => slot.spec.name === "sidebar.right.pane.tab");
  const drawerProps = drawerSlot.spec.inject();
  const drawerTree = drawerSlot.component({
    ...drawerProps,
    t,
    useDrawer: (selector) => selector(drawerProps.hooks.drawer.getSnapshot()),
  });
  const drawerText = JSON.stringify(drawerTree);
  assert.match(drawerText, /记忆详情/);
  assert.match(drawerText, /2 条/);
  // Rows are child components: render them before asserting on their text.
  const rowElements = [];
  const collect = (node) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) collect(item);
      return;
    }
    if (node.props?.fact) {
      rowElements.push(node);
      return;
    }
    collect(node.props?.children);
  };
  collect(drawerTree);
  assert.equal(rowElements.length, 2);
  const rows = rowElements.map((element) => element.type(element.props));
  const rowText = JSON.stringify(rows);
  assert.match(rowText, /api/);
  assert.match(rowText, /7070/);
  assert.match(rowText, /••••••••/, "a credential renders masked in the drawer");
  assert.doesNotMatch(rowText, /sk-live-123/);
  rows[0].props.onClick();
  assert.deepEqual(ctx.__panelCalls, ["dsh-fact-memory"]);
  assert.ok(calls.some((call) => call.url.endsWith("/fact") && JSON.parse(call.body).factId === "f-1"));

  // Row mark: a dot for a session that wrote facts, nothing for one that did not.
  const markSlot = ctx.__slots.find((slot) => slot.spec.name === "sidebar.session.row.leading");
  const markProps = markSlot.spec.inject();
  await markProps.refreshSessions(true);
  const withFacts = markSlot.component({
    ...markProps,
    t,
    sessionId: "session-1",
    useSessions: (selector) => selector(markProps.hooks.sessions.getSnapshot()),
  });
  assert.equal(withFacts.props.className, "FM_rowMark");
  assert.equal(withFacts.props.title, "这个会话写过 2 条记忆");
  const withoutFacts = markSlot.component({
    ...markProps,
    t,
    sessionId: "session-2",
    useSessions: (selector) => selector(markProps.hooks.sessions.getSnapshot()),
  });
  assert.equal(withoutFacts, null);
});

test("a slow extraction still lands its card: the probe polls until the pass settles", async () => {
  let calls = 0;
  globalThis.fetch = async (url) => {
    if (url.endsWith("/activity")) {
      calls += 1;
      const done = calls >= 2;
      return {
        status: 200,
        ok: true,
        json: async () => ({
          ok: true,
          sessionId: "session-slow",
          facts: [],
          count: 0,
          extraction: done ? { queued: 0, running: false, settledSeq: 7, lastStatus: "ok" } : { queued: 1, running: true, settledSeq: null, lastStatus: null },
          lastRun: done
            ? { at: "2026-01-01T00:00:00.000Z", fromSeq: 4, toSeq: 7, saved: 2, proposals: 0, conflicts: 0, refused: 0, status: "ok" }
            : null,
        }),
      };
    }
    return { status: 404, ok: false, json: async () => ({ ok: false }) };
  };

  const loaded = await loadCard();
  const ctx = fakeClientContext();
  loaded.apply(ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const slot = ctx.__slots.find((item) => item.spec.name === "conversation.chat.turnTail");
  const props = slot.spec.inject("session-slow");

  // The first look happens before the pass finished: nothing to show yet.
  assert.equal(await props.refreshTurn("session-slow", 7), null);
  // The old implementation gave up here; the card has to keep asking.
  await new Promise((resolve) => setTimeout(resolve, 4200));
  const entry = props.hooks.turn.getSnapshot().bySession["session-slow"];
  assert.equal(entry?.run?.saved, 2);
  assert.equal(entry?.run?.toSeq, 7);
});

test("the turn card survives the debounce window instead of giving up before the pass starts", async () => {
  let calls = 0;
  globalThis.fetch = async (url) => {
    if (url.endsWith("/activity")) {
      calls += 1;
      // The first two probes land inside the debounce window: the pass is armed
      // but owns no queue slot. That used to look identical to "this turn will
      // never produce anything", and the poll died two probes in.
      const done = calls >= 3;
      return {
        status: 200,
        ok: true,
        json: async () => ({
          ok: true,
          sessionId: "session-debounce",
          facts: [],
          count: 0,
          extraction: done
            ? { enabled: true, queued: 0, running: false, waiting: null, retrying: null, deferred: null, settledSeq: 7, lastStatus: "ok" }
            : { enabled: true, queued: 0, running: false, waiting: { dueInMs: 2000, toSeq: 7 }, retrying: null, deferred: null, settledSeq: null, lastStatus: null },
          lastRun: done
            ? { at: "2026-01-01T00:00:00.000Z", fromSeq: 4, toSeq: 7, saved: 1, proposals: 0, conflicts: 0, refused: 0, status: "ok" }
            : null,
        }),
      };
    }
    return { status: 404, ok: false, json: async () => ({ ok: false }) };
  };

  const loaded = await loadCard();
  const ctx = fakeClientContext();
  loaded.apply(ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const slot = ctx.__slots.find((item) => item.spec.name === "conversation.chat.turnTail");
  const props = slot.spec.inject("session-debounce");
  assert.equal(await props.refreshTurn("session-debounce", 7), null);
  // Two probes inside the debounce window, then the finished pass.
  await new Promise((resolve) => setTimeout(resolve, 12_600));
  const entry = props.hooks.turn.getSnapshot().bySession["session-debounce"];
  assert.equal(entry?.run?.saved, 1, "the card lands once the debounced pass finishes");
  assert.equal(entry?.run?.toSeq, 7);
  props.cancelTurn("session-debounce", 7);
});

test("one turn card's unmount does not cancel another turn's poll", async () => {
  const runs = new Map([
    [12, { at: "2026-01-01T00:00:00.000Z", fromSeq: 4, toSeq: 12, saved: 2, proposals: 0, conflicts: 0, refused: 0, status: "ok" }],
    [20, { at: "2026-01-01T00:00:00.000Z", fromSeq: 13, toSeq: 20, saved: 1, proposals: 0, conflicts: 0, refused: 0, status: "ok" }],
  ]);
  const seen = new Set();
  globalThis.fetch = async (url, init) => {
    if (url.endsWith("/activity")) {
      const target = Number(JSON.parse(init.body)?.seq ?? 0) || 0;
      // The first probe of every turn finds nothing, so both cards keep polling.
      const first = !seen.has(target);
      seen.add(target);
      return {
        status: 200,
        ok: true,
        json: async () => ({
          ok: true,
          sessionId: "session-two",
          facts: [],
          count: 0,
          extraction: { enabled: true, queued: 0, running: true, waiting: null, retrying: null, deferred: null, settledSeq: null, lastStatus: null },
          lastRun: first ? null : runs.get(target) ?? null,
        }),
      };
    }
    return { status: 404, ok: false, json: async () => ({ ok: false }) };
  };

  const loaded = await loadCard();
  const ctx = fakeClientContext();
  loaded.apply(ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const slot = ctx.__slots.find((item) => item.spec.name === "conversation.chat.turnTail");
  const props = slot.spec.inject("session-two");
  await props.refreshTurn("session-two", 12);
  await props.refreshTurn("session-two", 20);
  // The older card scrolls away: only its own poll may stop.
  props.cancelTurn("session-two", 12);
  await new Promise((resolve) => setTimeout(resolve, 4300));
  const entry = props.hooks.turn.getSnapshot().bySession["session-two"];
  assert.equal(entry?.run?.toSeq, 20, "the newest turn keeps polling after an older card unmounts");
  props.cancelTurn("session-two", 20);
});

test("the page paginates, confirms with a toast, and puts an expiry back on undo", async () => {
  const calls = [];
  const pageFacts = Array.from({ length: 100 }, (_unused, index) => ({
    id: "f-" + index,
    entity: "api",
    predicate: "端口",
    value: String(8000 + index),
    status: "active",
    evidenceLevel: "explicit_user",
    observedAt: "2026-01-01T00:00:00.000Z",
    recordRevision: 1,
  }));
  globalThis.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    calls.push({ url, body });
    if (url.endsWith("/status")) return { status: 200, ok: true, json: async () => statusPayload };
    if (url.endsWith("/facts")) {
      const items = body.query === "zzz" ? [] : body.offset === 100 ? [{ ...pageFacts[0], id: "f-last" }] : pageFacts;
      return { status: 200, ok: true, json: async () => ({ ok: true, status: "live", count: items.length, items, generation: 7 }) };
    }
    if (url.endsWith("/fact-expire"))
      return { status: 200, ok: true, json: async () => ({ ok: true, fact: { id: "f-0", status: "expired", recordRevision: 4 }, generation: 8 }) };
    if (url.endsWith("/fact-restore"))
      return { status: 200, ok: true, json: async () => ({ ok: true, fact: { id: "f-0", status: "active", recordRevision: 5 }, generation: 9 }) };
    if (url.endsWith("/fact")) return { status: 200, ok: true, json: async () => ({ ok: true, fact: { id: "f-0", entity: "api", predicate: "端口", value: "8000", status: "active", recordRevision: 5 }, history: [], sources: [] }) };
    if (url.endsWith("/proposals")) return { status: 200, ok: true, json: async () => ({ ok: true, items: [] }) };
    if (url.endsWith("/conflicts")) return { status: 200, ok: true, json: async () => ({ ok: true, groups: [] }) };
    return { status: 200, ok: true, json: async () => ({ ok: true }) };
  };

  const loaded = await loadCard();
  const ctx = fakeClientContext();
  loaded.apply(ctx);
  const pageSlot = ctx.__slots.find((slot) => slot.spec.name === "main");
  const props = pageSlot.spec.inject();
  const snap = () => props.hooks.memoryPage.getSnapshot();
  const t = ctx.locale.bind("dsh-fact-memory");
  const render = () => pageSlot.component({ ...props, t, useMemoryPage: (selector) => selector(snap()) });
  // The mount effect is what loads the first page; in this harness it runs when
  // the component renders, so render once instead of trusting a timer.
  render();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const factCalls = () => calls.filter((call) => call.url === "/api/fact-memory/facts");

  // Page one asks for an explicit window; the list is no longer capped at 200.
  const first = factCalls().at(-1);
  assert.equal(first.body.limit, 100);
  assert.equal(first.body.offset, 0);
  assert.equal(snap().facts.items.length, 100);
  assert.equal(snap().facts.hasMore, true);
  // Rendering re-runs the mount effect in this harness, which starts another
  // first-page read: let it settle before asking for the next page.
  assert.match(JSON.stringify(render()), /加载更多/);
  await new Promise((resolve) => setTimeout(resolve, 0));

  await props.actions.loadMoreFacts();
  const second = factCalls().at(-1);
  assert.equal(second.body.offset, 100, "the next page continues from what is shown");
  assert.equal(snap().facts.items.length, 101, "append, never replace");
  assert.equal(snap().facts.hasMore, false, "a short page ends the list");
  const fullText = JSON.stringify(render());
  assert.match(fullText, /共 101 条，已全部显示/);
  assert.doesNotMatch(fullText, /加载更多/);

  // An expiry is a toast with a way back, not a line that stays forever.
  await props.actions.expireFact("f-0", 3);
  assert.equal(snap().toast.key, "page.toast.expired");
  const toastElement = findElement(render(), (element) => element?.type?.name === "ToastView");
  const toastText = JSON.stringify(toastElement.type(toastElement.props));
  assert.match(toastText, /已标记失效/);
  assert.match(toastText, /撤销/);
  await props.actions.runUndo();
  const restore = calls.filter((call) => call.url === "/api/fact-memory/fact-restore").at(-1);
  assert.ok(restore, "undo calls the restore route");
  assert.equal(restore.body.factId, "f-0");
  assert.equal(restore.body.expectedRevision, 4, "undo carries the revision the expiry produced");
  assert.equal(snap().toast.key, "page.toast.restored");

  // Search tells the user what to do when nothing matches.
  await props.actions.setSearch("zzz");
  const emptyText = JSON.stringify(render());
  assert.match(emptyText, /没有匹配的事实/);
  assert.match(emptyText, /清空搜索/);
  assert.match(emptyText, /最近搜索/, "the search is remembered as a chip");
});

test("the queue says what arrived since the last visit and lists an audit card's rows", async () => {
  const calls = [];
  const digestStatus = {
    ...statusPayload,
    proposals: { pending: 4 },
    audit: {
      lastRun: { status: "ok", findings: 4, proposals: 4, at: "2026-11-14T00:00:00.000Z" },
      enabled: true,
      intervalMs: 21600000,
      running: false,
      lastError: "",
      lastResult: null,
      open: [],
      byAction: {},
    },
    review: { pending: 4, seenAt: null, newCount: 4, newByKind: { audit: 4 } },
  };
  const auditCard = {
    id: "p-audit",
    kind: "audit",
    action: "fold_log",
    entity: "dsh",
    predicate: "备份结果",
    value: "3 条同一流水线（只有日期不同），可合并为一条并保留历史",
    current: null,
    revision: 1,
    confidence: 0.5,
    reason: "体检发现：3 条同一流水线",
    targets: [
      { factId: "f-keep", role: "keep", value: "OK 备份 2026-11-13 00:00" },
      { factId: "f-drop", role: "drop", value: "OK 备份 2026-11-09 00:00" },
    ],
    details: [
      { kind: "fact", role: "keep", factId: "f-keep", value: "OK 备份 2026-11-13 00:00", observedAt: "2026-11-13T00:00:00.000Z", status: "active" },
      { kind: "fact", role: "drop", factId: "f-drop", value: "OK 备份 2026-11-09 00:00", observedAt: "2026-11-09T00:00:00.000Z", status: "active" },
    ],
  };
  globalThis.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    calls.push({ url, body });
    if (url.endsWith("/status")) return { status: 200, ok: true, json: async () => digestStatus };
    if (url.endsWith("/proposals")) return { status: 200, ok: true, json: async () => ({ ok: true, count: 1, status: "pending", items: [auditCard] }) };
    if (url.endsWith("/facts")) return { status: 200, ok: true, json: async () => ({ ok: true, status: "live", count: 0, items: [], generation: 7 }) };
    if (url.endsWith("/conflicts")) return { status: 200, ok: true, json: async () => ({ ok: true, groups: [] }) };
    return { status: 200, ok: true, json: async () => ({ ok: true }) };
  };

  const loaded = await loadCard();
  const ctx = fakeClientContext();
  loaded.apply(ctx);
  const pageSlot = ctx.__slots.find((slot) => slot.spec.name === "main");
  const props = pageSlot.spec.inject();
  const snap = () => props.hooks.memoryPage.getSnapshot();
  const t = ctx.locale.bind("dsh-fact-memory");
  const render = () => pageSlot.component({ ...props, t, useMemoryPage: (selector) => selector(snap()) });
  render();
  await new Promise((resolve) => setTimeout(resolve, 0));

  await props.actions.setTab("proposals");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const tree = render();
  const text = JSON.stringify(tree);
  // The count is a snapshot: marking the queue seen does not erase the line.
  assert.match(text, /自你上次查看后新增 4 条提案/);
  assert.match(text, /体检整理 4/);
  // The card body is its own component; the harness does not descend into one,
  // so call it the way the renderer would.
  const cardElement = findElement(tree, (element) => element?.props?.proposal?.id === "p-audit");
  assert.ok(cardElement, "the audit card was rendered");
  const cardText = JSON.stringify(cardElement.type(cardElement.props));
  assert.match(cardText, /OK 备份 2026-11-13 00:00/, "the card lists its rows, not a current → value diff");
  assert.match(cardText, /保留这条/);
  assert.match(cardText, /剔除这条/);
  assert.doesNotMatch(text, /"className":"FM_pgDiff"/, "an aggregated card has no current → value diff");
  assert.notEqual(snap().reviewDigest, null);
  assert.ok(
    calls.some((call) => call.url === "/api/fact-memory/review-seen"),
    "opening the queue marks it read",
  );

  await props.actions.pruneProposal("p-audit", ["f-drop"]);
  const prune = calls.filter((call) => call.url === "/api/fact-memory/proposal-prune").at(-1);
  assert.ok(prune, "striking a row out goes through its own route");
  assert.deepEqual(prune.body.dropFactIds, ["f-drop"]);

  // Leaving the tab drops the snapshot: coming back shows nothing stale.
  await props.actions.setTab("facts");
  assert.equal(snap().reviewDigest, null);
});

test("an empty library teaches one thing to say instead of showing a blank box", async () => {
  globalThis.fetch = async (url) => {
    if (url.endsWith("/status")) return { status: 200, ok: true, json: async () => statusPayload };
    if (url.endsWith("/facts")) return { status: 200, ok: true, json: async () => ({ ok: true, status: "live", count: 0, items: [], generation: 1 }) };
    if (url.endsWith("/proposals")) return { status: 200, ok: true, json: async () => ({ ok: true, items: [] }) };
    if (url.endsWith("/conflicts")) return { status: 200, ok: true, json: async () => ({ ok: true, groups: [] }) };
    return { status: 200, ok: true, json: async () => ({ ok: true }) };
  };
  const loaded = await loadCard();
  const ctx = fakeClientContext();
  loaded.apply(ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const pageSlot = ctx.__slots.find((slot) => slot.spec.name === "main");
  const props = pageSlot.spec.inject();
  const t = ctx.locale.bind("dsh-fact-memory");
  const snap = () => props.hooks.memoryPage.getSnapshot();
  const tree = pageSlot.component({ ...props, t, useMemoryPage: (selector) => selector(snap()) });
  const emptyElement = findElement(tree, (element) => element?.type?.name === "EmptyState");
  assert.ok(emptyElement, "an empty library still renders a panel");
  const emptyTree = emptyElement.type(emptyElement.props);
  const text = JSON.stringify(emptyTree);
  assert.match(text, /可以这样让它记住/);
  assert.match(text, /记住：我偏好中文回答/, "a concrete sentence, not a command name");
  assert.match(text, /复制示例/);
  const copy = findElement(emptyTree, (element) => element?.props?.children === "复制示例" && typeof element.props.onClick === "function");
  Object.defineProperty(globalThis.navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true });
  copy.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(props.hooks.memoryPage.getSnapshot().toast.key, "page.toast.copied");
});

test("an entity detail renders its name as text, never as an object", async () => {
  // The store hands back the whole entity row; the page renders it as a title.
  // A row reaching React as a child throws "Objects are not valid as a React
  // child" and blanked the whole page, so this payload is the regression.
  globalThis.fetch = async (url) => {
    if (url.endsWith("/entity")) {
      return {
        status: 200,
        ok: true,
        json: async () => ({
          ok: true,
          entity: { id: "e1", name: "api", type: "service", scope: "global", aliases: [], status: "active" },
          facts: [{ id: "f1", entity: "api", predicate: "端口", value: "8080", status: "active" }],
        }),
      };
    }
    if (url.endsWith("/status")) return { status: 200, ok: true, json: async () => statusPayload };
    return { status: 200, ok: true, json: async () => ({ ok: true }) };
  };
  const loaded = await loadCard();
  const ctx = fakeClientContext();
  loaded.apply(ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const pageSlot = ctx.__slots.find((slot) => slot.spec.name === "main");
  const pageProps = pageSlot.spec.inject();
  await pageProps.actions.openEntity("api");
  const snapshot = pageProps.hooks.memoryPage.getSnapshot();
  assert.equal(snapshot.detail.kind, "entity");
  const t = ctx.locale.bind("dsh-fact-memory");
  const tree = pageSlot.component({ ...pageProps, t, useMemoryPage: (selector) => selector(snapshot) });
  const railElement = findElement(tree, (element) => element?.type?.name === "EntityDetail");
  assert.ok(railElement, "the entity detail must mount");
  const railTree = railElement.type(railElement.props);
  assert.equal(findObjectChild(railTree), null, "no plain object may sit where React expects a child");
  const title = findElement(railTree, (element) => element?.props?.className === "FM_pgEntityLg");
  assert.ok(title, "the rail carries the entity title");
  assert.equal(typeof title.props.children, "string", "a React child may not be an object");
  assert.equal(title.props.children, "api");
  // The payload may also carry a plain name (older stores); it must render too.
  const plainTree = railElement.type({ ...railElement.props, detail: { ...railElement.props.detail, data: { ...railElement.props.detail.data, entity: "api" } } });
  const plainTitle = findElement(plainTree, (element) => element?.props?.className === "FM_pgEntityLg");
  assert.equal(plainTitle.props.children, "api");
});

test("a slower older search cannot overwrite the newer result", async () => {
  const pending = [];
  globalThis.fetch = (url, init) => {
    if (url.endsWith("/facts")) {
      const body = init && init.body ? JSON.parse(init.body) : {};
      return new Promise((resolve) => pending.push({ body, resolve }));
    }
    if (url.endsWith("/status")) return Promise.resolve({ status: 200, ok: true, json: async () => statusPayload });
    return Promise.resolve({ status: 200, ok: true, json: async () => ({ ok: true, items: [] }) });
  };
  const loaded = await loadCard();
  const ctx = fakeClientContext();
  loaded.apply(ctx);
  const pageSlot = ctx.__slots.find((slot) => slot.spec.name === "main");
  const props = pageSlot.spec.inject();
  const snap = () => props.hooks.memoryPage.getSnapshot();

  const older = props.actions.setSearch("a");
  const newer = props.actions.setSearch("ab");
  assert.equal(pending.length, 2, "both searches were sent");
  assert.equal(pending[1].body.query, "ab");

  pending[1].resolve({
    status: 200,
    ok: true,
    json: async () => ({ ok: true, items: [{ id: "b", entity: "api", predicate: "端口", value: "2", status: "active" }] }),
  });
  await newer;
  pending[0].resolve({
    status: 200,
    ok: true,
    json: async () => ({ ok: true, items: [{ id: "a", entity: "api", predicate: "端口", value: "1", status: "active" }] }),
  });
  await older;

  assert.deepEqual(snap().facts.items.map((item) => item.id), ["b"], "the late answer is dropped");
  assert.equal(snap().query, "ab");
});

test("a late detail answer cannot replace the newer one or reopen a closed pane", async () => {
  const pending = [];
  globalThis.fetch = (url, init) => {
    if (url.endsWith("/fact")) {
      const body = init && init.body ? JSON.parse(init.body) : {};
      return new Promise((resolve) => pending.push({ body, resolve }));
    }
    if (url.endsWith("/status")) return Promise.resolve({ status: 200, ok: true, json: async () => statusPayload });
    return Promise.resolve({ status: 200, ok: true, json: async () => ({ ok: true, items: [] }) });
  };
  const loaded = await loadCard();
  const ctx = fakeClientContext();
  loaded.apply(ctx);
  const pageSlot = ctx.__slots.find((slot) => slot.spec.name === "main");
  const props = pageSlot.spec.inject();
  const snap = () => props.hooks.memoryPage.getSnapshot();

  const older = props.actions.openFact("a");
  const newer = props.actions.openFact("b");
  assert.equal(pending.length, 2);
  pending[1].resolve({ status: 200, ok: true, json: async () => ({ ok: true, fact: { id: "b" } }) });
  await newer;
  pending[0].resolve({ status: 200, ok: true, json: async () => ({ ok: true, fact: { id: "a" } }) });
  await older;
  assert.equal(snap().detail.data.fact.id, "b", "the late answer is dropped");

  const closed = props.actions.openFact("c");
  props.actions.closeDetail();
  pending[2].resolve({ status: 200, ok: true, json: async () => ({ ok: true, fact: { id: "c" } }) });
  await closed;
  assert.equal(snap().detail, null, "closing wins over an in-flight read");
});

test("a late graph read cannot replace the newer selection", async () => {
  const pending = [];
  globalThis.fetch = (url) => {
    if (url.endsWith("/graph")) return new Promise((resolve) => pending.push(resolve));
    if (url.endsWith("/status")) return Promise.resolve({ status: 200, ok: true, json: async () => statusPayload });
    return Promise.resolve({ status: 200, ok: true, json: async () => ({ ok: true, items: [] }) });
  };
  const loaded = await loadCard();
  const ctx = fakeClientContext();
  loaded.apply(ctx);
  const pageSlot = ctx.__slots.find((slot) => slot.spec.name === "main");
  const props = pageSlot.spec.inject();
  const snap = () => props.hooks.memoryPage.getSnapshot();

  const older = props.actions.loadGraph("a", "current");
  const newer = props.actions.loadGraph("b", "current");
  assert.equal(pending.length, 2);
  pending[1]({ status: 200, ok: true, json: async () => ({ ok: true, nodes: [{ id: "e:b" }], edges: [] }) });
  await newer;
  pending[0]({ status: 200, ok: true, json: async () => ({ ok: true, nodes: [{ id: "e:a" }], edges: [] }) });
  await older;

  const graph = snap().graph;
  assert.equal(graph.entity, "b", "the late answer must not put its subject back");
  assert.equal(graph.data.nodes[0].id, "e:b");
});

test("undoing a proposal that replaced an older value puts the old value back", async () => {
  const calls = [];
  globalThis.fetch = (url, options = {}) => {
    calls.push({ url: String(url), body: String(options.body ?? "") });
    if (url.endsWith("/proposal-apply")) {
      return Promise.resolve({ status: 200, ok: true, json: async () => ({ ok: true, factId: "f-new", written: "superseded", previousValue: "8080" }) });
    }
    if (url.endsWith("/fact-update")) {
      return Promise.resolve({ status: 200, ok: true, json: async () => ({ ok: true, factId: "f-restored", fact: { id: "f-restored", recordRevision: 6, value: "8080" } }) });
    }
    if (url.endsWith("/fact")) {
      return Promise.resolve({ status: 200, ok: true, json: async () => ({ ok: true, fact: { id: "f-new", recordRevision: 5, value: "9090" } }) });
    }
    if (url.endsWith("/status")) return Promise.resolve({ status: 200, ok: true, json: async () => statusPayload });
    return Promise.resolve({ status: 200, ok: true, json: async () => ({ ok: true, items: [], count: 0 }) });
  };
  const loaded = await loadCard();
  const ctx = fakeClientContext();
  loaded.apply(ctx);
  const pageSlot = ctx.__slots.find((slot) => slot.spec.name === "main");
  const props = pageSlot.spec.inject();

  await props.actions.acceptProposal("p1");
  const toast = props.hooks.memoryPage.getSnapshot().toast;
  assert.ok(toast?.undo, "a replaced value can be put back");
  await toast.undo();

  const update = calls.find((call) => call.url.endsWith("/fact-update"));
  assert.ok(update, "the old value is written back");
  assert.match(update.body, /"value":"8080"/);
  assert.match(update.body, /"expectedRevision":5/);
});
