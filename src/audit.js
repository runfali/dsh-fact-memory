/**
 * The library's own health check.
 *
 * Everything here is SQL and string work — no model, no embeddings — so it can run
 * on a schedule, cost nothing, and still notice a library rotting between sessions.
 * It never writes a fact: each finding becomes one *aggregated* proposal, because a
 * queue that grows one row per problem is a queue nobody comes back to.
 *
 * Three findings, each chosen because a rule can prove it without judgement:
 *
 *   - self_referential  the value only restates its own predicate;
 *   - log_pipeline      one recurring job written as N rows (foldable, see logSlotKey);
 *   - entity_fragment   one subject split across two spellings (alias + absorb).
 *
 * Deliberately absent: anything that guesses "this looks stale". Age is not
 * evidence — a two-month-old port number is as true as yesterday's.
 */
import { canonicalEntityKey, logSlotKey } from "./dedup.js";
import { normValue, nowIso } from "./util.js";
import { createProposal } from "./proposals.js";
import { visibleSql } from "./store.js";

export const AUDIT_LIMITS = {
  /** One proposal carries at most this many rows; a bigger pile becomes a second proposal. */
  maxDetailsPerProposal: 50,
  /** Fewer runs than this is a coincidence, not a pipeline. */
  minPipelineRows: 3,
  /** Guard against a pathological library turning one sweep into thousands of rows. */
  maxFindings: 400,
  /** A fragment shorter than this is a common word, not a subject. */
  minFragmentChars: 6,
  /** The fragment must cover this share of the longer key to be the same subject. */
  minFragmentShare: 0.6,
};

/** Every live fact with the fields the checks need, sensitive rows excluded at SQL. */
function liveRows(store, includeSensitive) {
  return store.db
    .prepare(
      `SELECT f.id, f.entity_id, f.predicate, f.value_text, f.scope, f.qualifiers_key, f.observed_at,
              f.record_revision, e.name AS entity_name
         FROM facts f JOIN entities e ON e.id = f.entity_id
        WHERE f.status IN ('active','scheduled') AND ${visibleSql({ alias: "f", includeSensitive })}
        ORDER BY f.entity_id, f.predicate, f.observed_at DESC`,
    )
    .all();
}

const detailOf = (row) => ({
  factId: row.id,
  recordRevision: Number(row.record_revision),
  value: String(row.value_text ?? "").slice(0, 200),
  observedAt: row.observed_at,
});

/**
 * The value says nothing the predicate did not already say: "record it so users
 * know" filed under "needs to be recorded so users know".
 *
 * A containment rule rather than an equality rule, because the real case had the
 * value as a prefix of the predicate. The 60% floor is what keeps a genuinely
 * short value ("8080" under "端口 8080") out of it.
 */
export function isSelfReferential(predicate, value) {
  const p = normValue(predicate);
  const v = normValue(value);
  if (p.length < 4 || v.length < 4) return false;
  if (p === v) return true;
  if (!p.includes(v)) return false;
  return v.length / p.length >= 0.6;
}

export function findSelfReferential(rows) {
  const findings = [];
  for (const row of rows) {
    if (!isSelfReferential(row.predicate, row.value_text)) continue;
    findings.push({
      kind: "self_referential",
      action: "retire",
      entity: row.entity_name,
      entityId: row.entity_id,
      predicate: row.predicate,
      scope: row.scope,
      details: [detailOf(row)],
    });
  }
  return findings;
}

/**
 * One recurring job, N rows. A pipeline is only claimed when the rows are
 * identical apart from a real calendar date — the same test the write path uses to
 * fold the next run, so what the check proposes and what the writer does cannot
 * drift apart.
 */
export function findLogPipelines(rows, { minPipelineRows = AUDIT_LIMITS.minPipelineRows } = {}) {
  const slots = new Map();
  for (const row of rows) {
    const slot = `${row.entity_id}\u0000${row.predicate}\u0000${row.scope}\u0000${row.qualifiers_key}`;
    const bucket = logSlotKey(row.value_text);
    if (!bucket) continue;
    const key = `${slot}\u0000${bucket}`;
    const group = slots.get(key);
    if (group) group.push(row);
    else slots.set(key, [row]);
  }
  const findings = [];
  for (const group of slots.values()) {
    if (group.length < minPipelineRows) continue;
    const ordered = [...group].sort((left, right) => String(right.observed_at).localeCompare(String(left.observed_at)));
    findings.push({
      kind: "log_pipeline",
      action: "fold_log",
      entity: ordered[0].entity_name,
      entityId: ordered[0].entity_id,
      predicate: ordered[0].predicate,
      scope: ordered[0].scope,
      keepId: ordered[0].id,
      details: ordered.map(detailOf),
    });
  }
  return findings;
}

/**
 * One subject, two spellings. Keyed on canonicalEntityKey so "DSH 插件
 * dsh-fact-memory" and "dsh-fact-memory插件" land in the same family, and gated on
 * coverage so "dsh" (a 3-character word) never looks like a fragment of it.
 */
export function findEntityFragments(store, { limits = AUDIT_LIMITS } = {}) {
  const entities = store.db
    .prepare(
      `SELECT e.id, e.name, e.scope, COUNT(f.id) AS facts
         FROM entities e JOIN facts f ON f.entity_id = e.id
        WHERE e.status = 'active' AND f.status IN ('active','scheduled')
        GROUP BY e.id HAVING facts > 0`,
    )
    .all();
  const keys = entities.map((entity) => ({ ...entity, key: canonicalEntityKey(entity.name) }));
  const findings = [];
  const seen = new Set();
  for (const short of keys) {
    if (short.key.length < limits.minFragmentChars) continue;
    for (const long of keys) {
      if (short.id === long.id || short.scope !== long.scope) continue;
      if (long.key.length <= short.key.length) continue;
      if (!long.key.includes(short.key)) continue;
      if (short.key.length / long.key.length < limits.minFragmentShare) continue;
      // The survivor is the spelling with more facts behind it: that is the one the
      // user has been reading, whatever the string lengths say.
      const survivor = Number(long.facts) >= Number(short.facts) ? long : short;
      const fragment = survivor.id === long.id ? short : long;
      const pair = [survivor.id, fragment.id].sort().join("\u0000");
      if (seen.has(pair)) continue;
      seen.add(pair);
      findings.push({
        kind: "entity_fragment",
        action: "alias",
        entity: survivor.name,
        entityId: survivor.id,
        predicate: "实体别名",
        scope: survivor.scope,
        details: [{ entityId: fragment.id, name: fragment.name, facts: Number(fragment.facts) }],
        targets: [
          { entityId: survivor.id, role: "canonical", name: survivor.name },
          { entityId: fragment.id, role: "alias", name: fragment.name },
        ],
      });
    }
  }
  return findings;
}

/** Every finding this library can prove right now, cheapest checks first. */
export function collectFindings(store, { limits = AUDIT_LIMITS, includeSensitive = false } = {}) {
  const rows = liveRows(store, includeSensitive);
  const findings = [
    ...findSelfReferential(rows),
    ...findLogPipelines(rows, limits),
    ...findEntityFragments(store, { limits }),
  ];
  return findings.slice(0, limits.maxFindings);
}

const KIND_TITLES = {
  self_referential: (count) => `${count} 条事实的值只是把属性名又说了一遍`,
  log_pipeline: (count) => `${count} 条同一流水线（只有日期不同），可合并为一条并保留历史`,
  entity_fragment: (count) => `${count} 个疑似同一主体的不同写法，补上别名后归并`,
};

/**
 * The rows one batch of a proposal acts on, derived from that batch's own details.
 *
 * Reusing the first finding's targets was wrong twice: a group built from two
 * findings pointed at only the first one's rows, and every batch after the first
 * described rows it did not list — a fold batch without the keep row could never
 * be applied at all.
 */
function targetsFor(group, details) {
  if (group.kind === "entity_fragment") {
    return [
      { entityId: group.entityId, role: "canonical", name: group.entity },
      ...details.map((detail) => ({ entityId: detail.entityId, role: "alias", name: detail.name })),
    ];
  }
  if (group.kind === "log_pipeline") {
    // The most recently observed run stays; the older ones fold into it.
    const keep = details.reduce(
      (best, detail) => (String(detail?.observedAt ?? "") > String(best?.observedAt ?? "") ? detail : best),
      details[0],
    );
    return details.map((detail) => ({
      factId: detail.factId,
      recordRevision: detail.recordRevision,
      role: String(detail.factId) === String(keep?.factId) ? "keep" : "drop",
    }));
  }
  return details.map((detail) => ({ factId: detail.factId, recordRevision: detail.recordRevision, role: "drop" }));
}

/** Split one class of findings into proposals of at most `maxDetailsPerProposal`. */
export function groupFindings(findings, { maxDetailsPerProposal = AUDIT_LIMITS.maxDetailsPerProposal } = {}) {
  const grouped = new Map();
  for (const finding of findings) {
    const key = [finding.kind, finding.entityId, finding.predicate, finding.scope].join("\u0000");
    const group = grouped.get(key);
    if (group) group.details.push(...finding.details);
    else grouped.set(key, { ...finding, details: [...finding.details] });
  }
  const out = [];
  for (const group of grouped.values()) {
    // Two findings of the same class can name the same row (a pipeline seen from two
    // windows). Keeping both copies listed the row twice and made the keep choice
    // ambiguous.
    const seen = new Set();
    const details = group.details.filter((detail) => {
      const id = String(detail?.factId ?? detail?.entityId ?? "");
      if (id === "" || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (details.length === 0) continue;
    const total = details.length;
    const batches = Math.ceil(total / maxDetailsPerProposal);
    const title = KIND_TITLES[group.kind]?.(total) ?? `${total} 条待处理`;
    for (let index = 0, number = 0; index < total; index += maxDetailsPerProposal, number += 1) {
      const chunk = details.slice(index, index + maxDetailsPerProposal);
      out.push({
        ...group,
        details: chunk,
        title: batches > 1 ? `${title}（第 ${number + 1}/${batches} 批）` : title,
        reason: `体检发现：${title}`,
        targets: targetsFor(group, chunk),
      });
    }
  }
  return out;
}

/**
 * Run the check and file one proposal per class of problem. Idempotent: the
 * fingerprint of an unchanged proposal is unique among pending rows, so a sweep
 * that finds the same twelve facts twice does not queue them twice.
 */
export function runAudit({ store, limits = AUDIT_LIMITS, includeSensitive = false, at = nowIso() } = {}) {
  const started = Date.now();
  const findings = collectFindings(store, { limits, includeSensitive });
  if (findings.length === 0) {
    store.recordAuditRun({ status: "clean", findings: 0, proposals: 0, durationMs: Date.now() - started, at });
    return { status: "clean", findings: 0, proposals: 0, byKind: {}, durationMs: Date.now() - started };
  }
  const groups = groupFindings(findings, limits);
  const byKind = {};
  let proposals = 0;
  let duplicates = 0;
  for (const group of groups) {
    const result = createProposal(store, {
      kind: "audit",
      action: group.action,
      entityName: group.entity,
      predicate: group.predicate,
      value: group.title,
      scope: group.scope,
      cardinality: "unknown",
      confidence: 0.5,
      evidenceLevel: "unverified",
      reason: group.reason,
      targets: group.targets,
    });
    if (result.status === "created") proposals += 1;
    else duplicates += 1;
  }
  const durationMs = Date.now() - started;
  const counts = {};
  for (const finding of findings) counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
  Object.assign(byKind, counts);
  store.recordAuditRun({ status: "ok", findings: findings.length, proposals, durationMs, at });
  return { status: "ok", findings: findings.length, proposals, duplicates, byKind, durationMs };
}

/** What the settings card shows: the last sweep, plus what is still open. */
export function auditSummary(store, { limit = 20 } = {}) {
  const runs = store.recentAuditRuns({ limit: 5 });
  const last = runs[0] ?? null;
  const open = store.db
    .prepare("SELECT kind, COUNT(*) AS count FROM proposals WHERE status = 'pending' AND kind = 'audit' GROUP BY kind")
    .all();
  const pending = store.db
    .prepare("SELECT COUNT(*) AS count FROM proposals WHERE status = 'pending'")
    .get();
  return {
    lastRun: last
      ? {
        at: last.at,
        status: last.status,
        reason: last.reason,
        findings: Number(last.findings),
        proposals: Number(last.proposals),
        durationMs: Number(last.duration_ms),
      }
      : null,
    open: Number(pending?.count ?? 0),
    byAction: Object.fromEntries(open.map((row) => [row.kind, Number(row.count)])),
    seenAt: store.reviewSeenAt("proposals"),
  };
}
