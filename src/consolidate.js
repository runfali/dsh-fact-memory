/**
 * Near-duplicate consolidation: recall, then ask a model, then let a human decide.
 *
 * Two writers describe the same statement in different words (the rule extractor,
 * the model extractor and an explicit `memory_write` all do it), and the library
 * ends up with two rows that mean one thing. Neither half of the cheap machinery
 * can settle that alone:
 *
 *   - IDF cosine catches shared vocabulary, but "测试结果 187" / "测试结果 188"
 *     score 0.89 and state different facts — a merge there destroys a value;
 *   - embeddings catch a re-phrasing ("正式上线" / "上线状态", cosine 0.916) and
 *     miss an identifier difference the cosine does not feel.
 *
 * So recall is the UNION of both, and the decision is a model's, with a strict
 * closed answer. The model only ever says same / distinct / unsure — it never
 * picks the survivor and never writes: the keeper is decided by rules (evidence
 * level, then the earlier observation), and v1 turns every merge into a pending
 * proposal. Nothing in the library changes until a person accepts it.
 *
 * Boundaries that matter:
 *   - sensitive and credential facts are excluded by the query itself: their text
 *     must not leave the machine for a model;
 *   - pairs are compared inside one entity and one scope only — "api 端口 7801"
 *     and "web 端口 7801" are two facts, and a cross-scope merge is never right;
 *   - a judgement is remembered per vector generation, so the same pair is never
 *     paid for twice and a re-embedding re-opens it;
 *   - a failed call records an attempt and changes nothing.
 */
import { buildIdfFn, classifyPair, factTokens, vetoThetaFor } from "./dedup.js";
import { createProposal } from "./proposals.js";
import { blobToVector, cosine } from "./semantic.js";
import { nowIso, oneLine, sha256 } from "./util.js";

export const CONSOLIDATE_LIMITS = {
  /** Vectors below this are not considered the same statement by recall. */
  cosineFloor: 0.85,
  /** Pairs one sweep may look at (cheap, local). */
  maxPairs: 60,
  /** Model calls one sweep may spend (the expensive part). */
  maxJudgements: 8,
  /** A pair the model could not answer is retried this many times, then parked. */
  maxAttempts: 3,
  maxReasonChars: 80,
};

const EVIDENCE_RANK = { explicit_user: 3, confirmed_user: 2, observed: 1, unverified: 0 };

/**
 * One pair's identity: the two row ids plus the vector generation they were
 * compared under. Including the fingerprint is what makes the memo expire when
 * the embedding model changes — the same two rows may look different to a new
 * vector space, so the old verdict must not silence the question.
 */
export function pairKeyOf({ fingerprint, leftId, rightId }) {
  const ids = [String(leftId ?? ""), String(rightId ?? "")].sort();
  return sha256([String(fingerprint ?? ""), ids[0], ids[1]].join("\u0001"));
}

function vectorOf(blob) {
  if (!blob) return null;
  try {
    const vector = blobToVector(blob);
    return Array.isArray(vector) && vector.length > 0 ? vector : null;
  } catch {
    return null;
  }
}

/**
 * Every pair worth asking about, cheapest evidence first: lexical tier from the
 * existing classifier, vector cosine when both rows carry one for this
 * generation. A pair qualifies if EITHER leg fires.
 */
export function collectDuplicatePairs(store, { fingerprint = "", cosineFloor = CONSOLIDATE_LIMITS.cosineFloor, maxPairs = CONSOLIDATE_LIMITS.maxPairs, limit = 400 } = {}) {
  const rows = store.dedupCandidates({ fingerprint, limit });
  if (rows.length < 2) return [];
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.entity_id}\u0000${row.scope}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const pairs = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const documents = group.map((row) => factTokens({ entity: row.entity_name, predicate: row.predicate, value: row.value_text }));
    const idfFn = buildIdfFn(documents);
    const thresholds = { cosineFloor, docCount: group.length, vetoThetaIdf: vetoThetaFor(group.length) };
    const vectors = group.map((row) => vectorOf(row.vector));
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const left = group[i];
        const right = group[j];
        const verdict = classifyPair(documents[i], documents[j], idfFn, thresholds);
        const lexical = Number(verdict.score ?? 0);
        const vector = vectors[i] && vectors[j] ? cosine(vectors[i], vectors[j]) : null;
        const byVector = vector !== null && vector >= cosineFloor;
        const byLexical = verdict.tier !== "none";
        if (!byVector && !byLexical) continue;
        pairs.push({
          pairKey: pairKeyOf({ fingerprint, leftId: left.id, rightId: right.id }),
          fingerprint,
          left,
          right,
          cosine: vector === null ? null : Number(vector.toFixed(4)),
          lexical: Number(lexical.toFixed(4)),
          tier: verdict.tier,
          scope: left.scope,
        });
      }
    }
  }
  // Strongest evidence first; a pure vector hit outranks a lexical-only one
  // because the lexical tier is already the cheaper, higher-precision signal.
  pairs.sort((a, b) => (b.cosine ?? 0) - (a.cosine ?? 0) || b.lexical - a.lexical);
  // Then round-robin across subjects before spending the budget. One subject with a
  // pile of near-identical rows (a nightly backup log writes one per night) would
  // otherwise consume every model call the run is allowed, and every other subject's
  // duplicates would wait for the next sweep.
  const ordered = interleaveByEntity(pairs);
  return ordered.slice(0, Math.max(1, Number(maxPairs) || CONSOLIDATE_LIMITS.maxPairs));
}

/** Pairs interleaved by subject, preserving the score order inside each subject. */
export function interleaveByEntity(pairs) {
  const buckets = new Map();
  for (const pair of pairs) {
    const key = String(pair.left?.entity_id ?? "");
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(pair);
  }
  const out = [];
  for (let moved = true; moved; ) {
    moved = false;
    for (const bucket of buckets.values()) {
      const next = bucket.shift();
      if (!next) continue;
      out.push(next);
      moved = true;
    }
  }
  return out;
}

/**
 * Which row survives a merge. Rules, never the model: the better evidence wins,
 * and between two equally-evidenced statements the earlier observation is the
 * memory while the later one is its echo. The id tiebreak keeps the answer
 * deterministic, so a repeated run files the same proposal instead of its mirror.
 */
export function preferredKeep(left, right) {
  const rank = (row) => EVIDENCE_RANK[row.evidence_level] ?? 0;
  const leftRank = rank(left);
  const rightRank = rank(right);
  if (leftRank !== rightRank) return leftRank > rightRank ? left.id : right.id;
  const leftAt = Date.parse(left.observed_at ?? "") || 0;
  const rightAt = Date.parse(right.observed_at ?? "") || 0;
  if (leftAt !== rightAt) return leftAt <= rightAt ? left.id : right.id;
  return String(left.id) <= String(right.id) ? left.id : right.id;
}

export const JUDGE_SYSTEM = [
  "你在判断两条已存事实是不是同一件事的两种说法。",
  "只回答 what（是否同一件事），不要选择保留哪一条，也不要做任何写操作。",
  "same：去掉措辞差异后是同一个主张，包括同义属性名、全称/简称、加了时间戳的复述。",
  "distinct：值不同（187 与 188）、时间窗口不同、限定条件不同，或指向不同对象。",
  "unsure：只给了两条陈述，信息不足以判断。",
  '只输出 JSON：{"decision":"same|distinct|unsure","keep":"left|right|neither","reason":"不超过 80 字的理由"}',
].join("\n");

export const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "keep", "reason"],
  properties: {
    decision: { type: "string", enum: ["same", "distinct", "unsure"] },
    keep: { type: "string", enum: ["left", "right", "neither"] },
    reason: { type: "string", maxLength: 80 },
  },
};

/** The prompt is the two statements and nothing else: no ids, no library dump. */
export function judgePrompt(pair) {
  const line = (label, row) =>
    `${label}: 主体=${row.entity_name} · 属性=${row.predicate} · 值=${row.value_text} · 证据=${row.evidence_level} · 观察于=${row.observed_at}`;
  return [
    line("A", pair.left),
    line("B", pair.right),
    "",
    "这两条是同一件事吗？只输出 JSON。",
  ].join("\n");
}

/** Pull the first JSON object out of a model answer (it may be fenced). */
export function parseJudgeAnswer(text) {
  const raw = String(text ?? "").trim();
  if (raw === "") return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const decision = String(parsed.decision ?? "").trim();
  if (!["same", "distinct", "unsure"].includes(decision)) return null;
  const keep = ["left", "right", "neither"].includes(String(parsed.keep ?? "").trim()) ? String(parsed.keep).trim() : "neither";
  const reason = String(parsed.reason ?? "").trim().slice(0, CONSOLIDATE_LIMITS.maxReasonChars);
  return { decision, keep, reason };
}

function mergeProposal(store, pair, keepId) {
  const winner = String(keepId) === String(pair.left.id) ? pair.left : pair.right;
  const loser = winner === pair.left ? pair.right : pair.left;
  const leftRevision = Number(store.getFact(pair.left.id)?.recordRevision ?? 0);
  const rightRevision = Number(store.getFact(pair.right.id)?.recordRevision ?? 0);
  const verdict = pair.cosine === null ? `词法 ${pair.lexical}` : `向量 ${pair.cosine}`;
  const result = createProposal(store, {
    kind: "merge",
    action: "merge",
    entityName: winner.entity_name,
    predicate: winner.predicate,
    value: winner.value_text,
    cardinality: "unknown",
    scope: winner.scope,
    // The role says which side survives: applying the proposal must not have to
    // re-derive it from evidence, because the user may have accepted a proposal
    // filed under an older evidence ranking.
    targets: [
      { factId: keepId, recordRevision: keepId === pair.left.id ? leftRevision : rightRevision, role: "keep" },
      { factId: keepId === pair.left.id ? pair.right.id : pair.left.id, recordRevision: keepId === pair.left.id ? rightRevision : leftRevision, role: "drop" },
    ],
    evidence: [{ factId: pair.left.id, quote: pair.left.value_text }, { factId: pair.right.id, quote: pair.right.value_text }],
    evidenceLevel: "observed",
    confidence: pair.decision === "same" ? 0.8 : 0.5,
    reason: `近重复（${verdict}）：${pair.reason || "模型判定可归并"}`,
  });
  return { result, winner, loser };
}

/**
 * One consolidation pass.
 *
 * `judge` is injected so the caller owns the model (host or custom) and the tests
 * own the answers: it receives one pair and returns {decision, keep, reason} or
 * null when the model is unavailable. A null answer is not a verdict — the pair
 * keeps its attempt count and stays queued.
 */
export async function runConsolidation({ store, judge, fingerprint = "", model = "", limits = {}, at = nowIso() } = {}) {
  const started = Date.now();
  const cfg = { ...CONSOLIDATE_LIMITS, ...limits };
  const pairs = collectDuplicatePairs(store, { fingerprint, cosineFloor: cfg.cosineFloor, maxPairs: cfg.maxPairs });
  if (pairs.length === 0) {
    const reason = fingerprint === "" ? "no_vector_generation" : "no_candidate_pairs";
    store.recordDedupRun({ status: "skipped", reason, pairs: 0, at, durationMs: Date.now() - started });
    return { status: "skipped", reason, pairs: 0, judged: 0, proposals: 0 };
  }
  if (typeof judge !== "function") {
    store.recordDedupRun({ status: "deferred", reason: "no_model", pairs: pairs.length, at, durationMs: Date.now() - started });
    return { status: "deferred", reason: "no_model", pairs: pairs.length, judged: 0, proposals: 0 };
  }

  const counts = { judged: 0, same: 0, distinct: 0, unsure: 0, proposals: 0, failed: 0, deferred: 0 };
  for (const pair of pairs) {
    if (counts.judged >= cfg.maxJudgements) break;
    const previous = store.dedupJudgement(pair.pairKey);
    if (previous && ["resolved", "proposed"].includes(previous.status)) continue;
    const attempts = Number(previous?.attempts ?? 0);
    if (previous && previous.status === "failed" && attempts >= cfg.maxAttempts) continue;
    let answer = null;
    try {
      answer = await judge(pair);
    } catch (error) {
      answer = null;
      pair.reason = oneLine(error).slice(0, cfg.maxReasonChars);
    }
    if (!answer) {
      counts.failed += 1;
      store.recordDedupJudgement({
        pairKey: pair.pairKey,
        fingerprint,
        leftId: pair.left.id,
        rightId: pair.right.id,
        scope: pair.scope,
        cosine: pair.cosine,
        lexical: pair.lexical,
        // A failure has no verdict; the column is NOT NULL, so it records the
        // weakest honest answer and the status says the pair was not decided.
        decision: "unsure",
        keepId: null,
        dropId: null,
        reason: pair.reason || "模型未给出可用答案",
        source: "model",
        status: "failed",
        attempts: attempts + 1,
        createdAt: previous?.created_at ?? at,
        at,
      });
      continue;
    }
    counts.judged += 1;
    counts[answer.decision] += 1;
    const keepId = preferredKeep(pair.left, pair.right);
    if (answer.decision === "distinct") {
      // "These are two different facts" needs no human action, and remembering it
      // is what keeps the pair out of the next sweep.
      store.recordDedupJudgement({
        pairKey: pair.pairKey,
        fingerprint,
        leftId: pair.left.id,
        rightId: pair.right.id,
        scope: pair.scope,
        cosine: pair.cosine,
        lexical: pair.lexical,
        decision: "distinct",
        keepId,
        dropId: null,
        reason: answer.reason,
        source: "model",
        status: "resolved",
        attempts: attempts + 1,
        createdAt: previous?.created_at ?? at,
        at,
      });
      continue;
    }
    // same / unsure: v1 files a proposal and changes nothing on its own.
    const filed = mergeProposal(store, { ...pair, decision: answer.decision, reason: answer.reason }, keepId);
    const proposalId = filed.result?.proposal?.id ?? null;
    store.recordDedupJudgement({
      pairKey: pair.pairKey,
      fingerprint,
      leftId: pair.left.id,
      rightId: pair.right.id,
      scope: pair.scope,
      cosine: pair.cosine,
      lexical: pair.lexical,
      decision: answer.decision,
      keepId,
      dropId: keepId === pair.left.id ? pair.right.id : pair.left.id,
      reason: answer.reason,
      source: "model",
      proposalId,
      status: proposalId ? "proposed" : "failed",
      attempts: attempts + 1,
      createdAt: previous?.created_at ?? at,
      at,
    });
    if (proposalId) counts.proposals += 1;
  }
  const status = counts.judged > 0 || counts.failed === 0 ? "ok" : "error";
  store.recordDedupRun({
    status,
    reason: counts.deferred > 0 ? "model_deferred" : "",
    pairs: pairs.length,
    judged: counts.judged,
    same: counts.same,
    distinct: counts.distinct,
    unsure: counts.unsure,
    proposals: counts.proposals,
    model,
    durationMs: Date.now() - started,
    at,
  });
  return { status, pairs: pairs.length, ...counts };
}

/** The panel's view of the ledger: what was decided recently, and by what. */
export function dedupSummary(store, { limit = 20 } = {}) {
  const runs = store.recentDedupRuns({ limit: 5 });
  const judged = store.recentDedupJudgements({ limit });
  return {
    lastRun: runs[0]
      ? {
          at: runs[0].at,
          status: runs[0].status,
          reason: runs[0].reason,
          pairs: Number(runs[0].pairs),
          judged: Number(runs[0].judged),
          same: Number(runs[0].same_count),
          distinct: Number(runs[0].distinct_count),
          unsure: Number(runs[0].unsure_count),
          proposals: Number(runs[0].proposals),
          model: runs[0].model,
          durationMs: Number(runs[0].duration_ms),
        }
      : null,
    runs: runs.length,
    judged: judged.length,
    open: judged.filter((row) => row.status === "open" || row.status === "failed").length,
  };
}
