import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { MemoryStore } from "../src/store.js";
import { directoryLines, formatFact, renderHits, search } from "../src/retrieve.js";

const dirs = [];
function seeded() {
  const dir = mkdtempSync(join(tmpdir(), "fm-retrieve-"));
  dirs.push(dir);
  const store = MemoryStore.open({ dataDir: dir });
  store.writeFact({
    entity: { name: "api", type: "service" },
    predicate: "端口",
    value: "8080",
    cardinality: "single",
    evidenceLevel: "explicit_user",
    observedAt: "2026-01-01T00:00:00.000Z",
  });
  store.writeFact({
    entity: { name: "fact-memory", type: "project" },
    predicate: "路径",
    value: "/srv/fact-memory",
    cardinality: "single",
    observedAt: "2026-01-01T00:00:00.000Z",
  });
  store.writeFact({
    entity: { name: "user", type: "person" },
    predicate: "时区",
    value: "Asia/Shanghai",
    cardinality: "single",
    evidenceLevel: "explicit_user",
    observedAt: "2026-01-01T00:00:00.000Z",
  });
  store.writeFact({
    entity: { name: "user", type: "person" },
    predicate: "手机号",
    value: "13800138000",
    privacyClass: "sensitive",
    modelUseAllowed: false,
    evidenceLevel: "explicit_user",
    observedAt: "2026-01-01T00:00:00.000Z",
  });
  return store;
}
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* disposable temp dir */
    }
  }
});

test("chinese keyword and identifier queries both reach the fact", async () => {
  const store = seeded();
  const byWord = await search(store, { query: "端口" });
  assert.ok(byWord.channels.fts > 0);
  assert.equal(byWord.items[0].predicate, "端口");
  const byPath = await search(store, { query: "/srv/fact-memory" });
  assert.ok(byPath.items.some((fact) => fact.value === "/srv/fact-memory"));
  assert.ok(byPath.channels.identifier > 0);
  assert.deepEqual((await search(store, { query: "不存在的词" })).items, []);
  store.close();
});

test("sensitive facts never enter model-facing recall", async () => {
  const store = seeded();
  assert.deepEqual((await search(store, { query: "手机号 13800138000" })).items, []);
  assert.equal(directoryLines(store).some((fact) => String(fact.value).includes("13800138000")), false);
  store.close();
});

test("rendering is budgeted and each line keeps its id", async () => {
  const store = seeded();
  const { items } = await search(store, { query: "端口", limit: 5 });
  const text = renderHits(items, { maxChars: 60 });
  assert.ok(Array.from(text).length <= 60);
  const line = formatFact(items[0]);
  assert.match(line, /api/);
  assert.match(line, /8080/);
  assert.match(line, /〔[0-9a-f]{8}〕/);
  store.close();
});

test("limit and scope are enforced", async () => {
  const store = seeded();
  assert.equal((await search(store, { query: "端口", limit: 1 })).items.length, 1);
  store.writeFact({
    entity: { name: "api", type: "service" },
    predicate: "技术栈",
    value: "python",
    scope: "session:x",
    observedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal((await search(store, { query: "python", scope: "session:x" })).items.length, 1);
  assert.deepEqual((await search(store, { query: "python", scope: "session:y" })).items, []);
  store.close();
});
