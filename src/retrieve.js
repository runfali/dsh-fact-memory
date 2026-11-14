/**
 * Retrieval over the SQLite truth source: an exact identifier channel that BM25
 * is bad at, BM25 over the FTS projection, and — when a provider is configured —
 * vector recall. Ranked lists are fused with RRF, the fused pool is optionally
 * reranked, and every response says which paths actually ran.
 *
 * Nothing here hides a degraded path: a query with no embedding provider reports
 * `vectorUsed:false` and the caller must not claim semantic recall.
 */
import { ftsMatch, parseIdentifiers } from "./util.js";
import { visibleSql } from "./store.js";
import { embedQuery, vectorChannel, rerank, semanticPaths, embeddingText, loadCalibration, rerankFingerprint, embeddingFingerprint } from "./semantic.js";

const RRF_K = 60;
const DEFAULT_LIMIT = 5;
const MAX_CANDIDATES = 60;
/** Candidate pool handed to the reranker; also the plan's default rerank.topN. */
const RERANK_POOL = 20;
/** At most this many exact-identifier matches are protected into the pool. */
const EXACT_PROTECTED = 5;
const QUERY_DEADLINE_MS = 2500;
const QUERY_EMBED_TIMEOUT_MS = 800;

const LIVE_STATUSES = "'active','scheduled','conflict'";
const HISTORY_STATUSES = "'active','scheduled','conflict','superseded','expired'";
const BASE_WHERE = `f.status IN (${LIVE_STATUSES}) AND ${visibleSql({ alias: "f" })}`;
/**
 * `forgotten` never comes back, history or not. `includeSensitive` is the
 * read-time form of the `sensitiveModelVisible` switch: it widens the predicate
 * instead of rewriting rows, and never covers a credential.
 */
function whereFor(includeHistory, includeSensitive = false) {
  const statuses = includeHistory ? HISTORY_STATUSES : LIVE_STATUSES;
  return `f.status IN (${statuses}) AND ${visibleSql({ alias: "f", includeSensitive })}`;
}

function rankList(rows, scoreOf) {
  const seen = new Set();
  const ranked = [];
  for (const row of rows) {
    if (seen.has(row.fact_id)) continue;
    seen.add(row.fact_id);
    ranked.push({ factId: row.fact_id, score: scoreOf(row) });
  }
  return ranked;
}

function ftsChannel(store, query, where = BASE_WHERE) {
  const expression = ftsMatch(query);
  if (expression === "") return [];
  const rows = store.db
    .prepare(
      `SELECT t.fact_id AS fact_id, bm25(facts_fts) AS rank
       FROM facts_fts t
       JOIN facts f ON f.id = t.fact_id
       WHERE facts_fts MATCH ? AND ${where}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(expression, MAX_CANDIDATES);
  return rankList(rows, (row) => -Number(row.rank ?? 0));
}

function identifierChannel(store, query, where = BASE_WHERE) {
  const identifiers = parseIdentifiers(query);
  if (identifiers.length === 0) return [];
  const scored = new Map();
  for (const identifier of identifiers) {
    const like = `%${identifier.norm}%`;
    const rows = store.db
      .prepare(
        `SELECT f.id AS fact_id, f.norm_text AS norm_text, e.norm_name AS entity_norm
         FROM facts f JOIN entities e ON e.id = f.entity_id
         WHERE ${where} AND (f.norm_text LIKE ? OR e.norm_name LIKE ?)
         LIMIT ?`,
      )
      .all(like, like, MAX_CANDIDATES);
    for (const row of rows) {
      const inValue = String(row.norm_text ?? "").includes(identifier.norm);
      const inEntity = String(row.entity_norm ?? "").includes(identifier.norm);
      const bonus = (inValue ? 3 : 0) + (inEntity ? 1.5 : 0) + (identifier.kind === "path" || identifier.kind === "url" ? 0.5 : 0);
      scored.set(row.fact_id, Math.max(scored.get(row.fact_id) ?? 0, bonus));
    }
  }
  const ordered = [...scored.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, MAX_CANDIDATES)
    .map(([factId, score]) => ({ fact_id: factId, score }));
  return rankList(ordered, (row) => Number(row.score));
}

function rrf(lists) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((entry, index) => {
      scores.set(entry.factId, (scores.get(entry.factId) ?? 0) + 1 / (RRF_K + index + 1));
    });
  }
  return [...scores.entries()].sort((left, right) => right[1] - left[1]);
}

/** Ranked candidate ids with their fact rows, in fused order. */
function factsFor(store, ids) {
  return ids.map((factId) => store.getFact(factId)).filter(Boolean);
}

/**
 * One search. Async because the optional semantic paths are network calls; the
 * whole query is capped at 2500 ms and the embedding leg at 800 ms.
 *
 * @param {object} options
 * @param {string} options.query
 * @param {number} [options.limit]
 * @param {string|null} [options.scope]
 * @param {object|null} [options.vectorProvider]  openai-embeddings adapter or null
 * @param {object|null} [options.rerankProvider]  rerank-json adapter or null
 * @param {AbortSignal} [options.signal]
 */
export async function search(
  store,
  {
    query,
    limit = DEFAULT_LIMIT,
    scope = null,
    includeHistory = false,
    includeSensitive = false,
    vectorProvider = null,
    rerankProvider = null,
    signal,
    deadlineMs = QUERY_DEADLINE_MS,
  } = {},
) {
  const where = whereFor(includeHistory, includeSensitive);
  const text = String(query ?? "").trim();
  const channels = { fts: 0, identifier: 0, vector: 0 };
  const degraded = [];
  const paths = semanticPaths({
    vectorProvider,
    rerankProvider,
    vectorUsed: false,
    rerankUsed: false,
    rerankCalibrated: false,
  });
  if (text === "") return { items: [], channels, degraded, paths, rerank: null };

  const deadline = Date.now() + Math.max(200, Number(deadlineMs) || QUERY_DEADLINE_MS);
  const fts = ftsChannel(store, text, where);
  const identifier = identifierChannel(store, text, where);
  channels.fts = fts.length;
  channels.identifier = identifier.length;

  const lists = [identifier, fts];
  if (vectorProvider) {
    const remaining = Math.min(QUERY_EMBED_TIMEOUT_MS, deadline - Date.now());
    if (remaining > 50) {
      const fingerprint = embeddingFingerprint(vectorProvider);
      const vector = await embedQuery(vectorProvider, text, { timeoutMs: remaining, signal });
      if (vector && fingerprint) {
        // The vector table is a projection: a fact may have been superseded or
        // forgotten since it was indexed, so the same visibility predicate is
        // applied here — a stale vector must never resurrect a hidden fact.
        const recalled = vectorChannel(store, { fingerprint, vector, limit: MAX_CANDIDATES, where });
        channels.vector = recalled.length;
        if (recalled.length > 0) {
          lists.push(recalled);
          paths.vectorUsed = true;
        } else {
          degraded.push("no_vector_match");
        }
      } else {
        degraded.push("embedding_failed");
      }
    } else {
      degraded.push("deadline_before_embedding");
    }
  }

  const fused = rrf(lists);
  const fusedIds = [...new Set(fused.map(([factId]) => factId))];

  // The exact channel's strongest hits keep a slot in the pool even when BM25
  // buries them; without this a path buried at BM25 rank 19 can be dropped.
  const protectedIds = identifier.slice(0, EXACT_PROTECTED).map((entry) => entry.factId);
  const pool = [...new Set([...protectedIds, ...fusedIds])].slice(0, RERANK_POOL);

  let ordered = pool;
  let rerankInfo = null;
  if (rerankProvider && pool.length > 1) {
    const remaining = Math.min(1500, deadline - Date.now());
    if (remaining > 50) {
      const facts = factsFor(store, pool);
      try {
        const outcome = await rerank(rerankProvider, text, facts.map((fact) => embeddingText(fact)), {
          topN: facts.length,
          timeoutMs: remaining,
          signal,
        });
        if (outcome) {
          const calibration = loadCalibration(store, { kind: "rerank", fingerprint: rerankFingerprint(rerankProvider) });
          const scored = facts
            .map((fact, index) => ({ fact, score: outcome.scores[index] }))
            .sort((left, right) => right.score - left.score);
          const accepted = calibration ? scored.filter((entry) => entry.score >= calibration.threshold) : scored;
          ordered = accepted.map((entry) => entry.fact.id);
          paths.rerankUsed = true;
          paths.rerankCalibrated = Boolean(calibration);
          rerankInfo = {
            scoreMode: outcome.scoreMode,
            calibrated: Boolean(calibration),
            threshold: calibration?.threshold ?? null,
            dropped: scored.length - accepted.length,
          };
          if (!calibration) degraded.push("rerank_uncalibrated");
        } else {
          degraded.push("rerank_unavailable");
        }
      } catch {
        // A failed rerank is not a licence to return the fused top 3 blindly:
        // fall back to the strict lexical order below.
        degraded.push("rerank_failed");
      }
    } else {
      degraded.push("deadline_before_rerank");
    }
  } else if (rerankProvider) {
    degraded.push("rerank_no_candidates");
  }

  // A slot with several live values shows its newest first; the rank it earned is
  // kept, so this only reorders inside a slot.
  const sequenced = preferNewestPerSlot(store, ordered);

  const allowedStatus = new Set(includeHistory ? ["active", "scheduled", "conflict", "superseded", "expired"] : ["active", "scheduled", "conflict"]);
  const items = [];
  for (const factId of sequenced) {
    if (items.length >= Math.max(1, limit)) break;
    const fact = store.getFact(factId);
    if (!fact) continue;
    // Belt and braces: a channel that forgot a filter cannot leak a forgotten or
    // credential fact into the model's context through the fused list.
    if (!allowedStatus.has(fact.status)) continue;
    if (!fact.modelUseAllowed && !(includeSensitive && fact.privacyClass === "sensitive" && !store.isSecretFact(fact.id))) continue;
    if (scope && fact.scope !== scope && fact.scope !== "global") continue;
    items.push(fact);
  }
  if (fts.length === 0 && identifier.length === 0 && channels.vector === 0) degraded.push("no_match");
  return { items, channels, degraded, paths, rerank: rerankInfo };
}

/** All facts for the management views; used by the panel and the JSONL export. */
export function listFacts(store, { status = null, limit = 500 } = {}) {
  const rows = status
    ? store.db.prepare("SELECT f.id FROM facts f WHERE f.status = ? ORDER BY f.updated_at DESC LIMIT ?").all(status, limit)
    : store.db
        .prepare("SELECT f.id FROM facts f WHERE f.status != 'forgotten' ORDER BY f.updated_at DESC LIMIT ?")
        .all(limit);
  return rows.map((row) => store.getFact(row.id)).filter(Boolean);
}

/** The observation date, not the value's trailing timestamp — that belongs to the value. */
function observedDay(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

export function formatFact(fact, { withId = true, withDate = true } = {}) {
  const flags = [];
  if (fact.status === "conflict") flags.push("待确认冲突");
  if (fact.status === "scheduled") flags.push("未生效");
  if (fact.privacyClass === "sensitive") flags.push("敏感");
  const qualifiers = Object.keys(fact.qualifiers ?? {}).length > 0 ? ` ${JSON.stringify(fact.qualifiers)}` : "";
  const day = withDate ? observedDay(fact.observedAt) : "";
  const when = day === "" ? "" : ` · ${day}`;
  const folded = Number(fact.foldedCount ?? 0) > 0 ? ` · 共 ${Number(fact.foldedCount) + 1} 次` : "";
  const tail = withId ? ` 〔${String(fact.id).slice(0, 8)}〕` : "";
  return `- ${fact.entity} · ${fact.predicate}: ${fact.value}${qualifiers}${when}${folded}${flags.length ? `（${flags.join("，")}）` : ""}${tail}`;
}

/**
 * Within one slot (entity + predicate + qualifiers) the newest value answers the
 * question; the older ones are history. Nine backup rows all say "OK" and the only
 * thing worth reading is which run came last, so the newest of a slot takes the
 * slot's best rank and its older siblings follow it in place.
 *
 * Order across slots is untouched: this never promotes an unrelated fact, so a
 * fact that is merely old but unique keeps the rank its relevance earned.
 */
export function preferNewestPerSlot(store, ids) {
  if (!Array.isArray(ids) || ids.length < 2) return ids;
  const lookup = store.db.prepare(
    "SELECT entity_id, predicate, qualifiers_key, observed_at FROM facts WHERE id = ?",
  );
  const bySlot = new Map();
  const meta = new Map();
  for (const id of ids) {
    const row = lookup.get(id);
    if (!row) {
      meta.set(id, null);
      continue;
    }
    const key = `${row.entity_id}\u0000${row.predicate}\u0000${row.qualifiers_key}`;
    meta.set(id, { key, observedAt: String(row.observed_at ?? "") });
    const bucket = bySlot.get(key);
    if (bucket) bucket.push(id);
    else bySlot.set(key, [id]);
  }
  const emitted = new Set();
  const out = [];
  for (const id of ids) {
    const info = meta.get(id);
    if (!info) {
      out.push(id);
      continue;
    }
    if (emitted.has(info.key)) continue;
    emitted.add(info.key);
    const members = bySlot.get(info.key) ?? [id];
    const ordered = [...members].sort((left, right) => {
      const a = meta.get(left)?.observedAt ?? "";
      const b = meta.get(right)?.observedAt ?? "";
      if (a === b) return members.indexOf(left) - members.indexOf(right);
      return b.localeCompare(a);
    });
    out.push(...ordered);
  }
  return out;
}

/** Render search hits within a character budget; never split a fact in half. */
export function renderHits(items, { maxChars = 1200 } = {}) {
  const lines = [];
  let used = 0;
  for (const fact of items) {
    const line = formatFact(fact);
    if (used + line.length > maxChars && lines.length > 0) {
      lines.push(`… 另有 ${items.length - lines.length} 条未列出`);
      break;
    }
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n");
}

/**
 * The resident directory: what memory knows, grouped by entity, with predicate
 * names only. Deliberately value-free (I.1) — the frame says "there is
 * something", a real question goes through memory_search for the body, source
 * and date. Conflicting slots surface as "有待裁决" instead of a one-sided value.
 */
export function directoryEntries(store, { maxEntities = 24, maxPredicates = 8, includeSensitive = false } = {}) {
  const rows = store.db
    .prepare(
      `SELECT e.id AS entity_id, e.name AS entity_name, e.scope AS entity_scope,
              f.id AS fact_id, f.predicate, f.status, f.updated_at, f.privacy_class, f.model_use_allowed
         FROM facts f JOIN entities e ON e.id = f.entity_id
        WHERE f.status IN ('active','scheduled','conflict') AND ${visibleSql({ alias: "f", includeSensitive })}
        ORDER BY e.name COLLATE NOCASE, f.updated_at DESC`,
    )
    .all();
  const byEntity = new Map();
  for (const row of rows) {
    const key = row.entity_id;
    let group = byEntity.get(key);
    if (!group) {
      group = {
        entityId: row.entity_id,
        entity: row.entity_name,
        scope: row.entity_scope,
        predicates: [],
        facts: 0,
        scheduled: 0,
        conflicts: 0,
      };
      byEntity.set(key, group);
    }
    if (row.status === "conflict") {
      group.conflicts += 1;
      continue;
    }
    group.facts += 1;
    if (row.status === "scheduled") group.scheduled += 1;
    if (!group.predicates.includes(row.predicate) && group.predicates.length < maxPredicates) {
      group.predicates.push(row.predicate);
    }
  }
  return [...byEntity.values()]
    .filter((group) => group.facts > 0 || group.conflicts > 0)
    .sort((a, b) => b.facts - a.facts || a.entity.localeCompare(b.entity))
    .slice(0, maxEntities);
}

/** One directory line: entity, scope, predicate names, counts, locator id. */
export function formatDirectoryEntry(group) {
  const scope = group.scope && group.scope !== "global" ? `（${group.scope}）` : "";
  const names = group.predicates.join("、");
  const more = group.facts > group.predicates.length ? ` 等 ${group.facts} 条` : "";
  const flags = [];
  if (group.conflicts > 0) flags.push(`${group.conflicts} 处待裁决`);
  if (group.scheduled > 0) flags.push(`${group.scheduled} 条未生效`);
  const tail = `〔#${String(group.entityId).slice(0, 6)}${flags.length ? ` · ${flags.join(" · ")}` : ""}〕`;
  return `- ${group.entity}${scope}：${names}${more} ${tail}`;
}

/** Back-compat shim for callers that still ask for a flat fact list. */
export function directoryLines(store, { maxItems = 40 } = {}) {
  const rows = store.db
    .prepare(
      `SELECT f.id FROM facts f JOIN entities e ON e.id = f.entity_id
        WHERE f.status IN ('active','scheduled') AND f.model_use_allowed = 1
        ORDER BY f.updated_at DESC LIMIT ?`,
    )
    .all(maxItems);
  return rows.map((row) => store.getFact(row.id)).filter(Boolean);
}
