import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

/**
 * The panel is only ever rendered by the host, so a missing helper or a typo in
 * an action name would ship silently: node --check parses it and the controller
 * tests never call it. This lifts the component out of the bundle and calls it
 * with representative states, which is the closest thing to a render without a
 * DOM.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "client.js"), "utf8");

function liftDreamPanel() {
  const start = source.indexOf("function DreamPanel(");
  assert.ok(start > 0, "DreamPanel exists");
  const end = source.indexOf("function MemoryPage(", start);
  assert.ok(end > start, "DreamPanel has an end");
  // The panel closes over one module constant; it has to come along.
  const constAt = source.lastIndexOf("const DREAM_BODY_PREVIEW", start);
  const body = (constAt > 0 ? source.slice(constAt, source.indexOf(";", constAt) + 1) + "\n" : "") + source.slice(start, end).trim();
  const jsx = (type, props) => ({ type, props });
  const jsxs = jsx;
  const factory = new Function("jsx", "jsxs", "Glyph", "shortTime", body + "\nreturn DreamPanel;");
  return factory(jsx, jsxs, () => null, (value) => String(value ?? ""));
}

const DreamPanel = liftDreamPanel();
const t = (key) => key;
const noop = () => {};

function actions() {
  return {
    acceptDream: noop,
    rejectDream: noop,
    editDream: noop,
    toggleDream: noop,
    toggleDreamNote: noop,
    setDreamDraft: noop,
    setDreamFocus: noop,
    runDream: noop,
    loadDreams: noop,
    backfillDream: noop,
    restoreDream: noop,
    setDreamBackfill: noop,
  };
}

const base = { loading: false, error: null, focus: "", busy: "", open: "", draftTitle: "", draftBody: "", notice: null, confirmBackfill: false };

test("the dream panel renders every state without a missing helper", () => {
  // Loading, disabled, and the full state with all sections present.
  assert.ok(DreamPanel({ dream: { ...base, loading: true }, t, zone: undefined, actions: actions() }));
  assert.ok(DreamPanel({ dream: { ...base, data: { enabled: false } }, t, zone: undefined, actions: actions() }));
  const row = {
    id: "d1",
    topicKey: "k",
    title: "标题",
    body: "正文",
    novelty: "high",
    unverified: true,
    sources: [{ sessionId: "s" }],
    createdAt: "2026-11-10T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z",
    validFrom: "2026-11-01T00:00:00.000Z",
    validTo: "2026-11-09T00:00:00.000Z",
    hitCount: 2,
  };
  const full = {
    enabled: true,
    paused: true,
    line: "状态行",
    index: [{ topicKey: "k", title: "标题", hitCount: 2, validFrom: "2026-11-01T00:00:00.000Z" }],
    pending: [row],
    active: [row],
    archived: [row],
    counts: { pending: 1, active: 3, archived: 1 },
    archiveAfterDays: 90,
    backfillMaxSessions: 50,
    backfillMaxChars: 200000,
  };
  assert.ok(DreamPanel({ dream: { ...base, data: full }, t, zone: "Asia/Shanghai", actions: actions() }));
  assert.ok(DreamPanel({ dream: { ...base, data: full, confirmBackfill: true, notice: { code: "page.dream.ran", params: { accepted: 1, dropped: 0 } } }, t, zone: undefined, actions: actions() }));
  assert.ok(DreamPanel({ dream: { ...base, data: full, busy: "backfill", open: "d1" }, t, zone: undefined, actions: actions() }));
  assert.ok(DreamPanel({ dream: { ...base, data: null, error: "boom" }, t, zone: undefined, actions: actions() }));
});

test("an accepted note shows its title until it is opened", () => {
  const calls = [];
  const act = { ...actions(), toggleDreamNote: (id) => calls.push(id) };
  const note = {
    id: "d1",
    topicKey: "release-process",
    title: "发布改成两步走",
    body: "预发环境跑完整回归。",
    topics: ["发布流程"],
    novelty: "high",
    unverified: false,
    sources: [{ sessionId: "sess-1", label: "S1", fromSeq: 3, toSeq: 9 }],
    createdAt: "2026-11-10T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z",
    validFrom: "2026-11-01T00:00:00.000Z",
    hitCount: 2,
    readCount: 1,
  };
  const data = {
    enabled: true,
    active: [note],
    pending: [],
    index: [{ topicKey: "release-process", title: "发布改成两步走", hitCount: 2, readCount: 1 }],
    archived: [],
    counts: { pending: 0, active: 1, archived: 0 },
    archiveAfterDays: 90,
  };
  const scan = (node, texts, heads) => {
    if (!node || typeof node !== "object") return;
    const props = node.props ?? {};
    if (typeof props.children === "string") texts.push(props.children);
    if (typeof props.className === "string" && props.className.startsWith("FM_pgDreamRow")) heads.push(props);
    const kids = props.children;
    if (Array.isArray(kids)) kids.forEach((kid) => scan(kid, texts, heads));
    else if (kids !== undefined) scan(kids, texts, heads);
  };

  // Closed: the title is enough to decide; sixteen three-hundred-character
  // previews are not a library, they are a wall.
  const texts = [];
  const heads = [];
  scan(DreamPanel({ dream: { ...base, data }, t, zone: "Asia/Shanghai", actions: act }), texts, heads);
  assert.ok(texts.includes("发布改成两步走"), "the title is on the page");
  assert.ok(!texts.includes("预发环境跑完整回归。"), "the prose waits for a click");
  const rows = heads.filter((props) => props.role === "button");
  assert.equal(rows.length, 1, "the accepted note has one clickable row");
  assert.equal(rows[0]["aria-expanded"], false);
  // Accepted notes come before the review queue and before the topic index.
  const order = texts.filter((text) => text === "page.dream.activeTitle" || text === "page.dream.indexTitle" || text === "page.dream.pendingTitle");
  assert.deepEqual(order, ["page.dream.activeTitle", "page.dream.pendingTitle", "page.dream.indexTitle"]);

  rows[0].onClick();
  assert.deepEqual(calls, ["d1"], "clicking the row asks the controller to open this note");

  // Opened: the prose, the key, the date and the source range all arrive.
  const openTexts = [];
  const openHeads = [];
  scan(DreamPanel({ dream: { ...base, data, openNote: "d1" }, t, zone: "Asia/Shanghai", actions: act }), openTexts, openHeads);
  assert.ok(openTexts.includes("预发环境跑完整回归。"), "the prose arrives with the click");
  assert.ok(openTexts.includes("page.dream.detailMeta"));
  assert.ok(openTexts.includes("page.dream.sourceLine"));
  assert.ok(openTexts.includes("page.dream.topics"));
  assert.equal(openHeads.filter((props) => props.role === "button")[0]["aria-expanded"], true);
});

test("fifteen notes and ten index rows per page, with real page numbers", () => {
  const calls = [];
  const act = { ...actions(), setDreamPage: (kind, page) => calls.push(kind + ":" + page) };
  const note = (n) => ({
    id: "d" + n,
    topicKey: "topic-" + n,
    title: "笔记 " + n,
    body: "正文 " + n,
    createdAt: "2026-11-10T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z",
    hitCount: 0,
    readCount: 0,
  });
  const data = {
    enabled: true,
    active: Array.from({ length: 16 }, (_unused, index) => note(index + 1)),
    pending: [],
    index: Array.from({ length: 12 }, (_unused, index) => ({ topicKey: "topic-" + (index + 1), title: "主题 " + (index + 1), hitCount: 0, readCount: 0 })),
    archived: [],
    counts: { pending: 0, active: 16, archived: 0 },
    archiveAfterDays: 90,
  };
  const collect = (node, texts, pagers) => {
    if (!node || typeof node !== "object") return;
    const props = node.props ?? {};
    if (typeof props.children === "string") texts.push(props.children);
    if (props.className === "FM_pgPager") pagers.push(props);
    const kids = props.children;
    if (Array.isArray(kids)) kids.forEach((kid) => collect(kid, texts, pagers));
    else if (kids !== undefined) collect(kids, texts, pagers);
  };

  const texts = [];
  const pagers = [];
  collect(DreamPanel({ dream: { ...base, data }, t, zone: "Asia/Shanghai", actions: act }), texts, pagers);
  assert.ok(texts.includes("笔记 15"), "page one ends on the fifteenth note");
  assert.ok(!texts.includes("笔记 16"), "the sixteenth note waits for page two");
  assert.ok(texts.includes("主题 10"), "the index shows ten rows");
  assert.ok(!texts.includes("主题 11"), "the eleventh topic waits for page two");
  assert.equal(pagers.length, 2, "both lists have a pager");

  // The page-two render is driven by state, so the second page is reachable.
  const pageTwo = [];
  collect(DreamPanel({ dream: { ...base, data, notePage: 2, indexPage: 2 }, t, zone: "Asia/Shanghai", actions: act }), pageTwo, []);
  assert.ok(pageTwo.includes("笔记 16"), "page two carries the last note");
  assert.ok(!pageTwo.includes("笔记 1"), "page two does not repeat page one");
  assert.ok(pageTwo.includes("主题 11"), "page two carries the rest of the index");

  // Numbered buttons, not a "load more": page two is one click away.
  const flat = (kids) => (Array.isArray(kids) ? kids : [kids]);
  const buttons = [];
  const findButtons = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "button" && typeof node.props?.children === "string") buttons.push(node);
    const kids = node.props?.children;
    if (Array.isArray(kids)) kids.forEach(findButtons);
    else if (kids !== undefined) findButtons(kids);
  };
  findButtons(DreamPanel({ dream: { ...base, data }, t, zone: "Asia/Shanghai", actions: act }));
  const second = buttons.find((node) => node.props.children === "2");
  assert.ok(second, "a numbered page button exists");
  assert.equal(flat(second.props.className).join(""), "FM_pgPagerBtn");
  assert.deepEqual(calls, [], "rendering alone turns no page");
  second.props.onClick();
  assert.deepEqual(calls, ["note:2"], "clicking 2 asks the controller for page two");
  const current = buttons.find((node) => node.props.className === "FM_pgPagerBtn FM_pgPagerBtnOn");
  assert.equal(current.props.children, "1", "page one is marked as the current page");

  // The archive is paged the same way, and its rows open nothing: they are
  // history, kept readable but not editable in place.
  const archived = {
    ...data,
    archived: Array.from({ length: 12 }, (_unused, index) => ({ id: "a" + (index + 1), topicKey: "old-" + (index + 1), title: "旧笔记 " + (index + 1), updatedAt: "2026-09-01T00:00:00.000Z" })),
    counts: { pending: 0, active: 16, archived: 12 },
  };
  const archivedTexts = [];
  const archivedPagers = [];
  collect(DreamPanel({ dream: { ...base, data: archived }, t, zone: "Asia/Shanghai", actions: act }), archivedTexts, archivedPagers);
  assert.ok(archivedTexts.includes("旧笔记 10"), "the archive shows ten rows");
  assert.ok(!archivedTexts.includes("旧笔记 11"), "the eleventh archived note waits for page two");
  assert.equal(archivedPagers.length, 3, "all three lists have a pager");
});
