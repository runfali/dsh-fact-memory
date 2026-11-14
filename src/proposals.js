/**
 * Proposals: the review queue for anything the rules may not apply alone.
 *
 * A proposal carries the concrete diff (targets, original values, proposed
 * action, evidence) and the base revision of every target. Accepting it is the
 * only path to a fact when the evidence is not the user's own statement, and a
 * target that changed after the proposal was filed makes it `stale` instead of
 * overwriting the newer value — the plan's E4 fence.
 */
import { nowIso, normValue, privacyHits, safeJson, sha256, uuid, casefold } from "./util.js";
import { qualifierKey, claimKeyOf } from "./store.js";

// A health-check proposal carries a whole class of problems at once, so the cap is
// sized for "fifty rows, one click" rather than for a single diff.
const MAX_TARGETS = 60;

/**
 * Accept `"api"`, `{ name: "api" }` and `{ entity: "api" }`. A caller that hands
 * over a record instead of a name used to be stringified into "[object Object]",
 * which then showed up in the review queue as an unnamed subject.
 */
function entityNameOf(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") {
    const inner = value.name ?? value.entity ?? value.entityName ?? value.id ?? "";
    return typeof inner === "string" ? inner.trim() : "";
  }
  return String(value).trim();
}

export function proposalFingerprint({ kind, action, entityName, predicate, normValue: normalized, scope, qualifiersKey, targets }) {
  const ids = (targets ?? []).map((target) => String(target.factId ?? "")).sort();
  return sha256(JSON.stringify([kind, action, casefold(entityName), casefold(predicate), normalized, scope ?? "global", qualifiersKey ?? "{}", ids]));
}

function rowToProposal(row) {
  if (!row) return null;
  // Tolerant reads: a proposal whose target list cannot be parsed must still be
  // listable (and refusable) rather than break the whole queue.
  const targets = safeJson(row.targets, []);
  const evidence = safeJson(row.evidence_refs, []);
  return {
    id: row.id,
    kind: row.kind,
    action: row.action,
    entity: row.entity_name,
    predicate: row.predicate,
    value: row.value_text,
    cardinality: row.cardinality,
    scope: row.scope,
    qualifiers: safeJson(row.qualifiers || "{}", {}),
    targets,
    evidence,
    evidenceLevel: row.evidence_level,
    confidence: Number(row.confidence),
    reason: row.reason,
    status: row.status,
    revision: Number(row.revision),
    baseGeneration: Number(row.base_generation),
    decision: row.decision,
    decidedAt: row.decided_at,
    appliedFactId: row.applied_fact_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Create or return the open proposal with the same content. Never duplicates. */
export function createProposal(store, input) {
  const entityName = entityNameOf(input.entityName ?? input.entity);
  const predicate = String(input.predicate ?? "").trim();
  const value = String(input.value ?? "").trim();
  if (entityName === "" || predicate === "" || value === "") throw new Error("proposal needs entity, predicate and value");
  const qualifiers = input.qualifiers && typeof input.qualifiers === "object" ? input.qualifiers : {};
  const qualifiersKey = qualifierKey(qualifiers);
  const scope = String(input.scope ?? "global");
  const targets = Array.isArray(input.targets) ? input.targets.slice(0, MAX_TARGETS) : [];
  const kind = ["low_confidence", "conflict_resolve", "expiry", "merge", "audit"].includes(input.kind) ? input.kind : "low_confidence";
  const action = ["create", "replace", "merge", "expire", "resolve", "retire", "fold_log", "alias"].includes(input.action)
    ? input.action
    : "create";
  const normalized = normValue(value);
  const fingerprint = proposalFingerprint({ kind, action, entityName, predicate, normValue: normalized, scope, qualifiersKey, targets });
  const existing = store.db.prepare("SELECT * FROM proposals WHERE fingerprint = ? AND status = 'pending'").get(fingerprint);
  if (existing) return { status: "duplicate", proposal: rowToProposal(existing) };

  const now = nowIso();
  const id = uuid();
  store.tx(() => {
    store.db
      .prepare(
        `INSERT INTO proposals
           (id, kind, action, entity_name, predicate, value_text, norm_value, cardinality, scope, qualifiers,
            qualifiers_key, targets, evidence_refs, evidence_level, confidence, reason, status, revision,
            base_generation, fingerprint, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?)`,
      )
      .run(
        id,
        kind,
        action,
        entityName,
        predicate,
        value,
        normalized,
        ["single", "multi", "unknown"].includes(input.cardinality) ? input.cardinality : "unknown",
        scope,
        JSON.stringify(qualifiers),
        qualifiersKey,
        JSON.stringify(targets),
        JSON.stringify(Array.isArray(input.evidence) ? input.evidence.slice(0, 20) : []),
        input.evidenceLevel === "observed" ? "observed" : "unverified",
        Math.min(1, Math.max(0, Number(input.confidence ?? 0.5))),
        String(input.reason ?? "").slice(0, 400),
        Number(input.baseGeneration ?? store.meta.generation),
        fingerprint,
        now,
        now,
      );
  });
  return { status: "created", proposal: rowToProposal(store.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id)) };
}

export function getProposal(store, id) {
  return rowToProposal(store.db.prepare("SELECT * FROM proposals WHERE id = ?").get(String(id)));
}

export function listProposals(store, { status = "pending", limit = 50 } = {}) {
  const rows = status
    ? store.db.prepare("SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, limit)
    : store.db.prepare("SELECT * FROM proposals ORDER BY created_at DESC LIMIT ?").all(limit);
  return rows.map(rowToProposal).filter(Boolean);
}

/**
 * Why a proposal can no longer be applied as written. Checked at accept time,
 * never trusted from the moment of creation.
 */
export function proposalStaleness(store, proposal) {
  const claimKey = claimKeyOf({
    entityName: proposal.entity,
    predicate: proposal.predicate,
    qualifiers: proposal.qualifiers,
    value: proposal.value,
  });
  if (store.isTombstoned({ namespace: "proposal", claimKey })) {
    return { reason: "tombstoned", detail: "这条主张已被用户遗忘，提案不能让它复活。" };
  }
  // A health-check proposal lists a whole class of rows behind one decision. One
  // row changing under it must not discard the other forty-nine, so those are
  // collected and skipped at apply time; a single-diff proposal keeps the hard
  // fence (a changed target means the proposal no longer describes a diff).
  const audit = proposal.kind === "audit";
  const staleTargets = [];
  for (const target of proposal.targets ?? []) {
    if (!target?.factId) continue;
    const row = store.db.prepare("SELECT record_revision, status FROM facts WHERE id = ?").get(target.factId);
    if (!row) {
      if (audit) {
        staleTargets.push({ factId: String(target.factId), reason: "missing" });
        continue;
      }
      return { reason: "target_missing", detail: `提案依据的事实 ${String(target.factId).slice(0, 8)} 已不存在。` };
    }
    // A row that already reached the state the proposal wants is not stale work.
    const settled = proposal.action === "retire" && row.status === "expired";
    if (settled && audit) {
      staleTargets.push({ factId: String(target.factId), reason: "already_done" });
      continue;
    }
    if (Number(row.record_revision) !== Number(target.recordRevision)) {
      if (audit) {
        staleTargets.push({ factId: String(target.factId), reason: "changed", was: Number(target.recordRevision), now: Number(row.record_revision) });
        continue;
      }
      return {
        reason: "target_changed",
        detail: `提案依据的事实 ${String(target.factId).slice(0, 8)} 已被修改（版本 ${target.recordRevision} → ${row.record_revision}）。`,
      };
    }
  }
  if (staleTargets.length > 0) {
    return {
      partial: true,
      reason: "some_targets_stale",
      detail: `提案里有 ${staleTargets.length} 条依据已变，其余仍可执行。`,
      staleTargets,
    };
  }
  return null;
}

function markStale(store, proposal, reason) {
  const at = nowIso();
  store.tx(() => {
    store.db
      .prepare("UPDATE proposals SET status = 'stale', decision = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(String(reason).slice(0, 120), at, at, proposal.id);
  });
  return { ...proposal, status: "stale", decision: String(reason).slice(0, 120), decidedAt: at };
}

/**
 * Accept a proposal. `confirmed_user` is the evidence level because a human
 * clicked through the diff; the write still goes through the normal slot rules.
 */
export function applyProposal(store, { proposalId, at = nowIso() } = {}) {
  const proposal = getProposal(store, proposalId);
  if (!proposal) return { status: "not_found" };
  if (proposal.status === "applied") return { status: "already", factId: proposal.appliedFactId, proposal };
  if (proposal.status === "rejected") return { status: "rejected", proposal };
  if (proposal.status === "stale") return { status: "stale", reason: proposal.decision, proposal };

  const stale = proposalStaleness(store, proposal);
  let staleIds = new Set();
  if (stale) {
    if (!stale.partial) {
      return { status: "stale", reason: stale.reason, detail: stale.detail, proposal: markStale(store, proposal, stale.reason) };
    }
    staleIds = new Set(stale.staleTargets.map((target) => String(target.factId)));
  }
  // Rows that changed since the sweep are skipped rather than applied to their new
  // revision, and the receipt says how many so "applied" never overstates the work.
  const liveTargets = (proposal.targets ?? []).filter((target) => !target?.factId || !staleIds.has(String(target.factId)));
  const skippedStale = staleIds.size;

  // A merge is not a write: it retires one row into the other and moves its
  // evidence. Doing it through writeFact would create a third row that says the
  // same thing as the two being merged.
  if (proposal.action === "merge") {
    const keepTarget = (proposal.targets ?? []).find((target) => target?.role === "keep") ?? proposal.targets?.[0] ?? null;
    const dropTarget = (proposal.targets ?? []).find((target) => target?.role === "drop") ?? proposal.targets?.[1] ?? null;
    if (!keepTarget?.factId || !dropTarget?.factId) return { status: "refused", reason: "merge_targets_missing", proposal };
    const merged = store.mergeFacts({ winnerId: keepTarget.factId, loserId: dropTarget.factId, at });
    if (merged.status !== "ok") return { status: "refused", reason: merged.reason ?? merged.status, proposal };
    store.tx(() => {
      store.db
        .prepare("UPDATE proposals SET status = 'applied', decision = 'applied', decided_at = ?, updated_at = ?, applied_fact_id = ? WHERE id = ?")
        .run(at, at, merged.winner.id, proposal.id);
    });
    return {
      status: "applied",
      factId: merged.winner.id,
      written: "merged",
      merged: { keptFactId: merged.winner.id, retiredFactId: merged.loser.id, movedSources: merged.movedSources },
      proposal: getProposal(store, proposal.id),
    };
  }

  // ── health-check proposals ────────────────────────────────────────────
  // These carry a class of problems, not one diff, so each branch applies the whole
  // batch and reports the counts back. Every one of them is reversible at the data
  // level: nothing is deleted, only retired or folded.

  if (proposal.action === "retire") {
    const ids = liveTargets.map((target) => target?.factId).filter(Boolean);
    if (ids.length === 0) return { status: "refused", reason: skippedStale > 0 ? "all_targets_stale" : "no_targets", proposal };
    const done = store.expireFacts({ ids, at });
    if (Number(done.expired ?? 0) === 0) return { status: "refused", reason: "nothing_expired", proposal };
    store.tx(() => {
      store.db
        .prepare("UPDATE proposals SET status = 'applied', decision = 'applied', decided_at = ?, updated_at = ? WHERE id = ?")
        .run(at, at, proposal.id);
    });
    return { status: "applied", written: "expired", expired: done.expired, skippedStale, proposal: getProposal(store, proposal.id) };
  }

  if (proposal.action === "fold_log") {
    const keep = liveTargets.find((target) => target?.role === "keep") ?? liveTargets[0] ?? null;
    const drops = liveTargets.filter((target) => target?.factId && String(target.factId) !== String(keep?.factId ?? ""));
    if (!keep?.factId || drops.length === 0) {
      // The keep row itself changed since the sweep: folding into its new revision
      // would move evidence onto a value a human has not seen.
      const keepStale = (proposal.targets ?? []).some((target) => target?.role === "keep" && staleIds.has(String(target.factId ?? "")));
      return { status: "refused", reason: keepStale ? "keep_target_stale" : skippedStale > 0 ? "all_targets_stale" : "no_targets", proposal };
    }
    let folded = 0;
    let moved = 0;
    let failed = 0;
    const foldedValues = [];
    for (const drop of drops) {
      const merged = store.mergeFacts({ winnerId: keep.factId, loserId: drop.factId, at });
      if (merged.status !== "ok") {
        failed += 1;
        continue;
      }
      folded += 1;
      moved += Number(merged.movedSources ?? 0);
      if (merged.loser?.value) foldedValues.push(merged.loser.value);
    }
    // Reporting "applied" after zero merges was the worst possible receipt: the row
    // left the queue while every fact stayed exactly where it was.
    if (folded === 0) return { status: "refused", reason: "merge_failed", failed, proposal };
    // The rows are retired, not erased: the survivor keeps their values so the
    // "共 N 次" rendering matches what a fold at write time would have produced.
    // Both writes share one transaction — a crash between them would leave the card
    // pending while the history had already moved.
    let noted = null;
    store.tx(() => {
      noted = store.recordFoldedValues({ factId: keep.factId, values: foldedValues, at });
      store.db
        .prepare("UPDATE proposals SET status = 'applied', decision = 'applied', decided_at = ?, updated_at = ?, applied_fact_id = ? WHERE id = ?")
        .run(at, at, keep.factId, proposal.id);
    });
    return {
      status: "applied",
      written: "folded",
      folded,
      failed,
      skippedStale,
      foldedCount: Number(noted?.foldedCount ?? 0),
      movedSources: moved,
      factId: keep.factId,
      proposal: getProposal(store, proposal.id),
    };
  }

  if (proposal.action === "alias") {
    const canonical = (proposal.targets ?? []).find((target) => target?.role === "canonical") ?? null;
    const fragment = (proposal.targets ?? []).find((target) => target?.role === "alias") ?? null;
    if (!canonical?.entityId || !fragment?.entityId) return { status: "refused", reason: "no_targets", proposal };
    // Check both ends before the first write: a fragment deleted between the sweep
    // and the click used to leave an alias on the survivor pointing at nothing.
    const canonicalRow = store.getEntity(canonical.entityId);
    const fragmentRow = store.getEntity(fragment.entityId);
    if (!canonicalRow || !fragmentRow) return { status: "refused", reason: "entity_missing", proposal };
    const named = store.addEntityAlias({ entityId: canonical.entityId, alias: fragment.name ?? fragmentRow.name ?? "" });
    if (named.status !== "ok" && named.status !== "already" && named.status !== "noop") {
      return { status: "refused", reason: named.status ?? "alias_failed", proposal };
    }
    const absorbed = store.absorbEntity({ fromId: fragment.entityId, intoId: canonical.entityId, at });
    if (absorbed.status !== "ok") return { status: "refused", reason: absorbed.reason ?? absorbed.status, proposal };
    store.tx(() => {
      store.db
        .prepare("UPDATE proposals SET status = 'applied', decision = 'applied', decided_at = ?, updated_at = ? WHERE id = ?")
        .run(at, at, proposal.id);
    });
    return {
      status: "applied",
      written: "aliased",
      alias: named.status,
      moved: absorbed.moved ?? 0,
      retired: absorbed.retired ?? 0,
      proposal: getProposal(store, proposal.id),
    };
  }

  // Accepting a proposal must not launder personal data past the privacy gate:
  // the value is scanned again at write time, not trusted from submission.
  const sensitive = privacyHits(proposal.value).length > 0;
  const written = store.tx(() => {
    const result = store.writeFact({
      entity: { name: proposal.entity, type: proposal.entity === "user" ? "person" : "project" },
      predicate: proposal.predicate,
      value: proposal.value,
      cardinality: proposal.cardinality,
      scope: proposal.scope,
      qualifiers: proposal.qualifiers,
      evidenceLevel: "confirmed_user",
      privacyClass: sensitive ? "sensitive" : "standard",
      modelUseAllowed: !sensitive,
      observedAt: at,
      source: {
        sourceType: "manual",
        namespace: "proposal",
        sessionId: null,
        seq: null,
        messageId: proposal.id,
        role: "user",
        textRange: null,
        evidenceHash: sha256(`proposal:${proposal.id}:${proposal.revision}`),
        quote: `提案采纳：${proposal.entity} · ${proposal.predicate} = ${proposal.value}`,
      },
    });
    store.db
      .prepare("UPDATE proposals SET status = 'applied', decision = 'applied', decided_at = ?, updated_at = ?, applied_fact_id = ? WHERE id = ?")
      .run(at, at, result.fact.id, proposal.id);
    store.bumpGeneration();
    return result;
  });
  return { status: "applied", factId: written.fact.id, written: written.status, previous: written.previous?.value ?? null, proposal: getProposal(store, proposalId) };
}

export function rejectProposal(store, { proposalId, at = nowIso() } = {}) {
  const proposal = getProposal(store, proposalId);
  if (!proposal) return { status: "not_found" };
  if (proposal.status === "applied") return { status: "already", proposal };
  if (proposal.status === "rejected") return { status: "already", proposal };
  store.tx(() => {
    store.db
      .prepare("UPDATE proposals SET status = 'rejected', decision = 'rejected', decided_at = ?, updated_at = ? WHERE id = ?")
      .run(at, at, proposal.id);
    store.bumpGeneration();
  });
  return { status: "rejected", proposal: getProposal(store, proposalId) };
}

/**
 * Strike rows out of an aggregated proposal before accepting it.
 *
 * The health check files one proposal per class of problem ("nine log lines that
 * only differ by date"), and the honest review gesture is "these eight, not that
 * one" — rejecting the whole card and doing nothing is the wrong default. Only
 * fact-shaped rows can be dropped: an entity-alias card is a single two-row
 * decision, and dropping its canonical side would leave nothing to merge into.
 * The fingerprint is left untouched on purpose: narrowing does not create a new
 * claim, and recomputing it could collide with another open card.
 */
export function pruneProposal(store, { proposalId, dropFactIds = [], at = nowIso() } = {}) {
  const proposal = getProposal(store, proposalId);
  if (!proposal) return { status: "not_found" };
  if (proposal.status !== "pending") return { status: "not_pending", proposal };
  if (!["retire", "fold_log"].includes(proposal.action)) {
    return { status: "refused", message: "这类提案只能整条接受或拒绝。", proposal };
  }
  const drop = new Set((dropFactIds ?? []).map((id) => String(id ?? "")).filter(Boolean));
  if (drop.size === 0) return { status: "refused", message: "没有指定要剔除的明细。", proposal };
  const kept = (proposal.targets ?? []).filter((target) => !drop.has(String(target.factId ?? "")));
  if (kept.length === (proposal.targets ?? []).length) {
    return { status: "refused", message: "这些明细不在这条提案里。", proposal };
  }
  if (kept.length === 0) return { status: "refused", message: "不能把明细全部剔除；整条不需要就选拒绝。", proposal };
  if (proposal.action === "fold_log" && !kept.some((target) => String(target.role ?? "") === "keep")) {
    return { status: "refused", message: "折叠要留一条当主值，那条不能剔除。", proposal };
  }
  store.tx(() => {
    store.db
      .prepare("UPDATE proposals SET targets = ?, revision = revision + 1, base_generation = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(kept), store.meta.generation, at, proposal.id);
  });
  const fresh = getProposal(store, proposal.id);
  return { status: "ok", proposal: fresh, dropped: (proposal.targets ?? []).length - kept.length };
}

/**
 * Editing a proposal produces a new revision and re-runs the fence: the old
 * revision is retired, the new one is pending again with a fresh base.
 */
export function reviseProposal(store, { proposalId, value, reason = "edited" } = {}) {
  const proposal = getProposal(store, proposalId);
  if (!proposal) return { status: "not_found" };
  if (proposal.status !== "pending") return { status: "not_pending", proposal };
  const next = String(value ?? proposal.value).trim();
  if (next === "") return { status: "refused", message: "改后的值不能为空。" };
  const at = nowIso();
  const normalized = normValue(next);
  const fingerprint = proposalFingerprint({
    kind: proposal.kind,
    action: proposal.action,
    entityName: proposal.entity,
    predicate: proposal.predicate,
    normValue: normalized,
    scope: proposal.scope,
    qualifiersKey: qualifierKey(proposal.qualifiers),
    targets: proposal.targets,
  });
  try {
    store.tx(() => {
      store.db
        .prepare(
          `UPDATE proposals SET value_text = ?, norm_value = ?, revision = revision + 1, fingerprint = ?,
             base_generation = ?, reason = ?, updated_at = ? WHERE id = ?`,
        )
        .run(next, normalized, fingerprint, store.meta.generation, String(reason).slice(0, 400), at, proposal.id);
    });
  } catch (error) {
    // Editing a proposal into the same value as another open one trips the unique
    // index; that is a refusal to show, not a crash.
    if (/UNIQUE constraint failed/i.test(String(error?.message))) {
      return { status: "refused", message: "已有一条待审提案就是这个值，先处理那一条。" };
    }
    throw error;
  }
  return { status: "revised", proposal: getProposal(store, proposalId) };
}

/** Facts a proposal points at, for the panel's diff view. */
export function proposalTargetFacts(store, proposal) {
  return (proposal.targets ?? []).map((target) => store.getFact(target.factId)).filter(Boolean);
}
