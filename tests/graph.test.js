import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { MemoryStore } from "../src/store.js";
import { edgeFacts, graphNebula, graphNeighborhood, graphStats } from "../src/graph.js";

const dirs = [];
function seeded() {
  const dir = mkdtempSync(join(tmpdir(), "fm-graph-"));
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
    entity: { name: "api", type: "service" },
    predicate: "路径",
    value: "/srv/api",
    cardinality: "single",
    evidenceLevel: "explicit_user",
    observedAt: "2026-01-02T00:00:00.000Z",
  });
  store.writeFact({
    entity: { name: "user", type: "person" },
    predicate: "偏好",
    value: "中文回答",
    cardinality: "multi",
    evidenceLevel: "explicit_user",
    observedAt: "2026-01-03T00:00:00.000Z",
  });
  // A conflict is created on purpose: the default view must not show it as a
  // confirmed relation.
  store.writeFact({
    entity: { name: "api", type: "service" },
    predicate: "端口",
    value: "9090",
    cardinality: "single",
    evidenceLevel: "observed",
    observedAt: "2026-01-04T00:00:00.000Z",
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

test("one entity's facts become a neighborhood with evidence on every edge", () => {
  const store = seeded();
  const graph = graphNeighborhood(store, { entity: "api" });
  assert.deepEqual(graph.seeds, ["api"]);
  const entityNodes = graph.nodes.filter((node) => node.kind === "entity");
  assert.equal(entityNodes.length, 1);
  assert.equal(entityNodes[0].label, "api");
  // C.5.8: every row in an open conflict group is `conflict`, so neither side
  // of the port argument may appear as a confirmed relation.
  const values = graph.edges.map((edge) => graph.nodes.find((node) => node.id === edge.target)?.label);
  assert.ok(values.includes("/srv/api"));
  assert.equal(values.includes("8080"), false);
  assert.equal(values.includes("9090"), false);
  for (const edge of graph.edges) {
    assert.ok(edge.factIds.length >= 1);
    assert.equal(edge.status, "active");
    assert.equal(edge.confirmed, true);
    const facts = edgeFacts(store, edge.factIds);
    assert.equal(facts.length, edge.factIds.length);
  }
  store.close();
});

test("the history view shows the unresolved conflict edge", () => {
  const store = seeded();
  const graph = graphNeighborhood(store, { entity: "api", view: "all" });
  const conflict = graph.edges.find((edge) => edge.status === "conflict");
  assert.ok(conflict, "expected a conflict edge in view=all");
  assert.equal(conflict.confirmed, false);
  store.close();
});

test("an unknown entity yields an empty graph instead of throwing", () => {
  const store = seeded();
  const graph = graphNeighborhood(store, { entity: "nobody" });
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.edges, []);
  store.close();
});

test("the whole-store view is bounded and reports what it dropped", () => {
  const store = seeded();
  const busy = graphNeighborhood(store, { maxNodes: 2, maxEdges: 1 });
  assert.ok(busy.nodes.length <= 2);
  assert.ok(busy.edges.length <= 1);
  assert.ok(busy.truncated.nodes > 0 || busy.truncated.edges > 0);
  assert.equal(graphStats(store).entities, 2);
  store.close();
});

test("forgotten facts leave the graph", () => {
  const store = seeded();
  const before = graphNeighborhood(store, { entity: "user" });
  assert.equal(before.edges.length, 1);
  const factId = before.edges[0].factIds[0];
  store.forget({ factId, scope: "global", reasonCode: "user_request", originStoreId: store.meta.storeId, namespace: "tool" });
  const after = graphNeighborhood(store, { entity: "user" });
  assert.deepEqual(after.edges, []);
  store.close();
});
test("the nebula projection merges every visible fact into one bounded graph", () => {
  const store = seeded();
  const graph = graphNebula(store, { view: "current" });
  assert.equal(graph.mode, "nebula");
  assert.deepEqual(graph.seeds, ["api", "user"]);
  const entityNodes = graph.nodes.filter((node) => node.kind === "entity");
  const valueNodes = graph.nodes.filter((node) => node.kind === "value");
  assert.equal(entityNodes.length, 2);
  assert.equal(valueNodes.length, 2, "only values used by a visible fact become nodes");
  for (const node of graph.nodes) {
    assert.match(node.id, /^(e|v):/);
    assert.ok(node.label.length > 0);
    assert.ok(node.factCount >= 1);
    assert.equal(node.status, "active", "the current view carries no conflict rows");
    assert.ok(node.degree >= 1, "every kept node is attached to a kept edge");
  }
  assert.deepEqual(graph.totals, { nodes: 4, edges: 2 });
  assert.deepEqual(graph.truncated, { nodes: 0, edges: 0 });
  const keys = new Set(graph.edges.map((edge) => edge.source + "|" + edge.predicate + "|" + edge.target));
  assert.equal(keys.size, graph.edges.length, "edges are aggregated by (source, predicate, target)");
  for (const edge of graph.edges) {
    assert.ok(edge.factIds.length >= 1, "every edge keeps the facts that justify it");
    assert.equal(edge.factCount, edge.factIds.length);
    assert.equal(edge.status, "active");
  }
  store.close();
});

test("a value used by two subjects is one shared node with two edges", () => {
  const store = seeded();
  // Same value on a second subject: the nebula must merge it into one value
  // node instead of drawing the same star twice.
  store.writeFact({
    entity: { name: "user", type: "person" },
    predicate: "端口",
    value: "8080",
    cardinality: "single",
    evidenceLevel: "explicit_user",
    observedAt: "2026-01-05T00:00:00.000Z",
  });
  const graph = graphNebula(store, { view: "all" });
  const shared = graph.nodes.find((node) => node.id === "v:8080");
  assert.ok(shared, "the shared value is one node");
  assert.equal(shared.factCount, 2);
  assert.equal(shared.status, "conflict", "the worst backing fact wins");
  const entities = graph.nodes.filter((node) => node.kind === "entity");
  assert.equal(entities.length, 2);
  const toShared = graph.edges.filter((edge) => edge.target === "v:8080");
  assert.equal(toShared.length, 2, "both subjects keep their own edge to the shared value");
  store.close();
});

test("the nebula current view hides conflict rows the all view shows", () => {
  const store = seeded();
  const current = graphNebula(store, { view: "current" });
  assert.equal(current.edges.some((edge) => edge.status === "conflict"), false);
  const all = graphNebula(store, { view: "all" });
  const conflict = all.edges.find((edge) => edge.status === "conflict");
  assert.ok(conflict, "expected the unresolved port argument");
  assert.equal(conflict.predicate, "端口");
  const target = all.nodes.find((node) => node.id === conflict.target);
  assert.equal(target.kind, "value");
  assert.equal(target.status, "conflict");
  assert.ok(all.totals.nodes > current.totals.nodes);
  store.close();
});

test("the nebula projection is bounded and reports what it dropped", () => {
  const store = seeded();
  const busy = graphNebula(store, { view: "current", maxNodes: 2, maxEdges: 1 });
  assert.equal(busy.nodes.length, 2);
  assert.ok(busy.edges.length <= 1);
  assert.ok(busy.truncated.nodes > 0 || busy.truncated.edges > 0);
  assert.ok(busy.totals.nodes >= busy.nodes.length);
  assert.ok(busy.totals.edges >= busy.edges.length);
  store.close();
});

test("a named entity scopes the nebula, and sensitive facts stay out unless asked", () => {
  const store = seeded();
  store.writeFact({
    entity: { name: "api", type: "service" },
    predicate: "内部编号",
    value: "内部编号-42",
    cardinality: "single",
    evidenceLevel: "explicit_user",
    privacyClass: "sensitive",
    modelUseAllowed: false,
    observedAt: "2026-01-06T00:00:00.000Z",
  });
  const hidden = graphNebula(store, { entity: "api", view: "current" });
  assert.deepEqual(hidden.seeds, ["api"]);
  assert.equal(hidden.nodes.some((node) => node.label === "内部编号-42"), false);
  const visible = graphNebula(store, { entity: "api", view: "current", includeSensitive: true });
  assert.ok(visible.nodes.some((node) => node.label === "内部编号-42"));
  assert.ok(visible.edges.some((edge) => edge.predicate === "内部编号"));
  store.close();
});
