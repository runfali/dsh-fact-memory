/**
 * The store: one SQLite file, all writes transactional, every mutation recorded
 * against an operation key so that a retried tool call cannot duplicate a fact.
 *
 * Invariants this module owns (the rest of the plugin may not write SQL):
 *   - a single cardinality slot holds at most one active fact (partial index);
 *   - superseding is bi-temporal: the old row stays, it just stops being current;
 *   - forgetting leaves a tombstone so a replayed session cannot resurrect it;
 *   - the FTS row for a fact always matches its tokens (rebuildable, never
 *     authoritative).
 */
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { DEDUP_LIMITS, buildIdfFn, canonicalEntityKey, classifyPair, factTokens, logSlotKey, vetoThetaFor } from "./dedup.js";
import { ensureSchema, checkIntegrity } from "./schema.js";
import {
  PARSER_VERSION,
  SCHEMA_VERSION,
  casefold,
  hostTimeZone,
  json,
  normValue,
  nowIso,
  oneLine,
  privacyHits,
  safeJson,
  secretHits,
  sha256,
  tokenText,
  uuid,
} from "./util.js";

const FACT_STATUS = new Set(["active", "scheduled", "superseded", "conflict", "expired", "forgotten"]);

/** How many absorbed values a folded slot keeps before dropping the oldest. */
const FOLD_HISTORY_LIMIT = 20;

/** JSON columns are derived data: a damaged one must not take the row down with it. */
function safeParseArray(text) {
  if (Array.isArray(text)) return text;
  if (typeof text !== "string" || text.trim() === "") return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

/** Clamp a paging value without letting NaN through as SQLite's LIMIT NULL (no limit). */
function clampInt(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

/** Escape LIKE metacharacters; callers pair it with ESCAPE '\\'. */
function likeText(value) {
  return String(value).replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Parse a stored validity bound into a comparable instant; null means "open". */
function timeBound(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Do two statements claim the same stretch of time? C.5.3 only lets an
 * automatic replacement happen when the windows cannot both be true; a plain
 * present-tense update (neither side declares a window) is not an overlap.
 */
export function overlapsInTime(current, next, at) {
  const plain = !current.validFrom && !current.validTo && !next.validFrom && !next.validTo;
  if (plain) return false;
  const atMs = timeBound(at, Date.now());
  const aStart = timeBound(current.validFrom, Number.NEGATIVE_INFINITY);
  const aEnd = timeBound(current.validTo, Number.POSITIVE_INFINITY);
  const bStart = timeBound(next.validFrom, atMs);
  const bEnd = timeBound(next.validTo, Number.POSITIVE_INFINITY);
  return bStart < aEnd && aStart < bEnd;
}

/** Stable JSON so a qualifier set has one key regardless of property order. */
export function qualifierKey(qualifiers) {
  const value = qualifiers && typeof qualifiers === "object" ? qualifiers : {};
  const keys = Object.keys(value).sort();
  if (keys.length === 0) return "{}";
  return JSON.stringify(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

export function claimKeyOf({ entityName, predicate, qualifiers, value }) {
  return sha256([normValue(entityName), casefold(predicate), qualifierKey(qualifiers), normValue(value)].join("\u0001"));
}

/**
 * SQL predicate for "the model may see this row". `model_use_allowed` is the
 * per-row decision; the `sensitiveModelVisible` switch widens it to personal data
 * at read time so flipping the switch changes what the model sees immediately,
 * without rewriting rows. A credential (`fact_secrets`) is never included, switch
 * or not — that asymmetry is deliberate.
 */
export function visibleSql({ alias = "f", includeSensitive = false } = {}) {
  // A credential is never visible, whatever any other column says: the mark is
  // derived from the value, so a hand-edited permission cannot expose one.
  const notSecret = `NOT EXISTS (SELECT 1 FROM fact_secrets sec WHERE sec.fact_id = ${alias}.id)`;
  // Personal data is governed by the read-time switch, not by the permission
  // stamped when the row was written — otherwise turning the switch off would
  // leave older sensitive rows readable, which is not what the switch says.
  const allowed = includeSensitive
    ? `(${alias}.privacy_class = 'sensitive' OR ${alias}.model_use_allowed = 1)`
    : `${alias}.model_use_allowed = 1 AND ${alias}.privacy_class != 'sensitive'`;
  return `${notSecret} AND ${allowed}`;
}

export function factSearchText(row) {
  const qualifiers = row.qualifiers && row.qualifiers !== "{}" ? Object.values(safeJson(row.qualifiers, {})).join(" ") : "";
  return tokenText([row.entity_name ?? "", row.predicate, row.value_text, qualifiers].join(" "));
}

/** Public shape of a dream row: snake_case in SQL, camelCase outside. */
export function rowToDream(row) {
  if (!row) return null;
  return {
    id: row.id,
    topicKey: row.topic_key,
    title: row.title,
    body: row.body,
    topics: safeParseArray(row.topics_json),
    factIds: safeParseArray(row.fact_ids_json),
    sources: (() => {
      try {
        const parsed = JSON.parse(row.sources_json ?? "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })(),
    status: row.status,
    evidence: row.evidence,
    novelty: row.novelty,
    unverified: Number(row.unverified) === 1,
    // World time: validFrom is the earliest source message, validTo the moment the
    // claim stopped being true (set when something replaces it). Transaction time
    // stays in createdAt/updatedAt, so both axes survive.
    validFrom: row.valid_from ?? null,
    validTo: row.valid_to ?? null,
    hitCount: Number(row.hit_count ?? 0),
    lastHitAt: row.last_hit_at ?? null,
    // Reads are the model actually opening the note (dream_read); hits are the
    // topic coming up in conversation. Kept apart because they answer different
    // questions: is the topic still alive, versus does the model ever use it.
    readCount: Number(row.read_count ?? 0),
    lastReadAt: row.last_read_at ?? null,
    supersedesId: row.supersedes_id ?? null,
    supersededBy: row.superseded_by ?? null,
    runId: row.run_id ?? null,
    digest: row.digest,
    model: row.model,
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Column mapping for the JSON surface: snake_case in SQL, camelCase outside. */
export function rowToFact(row) {
  if (!row) return null;
  return {
    id: row.id,
    entityId: row.entity_id,
    entity: row.entity_name ?? null,
    entityType: row.entity_type ?? null,
    predicate: row.predicate,
    value: row.value_text,
    valueEntityId: row.value_entity_id ?? null,
    cardinality: row.cardinality,
    scope: row.scope,
    // One corrupt column must not take down every surface that reads facts: the
    // fallback is the empty value the column always means.
    qualifiers: safeJson(row.qualifiers || "{}", {}),
    status: row.status,
    confidence: row.confidence,
    evidenceLevel: row.evidence_level,
    privacyClass: row.privacy_class,
    modelUseAllowed: row.model_use_allowed === 1,
    observedAt: row.observed_at,
    validFrom: row.valid_from ?? null,
    validTo: row.valid_to ?? null,
    timePrecision: row.time_precision,
    timeZone: row.time_zone ?? null,
    supersededBy: row.superseded_by ?? null,
    conflictGroupId: row.conflict_group_id ?? null,
    claimKey: row.claim_key,
    recordRevision: row.record_revision,
    /** How many observations of a recurring job were folded into this row. */
    foldedCount: Number(row.folded_count ?? 0),
    /** The values absorbed by a fold, oldest first (capped, never authoritative). */
    foldedFrom: safeParseArray(row.folded_from),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const FACT_SELECT = `SELECT f.*, e.name AS entity_name, e.type AS entity_type
  FROM facts f JOIN entities e ON e.id = f.entity_id`;

export class MemoryStore {
  constructor(db, { dataDir, timezone }) {
    this.db = db;
    this.dataDir = dataDir;
    this.path = join(dataDir, "memory.db");
    this.timezone = timezone || hostTimeZone();
    this.depth = 0;
  }

  static open({ dataDir, timezone = hostTimeZone(), freshStoreId }) {
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "memory.db");
    const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    ensureSchema(db, { storeTimezone: timezone, parserVersion: PARSER_VERSION, freshStoreId });
    return new MemoryStore(db, { dataDir, timezone });
  }

  get meta() {
    const row = this.db.prepare("SELECT * FROM store_meta WHERE id = 1").get();
    return {
      schemaVersion: row.schema_version,
      storeId: row.store_id,
      generation: row.generation,
      lastEventSeq: row.last_event_seq,
      timezone: row.store_timezone,
      parserVersion: row.parser_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * `PRAGMA integrity_check` walks the whole database, so the settings card's
   * 15-second poll must not run it every time. The answer is cached briefly and
   * any caller that needs certainty (a repair flow) passes `force`.
   */
  integrity({ maxAgeMs = 30000, force = false } = {}) {
    const now = Date.now();
    if (!force && this._integrity && now - this._integrity.at < maxAgeMs) return this._integrity.value;
    const value = checkIntegrity(this.db);
    this._integrity = { at: now, value };
    return value;
  }

  /** Nested-safe transaction. Rollback restores the previous savepoint level. */
  tx(fn, { immediate = true } = {}) {
    const outer = this.depth === 0;
    const name = `sp_${this.depth}`;
    if (outer) this.db.exec(immediate ? "BEGIN IMMEDIATE" : "BEGIN");
    else this.db.exec(`SAVEPOINT ${name}`);
    // A supersede closes the old row by pointing at the new one, which does not
    // exist yet; deferred FK checks are what make that legal.
    if (outer) this.db.exec("PRAGMA defer_foreign_keys = ON");
    this.depth += 1;
    try {
      const result = fn();
      this.depth -= 1;
      if (outer) this.db.exec("COMMIT");
      else this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.depth -= 1;
      try {
        if (outer) this.db.exec("ROLLBACK");
        else this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      } catch {
        /* keep the original failure */
      }
      throw error;
    }
  }

  bumpGeneration() {
    this.db.prepare("UPDATE store_meta SET generation = generation + 1, updated_at = ? WHERE id = 1").run(nowIso());
    return this.meta.generation;
  }

  // ── entities ───────────────────────────────────────────────────────────
  ensureEntity({ name, type = "project", scope = "global", aliases = [] }) {
    const normName = normValue(name);
    if (normName === "") throw new Error("entity name is empty");
    const existing = this.db
      .prepare("SELECT * FROM entities WHERE norm_name = ? AND scope = ?")
      .get(normName, scope);
    if (existing) {
      if (existing.status === "active") return { id: existing.id, created: false, entity: existing };
      // A retired or merged entity may be revived by an explicit write; merged
      // entities resolve to their surviving target instead of splitting history.
      if (existing.status === "merged" && existing.merged_into) {
        return { id: existing.merged_into, created: false, entity: existing };
      }
      this.db
        .prepare("UPDATE entities SET status = 'active', record_revision = record_revision + 1, updated_at = ? WHERE id = ?")
        .run(nowIso(), existing.id);
      return { id: existing.id, created: false, entity: existing };
    }
    // An alias someone already taught us is the same subject. Aliases used to be
    // write-only — recorded on the absorbing entity and then never consulted — so
    // a spelling the user had already accepted still fell through to the
    // shape-based search below and, when it was not shape-identical, created a
    // second entity for the same thing.
    const byAlias = this.db
      .prepare("SELECT * FROM entities WHERE scope = ? AND status = 'active'")
      .all(scope)
      .find((row) => {
        let known = [];
        try {
          known = JSON.parse(row.aliases || "[]");
        } catch {
          return false;
        }
        return Array.isArray(known) && known.some((alias) => normValue(alias) === normName);
      });
    if (byAlias) return { id: byAlias.id, created: false, entity: byAlias };
    // A second spelling of a subject we already know must not create a second
    // entity: it would split one subject across two graph nodes and let the same
    // statement be stored twice under two names. The known spelling absorbs it.
    const canonical = canonicalEntityKey(name);
    const twin = canonical === ""
      ? null
      : this.db
        .prepare("SELECT * FROM entities WHERE scope = ? AND status = 'active'")
        .all(scope)
        .find((row) => canonicalEntityKey(row.name) === canonical);
    if (twin) {
      let known = [];
      try {
        known = JSON.parse(twin.aliases || "[]");
      } catch {
        known = [];
      }
      if (!Array.isArray(known)) known = [];
      const spelled = String(name).trim();
      if (!known.includes(spelled) && normValue(spelled) !== twin.norm_name) {
        this.db
          .prepare("UPDATE entities SET aliases = ?, updated_at = ?, record_revision = record_revision + 1 WHERE id = ?")
          .run(json([...known, spelled]), nowIso(), twin.id);
      }
      return { id: twin.id, created: false, entity: twin };
    }

    const id = uuid();
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO entities (id, name, norm_name, type, aliases, scope, status, record_revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
      )
      .run(id, String(name).trim(), normName, type, json(aliases), scope, at, at);
    return { id, created: true, entity: { id, name, norm_name: normName, type, scope } };
  }

  entities({ limit = 500 } = {}) {
    return this.db
      .prepare("SELECT * FROM entities WHERE status = 'active' ORDER BY updated_at DESC LIMIT ?")
      .all(limit);
  }

  // ── facts ──────────────────────────────────────────────────────────────
  getFact(id) {
    return rowToFact(this.db.prepare(`${FACT_SELECT} WHERE f.id = ?`).get(id));
  }

  /**
   * One slot = one subject + one property + one scope + one qualifier set.
   *
   * The predicate comparison is case-insensitive because `claim_key` already
   * folds case: without it "Port" and "port" were two slots to the unique index
   * and one claim to everything else, so a single-valued property could hold two
   * live values. Chinese predicates are unaffected by NOCASE.
   */
  findActiveBySlot({ entityId, predicate, scope, qualifiersKey }) {
    return rowToFact(
      this.db
        .prepare(`${FACT_SELECT} WHERE f.entity_id = ? AND f.predicate = ? COLLATE NOCASE AND f.scope = ? AND f.qualifiers_key = ?
                  AND f.cardinality = 'single' AND f.status IN ('active','scheduled')`)
        .get(entityId, predicate, scope, qualifiersKey),
    );
  }

  findActiveByValue({ entityId, predicate, scope, qualifiersKey, normText }) {
    return rowToFact(
      this.db
        .prepare(`${FACT_SELECT} WHERE f.entity_id = ? AND f.predicate = ? COLLATE NOCASE AND f.scope = ? AND f.qualifiers_key = ?
                  AND f.norm_text = ? AND f.status IN ('active','scheduled')`)
        .get(entityId, predicate, scope, qualifiersKey, normText),
    );
  }

  /**
   * The active fact that already says this, under another name or another
   * property word. Two passes, cheapest first:
   *   1. same property, same value, different subject spelling — a duplicate
   *      regardless of corpus size;
   *   2. near-identical text by IDF-weighted cosine, vetoed when a rare
   *      identifier exists on one side only — only once the corpus is large
   *      enough for IDF to mean anything.
   */
  findNearDuplicateFact({ entityName, predicate, value, scope }) {
    const rows = this.db
      .prepare(`${FACT_SELECT} WHERE f.status = 'active' AND f.scope = ? ORDER BY f.updated_at DESC LIMIT 400`)
      .all(scope);
    if (rows.length === 0) return null;
    const predicateKey = normValue(predicate);
    const valueKey = normValue(value);
    const selfKey = canonicalEntityKey(entityName);
    for (const row of rows) {
      // One subject cannot hold two different properties with the identical
      // value by accident: "首轮开发状态" and "开发状态" are the same statement.
      // Different subjects are deliberately NOT merged here — "api 端口 7801"
      // and "web 端口 7801" are two facts that merely share a number, and the
      // identifier veto in the fuzzy pass is what keeps them apart.
      if (canonicalEntityKey(row.entity_name) !== selfKey) continue;
      if (normValue(row.value_text) !== valueKey) continue;
      if (normValue(row.predicate) === predicateKey) continue;
      return { id: row.id, matchedBy: "same_value" };
    }
    if (rows.length < DEDUP_LIMITS.minCorpus) return null;
    const documents = rows.map((row) => factTokens({ entity: row.entity_name, predicate: row.predicate, value: row.value_text }));
    const idfFn = buildIdfFn(documents);
    const candidate = factTokens({ entity: entityName, predicate, value });
    const thresholds = { ...DEDUP_LIMITS, docCount: rows.length, vetoThetaIdf: vetoThetaFor(rows.length) };
    let best = null;
    rows.forEach((row, index) => {
      const verdict = classifyPair(candidate, documents[index], idfFn, thresholds);
      if (verdict.tier === "none") return;
      if (!best || verdict.score > best.score) best = { id: row.id, score: verdict.score, matchedBy: verdict.tier };
    });
    return best;
  }

  /**
   * Insert one fact. The caller has already decided that this write is allowed;
   * the store decides what it does to the row that occupied the same slot.
   */
  writeFact(input) {
    const {
      entity,
      predicate,
      value,
      valueEntityId = null,
      cardinality = "unknown",
      scope = "global",
      qualifiers = {},
      evidenceLevel = "explicit_user",
      privacyClass: inputPrivacy = "standard",
      modelUseAllowed: inputVisible = true,
      observedAt = nowIso(),
      validFrom = null,
      validTo = null,
      timePrecision = "unknown",
      source = null,
      supersede = true,
    } = input;
    if (String(value ?? "").trim() === "") throw new Error("fact value is empty");
    // A credential is never model-visible, whatever the caller passed: the mark
    // is derived from the value, so no write path can launder one into context.
    const secretValue = secretHits(String(value ?? "")).length > 0;
    const privacyClass = secretValue ? "sensitive" : inputPrivacy;
    const modelUseAllowed = secretValue ? false : inputVisible;

    const written = this.tx(() => {
      // Keep the credential mark inside the same transaction as the row it
      // protects: a crash between the two used to leave a secret fact unmarked.
      const writeOnce = () => {
      const { id: entityId } = this.ensureEntity(entity);
      const normText = normValue(value);
      const qualifiersJson = json(qualifiers);
      const qualifiersKey = qualifierKey(qualifiers);
      const claimKey = claimKeyOf({ entityName: entity.name, predicate, qualifiers, value });
      const at = nowIso();

      const current = this.findActiveBySlot({ entityId, predicate, scope, qualifiersKey });
      // A recurring job writes the same line once per run: same residue, new date.
      // Folding keeps one row per slot and still counts the runs, instead of
      // burying the library under one row per night.
      if (current && current.status === "active" && normValue(current.value) !== normText) {
        const folded = this.foldLogSlot({ current, value, normText, observedAt, source, at });
        if (folded) return folded;
      } else if (!current) {
        // No single-valued row holds this slot, but a multi-valued one may still be
        // the same recurring line. Cardinality says how many values a slot allows,
        // not whether two statements are the same statement.
        const folded = this.foldLogSlotInSlot({ entityId, predicate, scope, qualifiersKey, value, normText, observedAt, source, at });
        if (folded) return folded;
      }
      if (current && current.status === "active") {
        if (normValue(current.value) === normText) {
          this.db
            .prepare("UPDATE facts SET observed_at = ?, record_revision = record_revision + 1, updated_at = ? WHERE id = ?")
            .run(observedAt, at, current.id);
          if (source) this.insertSource(current.id, source);
          this.settleSlotConflicts({ entityId, predicate, scope, qualifiersKey, winnerId: current.id, at, observedAt });
          return { status: "duplicate", fact: this.getFact(current.id), previous: null };
        }
        const trusted = evidenceLevel === "explicit_user" || evidenceLevel === "confirmed_user";
        const future = Boolean(validFrom) && Date.parse(validFrom) > Date.parse(at);
        // A future-dated statement is a planned change: end the open-ended value
        // at the planned start and keep the new row `scheduled`. Only an already
        // scheduled rival or an explicitly overlapping end makes it a conflict.
        if (supersede && trusted && future) {
          const scheduledRival = this.db
            .prepare(
              `SELECT id FROM facts WHERE entity_id = ? AND predicate = ? AND scope = ? AND qualifiers_key = ?
                 AND status = 'scheduled' LIMIT 1`,
            )
            .get(entityId, predicate, scope, qualifiersKey);
          const overlapsEnd = current.validTo && Date.parse(current.validTo) > Date.parse(validFrom);
          if (!scheduledRival && !overlapsEnd) {
            if (!current.validTo) {
              this.db
                .prepare(
                  "UPDATE facts SET valid_to = ?, updated_at = ?, record_revision = record_revision + 1 WHERE id = ?",
                )
                .run(validFrom, at, current.id);
            }
            const plannedId = uuid();
            this.insertRow({
              id: plannedId,
              entityId, predicate, value, normText, valueEntityId, cardinality: "single", scope,
              qualifiersJson, qualifiersKey, status: "scheduled", evidenceLevel, privacyClass, modelUseAllowed,
              observedAt, validFrom, validTo, timePrecision, claimKey, at,
            });
            if (source) this.insertSource(plannedId, source);
            this.rebuildFts(plannedId);
            return { status: "scheduled", fact: this.getFact(plannedId), previous: this.getFact(current.id) };
          }
        }
        // An update only replaces silently when the two windows cannot both be
        // true. Overlapping (or incomparable) windows are adjudicated instead.
        const canReplace = trusted && !overlapsInTime(current, { validFrom, validTo }, at);
        if (supersede && canReplace) {
          // Close the old row BEFORE inserting: facts_single_slot only tolerates
          // one active row per slot.
          const id = uuid();
          this.db
            .prepare("UPDATE facts SET status = 'superseded', superseded_by = ?, valid_to = ?, updated_at = ?, record_revision = record_revision + 1 WHERE id = ?")
            .run(id, observedAt, at, current.id);
          this.insertRow({
            id,
            entityId, predicate, value, normText, valueEntityId, cardinality: "single", scope,
            qualifiersJson, qualifiersKey, status: "active", evidenceLevel, privacyClass, modelUseAllowed,
            observedAt, validFrom, validTo, timePrecision, claimKey, at,
          });
          if (source) this.insertSource(id, source);
          this.rebuildFts(id);
          // A user statement settles the slot: any rival row parked as a conflict
          // by an earlier guess now has an authoritative answer.
          this.settleSlotConflicts({ entityId, predicate, scope, qualifiersKey, winnerId: id, at, observedAt });
          return { status: "superseded", fact: this.getFact(id), previous: this.getFact(current.id) };
        }
        // Untrusted evidence contradicting a trusted slot: keep both, open a
        // conflict group instead of silently picking a winner.
        const groupId = current.conflictGroupId && this.openConflictGroup(current.conflictGroupId, at)
          ? current.conflictGroupId
          : this.createConflictGroup(`contradiction:${predicate}`, at);
        const id = this.insertRow({
          entityId, predicate, value, normText, valueEntityId, cardinality: "single", scope,
          qualifiersJson, qualifiersKey, status: "conflict", evidenceLevel, privacyClass, modelUseAllowed,
          observedAt, validFrom, validTo, timePrecision, claimKey, at, conflictGroupId: groupId,
        });
        // C.5.8: a conflict leaves no side looking authoritative. Park the old
        // row as `conflict` before the new one lands, otherwise retrieval would
        // keep answering with the old value and only footnote the dispute.
        this.db
          .prepare(
            "UPDATE facts SET status = 'conflict', conflict_group_id = ?, updated_at = ?, record_revision = record_revision + 1 WHERE id = ?",
          )
          .run(groupId, at, current.id);
        if (source) this.insertSource(id, source);
        this.rebuildFts(id);
        return { status: "conflict", fact: this.getFact(id), previous: this.getFact(current.id), conflictGroupId: groupId };
      }

      const duplicate = this.findActiveByValue({ entityId, predicate, scope, qualifiersKey, normText });
      if (duplicate) {
        this.db
          .prepare("UPDATE facts SET observed_at = ?, record_revision = record_revision + 1, updated_at = ? WHERE id = ?")
          .run(observedAt, at, duplicate.id);
        if (source) this.insertSource(duplicate.id, source);
        this.settleSlotConflicts({ entityId, predicate, scope, qualifiersKey, winnerId: duplicate.id, at, observedAt });
        return { status: "duplicate", fact: this.getFact(duplicate.id), previous: null };
      }

      // The same statement can arrive under another spelling or another property
      // word ("首轮开发状态" vs "开发状态"). Folding it into the fact we already hold
      // is what keeps the library from collecting three copies of one sentence.
      const near = this.findNearDuplicateFact({ entityName: entity.name, predicate, value, scope });
      if (near) {
        this.db
          .prepare("UPDATE facts SET observed_at = ?, record_revision = record_revision + 1, updated_at = ? WHERE id = ?")
          .run(observedAt, at, near.id);
        if (source) this.insertSource(near.id, source);
        return { status: "duplicate", fact: this.getFact(near.id), previous: null, matchedBy: near.matchedBy };
      }

      const status = validFrom && validFrom > at ? "scheduled" : "active";
      const id = this.insertRow({
        entityId, predicate, value, normText, valueEntityId, cardinality, scope,
        qualifiersJson, qualifiersKey, status, evidenceLevel, privacyClass, modelUseAllowed,
        observedAt, validFrom, validTo, timePrecision: validFrom ? "day" : timePrecision, claimKey, at,
      });
      if (source) this.insertSource(id, source);
      this.rebuildFts(id);
      this.settleSlotConflicts({ entityId, predicate, scope, qualifiersKey, winnerId: id, at, observedAt });
      return { status: "inserted", fact: this.getFact(id), previous: null };
      };
      const result = writeOnce();
      if (secretValue && result?.fact?.id) this.markSecret(result.fact.id);
      return result;
    });
    return written;
  }

  /** Record that a fact holds a credential; `visibleSql` excludes it forever. */
  markSecret(factId) {
    this.db
      .prepare("INSERT OR IGNORE INTO fact_secrets (fact_id, marked_at) VALUES (?, ?)")
      .run(factId, nowIso());
  }

  isSecretFact(factId) {
    return Boolean(this.db.prepare("SELECT 1 AS hit FROM fact_secrets WHERE fact_id = ?").get(factId));
  }

  /**
   * Retire every rival row a contradiction left in `conflict` status for one slot,
   * and close its group. Without this a slot could keep an authoritative answer
   * forever shadowed by an older guess, and `memory_search` would keep reporting
   * `needs_selection` for a question the user already settled.
   */
  settleSlotConflicts({ entityId, predicate, scope, qualifiersKey, winnerId, at, observedAt }) {
    const rivals = this.db
      .prepare(
        `SELECT id, conflict_group_id FROM facts
          WHERE entity_id = ? AND predicate = ? AND scope = ? AND qualifiers_key = ?
            AND status = 'conflict' AND id != ?`,
      )
      .all(entityId, predicate, scope, qualifiersKey, winnerId);
    if (rivals.length === 0) return 0;
    const retire = this.db.prepare(
      `UPDATE facts SET status = 'superseded', superseded_by = ?, valid_to = COALESCE(valid_to, ?), updated_at = ?,
         record_revision = record_revision + 1 WHERE id = ?`,
    );
    const closeGroup = this.db.prepare(
      "UPDATE conflict_groups SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ? AND status = 'open'",
    );
    for (const rival of rivals) {
      retire.run(winnerId, observedAt, at, rival.id);
      if (rival.conflict_group_id) closeGroup.run(at, at, rival.conflict_group_id);
    }
    return rivals.length;
  }

  /**
   * Fold one observation of a recurring job into the row that already holds it.
   *
   * `logSlotKey` decides: the two values must be identical apart from one real
   * calendar date, which is what keeps "测试结果 187" and "测试结果 188" apart. The
   * absorbed value is pushed onto `folded_from` so the history stays readable,
   * and `observed_at` moves to the newest run — a pipeline that stops updating is
   * a pipeline whose job stopped running.
   *
   * Returns null when this is not a log slot, so the caller keeps looking.
   */
  foldLogSlot({ current, value, normText, observedAt, source, at }) {
    const before = logSlotKey(current.value);
    if (!before || before !== logSlotKey(value)) return null;
    const trimmed = String(value).trim();
    const history = [...safeParseArray(current.foldedFrom), current.value].slice(-FOLD_HISTORY_LIMIT);
    // The claim key is what tombstone matching and JSONL de-duplication compare. A row
    // whose value moved has to carry the matching key, or the next import of the same
    // observation looks like a new fact instead of the row it already is.
    const entity = this.db.prepare("SELECT name FROM entities WHERE id = ?").get(current.entityId);
    const claimKey = claimKeyOf({
      entityName: entity?.name ?? "",
      predicate: current.predicate,
      qualifiers: current.qualifiers,
      value: trimmed,
    });
    this.db
      .prepare(
        `UPDATE facts SET value_text = ?, norm_text = ?, claim_key = ?, observed_at = ?, updated_at = ?,
           folded_count = folded_count + 1, folded_from = ?, record_revision = record_revision + 1 WHERE id = ?`,
      )
      .run(trimmed, normText, claimKey, observedAt, at, JSON.stringify(history), current.id);
    if (source) this.insertSource(current.id, source);
    this.rebuildFts(current.id);
    // Read the count back instead of deriving it: history is capped, so the derived
    // number stopped at 21 while the column kept counting.
    const folded = this.db.prepare("SELECT folded_count FROM facts WHERE id = ?").get(current.id);
    return { status: "folded", fact: this.getFact(current.id), previous: current, foldedCount: Number(folded?.folded_count ?? 1) };
  }

  /**
   * Fold into whichever active row in this slot is the same line with another
   * date, regardless of cardinality.
   *
   * `findActiveBySlot` only answers for single-valued slots, but a stored pipeline
   * is usually written with cardinality "unknown" — which left the write-time fold
   * unreachable for most rows and pushed them to the six-hourly health check. The
   * guard is `logSlotKey`, not the cardinality: two values that differ by more
   * than one date are different values and are left alone.
   */
  foldLogSlotInSlot({ entityId, predicate, scope, qualifiersKey, value, normText, observedAt, source, at }) {
    const wanted = logSlotKey(value);
    if (!wanted) return null;
    const rows = this.db
      .prepare(
        `${FACT_SELECT} WHERE f.entity_id = ? AND f.predicate = ? COLLATE NOCASE AND f.scope = ?
           AND f.qualifiers_key = ? AND f.status = 'active' ORDER BY f.observed_at DESC LIMIT 20`,
      )
      .all(entityId, predicate, scope, qualifiersKey)
      .map(rowToFact);
    for (const row of rows) {
      if (logSlotKey(row.value) !== wanted) continue;
      const folded = this.foldLogSlot({ current: row, value, normText, observedAt, source, at });
      if (folded) return folded;
    }
    return null;
  }

  /**
   * Remember values that were folded into a survivor by an accepted audit
   * proposal. `mergeFacts` is value-agnostic (it also merges re-wordings, where a
   * "seen N times" count would be a lie), so the log case records its own history
   * here and the panel's "共 N 次" stays honest.
   */
  recordFoldedValues({ factId, values = [], at = nowIso() }) {
    const row = this.db.prepare("SELECT folded_count, folded_from FROM facts WHERE id = ?").get(String(factId));
    if (!row) return { status: "not_found" };
    const list = (Array.isArray(values) ? values : []).map((value) => String(value ?? "").trim()).filter(Boolean);
    if (list.length === 0) return { status: "noop", foldedCount: Number(row.folded_count ?? 0) };
    const history = [...safeParseArray(row.folded_from), ...list].slice(-FOLD_HISTORY_LIMIT);
    this.db
      .prepare("UPDATE facts SET folded_count = folded_count + ?, folded_from = ?, updated_at = ? WHERE id = ?")
      .run(list.length, JSON.stringify(history), at, String(factId));
    return { status: "ok", foldedCount: Number(row.folded_count ?? 0) + list.length };
  }

  /**
   * Teach one entity another spelling. The lookup side already consults aliases
   * (ensureEntity), so this is the whole of "别名一起做".
   */
  addEntityAlias({ entityId, alias }) {
    const row = this.db.prepare("SELECT aliases, norm_name FROM entities WHERE id = ?").get(String(entityId));
    if (!row) return { status: "not_found" };
    const spelled = String(alias ?? "").trim();
    const normalized = normValue(spelled);
    if (spelled === "" || normalized === row.norm_name) return { status: "noop" };
    const known = safeParseArray(row.aliases);
    if (known.some((entry) => normValue(entry) === normalized)) return { status: "already", aliases: known };
    const next = [...known, spelled];
    this.db
      .prepare("UPDATE entities SET aliases = ?, updated_at = ?, record_revision = record_revision + 1 WHERE id = ?")
      .run(json(next), nowIso(), String(entityId));
    return { status: "ok", aliases: next };
  }

  /**
   * Retire facts the health check proved worthless (a value that only restates its
   * own predicate). `expired` rather than `forgotten`: the row stays in history, so
   * accepting an audit proposal is always reversible.
   */
  expireFacts({ ids, at = nowIso(), reason = "audit" }) {
    const list = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
    if (list.length === 0) return { status: "noop", expired: 0 };
    let expired = 0;
    this.tx(() => {
      const statement = this.db.prepare(
        `UPDATE facts SET status = 'expired', conflict_group_id = NULL, valid_to = COALESCE(valid_to, ?),
           updated_at = ?, record_revision = record_revision + 1
          WHERE id = ? AND status IN ('active','scheduled','conflict')`,
      );
      for (const id of list) expired += Number(statement.run(at, at, id).changes ?? 0);
      if (expired > 0) this.bumpGeneration();
    });
    return { status: "ok", expired, reason };
  }

  recordAuditRun({ status, reason = null, findings = 0, proposals = 0, durationMs = 0, at = nowIso() }) {
    const id = uuid();
    this.db
      .prepare("INSERT INTO audit_runs (id, at, status, reason, findings, proposals, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, at, String(status), reason === null ? null : String(reason).slice(0, 200), Number(findings) || 0, Number(proposals) || 0, Number(durationMs) || 0);
    this.db.prepare("DELETE FROM audit_runs WHERE id NOT IN (SELECT id FROM audit_runs ORDER BY at DESC LIMIT ?)").run(40);
    return id;
  }

  recentAuditRuns({ limit = 10 } = {}) {
    return this.db.prepare("SELECT * FROM audit_runs ORDER BY at DESC LIMIT ?").all(limit);
  }

  /** When the human last opened the review queue; null when they never have. */
  reviewSeenAt(id = "proposals") {
    const row = this.db.prepare("SELECT seen_at FROM review_state WHERE id = ?").get(String(id));
    return row?.seen_at ?? null;
  }

  markReviewSeen({ id = "proposals", at = nowIso() } = {}) {
    this.db
      .prepare("INSERT INTO review_state (id, seen_at) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET seen_at = excluded.seen_at")
      .run(String(id), at);
    return at;
  }

  /**
   * Fold one entity into another after a human accepted the alias proposal.
   *
   * The alias alone only stops the *next* split; the facts already filed under the
   * fragment have to move, or the review queue keeps showing two subjects. A fact
   * whose slot the survivor already fills is retired into the survivor instead of
   * moved — moving it would collide with the single-slot index.
   */
  absorbEntity({ fromId, intoId, at = nowIso() }) {
    if (!fromId || !intoId || String(fromId) === String(intoId)) return { status: "refused", reason: "same_entity" };
    const from = this.db.prepare("SELECT id, name, status FROM entities WHERE id = ?").get(String(fromId));
    const into = this.db.prepare("SELECT id, name, status FROM entities WHERE id = ?").get(String(intoId));
    if (!from) return { status: "not_found", reason: "from" };
    if (!into) return { status: "not_found", reason: "into" };
    let moved = 0;
    let retired = 0;
    this.tx(() => {
      const rows = this.db
        .prepare("SELECT id, predicate, value_text, scope, qualifiers, qualifiers_key, status FROM facts WHERE entity_id = ?")
        .all(String(fromId));
      for (const row of rows) {
        const live = row.status === "active" || row.status === "scheduled";
        const twin = live
          ? this.findActiveBySlot({ entityId: String(intoId), predicate: row.predicate, scope: row.scope, qualifiersKey: row.qualifiers_key })
          : null;
        if (twin && String(twin.id) !== String(row.id)) {
          const sources = this.db.prepare("SELECT * FROM fact_sources WHERE fact_id = ?").all(row.id);
          for (const source of sources) {
            this.db
              .prepare(
                `INSERT OR IGNORE INTO fact_sources
                   (id, fact_id, source_type, namespace, session_id, seq, message_id, role, text_range, evidence_hash, quote, evidence_key, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(uuid(), twin.id, source.source_type, source.namespace, source.session_id, source.seq, source.message_id, source.role, source.text_range, source.evidence_hash, source.quote, source.evidence_key, source.created_at);
          }
          this.db
            .prepare(
              `UPDATE facts SET status = 'superseded', superseded_by = ?, valid_to = COALESCE(valid_to, ?), updated_at = ?,
                 record_revision = record_revision + 1 WHERE id = ?`,
            )
            .run(twin.id, at, at, row.id);
          retired += 1;
          continue;
        }
        let qualifiers = {};
        try {
          qualifiers = JSON.parse(row.qualifiers || "{}");
        } catch {
          qualifiers = {};
        }
        this.db
          .prepare("UPDATE facts SET entity_id = ?, claim_key = ?, updated_at = ?, record_revision = record_revision + 1 WHERE id = ?")
          .run(String(intoId), claimKeyOf({ entityName: into.name, predicate: row.predicate, qualifiers, value: row.value_text }), at, row.id);
        moved += 1;
      }
      this.db
        .prepare("UPDATE entities SET status = 'merged', merged_into = ?, updated_at = ?, record_revision = record_revision + 1 WHERE id = ?")
        .run(String(intoId), at, String(fromId));
      this.bumpGeneration();
    });
    return { status: "ok", moved, retired, survivor: this.getEntity(intoId), absorbed: from };
  }

  getEntity(id) {
    return this.db.prepare("SELECT * FROM entities WHERE id = ?").get(String(id)) ?? null;
  }

  insertRow(row) {
    const id = row.id ?? uuid();
    this.db
      .prepare(
        `INSERT INTO facts (id, entity_id, predicate, value_text, norm_text, value_entity_id, cardinality, scope,
           qualifiers, qualifiers_key, status, confidence, evidence_level, privacy_class, model_use_allowed,
           observed_at, valid_from, valid_to, time_precision, time_zone, conflict_group_id, claim_key,
           record_revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id, row.entityId, row.predicate, String(row.value).trim(), row.normText, row.valueEntityId, row.cardinality,
        row.scope, row.qualifiersJson, row.qualifiersKey, row.status, row.evidenceLevel, row.privacyClass,
        row.modelUseAllowed ? 1 : 0, row.observedAt, row.validFrom, row.validTo,
        row.timePrecision ?? "unknown", this.timezone, row.conflictGroupId ?? null, row.claimKey, row.at, row.at,
      );
    return id;
  }

  insertSource(factId, source) {
    const evidenceKey = sha256(
      [source.sourceType, source.namespace, source.sessionId ?? "", source.seq ?? "", source.messageId ?? "",
        source.textRange ?? "", source.evidenceHash].join("\u0001"),
    );
    this.db
      .prepare(
        `INSERT OR IGNORE INTO fact_sources (id, fact_id, source_type, namespace, session_id, seq, message_id, role,
           text_range, evidence_hash, quote, evidence_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        uuid(), factId, source.sourceType, source.namespace, source.sessionId ?? null, source.seq ?? null,
        source.messageId ?? null, source.role ?? null, source.textRange ?? null, source.evidenceHash,
        String(source.quote ?? "").slice(0, 500), evidenceKey, nowIso(),
      );
  }

  sourcesFor(factId) {
    return this.db.prepare("SELECT * FROM fact_sources WHERE fact_id = ? ORDER BY created_at").all(factId);
  }

  /**
   * Facts this conversation wrote, newest first — the turn card and the right
   * drawer read this. `sinceSeq` narrows to one Turn without needing a Turn id:
   * the transcript sequence is the only anchor a client actually has.
   */
  sessionFacts({ sessionId, sinceSeq = 0, untilSeq = null, limit = 50 } = {}) {
    const id = String(sessionId ?? "").trim();
    if (id === "") return [];
    const upper = Number(untilSeq);
    const bounded = Number.isFinite(upper) && upper > 0;
    return this.db
      .prepare(
        `SELECT f.*, e.name AS entity_name, e.type AS entity_type, s.seq AS source_seq FROM facts f
           JOIN fact_sources s ON s.fact_id = f.id
           JOIN entities e ON e.id = f.entity_id
          WHERE s.session_id = ? AND COALESCE(s.seq, 0) >= ?
            AND (? = 0 OR COALESCE(s.seq, 0) <= ?)
            AND f.status <> 'forgotten'
          GROUP BY f.id
          ORDER BY f.observed_at DESC
          LIMIT ?`,
      )
      .all(id, Number(sinceSeq) || 0, bounded ? 1 : 0, bounded ? upper : 0, Math.max(1, Math.min(200, Number(limit) || 50)))
      .map((row) => rowToFact(row));
  }

  /**
   * Remember what one Turn wrote. Kept in the store rather than in memory so the
   * turn-tail card still reports its counts after the host restarts.
   */
  recordTurnSummary({ sessionId, seq, fromSeq = 0, saved = 0, proposals = 0, conflicts = 0, refused = 0, status = "ok", at = nowIso() } = {}) {
    const id = String(sessionId ?? "").trim();
    if (id === "" || !Number.isFinite(Number(seq))) return null;
    const row = {
      id: uuid(),
      sessionId: id,
      seq: Number(seq),
      fromSeq: Number(fromSeq) || 0,
      saved: Number(saved) || 0,
      proposals: Number(proposals) || 0,
      conflicts: Number(conflicts) || 0,
      refused: Number(refused) || 0,
      status: String(status ?? "ok"),
      at,
    };
    this.db
      .prepare(
        `INSERT INTO turn_summaries (id, session_id, seq, from_seq, saved, proposals, conflicts, refused, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, seq) DO UPDATE SET
           from_seq = excluded.from_seq, saved = excluded.saved, proposals = excluded.proposals,
           conflicts = excluded.conflicts, refused = excluded.refused, status = excluded.status`,
      )
      .run(row.id, row.sessionId, row.seq, row.fromSeq, row.saved, row.proposals, row.conflicts, row.refused, row.status, row.at);
    return row;
  }

  /** The summary closest to `seq` for this session, or null. */
  turnSummary({ sessionId, seq = 0, tolerance = 4 } = {}) {
    const id = String(sessionId ?? "").trim();
    if (id === "") return null;
    const row = this.db
      .prepare(
        `SELECT * FROM turn_summaries
          WHERE session_id = ? AND ABS(seq - ?) <= ?
          ORDER BY ABS(seq - ?) ASC, created_at DESC
          LIMIT 1`,
      )
      .get(id, Number(seq) || 0, Math.max(0, Number(tolerance) || 0), Number(seq) || 0);
    if (!row) return null;
    return {
      at: row.created_at,
      fromSeq: row.from_seq ?? 0,
      toSeq: row.seq,
      saved: row.saved ?? 0,
      proposals: row.proposals ?? 0,
      conflicts: row.conflicts ?? 0,
      refused: row.refused ?? 0,
      status: row.status ?? "ok",
    };
  }

  /**
   * Append one extraction pass to the run log.
   *
   * Purely operational — it records that the scheduler ran, not what the user
   * knows. The queue page reads it back after a restart, so "nothing has been
   * extracted yet" can never look like "the plugin is dead". Trimmed to the
   * newest `keep` rows; the page only ever shows ten. Deliberately not part of
   * `wipe()`: clearing the library is exactly when the user wants to watch a
   * pass run.
   */
  recordExtractRun({
    sessionId,
    sessionTitle = "",
    status = "ok",
    reason = "",
    fromSeq = 0,
    toSeq = 0,
    messages = 0,
    chars = 0,
    chunks = 0,
    candidates = 0,
    saved = 0,
    proposals = 0,
    conflicts = 0,
    refused = 0,
    duplicates = 0,
    model = "",
    durationMs = 0,
    at = nowIso(),
    inputText = "",
    rejected = [],
    keep = 200,
  } = {}) {
    const id = String(sessionId ?? "").trim();
    if (id === "") return null;
    const row = {
      id: uuid(),
      sessionId: id,
      sessionTitle: String(sessionTitle ?? "").slice(0, 120),
      status: String(status ?? "ok"),
      reason: String(reason ?? "").slice(0, 200),
      fromSeq: Number(fromSeq) || 0,
      toSeq: Number(toSeq) || 0,
      messages: Number(messages) || 0,
      chars: Number(chars) || 0,
      chunks: Number(chunks) || 0,
      candidates: Number(candidates) || 0,
      saved: Number(saved) || 0,
      proposals: Number(proposals) || 0,
      conflicts: Number(conflicts) || 0,
      refused: Number(refused) || 0,
      duplicates: Number(duplicates) || 0,
      model: String(model ?? "").slice(0, 120),
      durationMs: Math.max(0, Number(durationMs) || 0),
      at,
      // Bounded on purpose: the page shows what was read, it is not an archive.
      inputText: String(inputText ?? "").slice(0, 20_000),
      inputTruncated: String(inputText ?? "").length > 20_000 ? 1 : 0,
      rejectedJson: JSON.stringify(
        (Array.isArray(rejected) ? rejected : []).slice(0, 40).map((item) => ({
          reason: String(item?.reason ?? "unknown").slice(0, 120),
          count: Math.max(1, Number(item?.count) || 1),
        })),
      ),
    };
    const bound = Math.max(20, Math.min(2000, Number(keep) || 200));
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO extract_runs (id, session_id, session_title, status, reason, from_seq, to_seq, messages, chars, chunks,
             candidates, saved, proposals, conflicts, refused, duplicates, model, duration_ms, at, created_at,
             input_text, rejected_json, input_truncated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id, row.sessionId, row.sessionTitle, row.status, row.reason, row.fromSeq, row.toSeq, row.messages,
          row.chars, row.chunks, row.candidates, row.saved, row.proposals, row.conflicts, row.refused,
          row.duplicates, row.model, row.durationMs, row.at, row.at, row.inputText, row.rejectedJson, row.inputTruncated,
        );
      this.db
        .prepare(
          `DELETE FROM extract_runs WHERE id NOT IN (
             SELECT id FROM extract_runs ORDER BY at DESC, created_at DESC LIMIT ?
           )`,
        )
        .run(bound);
    });
    return row;
  }

  /** Newest extraction passes, newest first. */
  extractRuns({ limit = 10 } = {}) {
    return this.db
      .prepare(
        `SELECT * FROM extract_runs ORDER BY at DESC, created_at DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(200, Number(limit) || 10)))
      .map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        title: row.session_title ?? "",
        status: row.status ?? "ok",
        reason: row.reason ?? "",
        fromSeq: row.from_seq ?? 0,
        toSeq: row.to_seq ?? 0,
        messages: row.messages ?? 0,
        chars: row.chars ?? 0,
        chunks: row.chunks ?? 0,
        candidates: row.candidates ?? 0,
        saved: row.saved ?? 0,
        proposals: row.proposals ?? 0,
        conflicts: row.conflicts ?? 0,
        refused: row.refused ?? 0,
        duplicates: row.duplicates ?? 0,
        model: row.model ?? "",
        durationMs: row.duration_ms ?? 0,
        at: row.at,
        hasDetail: Boolean(row.input_text) || Boolean(row.rejected_json),
      }));
  }

  /** One pass with the text it read; the list view never carries the text. */
  extractRun({ id } = {}) {
    const row = this.db.prepare("SELECT * FROM extract_runs WHERE id = ?").get(String(id ?? ""));
    if (!row) return null;
    let rejected = [];
    try {
      const parsed = JSON.parse(row.rejected_json || "[]");
      rejected = Array.isArray(parsed) ? parsed : [];
    } catch {
      rejected = [];
    }
    return {
      id: row.id,
      sessionId: row.session_id,
      title: row.session_title ?? "",
      status: row.status ?? "ok",
      reason: row.reason ?? "",
      fromSeq: row.from_seq ?? 0,
      toSeq: row.to_seq ?? 0,
      messages: row.messages ?? 0,
      chars: row.chars ?? 0,
      chunks: row.chunks ?? 0,
      candidates: row.candidates ?? 0,
      saved: row.saved ?? 0,
      proposals: row.proposals ?? 0,
      conflicts: row.conflicts ?? 0,
      refused: row.refused ?? 0,
      duplicates: row.duplicates ?? 0,
      model: row.model ?? "",
      durationMs: row.duration_ms ?? 0,
      at: row.at,
      inputText: row.input_text ?? "",
      inputTruncated: Number(row.input_truncated ?? 0) === 1,
      rejected,
    };
  }

  /** Session id → how many facts it wrote, for the sidebar row mark. */
  sessionsWithFacts({ limit = 300 } = {}) {
    return this.db
      .prepare(
        `SELECT s.session_id AS sessionId, COUNT(DISTINCT f.id) AS facts, MAX(f.observed_at) AS lastAt
           FROM fact_sources s
           JOIN facts f ON f.id = s.fact_id
          WHERE s.session_id IS NOT NULL AND f.status <> 'forgotten'
          GROUP BY s.session_id
          ORDER BY lastAt DESC
          LIMIT ?`,
      )
      .all(Math.max(1, Math.min(1000, Number(limit) || 300)));
  }

  /** Newest fact carrying this claim key, any status — used by import and tombstones. */
  factByClaimKey(claimKey) {
    return rowToFact(
      this.db.prepare(`${FACT_SELECT} WHERE f.claim_key = ? ORDER BY f.updated_at DESC LIMIT 1`).get(claimKey),
    );
  }

  createConflictGroup(reason, at = nowIso()) {
    const id = uuid();
    this.db
      .prepare("INSERT INTO conflict_groups (id, reason, status, created_at, updated_at) VALUES (?, ?, 'open', ?, ?)")
      .run(id, reason, at, at);
    return id;
  }

  openConflictGroup(id, at) {
    const row = this.db.prepare("SELECT status FROM conflict_groups WHERE id = ?").get(id);
    if (!row || row.status !== "open") return false;
    this.db.prepare("UPDATE conflict_groups SET updated_at = ? WHERE id = ?").run(at, id);
    return true;
  }

  /**
   * Open conflict groups with their rival rows, newest first. The settings card
   * renders this; nothing else reads conflicts, so it stays a read-only query.
   */
  listConflicts({ maxGroups = 20 } = {}) {
    const groups = this.db
      .prepare("SELECT id, reason, created_at FROM conflict_groups WHERE status = 'open' ORDER BY created_at DESC LIMIT ?")
      .all(maxGroups);
    return groups.map((group) => ({
      id: group.id,
      reason: group.reason,
      createdAt: group.created_at,
      rows: this.db
        .prepare(`${FACT_SELECT} WHERE f.conflict_group_id = ? ORDER BY f.observed_at DESC`)
        .all(group.id)
        .map((row) => rowToFact(row)),
    }));
  }

  /**
   * Settle one conflict group.
   *   keep  — the chosen side stays active, the rivals retire (default)
   *   multi — every side is true at once: all become active `multi` facts
   *   drop  — nobody is right: every side expires
   */
  resolveConflict({ factId, decision = "keep", scope = "all" }) {
    return this.tx(() => {
      const fact = this.getFact(factId);
      if (!fact || !fact.conflictGroupId) return { status: "not_found" };
      const groupId = fact.conflictGroupId;
      const rivals = this.db
        .prepare(`${FACT_SELECT} WHERE f.conflict_group_id = ? AND f.id != ?`)
        .all(groupId, factId);
      const at = nowIso();
      if (decision === "drop") {
        this.db
          .prepare(
            "UPDATE facts SET status = 'expired', conflict_group_id = NULL, valid_to = COALESCE(valid_to, ?), updated_at = ?, record_revision = record_revision + 1 WHERE conflict_group_id = ?",
          )
          .run(at, at, groupId);
        this.db.prepare("UPDATE conflict_groups SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?").run(at, at, groupId);
        this.bumpGeneration();
        return { status: "ok", decision, dropped: rivals.length + 1, fact: null };
      }
      if (decision === "multi") {
        this.db
          .prepare(
            "UPDATE facts SET status = 'active', cardinality = 'multi', conflict_group_id = NULL, updated_at = ?, record_revision = record_revision + 1 WHERE conflict_group_id = ?",
          )
          .run(at, groupId);
        this.db.prepare("UPDATE conflict_groups SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?").run(at, at, groupId);
        this.bumpGeneration();
        return { status: "ok", decision, active: rivals.length + 1, fact: this.getFact(factId) };
      }
      for (const rival of rivals) {
        this.db
          .prepare("UPDATE facts SET status = 'superseded', superseded_by = ?, valid_to = ?, updated_at = ?, record_revision = record_revision + 1 WHERE id = ?")
          .run(factId, at, at, rival.id);
      }
      this.db
        .prepare("UPDATE facts SET status = 'active', conflict_group_id = NULL, updated_at = ?, record_revision = record_revision + 1 WHERE id = ?")
        .run(at, factId);
      this.db.prepare("UPDATE conflict_groups SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?").run(at, at, groupId);
      this.bumpGeneration();
      return { status: "ok", decision, fact: this.getFact(factId), superseded: rivals.length };
    });
  }

  // ── forgetting ─────────────────────────────────────────────────────────
  /**
   * Forget a fact (or a whole entity) and leave a tombstone. Returns the ids that
   * changed so the caller can render a truthful receipt.
   */
  forget({ factId = null, entityId = null, scope = "global", reasonCode = "user_request", originStoreId, namespace = "manual" }) {
    return this.tx(() => {
      const rows = factId
        ? this.db.prepare(`${FACT_SELECT} WHERE f.id = ?`).all(factId)
        : this.db.prepare(`${FACT_SELECT} WHERE f.entity_id = ? AND f.status IN ('active','scheduled','conflict')`).all(entityId);
      if (rows.length === 0) return { status: "not_found", factIds: [] };
      const at = nowIso();
      const tombstoneId = uuid();
      this.db
        .prepare("INSERT INTO tombstones (id, origin_store_id, scope, reason_code, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(tombstoneId, originStoreId, scope, reasonCode, at);
      for (const row of rows) {
        this.db
          .prepare("UPDATE facts SET status = 'forgotten', valid_to = ?, updated_at = ?, record_revision = record_revision + 1 WHERE id = ?")
          .run(at, at, row.id);
        this.db
          .prepare("INSERT OR IGNORE INTO tombstone_fact_ids (tombstone_id, target_store_id, fact_id_text) VALUES (?, ?, ?)")
          .run(tombstoneId, originStoreId, row.id);
        this.db
          .prepare("INSERT OR IGNORE INTO tombstone_keys (tombstone_id, source_namespace, key_kind, key_hash) VALUES (?, ?, 'claim', ?)")
          .run(tombstoneId, namespace, row.claim_key);
        for (const source of this.sourcesFor(row.id)) {
          this.db
            .prepare("INSERT OR IGNORE INTO tombstone_keys (tombstone_id, source_namespace, key_kind, key_hash) VALUES (?, ?, 'evidence', ?)")
            .run(tombstoneId, source.namespace, source.evidence_key);
        }
        this.db.prepare("DELETE FROM facts_fts WHERE fact_id = ?").run(row.id);
      }
      this.bumpGeneration();
      return { status: "ok", tombstoneId, factIds: rows.map((row) => row.id) };
    });
  }

  isTombstoned({ namespace, claimKey, evidenceKey }) {
    // Claim keys are compared WITHOUT the namespace: a fact the user forgot must
    // not be resurrected by a write arriving from another path (tool vs. capture
    // vs. import). The namespace column is kept for audit and for the imported
    // tombstones a later build will add.
    void namespace;
    if (claimKey) {
      const hit = this.db
        .prepare("SELECT 1 AS hit FROM tombstone_keys WHERE key_kind = 'claim' AND key_hash = ? LIMIT 1")
        .get(claimKey);
      if (hit) return true;
    }
    if (evidenceKey) {
      const hit = this.db
        .prepare("SELECT 1 AS hit FROM tombstone_keys WHERE key_kind = 'evidence' AND key_hash = ? LIMIT 1")
        .get(evidenceKey);
      if (hit) return true;
    }
    return false;
  }

  tombstones({ limit = 200 } = {}) {
    return this.db.prepare("SELECT * FROM tombstones ORDER BY created_at DESC LIMIT ?").all(limit);
  }

  // ── pending ────────────────────────────────────────────────────────────
  addPending({ rawText = null, sourceRefs = [], reason, privacyClass = "standard", operationKey = null }) {
    const id = uuid();
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO pending_items (id, raw_text, source_refs, reason, status, privacy_class, model_use_allowed,
           attempt_count, operation_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'waiting', ?, ?, 0, ?, ?, ?)`,
      )
      // A personal sentence is stored but not model-visible; the column used to be
      // hardcoded to 0, which marked even an ordinary sentence as withheld.
      .run(id, rawText ? String(rawText).slice(0, 2000) : null, json(sourceRefs), reason, privacyClass, privacyClass === "sensitive" ? 0 : 1, operationKey, at, at);
    return id;
  }

  pending({ status = "waiting", limit = 200 } = {}) {
    return this.db
      .prepare("SELECT * FROM pending_items WHERE (? IS NULL OR status = ?) ORDER BY created_at LIMIT ?")
      .all(status, status, limit);
  }

  pendingItem({ id } = {}) {
    return this.db.prepare("SELECT * FROM pending_items WHERE id = ?").get(String(id ?? "")) ?? null;
  }

  /** A parked batch is consumed by a successful manual re-read, not deleted. */
  setPendingStatus({ id, status } = {}) {
    this.db
      .prepare("UPDATE pending_items SET status = ?, updated_at = ? WHERE id = ?")
      .run(String(status ?? "waiting"), nowIso(), String(id ?? ""));
  }

  // ── cursors ────────────────────────────────────────────────────────────
  cursor(namespace, sessionId) {
    return this.db
      .prepare("SELECT * FROM cursors WHERE source_namespace = ? AND session_id = ?")
      .get(namespace, sessionId);
  }

  setCursor({ namespace, sessionId, nextSeq, textOffset = 0, sourceFingerprint = null, lastOperationKey = null }) {
    this.db
      .prepare(
        `INSERT INTO cursors (source_namespace, session_id, next_seq, text_offset, parser_version, source_fingerprint, last_operation_key, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_namespace, session_id) DO UPDATE SET
           next_seq = excluded.next_seq, text_offset = excluded.text_offset, parser_version = excluded.parser_version,
           source_fingerprint = excluded.source_fingerprint, last_operation_key = excluded.last_operation_key,
           updated_at = excluded.updated_at`,
      )
      .run(namespace, sessionId, nextSeq, textOffset, PARSER_VERSION, sourceFingerprint, lastOperationKey, nowIso());
  }

  // ── operations (idempotency) ───────────────────────────────────────────
  /**
   * A tool call may be retried by the model or replayed by the transport. The
   * operation key is derived from the request, so the same key with the same
   * fingerprint returns the earlier receipt instead of writing twice; a different
   * fingerprint under the same key is a real collision and is refused.
   */
  beginOperation({ operationKey, fingerprint, actor, action, targetIds = [], baseGeneration = 0 }) {
    const existing = this.db.prepare("SELECT * FROM operations WHERE operation_key = ?").get(operationKey);
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) return { status: "collision", existing };
      return { status: "replay", receipt: JSON.parse(existing.receipt || "{}"), operationId: existing.operation_id };
    }
    const operationId = uuid();
    this.db
      .prepare(
        `INSERT INTO operations (operation_id, operation_key, request_fingerprint, actor, action, target_ids, base_generation, committed_generation, receipt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, '{}', ?)`,
      )
      .run(operationId, operationKey, fingerprint, actor, action, json(targetIds), baseGeneration, nowIso());
    return { status: "started", operationId };
  }

  /** Drop an operation row whose domain write failed, so a retry is not a replay. */
  abortOperation(operationId) {
    try {
      this.db.prepare("DELETE FROM operations WHERE operation_id = ? AND committed_generation = 0").run(operationId);
    } catch {
      /* a stale row is harmless: the next retry still writes once, then commits */
    }
  }

  commitOperation({ operationId, operationKey, fingerprint, receipt, targetIds = [] }) {    return this.tx(() => {
      const generation = this.bumpGeneration();
      this.db
        .prepare("UPDATE operations SET committed_generation = ?, receipt = ?, target_ids = ? WHERE operation_id = ?")
        .run(generation, json(receipt), json(targetIds), operationId);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO operation_dedupe (operation_id_hash, operation_key_hash, request_fingerprint, committed_generation, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(sha256(operationId), sha256(operationKey), fingerprint, generation, nowIso());
      return { generation, receipt };
    });
  }

  // ── derived index ──────────────────────────────────────────────────────
  rebuildFts(factId) {
    const row = this.db.prepare(`${FACT_SELECT} WHERE f.id = ?`).get(factId);
    this.db.prepare("DELETE FROM facts_fts WHERE fact_id = ?").run(factId);
    if (!row) return;
    this.db.prepare("INSERT INTO facts_fts (fact_id, tokens) VALUES (?, ?)").run(factId, factSearchText(row));
  }

  rebuildAllFts() {
    return this.tx(() => {
      this.db.exec("DELETE FROM facts_fts");
      const rows = this.db.prepare(`${FACT_SELECT} WHERE f.status IN ('active','scheduled','conflict')`).all();
      for (const row of rows) {
        this.db.prepare("INSERT INTO facts_fts (fact_id, tokens) VALUES (?, ?)").run(row.id, factSearchText(row));
      }
      return rows.length;
    });
  }

  // ── maintenance ────────────────────────────────────────────────────────
  async backup(destPath, { keep = 0 } = {}) {
    mkdirSync(dirname(destPath), { recursive: true });
    await backup(this.db, destPath);
    if (Number(keep) > 0) {
      // Rotation only ever touches this plugin's own backup files, newest first.
      const dir = dirname(destPath);
      const base = basename(destPath).replace(/\d{4}-.*$/, "");
      const stale = readdirSync(dir)
        .filter((name) => name.startsWith(base) && name.endsWith(".sqlite3"))
        .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
        .sort((left, right) => right.at - left.at)
        .slice(Number(keep));
      for (const entry of stale) {
        try {
          rmSync(join(dir, entry.name), { force: true });
        } catch {
          /* a locked or already-removed file is not worth failing the export */
        }
      }
    }
    return destPath;
  }

  // ── reset ──────────────────────────────────────────────────────────────
  /**
   * Factory-reset the library: every fact, entity, source, proposal, conflict,
   * tombstone, operation record, vector and calibration goes, and the counts come
   * back so the caller can say what was removed.
   *
   * What survives is the store identity (schema version, store id, timezone,
   * parser version) and — deliberately — the extraction cursors. Clearing a
   * cursor would make the next pass re-read the whole session history and refill
   * the library from the same chats the user just wiped.
   *
   * Configuration never lives in this database (it is the host's settings file),
   * so this call cannot touch it.
   */
  wipe() {
    const cleared = {};
    const tables = [
      "fact_sources",
      "facts_fts",
      "facts",
      "fact_vectors",
      "proposals",
      "pending_items",
      "conflict_groups",
      "tombstone_fact_ids",
      "tombstone_keys",
      "tombstones",
      "operation_dedupe",
      "operations",
      "turn_summaries",
      "fact_secrets",
      "calibrations",
      // Ledgers about the data above. Leaving them behind made the panel report a
      // health check and a dedup sweep from the previous library ("last run" with
      // rows that no longer exist), which reads as a live result.
      "audit_runs",
      "review_state",
      "dedup_runs",
      "dedup_judgements",
      // The dream layer is content the user asked to clear, so it goes with the
      // facts. `dream_runs` goes too: a "last run" row that outlives its own feed is
      // exactly the stale-ledger problem the comment above describes.
      "dreams",
      "dream_feed",
      "dream_feed_state",
      "dream_rejects",
      "dream_runs",
    ];
    this.tx(() => {
      // Count first, delete second: `facts` cascades into `fact_vectors` and
      // `fact_sources`, so a count after the parent delete would report zero.
      for (const table of tables) {
        const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
        cleared[table] = Number(row?.n ?? 0);
      }
      for (const table of tables) this.db.prepare(`DELETE FROM ${table}`).run();
      // Entities reference each other through merged_into, so the links have to go
      // before the rows — otherwise the RESTRICT foreign key refuses the delete.
      this.db.prepare("UPDATE entities SET merged_into = NULL").run();
      const entities = this.db.prepare("SELECT COUNT(*) AS n FROM entities").get();
      cleared.entities = Number(entities?.n ?? 0);
      this.db.prepare("DELETE FROM entities").run();
      this.db.prepare("UPDATE store_meta SET last_event_seq = 0, updated_at = ? WHERE id = 1").run(nowIso());
    });
    const generation = this.bumpGeneration();
    try {
      this.db.exec("VACUUM");
    } catch {
      /* a reader holding the database open can refuse VACUUM; the rows are gone */
    }
    return {
      generation,
      facts: cleared.facts ?? 0,
      entities: cleared.entities ?? 0,
      proposals: cleared.proposals ?? 0,
      conflicts: cleared.conflict_groups ?? 0,
      cleared,
    };
  }

  // ── time-driven state ──────────────────────────────────────────────────
  /**
   * Move facts along the clock: a window that has closed expires, and a
   * `scheduled` fact whose start has arrived becomes `active`. Promotion into a
   * slot that already has an active single value is a conflict, not a silent
   * overwrite (C.5.3), so both sides are parked for adjudication.
   *
   * Idempotent: running it twice at the same instant changes nothing. Returns
   * the counts so the caller can bump the generation only when work happened.
   */
  advanceTime(at = nowIso()) {
    return this.tx(() => {
      const closed = this.db
        .prepare(
          `UPDATE facts SET status = 'expired', updated_at = ?, record_revision = record_revision + 1
            WHERE status IN ('active','scheduled') AND valid_to IS NOT NULL AND datetime(valid_to) <= datetime(?)`,
        )
        .run(at, at).changes;
      const due = this.db
        .prepare(
          `${FACT_SELECT} WHERE f.status = 'scheduled'
             AND (f.valid_from IS NULL OR datetime(f.valid_from) <= datetime(?))
           ORDER BY f.valid_from`,
        )
        .all(at);
      let promoted = 0;
      let conflicts = 0;
      for (const row of due) {
        const fact = rowToFact(row);
        const holder = this.findActiveBySlot({
          entityId: row.entity_id,
          predicate: row.predicate,
          scope: row.scope,
          qualifiersKey: row.qualifiers_key,
        });
        if (holder && holder.id !== fact.id) {
          const groupId = this.createConflictGroup(`overlap:${row.predicate}`, at);
          this.db
            .prepare(
              "UPDATE facts SET status = 'conflict', conflict_group_id = ?, updated_at = ?, record_revision = record_revision + 1 WHERE id IN (?, ?)",
            )
            .run(groupId, at, holder.id, fact.id);
          conflicts += 1;
          continue;
        }
        this.db
          .prepare(
            "UPDATE facts SET status = 'active', updated_at = ?, record_revision = record_revision + 1 WHERE id = ?",
          )
          .run(at, fact.id);
        promoted += 1;
      }
      const total = closed + promoted + conflicts;
      if (total > 0) this.bumpGeneration();
      return { expired: closed, promoted, conflicts, changed: total };
    });
  }

  // ── reading surfaces for the memory page ───────────────────────────────
  /**
   * Facts for the library view. `status` defaults to the live set (active,
   * scheduled, conflict); `all` includes history, and `forgotten` never comes
   * back through this door unless explicitly asked for by id.
   */
  listFacts({ query = "", entity = "", entityId = "", scope = "", status = "live", limit = 100, offset = 0 } = {}) {
    const where = [];
    const args = [];
    if (status === "live") where.push("f.status IN ('active','scheduled','conflict')");
    else if (status === "all") where.push("f.status != 'forgotten'");
    else {
      where.push("f.status = ?");
      args.push(status);
    }
    if (entityId) {
      where.push("f.entity_id = ?");
      args.push(entityId);
    }
    if (entity) {
      where.push("LOWER(e.norm_name) LIKE ? ESCAPE '\\'");
      args.push(`%${likeText(String(entity).toLowerCase())}%`);
    }
    if (scope) {
      where.push("f.scope = ?");
      args.push(scope);
    }
    const q = String(query ?? "").trim();
    if (q) {
      where.push("(LOWER(e.name) LIKE ? ESCAPE '\\' OR LOWER(f.predicate) LIKE ? ESCAPE '\\' OR LOWER(f.value_text) LIKE ? ESCAPE '\\')");
      const like = `%${likeText(q.toLowerCase())}%`;
      args.push(like, like, like);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `${FACT_SELECT} ${clause} ORDER BY f.observed_at DESC, f.rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, clampInt(limit, 1, 500, 100), clampInt(offset, 0, Number.MAX_SAFE_INTEGER, 0));
    return rows.map((row) => rowToFact(row));
  }

  /** Every dated row of one slot, newest first — the history drawer. */
  factHistory({ factId, limit = 50 } = {}) {
    const fact = this.getFact(factId);
    if (!fact) return null;
    const rows = this.db
      .prepare(
        `${FACT_SELECT} WHERE f.entity_id = ? AND f.predicate = ? AND f.scope = ? AND f.qualifiers_key = ?
         ORDER BY f.observed_at DESC LIMIT ?`,
      )
      .all(
        fact.entityId ?? this.entityIdOf(fact.entity),
        fact.predicate,
        fact.scope,
        qualifierKey(fact.qualifiers ?? {}),
        limit,
      );
    return { fact, rows: rows.map((row) => rowToFact(row)) };
  }

  entityIdOf(name) {
    const row = this.db.prepare("SELECT id FROM entities WHERE norm_name = ?").get(normValue(name));
    return row?.id ?? null;
  }

  /** One entity plus its live facts, for the detail drawer. */
  entityDetail({ entity, limit = 100 } = {}) {
    const row = this.db
      .prepare("SELECT id, name, type, scope, aliases, status, created_at FROM entities WHERE norm_name = ?")
      .get(normValue(entity));
    if (!row) return null;
    // Filter by entity id, not by name: a LIKE on the name would drag in every
    // entity whose name merely contains this one as a substring.
    const facts = this.listFacts({ entityId: row.id, status: "live", limit });
    return {
      entity: {
        id: row.id,
        name: row.name,
        type: row.type,
        scope: row.scope,
        aliases: JSON.parse(row.aliases || "[]"),
        status: row.status,
        createdAt: row.created_at,
      },
      facts,
    };
  }

  /** A user edit: same slot, new value, confirmed by a human. */
  updateFact({ factId, value, expectedRevision = null, at = nowIso() }) {
    const fact = this.getFact(factId);
    // A forgotten row is not editable: the user removed the claim, and an edit
    // would quietly bring it back through the write path.
    if (!fact || fact.status === "forgotten") return { status: "not_found" };
    if (expectedRevision !== null && Number(fact.recordRevision) !== Number(expectedRevision)) {
      return { status: "stale", fact };
    }
    // Re-derive privacy from the NEW value: editing a plain fact into a phone
    // number must not inherit the old row's model visibility.
    const personal = privacyHits(String(value)).length > 0;
    const result = this.writeFact({
      entity: { name: fact.entity, type: fact.entityType ?? "project" },
      predicate: fact.predicate,
      value,
      cardinality: fact.cardinality,
      scope: fact.scope,
      qualifiers: fact.qualifiers,
      evidenceLevel: "confirmed_user",
      privacyClass: personal ? "sensitive" : fact.privacyClass,
      modelUseAllowed: personal ? false : fact.modelUseAllowed,
      observedAt: at,
      source: {
        sourceType: "manual",
        namespace: "manual",
        role: "user",
        quote: String(value).slice(0, 500),
        evidenceHash: sha256(`manual\u0001${factId}\u0001${value}`),
      },
      supersede: true,
    });
    return { status: "ok", result };
  }

  /** Mark a fact expired now; the row stays for history. */
  expireFact({ factId, expectedRevision = null, at = nowIso() }) {
    const fact = this.getFact(factId);
    if (!fact || fact.status === "forgotten") return { status: "not_found" };
    if (expectedRevision !== null && Number(fact.recordRevision) !== Number(expectedRevision)) {
      return { status: "stale", fact };
    }
    this.tx(() => {
      this.db
        .prepare(
          "UPDATE facts SET status = 'expired', valid_to = ?, updated_at = ?, record_revision = record_revision + 1 WHERE id = ?",
        )
        .run(at, at, factId);
      this.bumpGeneration();
    });
    return { status: "ok", fact: this.getFact(factId) };
  }

  /**
   * Undo for expireFact. An expired row only comes back while its slot is still
   * free: for a single-cardinality property the unique index holds one live row,
   * so restoring over a newer value would either throw or create a second truth.
   * The caller is told "occupied" and refreshes instead of silently overwriting.
   */
  restoreFact({ factId, expectedRevision = null, at = nowIso() }) {
    const fact = this.getFact(factId);
    if (!fact || fact.status === "forgotten") return { status: "not_found" };
    if (expectedRevision !== null && Number(fact.recordRevision) !== Number(expectedRevision)) {
      return { status: "stale", fact };
    }
    if (fact.status !== "expired") return { status: "not_expired", fact };
    const slotHeld = () => {
      const raw = this.db.prepare("SELECT cardinality, qualifiers_key FROM facts WHERE id = ?").get(factId);
      if (!raw || raw.cardinality !== "single") return null;
      return this.db
        .prepare(
          "SELECT id FROM facts WHERE entity_id = ? AND predicate = ? AND scope = ? AND qualifiers_key = ? AND cardinality = 'single' AND status IN ('active','scheduled')",
        )
        .get(fact.entityId, fact.predicate, fact.scope, raw.qualifiers_key);
    };
    let heldId = null;
    try {
      // The check and the update share one write transaction: otherwise a newer
      // value inserted between them turns into a UNIQUE failure (or two truths).
      heldId = this.tx(() => {
        const held = slotHeld();
        if (held && held.id !== factId) return held.id;
        this.db
          .prepare("UPDATE facts SET status = 'active', valid_to = NULL, updated_at = ?, record_revision = record_revision + 1 WHERE id = ?")
          .run(at, factId);
        this.bumpGeneration();
        return null;
      });
    } catch (error) {
      // Another process won the race between the slot read and the update.
      if (!/UNIQUE|constraint/i.test(String(error?.message ?? error))) throw error;
      heldId = slotHeld()?.id ?? null;
    }
    if (heldId !== null) return { status: "occupied", fact: this.getFact(heldId) };
    return { status: "ok", fact: this.getFact(factId) };
  }

  // ── duplicate review ───────────────────────────────────────────────────
  /**
   * The rows a duplicate sweep may compare: live facts the model is allowed to
   * see. A credential or a piece of personal data never enters the comparison,
   * because the comparison sends the two statements to a model.
   */
  dedupCandidates({ fingerprint = "", limit = 400 } = {}) {
    return this.db
      .prepare(
        `SELECT f.id AS id, f.entity_id AS entity_id, e.name AS entity_name, f.predicate AS predicate,
                f.value_text AS value_text, f.evidence_level AS evidence_level, f.observed_at AS observed_at,
                f.scope AS scope, v.vector AS vector
           FROM facts f
           JOIN entities e ON e.id = f.entity_id
           LEFT JOIN fact_vectors v ON v.fact_id = f.id AND v.fingerprint = ?
          WHERE f.status IN ('active','scheduled') AND ${visibleSql({ alias: "f" })}
          ORDER BY f.updated_at DESC
          LIMIT ?`,
      )
      .all(String(fingerprint ?? ""), Math.max(2, Math.min(2000, Number(limit) || 400)));
  }

  /** The remembered verdict for one pair, or null. */
  dedupJudgement(pairKey) {
    return this.db.prepare("SELECT * FROM dedup_judgements WHERE pair_key = ?").get(String(pairKey)) ?? null;
  }

  recentDedupJudgements({ status = null, limit = 50 } = {}) {
    const rows = status
      ? this.db.prepare("SELECT * FROM dedup_judgements WHERE status = ? ORDER BY updated_at DESC LIMIT ?").all(status, limit)
      : this.db.prepare("SELECT * FROM dedup_judgements ORDER BY updated_at DESC LIMIT ?").all(limit);
    return rows;
  }

  /** Insert or replace one verdict. The pair key already carries the generation. */
  recordDedupJudgement(row) {
    const at = row.at ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO dedup_judgements
           (pair_key, fingerprint, left_id, right_id, scope, cosine, lexical, decision, keep_id, drop_id,
            reason, source, proposal_id, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (pair_key) DO UPDATE SET
           decision = excluded.decision, keep_id = excluded.keep_id, drop_id = excluded.drop_id,
           reason = excluded.reason, source = excluded.source, proposal_id = excluded.proposal_id,
           status = excluded.status, attempts = excluded.attempts, updated_at = excluded.updated_at`,
      )
      .run(
        String(row.pairKey),
        String(row.fingerprint ?? ""),
        String(row.leftId),
        String(row.rightId),
        String(row.scope ?? "global"),
        row.cosine === null || row.cosine === undefined ? null : Number(row.cosine),
        row.lexical === null || row.lexical === undefined ? null : Number(row.lexical),
        String(row.decision),
        row.keepId ?? null,
        row.dropId ?? null,
        String(row.reason ?? "").slice(0, 400),
        ["model", "rule", "human"].includes(row.source) ? row.source : "model",
        row.proposalId ?? null,
        ["open", "proposed", "resolved", "failed"].includes(row.status) ? row.status : "open",
        Number(row.attempts ?? 0),
        row.createdAt ?? at,
        at,
      );
    return this.dedupJudgement(row.pairKey);
  }

  recordDedupRun({ status = "ok", reason = "", pairs = 0, judged = 0, same = 0, distinct = 0, unsure = 0, proposals = 0, model = "", durationMs = 0, at = nowIso(), keep = 40 } = {}) {
    const id = uuid();
    this.db
      .prepare(
        `INSERT INTO dedup_runs (id, status, reason, pairs, judged, same_count, distinct_count, unsure_count, proposals, model, duration_ms, at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ["ok", "skipped", "error", "deferred"].includes(status) ? status : "error",
        String(reason ?? "").slice(0, 300),
        Number(pairs) || 0,
        Number(judged) || 0,
        Number(same) || 0,
        Number(distinct) || 0,
        Number(unsure) || 0,
        Number(proposals) || 0,
        String(model ?? "").slice(0, 120),
        Number(durationMs) || 0,
        at,
        at,
      );
    // The log is a diagnostic, not history: keep the newest rows only.
    this.db
      .prepare("DELETE FROM dedup_runs WHERE id NOT IN (SELECT id FROM dedup_runs ORDER BY at DESC LIMIT ?)")
      .run(Math.max(5, Math.min(500, Number(keep) || 40)));
    return id;
  }

  recentDedupRuns({ limit = 10 } = {}) {
    return this.db.prepare("SELECT * FROM dedup_runs ORDER BY at DESC LIMIT ?").all(limit);
  }

  /**
   * Fold one row into another after a human accepted the merge.
   *
   * The loser is not deleted: it becomes `superseded` and points at the winner,
   * so the fact's history (and its sources) stay readable. Its sources are copied
   * to the winner first — the evidence is the part worth keeping.
   */
  mergeFacts({ winnerId, loserId, at = nowIso() }) {
    if (!winnerId || !loserId || String(winnerId) === String(loserId)) return { status: "refused", reason: "same_target" };
    const winner = this.getFact(winnerId);
    const loser = this.getFact(loserId);
    if (!winner || !loser) return { status: "not_found" };
    if (!["active", "scheduled"].includes(winner.status)) return { status: "refused", reason: "winner_not_live", winner, loser };
    if (!["active", "scheduled"].includes(loser.status)) return { status: "refused", reason: "loser_not_live", winner, loser };
    if (String(winner.entityId) !== String(loser.entityId)) return { status: "refused", reason: "different_entity", winner, loser };
    if (String(winner.scope) !== String(loser.scope)) return { status: "refused", reason: "different_scope", winner, loser };
    let moved = 0;
    this.tx(() => {
      const sources = this.db.prepare("SELECT * FROM fact_sources WHERE fact_id = ?").all(loserId);
      for (const source of sources) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO fact_sources
               (id, fact_id, source_type, namespace, session_id, seq, message_id, role, text_range, evidence_hash, quote, evidence_key, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(uuid(), winnerId, source.source_type, source.namespace, source.session_id, source.seq, source.message_id, source.role, source.text_range, source.evidence_hash, source.quote, source.evidence_key, source.created_at);
        moved += 1;
      }
      this.db
        .prepare(
          `UPDATE facts SET status = 'superseded', superseded_by = ?, valid_to = COALESCE(valid_to, ?), updated_at = ?,
             record_revision = record_revision + 1
            WHERE id = ? AND status IN ('active','scheduled')`,
        )
        .run(winnerId, at, at, loserId);
      this.bumpGeneration();
    });
    return { status: "ok", winner: this.getFact(winnerId), loser: this.getFact(loserId), movedSources: moved };
  }

  // ── dreams ─────────────────────────────────────────────────────────────
  //
  // A dream is prose about a stretch of conversation; a fact is one statement in a
  // slot. The two layers never share a row: nothing below reads or writes `facts`,
  // and the dream tests assert the fact count is identical across a full pass.

  /** Append one message to the feed. Replaying the same turn is a no-op. */
  dreamFeedAppend({ sessionId, seq, at, role, text }) {
    const body = String(text ?? "");
    const number = Number(seq);
    if (!sessionId || !Number.isFinite(number) || body.trim() === "") return { inserted: false, id: 0 };
    const result = this.db
      .prepare("INSERT OR IGNORE INTO dream_feed (session_id, seq, at, role, chars, text) VALUES (?, ?, ?, ?, ?, ?)")
      .run(String(sessionId), number, at || nowIso(), role === "user" ? "user" : "assistant", body.length, body);
    return { inserted: Number(result.changes) > 0, id: Number(result.lastInsertRowid ?? 0) };
  }

  /** Oldest-first feed window after a cursor. */
  dreamFeedRows({ afterId = 0, limit = 4000 } = {}) {
    return this.db
      .prepare("SELECT id, session_id, seq, at, role, chars, text FROM dream_feed WHERE id > ? ORDER BY id ASC LIMIT ?")
      .all(Number(afterId) || 0, clampInt(limit, 1, 20000, 4000));
  }

  /** What is waiting after the cursor: characters, messages, sessions. */
  dreamFeedStats({ afterId = 0 } = {}) {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(chars), 0) AS chars, COUNT(*) AS messages, COUNT(DISTINCT session_id) AS sessions, COALESCE(MAX(id), 0) AS maxId FROM dream_feed WHERE id > ?")
      .get(Number(afterId) || 0);
    return {
      chars: Number(row?.chars ?? 0),
      messages: Number(row?.messages ?? 0),
      sessions: Number(row?.sessions ?? 0),
      maxId: Number(row?.maxId ?? 0),
    };
  }

  /**Per-session view of the waiting window, carrying the user-message count T2 needs. */
  dreamFeedSessions({ afterId = 0, limit = 200 } = {}) {
    return this.db
      .prepare("SELECT session_id AS sessionId, COUNT(*) AS messages, SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS userMessages, COALESCE(SUM(chars), 0) AS chars, MIN(at) AS firstAt, MAX(at) AS lastAt, MIN(id) AS minId, MAX(id) AS maxId FROM dream_feed WHERE id > ? GROUP BY session_id ORDER BY minId ASC LIMIT ?")
      .all(Number(afterId) || 0, clampInt(limit, 1, 1000, 200));
  }

  /** Feed retention. The cursor is untouched: pruning never un-consumes material. */
  dreamFeedPrune({ before = null } = {}) {
    const cut = before || new Date(Date.now() - 30 * 86400000).toISOString();
    const result = this.db.prepare("DELETE FROM dream_feed WHERE at < ?").run(cut);
    // The per-session mark deliberately outlives the rows: it is one small row per
    // session, and expiring it would make a session resumed after a long pause
    // skip the turn it resumed on.
    return { deleted: Number(result.changes ?? 0), before: cut };
  }

  /**
   * Remove exactly the rows a pass consumed. A partial take (char budget hit) must
   * leave the remainder behind, which is why this takes ids instead of a range.
   */
  dreamFeedDelete({ ids = [] } = {}) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).map((id) => Number(id)).filter((id) => Number.isFinite(id)))];
    if (list.length === 0) return { deleted: 0 };
    let deleted = 0;
    this.tx(() => {
      for (let index = 0; index < list.length; index += 400) {
        const chunk = list.slice(index, index + 400);
        const sql = "DELETE FROM dream_feed WHERE id IN (" + chunk.map(() => "?").join(",") + ")";
        deleted += Number(this.db.prepare(sql).run(...chunk).changes ?? 0);
      }
    });
    return { deleted };
  }

  /**
   * The collection high-water mark for one session. Kept outside the feed on
   * purpose: a consumed row is deleted, so MAX(seq) over an emptied session is -1
   * and a restart would re-collect turns another process already summarized.
   */
  dreamFeedStateGet(sessionId) {
    const row = this.db.prepare("SELECT last_seq FROM dream_feed_state WHERE session_id = ?").get(String(sessionId));
    return Number(row?.last_seq ?? -1);
  }

  dreamFeedStateSet({ sessionId, lastSeq, at = nowIso() }) {
    const number = Number(lastSeq);
    if (!sessionId || !Number.isFinite(number)) return { status: "refused" };
    this.db
      .prepare("INSERT INTO dream_feed_state (session_id, last_seq, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at")
      .run(String(sessionId), number, at);
    return { status: "ok" };
  }

  /**
   * Record one dream. The digest is sha256(topic_key + body), so the same prose for
   * the same topic written twice is the same row — idempotence by content, not by
   * clock, which is what lets a re-run be safe.
   */
  dreamCreate({
    topicKey,
    title = "",
    body,
    topics = [],
    sources = [],
    evidence = "inferred",
    novelty = "low",
    unverified = false,
    supersedesId = null,
    runId = null,
    model = "",
    promptVersion = "v1",
    status = "pending",
    // World time: when the earliest source message behind this note was said.
    validFrom = null,
    at = nowIso(),
  } = {}) {
    const key = String(topicKey ?? "").trim();
    const text = String(body ?? "").trim();
    if (key === "" || text === "") return { status: "refused", reason: "empty" };
    const digest = sha256(key + "\u0000" + text);
    const existing = this.db.prepare("SELECT id FROM dreams WHERE topic_key = ? AND digest = ?").get(key, digest);
    if (existing) return { status: "duplicate", id: existing.id, digest };
    const id = uuid();
    this.tx(() => {
      this.db
        // fact_ids_json is reserved for a later pass that can prove which facts a
        // note summarizes; the model has no such list today, so nothing writes it.
        .prepare("INSERT INTO dreams (id, topic_key, title, body, topics_json, sources_json, status, evidence, novelty, unverified, supersedes_id, run_id, digest, model, prompt_version, valid_from, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, key, String(title ?? "").trim().slice(0, 200), text, json(topics), json(sources), status, evidence === "user_stated" ? "user_stated" : "inferred", novelty === "high" ? "high" : "low", unverified ? 1 : 0, supersedesId, runId, digest, String(model ?? ""), String(promptVersion ?? "v1"), validFrom === null ? null : String(validFrom), at, at);
    });
    return { status: "created", id, digest };
  }

  dream(id) {
    return rowToDream(this.db.prepare("SELECT * FROM dreams WHERE id = ?").get(id));
  }

  /** Query dreams. `status` accepts one status or a list; null means every status. */
  dreams({ status = null, topicKey = "", limit = 50, offset = 0, order = "recent" } = {}) {
    const where = [];
    const params = [];
    if (Array.isArray(status) && status.length > 0) {
      where.push("status IN (" + status.map(() => "?").join(",") + ")");
      params.push(...status);
    } else if (typeof status === "string" && status !== "") {
      where.push("status = ?");
      params.push(status);
    }
    if (topicKey) {
      where.push("topic_key = ?");
      params.push(topicKey);
    }
    const sort =
      order === "heat"
        ? " ORDER BY hit_count DESC, COALESCE(last_hit_at, updated_at) DESC, created_at DESC"
        : " ORDER BY created_at DESC";
    const sql = "SELECT * FROM dreams" + (where.length > 0 ? " WHERE " + where.join(" AND ") : "") + sort + " LIMIT ? OFFSET ?";
    return this.db.prepare(sql).all(...params, clampInt(limit, 1, 500, 50), Math.max(0, Number(offset) || 0)).map(rowToDream);
  }

  dreamPending({ limit = 50 } = {}) {
    return this.dreams({ status: "pending", limit, offset: 0 });
  }

  /** Topic keys already covered — the orient pass only needs titles. */
  dreamIndex({ limit = 40 } = {}) {
    return this.db
      // Hottest first: a topic the conversation keeps coming back to is the one
      // the model most needs to avoid re-proposing.
      .prepare("SELECT topic_key AS topicKey, title, status FROM dreams WHERE status IN ('active','pending') ORDER BY hit_count DESC, updated_at DESC LIMIT ?")
      .all(clampInt(limit, 1, 200, 40));
  }

  /** Accept a dream, optionally with edited prose. A rewritten body re-derives its digest. */
  dreamApply({ id, title = null, body = null, at = nowIso() }) {
    const row = this.db.prepare("SELECT * FROM dreams WHERE id = ?").get(id);
    if (!row) return { status: "not_found" };
    if (row.status === "active") return { status: "already_active", dream: rowToDream(row) };
    if (row.status !== "pending") return { status: "refused", reason: "status_" + row.status };
    const nextBody = String(body ?? row.body).trim();
    if (nextBody === "") return { status: "refused", reason: "empty_body" };
    const nextTitle = String(title ?? row.title).trim().slice(0, 200);
    const digest = sha256(row.topic_key + "\u0000" + nextBody);
    this.tx(() => {
      this.db.prepare("UPDATE dreams SET title = ?, body = ?, digest = ?, status = 'active', updated_at = ? WHERE id = ?").run(nextTitle, nextBody, digest, at, id);
      // The supersede link is written when the draft is created, but until someone
      // says yes to the new text the old note is still the live version. Accepting
      // is what actually closes it — otherwise both stay active on one topic.
      if (row.supersedes_id) this.dreamSupersede({ id: row.supersedes_id, byId: id, at });
    });
    return { status: "ok", dream: this.dream(id) };
  }

  /** Reject a dream and remember the topic, so the next pass stops re-proposing it. */
  dreamReject({ id, reason = "", at = nowIso() }) {
    const row = this.db.prepare("SELECT * FROM dreams WHERE id = ?").get(id);
    if (!row) return { status: "not_found" };
    if (row.status === "rejected") return { status: "already_rejected" };
    this.tx(() => {
      this.db.prepare("UPDATE dreams SET status = 'rejected', updated_at = ? WHERE id = ?").run(at, id);
      this.db
        .prepare("INSERT INTO dream_rejects (topic_key, reason, at) VALUES (?, ?, ?) ON CONFLICT(topic_key) DO UPDATE SET reason = excluded.reason, at = excluded.at")
        .run(row.topic_key, String(reason ?? "").slice(0, 400), at);
    });
    return { status: "ok" };
  }

  dreamRejects({ limit = 20 } = {}) {
    return this.db
      .prepare("SELECT topic_key AS topicKey, reason, at FROM dream_rejects ORDER BY at DESC LIMIT ?")
      .all(clampInt(limit, 1, 200, 20));
  }

  /** Close an active dream by pointing it at the one that replaces it. Nothing is deleted. */
  dreamSupersede({ id, byId, at = nowIso() }) {
    // World time closes when the replacement statement was made, not when someone
    // pressed accept: the old claim stopped being true when the new one was said.
    const old = this.db.prepare("SELECT valid_from, created_at FROM dreams WHERE id = ?").get(id);
    const next = this.db.prepare("SELECT valid_from FROM dreams WHERE id = ?").get(byId);
    const from = String(old?.valid_from ?? old?.created_at ?? "");
    const to = String(next?.valid_from ?? "") || String(at);
    const endsAt = from !== "" && to < from ? from : to;
    const result = this.db
      .prepare("UPDATE dreams SET status = 'superseded', superseded_by = ?, valid_to = COALESCE(valid_to, ?), updated_at = ? WHERE id = ? AND status IN ('active','pending')")
      .run(byId, endsAt, at, id);
    if (Number(result.changes) > 0) {
      this.db.prepare("UPDATE dreams SET supersedes_id = COALESCE(supersedes_id, ?), updated_at = ? WHERE id = ?").run(id, at, byId);
    }
    return { status: Number(result.changes) > 0 ? "ok" : "no_change" };
  }

  dreamStats() {
    const one = (sql) => Number(this.db.prepare(sql).get()?.count ?? 0);
    return {
      pending: one("SELECT COUNT(*) AS count FROM dreams WHERE status = 'pending'"),
      active: one("SELECT COUNT(*) AS count FROM dreams WHERE status = 'active'"),
      superseded: one("SELECT COUNT(*) AS count FROM dreams WHERE status = 'superseded'"),
      rejected: one("SELECT COUNT(*) AS count FROM dreams WHERE status = 'rejected'"),
      archived: one("SELECT COUNT(*) AS count FROM dreams WHERE status = 'archived'"),
      feedRows: one("SELECT COUNT(*) AS count FROM dream_feed"),
      rejects: one("SELECT COUNT(*) AS count FROM dream_rejects"),
    };
  }

  /**
   * Record that a note's topic actually came up. The only real heat signal this
   * layer has: not "how often did we reread it", but "did a conversation touch it".
   */
  dreamTouch({ ids = [], at = nowIso() } = {}) {
    const list = (Array.isArray(ids) ? ids : []).map((id) => String(id ?? "")).filter((id) => id !== "");
    if (list.length === 0) return { touched: 0 };
    let touched = 0;
    this.tx(() => {
      const statement = this.db.prepare("UPDATE dreams SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ? AND status = 'active'");
      for (const id of list) touched += Number(statement.run(at, id).changes) || 0;
    });
    return { touched };
  }

  /**
   * Record that the model opened these notes through `dream_read`. This is the
   * only signal that separates a memory layer someone uses from one that merely
   * exists: a cue proves the topic came up, a read proves a note was wanted.
   */
  dreamRead({ ids = [], at = nowIso() } = {}) {
    const list = (Array.isArray(ids) ? ids : []).map((id) => String(id ?? "")).filter((id) => id !== "");
    if (list.length === 0) return { read: 0 };
    let read = 0;
    this.tx(() => {
      const statement = this.db.prepare("UPDATE dreams SET read_count = read_count + 1, last_read_at = ? WHERE id = ? AND status = 'active'");
      for (const id of list) read += Number(statement.run(at, id).changes) || 0;
    });
    return { read };
  }

  /** How many notes sit in the given statuses — the reminder only needs a count. */
  dreamCount({ status = ["active"] } = {}) {
    const list = (Array.isArray(status) ? status : [status]).map((value) => String(value)).filter((value) => value !== "");
    const row =
      list.length === 0
        ? this.db.prepare("SELECT COUNT(*) AS count FROM dreams").get()
        : this.db.prepare("SELECT COUNT(*) AS count FROM dreams WHERE status IN (" + list.map(() => "?").join(",") + ")").get(...list);
    return Number(row?.count ?? 0);
  }

  /**
   * Archive notes nobody has touched since the given moment. Archived is a status,
   * not a delete: the row, its sources and its timeline stay, and a restore puts it
   * back. The rule is last real activity, never a made-up decay curve.
   */
  dreamArchiveStale({ before, at = nowIso() } = {}) {
    const mark = String(before ?? "");
    if (mark === "") return { archived: 0 };
    const result = this.db
      .prepare("UPDATE dreams SET status = 'archived', updated_at = ? WHERE status = 'active' AND COALESCE(last_hit_at, updated_at) < ?")
      .run(at, mark);
    return { archived: Number(result.changes) || 0 };
  }

  /** Put an archived note back into service. */
  dreamRestore({ id, at = nowIso() } = {}) {
    const row = this.db.prepare("SELECT status FROM dreams WHERE id = ?").get(id);
    if (!row) return { status: "not_found" };
    if (row.status !== "archived") return { status: "refused", reason: "status_" + row.status };
    // updated_at moves to now, or the same archive rule would hide it again tonight.
    this.db.prepare("UPDATE dreams SET status = 'active', updated_at = ? WHERE id = ?").run(at, id);
    return { status: "ok", dream: this.dream(id) };
  }

  recordDreamRun({
    id = uuid(),
    status = "ok",
    reason = "",
    trigger = "",
    focus = "",
    sessionIds = [],
    chars = 0,
    messages = 0,
    proposed = 0,
    accepted = 0,
    dropped = 0,
    cursorId = 0,
    model = "",
    durationMs = 0,
    error = "",
    at = nowIso(),
  } = {}) {
    this.db
      .prepare("INSERT INTO dream_runs (id, status, reason, trigger, focus, session_ids_json, chars, messages, proposed, accepted, dropped, cursor_id, model, duration_ms, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, status, reason, trigger, String(focus ?? "").slice(0, 400), json(sessionIds), Number(chars) || 0, Number(messages) || 0, Number(proposed) || 0, Number(accepted) || 0, Number(dropped) || 0, Number(cursorId) || 0, String(model ?? ""), Number(durationMs) || 0, String(error ?? "").slice(0, 500), at);
    return id;
  }

  recentDreamRuns({ limit = 10 } = {}) {
    return this.db
      // Two runs inside one millisecond share a timestamp; insertion order is the
      // only honest tiebreaker, and the first row is what the panel calls "last".
      .prepare("SELECT * FROM dream_runs ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(clampInt(limit, 1, 100, 10))
      .map((row) => ({
        ...row,
        sessionIds: safeParseArray(row.session_ids_json),
        cursorId: Number(row.cursor_id),
        durationMs: Number(row.duration_ms),
      }));
  }

  stats() {
    const one = (sql) => Number(this.db.prepare(sql).get().count ?? 0);
    return {
      facts: one("SELECT COUNT(*) AS count FROM facts"),
      active: one("SELECT COUNT(*) AS count FROM facts WHERE status = 'active'"),
      scheduled: one("SELECT COUNT(*) AS count FROM facts WHERE status = 'scheduled'"),
      conflict: one("SELECT COUNT(*) AS count FROM facts WHERE status = 'conflict'"),
      forgotten: one("SELECT COUNT(*) AS count FROM facts WHERE status = 'forgotten'"),
      entities: one("SELECT COUNT(*) AS count FROM entities WHERE status = 'active'"),
      sources: one("SELECT COUNT(*) AS count FROM fact_sources"),
      pending: one("SELECT COUNT(*) AS count FROM pending_items WHERE status IN ('waiting','retrying')"),
      tombstones: one("SELECT COUNT(*) AS count FROM tombstones"),
      generation: this.meta.generation,
      schemaVersion: SCHEMA_VERSION,
      sizeBytes: (() => {
        try {
          return statSync(this.path).size;
        } catch {
          return 0;
        }
      })(),
    };
  }

  close() {
    try {
      this.db.close();
    } catch (error) {
      return oneLine(error);
    }
    return null;
  }
}

export function openStore(options) {
  return MemoryStore.open(options);
}
