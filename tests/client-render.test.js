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
