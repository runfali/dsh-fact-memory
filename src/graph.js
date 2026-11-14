/**
 * The fact graph is a projection, never a second truth source: every edge is
 * derived from one or more facts and carries their ids, so a click on an edge
 * goes straight back to the evidence. When a fact is superseded, forgotten or in
 * conflict, its edge changes with it — there is nothing to reconcile.
 *
 * Nodes come in two kinds: the entity a fact is about, and the value it asserts.
 * `depth` follows value references that point at another entity, which is how a
 * project's host, port and path constraints end up in one neighborhood.
 */
import { visibleSql } from "./store.js";

const DEFAULT_MAX_NODES = 100;
const DEFAULT_MAX_EDGES = 200;

const VISIBLE = {
  current: ["active", "scheduled"],
  all: ["active", "scheduled", "conflict"],
};

function normName(text) {
  return String(text ?? "").normalize("NFKC").toLowerCase().trim();
}

function entityNode(row, factCount) {
  return { id: `e:${row.id}`, kind: "entity", label: row.name, entityId: row.id, factCount };
}

function valueNode(label, factCount) {
  return { id: `v:${normName(label)}`, kind: "value", label, factCount };
}

/**
 * @param {object} options
 * @param {string|null} options.entity  seed entity name; omit for the busiest entities
 * @param {number} options.depth        1 = seed's own facts, 2 = also entities those facts point at
 */
export function graphNeighborhood(
  store,
  { entity = null, depth = 1, view = "current", maxNodes = DEFAULT_MAX_NODES, maxEdges = DEFAULT_MAX_EDGES, includeSensitive = false } = {},
) {
  const statuses = VISIBLE[view] ?? VISIBLE.current;
  const statusSql = statuses.map(() => "?").join(",");
  const baseWhere = `f.status IN (${statusSql}) AND ${visibleSql({ alias: "f", includeSensitive })}`;

  let seedRows;
  if (entity) {
    const row = store.db.prepare("SELECT id, name FROM entities WHERE norm_name = ? AND status = 'active'").get(normName(entity));
    if (!row) return { seeds: [], nodes: [], edges: [], truncated: { nodes: 0, edges: 0 }, totals: { nodes: 0, edges: 0 } };
    seedRows = [row];
  } else {
    seedRows = store.db
      .prepare(
        `SELECT e.id AS id, e.name AS name, COUNT(*) AS count
           FROM facts f JOIN entities e ON e.id = f.entity_id
          WHERE ${baseWhere}
          GROUP BY e.id ORDER BY count DESC LIMIT 12`,
      )
      .all(...statuses);
  }
  const seedIds = new Set(seedRows.map((row) => row.id));

  const seenFactIds = new Set();
  const facts = [];
  const collect = (rows) => {
    for (const row of rows) {
      const id = row.id ?? row.fact_id;
      if (!id || seenFactIds.has(id)) continue;
      seenFactIds.add(id);
      facts.push(row);
    }
  };

  const detailFor = (ids) => `
    SELECT f.id AS id, f.entity_id AS entity_id, e.name AS entity_name, f.predicate AS predicate,
           f.value_text AS value, f.norm_text AS norm_text, f.status AS status, f.value_entity_id AS value_entity_id,
           f.evidence_level AS evidence_level, f.observed_at AS observed_at, f.updated_at AS updated_at
      FROM facts f JOIN entities e ON e.id = f.entity_id
     WHERE ${baseWhere} AND f.entity_id IN (${ids.map(() => "?").join(",")})`;

  const seedIdList = seedRows.map((row) => row.id);
  collect(store.db.prepare(`${detailFor(seedIdList)} ORDER BY f.updated_at DESC LIMIT ?`).all(...statuses, ...seedIdList, maxEdges * 2));

  if (depth >= 2) {
    const reached = new Set(facts.map((fact) => fact.value_entity_id).filter(Boolean));
    const next = [...reached].filter((id) => !seedIds.has(id));
    if (next.length > 0) {
      collect(store.db.prepare(`${detailFor(next)} ORDER BY f.updated_at DESC LIMIT ?`).all(...statuses, ...next, maxEdges));
      for (const id of next) seedIds.add(id);
    }
  }

  // A seed with no visible facts (all sensitive, all forgotten, …) is a real
  // answer — an empty neighborhood — not a SQL error. `IN ()` is invalid SQL.
  const entityIds = [...new Set(facts.map((fact) => fact.entity_id))];
  const entityRows =
    entityIds.length === 0
      ? []
      : store.db
          .prepare(`SELECT id, name FROM entities WHERE id IN (${entityIds.map(() => "?").join(",")})`)
          .all(...entityIds);

  const nodeMap = new Map();
  const entityFactCount = new Map();
  const valueFactCount = new Map();
  for (const fact of facts) {
    entityFactCount.set(fact.entity_id, (entityFactCount.get(fact.entity_id) ?? 0) + 1);
    const key = normName(fact.value);
    valueFactCount.set(key, (valueFactCount.get(key) ?? 0) + 1);
  }
  for (const row of entityRows) nodeMap.set(`e:${row.id}`, entityNode(row, entityFactCount.get(row.id) ?? 0));

  const edgeMap = new Map();
  for (const fact of facts) {
    const targetId = `v:${normName(fact.value)}`;
    const sourceId = `e:${fact.entity_id}`;
    if (!nodeMap.has(targetId)) nodeMap.set(targetId, valueNode(fact.value, valueFactCount.get(normName(fact.value)) ?? 0));
    const key = `${sourceId}|${fact.predicate}|${targetId}`;
    const edge = edgeMap.get(key) ?? {
      id: `edge:${edgeMap.size + 1}`,
      source: sourceId,
      target: targetId,
      predicate: fact.predicate,
      factIds: [],
      status: fact.status,
      evidenceLevel: fact.evidence_level,
      observedAt: fact.observed_at,
      confirmed: fact.status === "active",
    };
    edge.factIds.push(fact.id);
    // An edge backed by one confirmed fact is confirmed, even if another fact on
    // the same edge is only scheduled.
    if (fact.status === "active") edge.confirmed = true;
    if (fact.status === "conflict") edge.status = "conflict";
    else if (fact.status === "scheduled" && edge.status !== "conflict") edge.status = "scheduled";
    edge.observedAt = edge.observedAt > fact.observed_at ? edge.observedAt : fact.observed_at;
    edgeMap.set(key, edge);
  }

  const nodes = [...nodeMap.values()].slice(0, maxNodes);
  const kept = new Set(nodes.map((node) => node.id));
  const allEdges = [...edgeMap.values()];
  const edges = allEdges.filter((edge) => kept.has(edge.source) && kept.has(edge.target)).slice(0, maxEdges);

  return {
    seeds: seedRows.map((row) => row.name),
    nodes,
    edges,
    truncated: { nodes: Math.max(0, nodeMap.size - nodes.length), edges: Math.max(0, allEdges.length - edges.length) },
    totals: { nodes: nodeMap.size, edges: allEdges.length },
    view,
  };
}


// ── nebula: the whole projection, one node set for the 3D view ─────────────
// The one-hop neighborhood above is a reading tool; the nebula is a map. It
// still derives everything from facts — entity nodes on the left of a fact,
// value nodes on the right — but it merges all of them into one bounded node
// set, aggregates parallel facts into one edge, and reports what it dropped so
// the canvas can say so instead of silently lying about the shape of memory.
const NEBULA_DEFAULT_NODES = 600;
const NEBULA_DEFAULT_EDGES = 1200;
// Entities and values share maxNodes; entities cannot swallow the whole budget
// or a store with one fat entity would have no values at all.
const NEBULA_ENTITY_CAP = 300;
const STATUS_RANK = { active: 1, scheduled: 2, conflict: 3 };

function worseStatus(left, right) {
  return (STATUS_RANK[right] ?? 0) > (STATUS_RANK[left] ?? 0) ? right : left;
}

function emptyNebula() {
  return { mode: "nebula", seeds: [], nodes: [], edges: [], totals: { nodes: 0, edges: 0 }, truncated: { nodes: 0, edges: 0 } };
}

/**
 * @param {object} options
 * @param {"current"|"all"} options.view  current = active + scheduled, all = also open conflicts
 * @param {number} options.maxNodes       hard cap on returned nodes (default 600)
 * @param {number} options.maxEdges       hard cap on returned edges (default 1200)
 * @param {boolean} options.includeSensitive include personal data the model may see
 * @param {string|null} options.entity    optional: restrict to one entity's facts (the page's subject box)
 */
export function graphNebula(
  store,
  { view = "current", maxNodes = NEBULA_DEFAULT_NODES, maxEdges = NEBULA_DEFAULT_EDGES, includeSensitive = false, entity = null } = {},
) {
  const nodeBudget = Math.max(1, Math.floor(Number(maxNodes) || NEBULA_DEFAULT_NODES));
  const edgeBudget = Math.max(1, Math.floor(Number(maxEdges) || NEBULA_DEFAULT_EDGES));
  const statuses = VISIBLE[view] ?? VISIBLE.current;
  const statusSql = statuses.map(() => "?").join(",");
  const baseWhere = `f.status IN (${statusSql}) AND ${visibleSql({ alias: "f", includeSensitive })}`;

  let seedRow = null;
  if (entity) {
    seedRow = store.db
      .prepare("SELECT id, name, type, status FROM entities WHERE norm_name = ? AND status = 'active'")
      .get(normName(entity));
    if (!seedRow) return emptyNebula();
  }

  // Which entities make it onto the map: the named one, or the busiest ones.
  let entityRows;
  if (seedRow) {
    entityRows = [seedRow];
  } else {
    const entityBudget = Math.max(1, Math.min(NEBULA_ENTITY_CAP, Math.floor(nodeBudget / 2)));
    entityRows = store.db
      .prepare(
        `SELECT e.id AS id, e.name AS name, e.type AS type, COUNT(*) AS count
           FROM facts f JOIN entities e ON e.id = f.entity_id
          WHERE ${baseWhere}
          GROUP BY e.id
          ORDER BY count DESC, e.name
          LIMIT ?`,
      )
      .all(...statuses, entityBudget);
  }
  const entityIds = entityRows.map((row) => row.id);
  if (entityIds.length === 0) return emptyNebula();

  const idSql = entityIds.map(() => "?").join(",");
  // The fact limit is deliberately larger than the edge budget: one edge can
  // absorb many facts, and the node budget is what actually bites first.
  const facts = store.db
    .prepare(
      `SELECT f.id AS id, f.entity_id AS entity_id, f.predicate AS predicate, f.value_text AS value,
              f.norm_text AS norm_text, f.status AS status
         FROM facts f
        WHERE ${baseWhere} AND f.entity_id IN (${idSql})
        ORDER BY f.updated_at DESC, f.id
        LIMIT ?`,
    )
    .all(...statuses, ...entityIds, Math.max(edgeBudget * 3, 64));

  const entityFactCount = new Map();
  const entityStatus = new Map();
  const entityLabels = new Map(entityRows.map((row) => [row.id, row]));
  const valueNodes = new Map();
  for (const fact of facts) {
    entityFactCount.set(fact.entity_id, (entityFactCount.get(fact.entity_id) ?? 0) + 1);
    entityStatus.set(fact.entity_id, worseStatus(entityStatus.get(fact.entity_id) ?? fact.status, fact.status));
    const norm = fact.norm_text || normName(fact.value);
    const key = `v:${norm}`;
    const existing = valueNodes.get(key);
    if (existing) {
      existing.factCount += 1;
      existing.status = worseStatus(existing.status, fact.status);
      if (!existing.label) existing.label = String(fact.value ?? "");
    } else {
      valueNodes.set(key, {
        id: key,
        kind: "value",
        label: String(fact.value ?? ""),
        factCount: 1,
        entityType: null,
        status: fact.status,
        degree: 0,
      });
    }
  }

  const entityNodes = entityRows
    .filter((row) => (entityFactCount.get(row.id) ?? 0) > 0)
    .map((row) => ({
      id: `e:${row.id}`,
      kind: "entity",
      label: row.name,
      factCount: entityFactCount.get(row.id) ?? 0,
      entityType: row.type ?? null,
      status: entityStatus.get(row.id) ?? "active",
      degree: 0,
    }))
    .sort((left, right) => right.factCount - left.factCount || String(left.label).localeCompare(String(right.label)));
  const valueList = [...valueNodes.values()].sort(
    (left, right) => right.factCount - left.factCount || String(left.label).localeCompare(String(right.label)),
  );

  // Entities first (they are the anchors), values fill the remaining budget.
  const nodes = [...entityNodes, ...valueList].slice(0, nodeBudget);
  const kept = new Set(nodes.map((node) => node.id));

  const edgeMap = new Map();
  for (const fact of facts) {
    const source = `e:${fact.entity_id}`;
    const target = `v:${fact.norm_text || normName(fact.value)}`;
    if (!kept.has(source) || !kept.has(target)) continue;
    const key = `${source}|${fact.predicate}|${target}`;
    const edge = edgeMap.get(key) ?? {
      id: `nbe:${edgeMap.size + 1}`,
      source,
      target,
      predicate: fact.predicate,
      status: fact.status,
      factCount: 0,
      factIds: [],
    };
    edge.factCount += 1;
    edge.factIds.push(fact.id);
    edge.status = worseStatus(edge.status, fact.status);
    edgeMap.set(key, edge);
  }
  const allEdges = [...edgeMap.values()];
  const edges = allEdges.slice(0, edgeBudget);
  for (const edge of edges) {
    const source = nodes.find((node) => node.id === edge.source);
    const target = nodes.find((node) => node.id === edge.target);
    if (source) source.degree += 1;
    if (target) target.degree += 1;
  }

  // Totals describe the whole visible projection, so truncation is a fact the
  // caller can render instead of guessing from the returned page of nodes.
  const scopeWhere = seedRow ? `${baseWhere} AND f.entity_id = ?` : baseWhere;
  const scopeArgs = seedRow ? [...statuses, seedRow.id] : statuses;
  const totalsRow = store.db
    .prepare(`SELECT COUNT(DISTINCT f.entity_id) AS entity_count, COUNT(DISTINCT f.norm_text) AS value_count FROM facts f WHERE ${scopeWhere}`)
    .get(...scopeArgs);
  const edgeTotalRow = store.db
    .prepare(`SELECT COUNT(*) AS edge_count FROM (SELECT DISTINCT f.entity_id, f.predicate, f.norm_text FROM facts f WHERE ${scopeWhere})`)
    .get(...scopeArgs);
  const totalNodes = Number(totalsRow?.entity_count ?? 0) + Number(totalsRow?.value_count ?? 0);
  const totalEdges = Number(edgeTotalRow?.edge_count ?? 0);

  return {
    mode: "nebula",
    seeds: seedRow ? [seedRow.name] : entityRows.slice(0, 12).map((row) => row.name),
    nodes,
    edges,
    totals: { nodes: totalNodes, edges: totalEdges },
    truncated: { nodes: Math.max(0, totalNodes - nodes.length), edges: Math.max(0, totalEdges - edges.length) },
  };
}

/**
 * Facts behind one edge, for the panel's "回查支撑事实" action.
 *
 * Masked the same way the library list masks them: a credential fact is never
 * rendered, whatever surface asked for it — the graph is a screenshot away from
 * being a leak.
 */
export function edgeFacts(store, factIds) {
  return (Array.isArray(factIds) ? factIds : [])
    .map((id) => store.getFact(id))
    .filter(Boolean)
    .map((fact) => (store.isSecretFact(fact.id) ? { ...fact, value: "（凭据，已隐去）", secret: true } : { ...fact, secret: false }));
}

/** One-line summary used in the status payload and the panel header. */
export function graphStats(store, { includeSensitive = false } = {}) {
  const row = store.db
    .prepare(
      `SELECT COUNT(DISTINCT entity_id) AS entities, COUNT(*) AS facts FROM facts f
        WHERE f.status IN ('active','scheduled') AND ${visibleSql({ alias: "f", includeSensitive })}`,
    )
    .get();
  return { entities: Number(row?.entities ?? 0), facts: Number(row?.facts ?? 0) };
}
