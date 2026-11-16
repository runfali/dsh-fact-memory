/**
 * SQLite schema (generation 1) and the migration ladder.
 *
 * The database is the only online source of truth. Every derived structure
 * (FTS index, directory render, graph) is rebuildable from these tables; nothing
 * here depends on a model call or on a file next to the database.
 */
import { SCHEMA_VERSION, nowIso, secretHits, uuid } from "./util.js";

const DDL = [
  `CREATE TABLE store_meta (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     schema_version INTEGER NOT NULL,
     store_id TEXT NOT NULL,
     generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
     last_event_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
     store_timezone TEXT NOT NULL,
     parser_version TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE TABLE entities (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     norm_name TEXT NOT NULL,
     type TEXT NOT NULL CHECK (type IN ('person','project','host','service','convention')),
     aliases TEXT NOT NULL DEFAULT '[]',
     scope TEXT NOT NULL DEFAULT 'global',
     status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged','retired')),
     merged_into TEXT REFERENCES entities(id) ON DELETE RESTRICT,
     record_revision INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (norm_name, scope)
   )`,

  `CREATE TABLE conflict_groups (
     id TEXT PRIMARY KEY,
     reason TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
     resolved_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE TABLE facts (
     id TEXT PRIMARY KEY,
     entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
     predicate TEXT NOT NULL,
     value_text TEXT NOT NULL,
     norm_text TEXT NOT NULL,
     value_entity_id TEXT REFERENCES entities(id) ON DELETE RESTRICT,
     cardinality TEXT NOT NULL CHECK (cardinality IN ('single','multi','unknown')),
     scope TEXT NOT NULL,
     qualifiers TEXT NOT NULL DEFAULT '{}',
     qualifiers_key TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('active','scheduled','superseded','conflict','expired','forgotten')),
     confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
     evidence_level TEXT NOT NULL CHECK (evidence_level IN ('explicit_user','confirmed_user','observed','unverified')),
     privacy_class TEXT NOT NULL DEFAULT 'standard' CHECK (privacy_class IN ('standard','sensitive')),
     model_use_allowed INTEGER NOT NULL DEFAULT 1 CHECK (model_use_allowed IN (0,1)),
     observed_at TEXT NOT NULL,
     valid_from TEXT,
     valid_to TEXT,
     time_precision TEXT NOT NULL DEFAULT 'unknown' CHECK (time_precision IN ('instant','day','month','unknown')),
     time_zone TEXT,
     superseded_by TEXT REFERENCES facts(id) ON DELETE RESTRICT,
     conflict_group_id TEXT REFERENCES conflict_groups(id) ON DELETE RESTRICT,
     claim_key TEXT NOT NULL,
     operation_key TEXT,
     record_revision INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE UNIQUE INDEX facts_single_slot ON facts (entity_id, predicate, scope, qualifiers_key)
     WHERE cardinality = 'single' AND status = 'active'`,
  `CREATE INDEX facts_lookup ON facts (status, scope, entity_id, predicate)`,
  `CREATE INDEX facts_revision ON facts (record_revision)`,

  `CREATE TABLE fact_sources (
     id TEXT PRIMARY KEY,
     fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
     source_type TEXT NOT NULL CHECK (source_type IN ('session','manual','import','tool')),
     namespace TEXT NOT NULL,
     session_id TEXT,
     seq INTEGER,
     message_id TEXT,
     role TEXT,
     text_range TEXT,
     evidence_hash TEXT NOT NULL,
     quote TEXT NOT NULL,
     evidence_key TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (fact_id, evidence_key)
   )`,
  `CREATE INDEX fact_sources_evidence ON fact_sources (evidence_key)`,

  `CREATE TABLE pending_items (
     id TEXT PRIMARY KEY,
     raw_text TEXT,
     source_refs TEXT NOT NULL DEFAULT '[]',
     reason TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','retrying','resolved','rejected')),
     privacy_class TEXT NOT NULL DEFAULT 'standard',
     model_use_allowed INTEGER NOT NULL DEFAULT 0,
     attempt_count INTEGER NOT NULL DEFAULT 0,
     error_code TEXT,
     operation_key TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX pending_state ON pending_items (status, created_at)`,

  `CREATE TABLE cursors (
     source_namespace TEXT NOT NULL,
     session_id TEXT NOT NULL,
     next_seq INTEGER NOT NULL DEFAULT 0,
     text_offset INTEGER NOT NULL DEFAULT 0,
     parser_version TEXT NOT NULL,
     source_fingerprint TEXT,
     last_operation_key TEXT,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (source_namespace, session_id)
   )`,

  `CREATE TABLE tombstones (
     id TEXT PRIMARY KEY,
     origin_store_id TEXT NOT NULL,
     scope TEXT NOT NULL,
     reason_code TEXT NOT NULL,
     created_at TEXT NOT NULL,
     released_by TEXT
   )`,
  `CREATE TABLE tombstone_fact_ids (
     tombstone_id TEXT NOT NULL REFERENCES tombstones(id) ON DELETE CASCADE,
     target_store_id TEXT NOT NULL,
     fact_id_text TEXT NOT NULL,
     PRIMARY KEY (tombstone_id, target_store_id, fact_id_text)
   )`,
  `CREATE TABLE tombstone_keys (
     tombstone_id TEXT NOT NULL REFERENCES tombstones(id) ON DELETE CASCADE,
     source_namespace TEXT NOT NULL,
     key_kind TEXT NOT NULL CHECK (key_kind IN ('claim','evidence')),
     key_hash TEXT NOT NULL,
     PRIMARY KEY (tombstone_id, source_namespace, key_kind, key_hash)
   )`,
  `CREATE INDEX tombstone_keys_lookup ON tombstone_keys (source_namespace, key_kind, key_hash)`,

  `CREATE TABLE operations (
     operation_id TEXT PRIMARY KEY,
     operation_key TEXT NOT NULL,
     request_fingerprint TEXT NOT NULL,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     target_ids TEXT NOT NULL DEFAULT '[]',
     base_generation INTEGER NOT NULL DEFAULT 0,
     committed_generation INTEGER NOT NULL DEFAULT 0,
     receipt TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL,
     UNIQUE (operation_key)
   )`,
  `CREATE TABLE operation_dedupe (
     operation_id_hash TEXT PRIMARY KEY,
     operation_key_hash TEXT NOT NULL UNIQUE,
     request_fingerprint TEXT NOT NULL,
     committed_generation INTEGER NOT NULL,
     created_at TEXT NOT NULL
   )`,

  `CREATE VIRTUAL TABLE facts_fts USING fts5 (
     fact_id UNINDEXED,
     tokens
   )`,
];

/**
 * Generation 2: proposals (a review queue for anything the rules may not apply
 * on their own), per-fact embedding vectors, and rerank calibration records.
 * All three are additive; nothing in generation 1 is rewritten.
 */
const DDL_V2 = [
  `CREATE TABLE proposals (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('low_confidence','conflict_resolve','expiry','merge')),
     action TEXT NOT NULL CHECK (action IN ('create','replace','merge','expire','resolve')),
     entity_name TEXT NOT NULL,
     predicate TEXT NOT NULL,
     value_text TEXT NOT NULL,
     norm_value TEXT NOT NULL,
     cardinality TEXT NOT NULL DEFAULT 'unknown' CHECK (cardinality IN ('single','multi','unknown')),
     scope TEXT NOT NULL DEFAULT 'global',
     qualifiers TEXT NOT NULL DEFAULT '{}',
     qualifiers_key TEXT NOT NULL DEFAULT '{}',
     targets TEXT NOT NULL DEFAULT '[]',
     evidence_refs TEXT NOT NULL DEFAULT '[]',
     evidence_level TEXT NOT NULL CHECK (evidence_level IN ('observed','unverified')),
     confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
     reason TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected','stale')),
     revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
     base_generation INTEGER NOT NULL DEFAULT 0,
     fingerprint TEXT NOT NULL,
     decision TEXT,
     decided_at TEXT,
     applied_fact_id TEXT REFERENCES facts(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE UNIQUE INDEX proposals_open_fingerprint ON proposals (fingerprint) WHERE status = 'pending'`,
  `CREATE INDEX proposals_state ON proposals (status, created_at)`,

  `CREATE TABLE fact_vectors (
     fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
     fingerprint TEXT NOT NULL,
     dim INTEGER NOT NULL CHECK (dim > 0),
     vector BLOB NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (fact_id, fingerprint)
   )`,
  `CREATE INDEX fact_vectors_fingerprint ON fact_vectors (fingerprint)`,

  `CREATE TABLE calibrations (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     fingerprint TEXT NOT NULL,
     threshold REAL NOT NULL,
     precision REAL NOT NULL,
     recall REAL NOT NULL,
     samples INTEGER NOT NULL,
     details TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL,
     UNIQUE (kind, fingerprint)
   )`,
];

/**
 * Generation 5: credentials get their own mark.
 *
 * `privacy_class = 'sensitive'` covers both "personal data the user may let the
 * model see" and "a credential, never". The read-time `sensitiveModelVisible`
 * switch must be able to widen the first without ever exposing the second, so a
 * credential is recorded in its own table instead of overloading the enum.
 */
const DDL_V5 = [
  `CREATE TABLE IF NOT EXISTS fact_secrets (
     fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
     marked_at TEXT NOT NULL
   )`,
];

// v6: per-turn extraction summaries. The turn-tail card reads them back after a
// host restart, so a turn keeps saying what it wrote instead of going blank.
const DDL_V6 = [
  `CREATE TABLE IF NOT EXISTS turn_summaries (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     from_seq INTEGER,
     saved INTEGER NOT NULL DEFAULT 0,
     proposals INTEGER NOT NULL DEFAULT 0,
     conflicts INTEGER NOT NULL DEFAULT 0,
     refused INTEGER NOT NULL DEFAULT 0,
     status TEXT,
     created_at TEXT NOT NULL,
     UNIQUE (session_id, seq)
   )`,
];

// v7: one row per extraction pass, persisted.
//
// The queue page answers "is this plugin alive?" and the in-memory counters die
// with the process, so after a restart the page had nothing to show and looked
// broken. These rows are operational (never memory content): they survive a
// wipe on purpose, because "the library is empty" is exactly when the user most
// needs to see that extraction still runs.
const DDL_V7 = [
  `CREATE TABLE IF NOT EXISTS extract_runs (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     session_title TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'ok',
     reason TEXT NOT NULL DEFAULT '',
     from_seq INTEGER NOT NULL DEFAULT 0,
     to_seq INTEGER NOT NULL DEFAULT 0,
     messages INTEGER NOT NULL DEFAULT 0,
     chars INTEGER NOT NULL DEFAULT 0,
     chunks INTEGER NOT NULL DEFAULT 0,
     candidates INTEGER NOT NULL DEFAULT 0,
     saved INTEGER NOT NULL DEFAULT 0,
     proposals INTEGER NOT NULL DEFAULT 0,
     conflicts INTEGER NOT NULL DEFAULT 0,
     refused INTEGER NOT NULL DEFAULT 0,
     duplicates INTEGER NOT NULL DEFAULT 0,
     model TEXT NOT NULL DEFAULT '',
     duration_ms INTEGER NOT NULL DEFAULT 0,
     at TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS extract_runs_at ON extract_runs (at DESC)`,
  `CREATE INDEX IF NOT EXISTS extract_runs_session ON extract_runs (session_id, at DESC)`,
];

// v8: a run keeps what it was actually asked, so "已跳过" can explain itself
// instead of showing only counts. The text is bounded: it is a diagnostic,
// not a second copy of the conversation.
const DDL_V8 = [
  `ALTER TABLE extract_runs ADD COLUMN input_text TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE extract_runs ADD COLUMN rejected_json TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE extract_runs ADD COLUMN input_truncated INTEGER NOT NULL DEFAULT 0`,
];

// v9: near-duplicate review.
//
// Two rows can say the same thing in different words; IDF cosine catches the
// shared-vocabulary cases and embeddings catch the re-phrasings, but neither can
// decide whether two statements *mean* the same thing — "测试结果 187" and
// "测试结果 188" are 0.89 alike and completely different facts. So the pair is
// recorded here once it has been judged, together with the vector generation it
// was judged under: a stale fingerprint re-opens the question, a decided pair is
// never sent to the model twice, and every run stays auditable.
/**
 * v10 also carries the health-check ledger and the "what is new since I last
 * looked" marker. Both are small, additive, and derived — losing them costs a
 * re-run, never a fact.
 */
const DDL_V10 = [
  `CREATE TABLE IF NOT EXISTS audit_runs (
     id TEXT PRIMARY KEY,
     at TEXT NOT NULL,
     status TEXT NOT NULL,
     reason TEXT,
     findings INTEGER NOT NULL DEFAULT 0,
     proposals INTEGER NOT NULL DEFAULT 0,
     duration_ms INTEGER NOT NULL DEFAULT 0
   )`,
  "CREATE INDEX IF NOT EXISTS audit_runs_at ON audit_runs (at DESC)",
  // One row per review surface: the queue remembers when the human last opened it.
  `CREATE TABLE IF NOT EXISTS review_state (
     id TEXT PRIMARY KEY,
     seen_at TEXT NOT NULL
   )`,
];

// v12: the dream layer. A dream is prose distilled from a stretch of conversation;
// a fact is one statement in a slot. The two never share a row, so this generation
// only adds tables — nothing above is rewritten, and dropping the feature means
// deleting five tables, not recovering a store.
const DDL_V11 = [
  // Material waiting to be dreamt about. `id` is AUTOINCREMENT on purpose: the
  // consumed cursor is a high-water id, and a plain rowid restarts at 1 after a
  // prune empties the table, which would silently re-consume nothing forever.
  `CREATE TABLE IF NOT EXISTS dream_feed (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     at TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('user','assistant')),
     chars INTEGER NOT NULL DEFAULT 0,
     text TEXT NOT NULL,
     UNIQUE (session_id, seq)
   )`,
  `CREATE INDEX IF NOT EXISTS dream_feed_at ON dream_feed (at)`,
  `CREATE INDEX IF NOT EXISTS dream_feed_session ON dream_feed (session_id, seq)`,
  // Where collection stopped for each session. The feed rows are deleted once a
  // pass consumes them, so MAX(seq) over an emptied session is -1 and cannot answer
  // this question after a restart; without a separate high-water mark a restart
  // would re-collect turns a previous process already summarized.
  `CREATE TABLE IF NOT EXISTS dream_feed_state (
     session_id TEXT PRIMARY KEY,
     last_seq INTEGER NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  // The dream itself. `digest` makes a re-run idempotent by content rather than by
  // clock; `supersedes_id`/`superseded_by` give the timeline the same shape as fact
  // revisions, and nothing is ever deleted when it is replaced.
  `CREATE TABLE IF NOT EXISTS dreams (
     id TEXT PRIMARY KEY,
     topic_key TEXT NOT NULL,
     title TEXT NOT NULL DEFAULT '',
     body TEXT NOT NULL,
     topics_json TEXT NOT NULL DEFAULT '[]',
     -- Reserved: a note may later be linked to the facts it summarizes. Nothing
     -- writes it today, because the model cannot know a real fact id.
     fact_ids_json TEXT NOT NULL DEFAULT '[]',
     sources_json TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','superseded','rejected','archived')),
     evidence TEXT NOT NULL DEFAULT 'inferred' CHECK (evidence IN ('user_stated','inferred')),
     novelty TEXT NOT NULL DEFAULT 'low' CHECK (novelty IN ('high','low')),
     unverified INTEGER NOT NULL DEFAULT 0,
     supersedes_id TEXT,
     superseded_by TEXT,
     run_id TEXT,
     digest TEXT NOT NULL,
     model TEXT NOT NULL DEFAULT '',
     prompt_version TEXT NOT NULL DEFAULT 'v1',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (topic_key, digest)
   )`,
  `CREATE INDEX IF NOT EXISTS dreams_status ON dreams (status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS dreams_topic ON dreams (topic_key, status)`,

  // Run ledger. A failed pass is harmless because the feed is only consumed after
  // a model answer came back and was parsed; `cursor_id` records how far that pass
  // actually read, and is informational rather than a resume point.
  `CREATE TABLE IF NOT EXISTS dream_runs (
     id TEXT PRIMARY KEY,
     status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','skipped','error')),
     reason TEXT NOT NULL DEFAULT '',
     trigger TEXT NOT NULL DEFAULT '',
     focus TEXT NOT NULL DEFAULT '',
     session_ids_json TEXT NOT NULL DEFAULT '[]',
     chars INTEGER NOT NULL DEFAULT 0,
     messages INTEGER NOT NULL DEFAULT 0,
     proposed INTEGER NOT NULL DEFAULT 0,
     accepted INTEGER NOT NULL DEFAULT 0,
     dropped INTEGER NOT NULL DEFAULT 0,
     cursor_id INTEGER NOT NULL DEFAULT 0,
     model TEXT NOT NULL DEFAULT '',
     duration_ms INTEGER NOT NULL DEFAULT 0,
     error TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS dream_runs_at ON dream_runs (created_at DESC)`,

  // A topic the user said no to. Handed to the next pass as a negative example, so
  // the queue does not keep re-proposing the same thing every week.
  `CREATE TABLE IF NOT EXISTS dream_rejects (
     topic_key TEXT PRIMARY KEY,
     reason TEXT NOT NULL DEFAULT '',
     at TEXT NOT NULL
   )`,
];

// v14: world time and heat on the dream itself.
//
// Bi-temporal, the same shape as facts: created_at/updated_at are transaction
// time ("when did we learn this"), and valid_from/valid_to are world time
// ("when was it true"). A replaced note keeps its row and gets a valid_to, so
// nothing is deleted and the timeline stays readable.
//
// hit_count/last_hit_at are the only honest heat signal available: a note is
// "hot" when a conversation actually mentioned its topic and the cue matched.
// There is no decay constant here on purpose - a number that looks precise but
// is made up is worse than last-activity, which is measured.
/** True when a table already carries a column (used by the additive migrations). */
function hasColumn(db, table, column) {
  try {
    return db.prepare("PRAGMA table_info(" + table + ")").all().some((row) => String(row.name) === column);
  } catch {
    return false;
  }
}

function addColumnIfMissing(db, table, column, definition) {
  if (!hasColumn(db, table, column)) db.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition);
}

// The columns themselves are added by MIGRATIONS[13] through addColumnIfMissing();
// only the index is a plain statement.
const DDL_V12 = [
  // Ranking for the cue and the topic index: hottest first, then most recently hit.
  "CREATE INDEX IF NOT EXISTS dreams_heat ON dreams (status, hit_count DESC, last_hit_at DESC)",
];

const DDL_V9 = [
  `CREATE TABLE IF NOT EXISTS dedup_runs (
     id TEXT PRIMARY KEY,
     status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','skipped','error','deferred')),
     reason TEXT NOT NULL DEFAULT '',
     pairs INTEGER NOT NULL DEFAULT 0,
     judged INTEGER NOT NULL DEFAULT 0,
     -- Not "same"/"distinct"/"unsure": DISTINCT is a keyword, and a column named
     -- after it is a syntax error in SQLite.
     same_count INTEGER NOT NULL DEFAULT 0,
     distinct_count INTEGER NOT NULL DEFAULT 0,
     unsure_count INTEGER NOT NULL DEFAULT 0,
     proposals INTEGER NOT NULL DEFAULT 0,
     model TEXT NOT NULL DEFAULT '',
     duration_ms INTEGER NOT NULL DEFAULT 0,
     at TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS dedup_runs_at ON dedup_runs (at DESC)`,

  `CREATE TABLE IF NOT EXISTS dedup_judgements (
     pair_key TEXT PRIMARY KEY,
     fingerprint TEXT NOT NULL DEFAULT '',
     left_id TEXT NOT NULL,
     right_id TEXT NOT NULL,
     scope TEXT NOT NULL DEFAULT 'global',
     cosine REAL,
     lexical REAL,
     decision TEXT NOT NULL CHECK (decision IN ('same','distinct','unsure')),
     keep_id TEXT,
     drop_id TEXT,
     reason TEXT NOT NULL DEFAULT '',
     source TEXT NOT NULL DEFAULT 'model' CHECK (source IN ('model','rule','human')),
     proposal_id TEXT,
     status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','proposed','resolved','failed')),
     attempts INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS dedup_judgements_state ON dedup_judgements (status, updated_at DESC)`,
];

const DROP = [
  "DROP TABLE IF EXISTS dedup_judgements",
  "DROP TABLE IF EXISTS dedup_runs",
  "DROP TABLE IF EXISTS extract_runs",
  "DROP TABLE IF EXISTS turn_summaries",
  "DROP TABLE IF EXISTS fact_secrets",
  "DROP TABLE IF EXISTS calibrations",
  "DROP TABLE IF EXISTS fact_vectors",
  "DROP TABLE IF EXISTS proposals",
  "DROP TABLE IF EXISTS facts_fts",
  "DROP TABLE IF EXISTS operation_dedupe",
  "DROP TABLE IF EXISTS operations",
  "DROP TABLE IF EXISTS tombstone_keys",
  "DROP TABLE IF EXISTS tombstone_fact_ids",
  "DROP TABLE IF EXISTS tombstones",
  "DROP TABLE IF EXISTS cursors",
  "DROP TABLE IF EXISTS pending_items",
  "DROP TABLE IF EXISTS fact_sources",
  "DROP TABLE IF EXISTS facts",
  "DROP TABLE IF EXISTS conflict_groups",
  "DROP TABLE IF EXISTS entities",
  "DROP TABLE IF EXISTS store_meta",
];

function readUserVersion(db) {
  const row = db.prepare("PRAGMA user_version").get();
  return Number(row?.user_version ?? 0);
}

/**
 * The migration ladder. Each step is a separate transaction so a failure leaves
 * the previous generation intact and readable.
 */
const MIGRATIONS = {
  1: (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of DDL_V2) db.exec(statement);
      db.exec(`PRAGMA user_version = 2`);
      db.prepare("UPDATE store_meta SET schema_version = 2, updated_at = ?").run(nowIso());
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the original error is the one worth reporting */
      }
      throw error;
    }
  },
  // v3: a conflict group must not leave one side behind as an authoritative
  // `active` row. Builds before this only stamped the group id on the rival, so
  // repair every such row once at upgrade time.
  2: (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        `UPDATE facts SET status = 'conflict', updated_at = datetime('now')
          WHERE status = 'active' AND conflict_group_id IS NOT NULL
            AND conflict_group_id IN (SELECT id FROM conflict_groups WHERE status = 'open')`,
      );
      db.exec("PRAGMA user_version = 3");
      db.prepare("UPDATE store_meta SET schema_version = 3, updated_at = ?").run(nowIso());
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the original error is the one worth reporting */
      }
      throw error;
    }
  },
  // v4: a planned change (`scheduled`) must be able to coexist with the value it
  // will replace. The old partial index treated both as one slot, which made a
  // future-dated write impossible without a conflict; only live rows collide now.
  3: (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DROP INDEX IF EXISTS facts_single_slot");
      db.exec(
        `CREATE UNIQUE INDEX facts_single_slot ON facts (entity_id, predicate, scope, qualifiers_key)
           WHERE cardinality = 'single' AND status = 'active'`,
      );
      db.exec("PRAGMA user_version = 4");
      db.prepare("UPDATE store_meta SET schema_version = 4, updated_at = ?").run(nowIso());
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the original error is the one worth reporting */
      }
      throw error;
    }
  },
  // v5: mark existing credential rows so the sensitive switch can never expose
  // them. The mark is derived from the value itself, not from the caller.
  4: (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of DDL_V5) db.exec(statement);
      const rows = db
        .prepare("SELECT id, value_text FROM facts WHERE privacy_class = 'sensitive' OR model_use_allowed = 0")
        .all();
      const insert = db.prepare("INSERT OR IGNORE INTO fact_secrets (fact_id, marked_at) VALUES (?, ?)");
      const at = nowIso();
      for (const row of rows) {
        if (secretHits(row.value_text).length > 0) insert.run(row.id, at);
      }
      db.exec("PRAGMA user_version = 5");
      db.prepare("UPDATE store_meta SET schema_version = 5, updated_at = ?").run(nowIso());
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the original error is the one worth reporting */
      }
      throw error;
    }
  },
  // v6: per-turn extraction summaries.
  5: (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of DDL_V6) db.exec(statement);
      db.exec("PRAGMA user_version = 6");
      db.prepare("UPDATE store_meta SET schema_version = 6, updated_at = ?").run(nowIso());
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the original error is the one worth reporting */
      }
      throw error;
    }
  },
  // v7: the extraction run log the queue page reads after a restart.
  6: (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of DDL_V7) db.exec(statement);
      db.exec("PRAGMA user_version = 7");
      db.prepare("UPDATE store_meta SET schema_version = 7, updated_at = ?").run(nowIso());
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the original error is the one worth reporting */
      }
      throw error;
    }
  },
  // v8: the run log learns what the model was asked and what it refused.
  7: (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of DDL_V8) db.exec(statement);
      db.exec("PRAGMA user_version = 8");
      db.prepare("UPDATE store_meta SET schema_version = 8, updated_at = ?").run(nowIso());
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the original error is the one worth reporting */
      }
      throw error;
    }
  },
  // v9: the duplicate-review ledger (see DDL_V9).
  8: (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of DDL_V9) db.exec(statement);
      db.exec("PRAGMA user_version = 9");
      db.prepare("UPDATE store_meta SET schema_version = 9, updated_at = ?").run(nowIso());
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the original error is the one worth reporting */
      }
      throw error;
    }
  },
  // v10: a folded log slot keeps the values it absorbed (see logSlotKey).
  9: (db) => {
    // A store that a second process already upgraded (or a partially applied step
    // that a crash rolled back to the column, not the version) must not brick the
    // plugin at startup: adding a column twice is a no-op here, not a fatal error.
    const addColumn = (table, column, definition) => {
      const known = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
      if (!known.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    };
    db.exec("BEGIN IMMEDIATE");
    try {
      addColumn("facts", "folded_count", "INTEGER NOT NULL DEFAULT 0");
      addColumn("facts", "folded_from", "TEXT NOT NULL DEFAULT '[]'");
      for (const statement of DDL_V10) db.exec(statement);
      db.exec("PRAGMA user_version = 10");
      db.prepare("UPDATE store_meta SET schema_version = 10, updated_at = ?").run(nowIso());
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the original error is the one worth reporting */
      }
      throw error;
    }
  },
  // v11: the health check files cards whose kind ("audit") and action ("retire",
  // "fold_log", "alias") the v2 CHECK lists never imagined, and SQLite cannot
  // widen a CHECK in place. Rebuild the table and copy every row across, so an
  // existing queue (pending, applied, rejected alike) survives untouched.
  10: (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`CREATE TABLE proposals_next (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('low_confidence','conflict_resolve','expiry','merge','audit')),
     action TEXT NOT NULL CHECK (action IN ('create','replace','merge','expire','resolve','retire','fold_log','alias')),
     entity_name TEXT NOT NULL,
     predicate TEXT NOT NULL,
     value_text TEXT NOT NULL,
     norm_value TEXT NOT NULL,
     cardinality TEXT NOT NULL DEFAULT 'unknown' CHECK (cardinality IN ('single','multi','unknown')),
     scope TEXT NOT NULL DEFAULT 'global',
     qualifiers TEXT NOT NULL DEFAULT '{}',
     qualifiers_key TEXT NOT NULL DEFAULT '{}',
     targets TEXT NOT NULL DEFAULT '[]',
     evidence_refs TEXT NOT NULL DEFAULT '[]',
     evidence_level TEXT NOT NULL CHECK (evidence_level IN ('observed','unverified')),
     confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
     reason TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected','stale')),
     revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
     base_generation INTEGER NOT NULL DEFAULT 0,
     fingerprint TEXT NOT NULL,
     decision TEXT,
     decided_at TEXT,
     applied_fact_id TEXT REFERENCES facts(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`);
      db.exec(`INSERT INTO proposals_next
        (id, kind, action, entity_name, predicate, value_text, norm_value, cardinality, scope, qualifiers,
         qualifiers_key, targets, evidence_refs, evidence_level, confidence, reason, status, revision,
         base_generation, fingerprint, decision, decided_at, applied_fact_id, created_at, updated_at)
        SELECT id, kind, action, entity_name, predicate, value_text, norm_value, cardinality, scope, qualifiers,
         qualifiers_key, targets, evidence_refs, evidence_level, confidence, reason, status, revision,
         base_generation, fingerprint, decision, decided_at, applied_fact_id, created_at, updated_at
          FROM proposals`);
      db.exec("DROP TABLE proposals");
      db.exec("ALTER TABLE proposals_next RENAME TO proposals");
      db.exec("CREATE UNIQUE INDEX proposals_open_fingerprint ON proposals (fingerprint) WHERE status = 'pending'");
      db.exec("CREATE INDEX proposals_state ON proposals (status, created_at)");
      db.exec("PRAGMA user_version = 11");
      db.prepare("UPDATE store_meta SET schema_version = 11, updated_at = ?").run(nowIso());
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the original error is the one worth reporting */
      }
      throw error;
    }
  },
  // v12: the dream layer (see DDL_V11). Additive only: an older build that opens
  // this store keeps working on every table it knows and simply ignores these.
  11: (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of DDL_V11) db.exec(statement);
      db.exec("PRAGMA user_version = 12");
      db.prepare("UPDATE store_meta SET schema_version = 12, updated_at = ?").run(nowIso());
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the original error is the one worth reporting */
      }
      throw error;
    }
  },
  // v13: drop the dream full-text index that v12's first draft created. Nothing
  // ever queried it (the panel lists recent rows instead), and a build that had
  // already migrated carries it forever, which would leave fresh and migrated
  // stores with two different table sets for the same version.
  12: (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DROP TABLE IF EXISTS dreams_fts");
      db.exec("PRAGMA user_version = 13");
      db.prepare("UPDATE store_meta SET schema_version = 13, updated_at = ?").run(nowIso());
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the original error is the one worth reporting */
      }
      throw error;
    }
  },
  // v14: world-time columns and heat on dreams (see DDL_V12). Additive only and
  // every column is nullable or defaulted, so an older build reads the rows it
  // already knows and ignores the rest.
  13: (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      // Column adds are checked first: an early v14 build (or a hand-fixed file)
      // that already has them must not turn the whole upgrade into an error.
      addColumnIfMissing(db, "dreams", "valid_from", "TEXT");
      addColumnIfMissing(db, "dreams", "valid_to", "TEXT");
      addColumnIfMissing(db, "dreams", "hit_count", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "dreams", "last_hit_at", "TEXT");
      for (const statement of DDL_V12) db.exec(statement);
      db.exec("PRAGMA user_version = 14");
      db.prepare("UPDATE store_meta SET schema_version = 14, updated_at = ?").run(nowIso());
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the original error is the one worth reporting */
      }
      throw error;
    }
  },
};

/**
 * Create or migrate the schema. A database that is missing required tables is
 * NOT silently adopted as empty: the caller distinguishes "absent file" from
 * "corrupt / foreign file" and reports the reason.
 */
export function ensureSchema(db, { storeTimezone, parserVersion, freshStoreId }) {
  const version = readUserVersion(db);
  if (version > SCHEMA_VERSION) {
    const error = new Error(`memory store schema ${version} is newer than this plugin supports (${SCHEMA_VERSION})`);
    error.code = "SCHEMA_TOO_NEW";
    throw error;
  }
  let current = version;
  if (version === 0) {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of DDL) db.exec(statement);
      // Generation 1 is created as generation 1, then the ladder below takes it
      // to the current version exactly like an upgraded store would. Creating the
      // newest tables inline instead would give fresh and migrated stores two
      // different histories that only diverge on the next migration.
      db.exec("PRAGMA user_version = 1");
      const storeId = freshStoreId || uuid();
      const at = nowIso();
      db.prepare(
        `INSERT INTO store_meta (id, schema_version, store_id, generation, last_event_seq, store_timezone, parser_version, created_at, updated_at)
         VALUES (1, 1, ?, 0, 0, ?, ?, ?, ?)`,
      ).run(storeId, storeTimezone, parserVersion, at, at);
      db.exec("COMMIT");
      current = 1;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the original error is the one worth reporting */
      }
      // A second process may have created the store while this one waited for
      // the write lock; adopt its version instead of failing on a duplicate
      // table or primary key.
      const adopted = readUserVersion(db);
      if (adopted > 0) current = adopted;
      else throw error;
    }
  }
  // Walk every step this build actually implements; a gap is an error, never a
  // guess about what a future schema looks like.
  while (current < SCHEMA_VERSION) {
    const step = MIGRATIONS[current];
    if (typeof step !== "function") {
      const error = new Error(`memory store schema ${current} has no migration step in this build`);
      error.code = "SCHEMA_NO_MIGRATION";
      throw error;
    }
    try {
      step(db);
    } catch (error) {
      // Another host process may have completed this step between our version
      // read and BEGIN IMMEDIATE. Its user_version is now higher; that is a
      // success, not a duplicate-column failure.
      const adopted = readUserVersion(db);
      if (adopted <= current) throw error;
      current = adopted;
      continue;
    }
    current = Math.max(current + 1, readUserVersion(db));
  }
  return { version: SCHEMA_VERSION, migrated: version === 0, from: version };
}

/** Integrity gates run on startup and after a restore, per the plan's E.4 table. */
export function checkIntegrity(db) {
  const rows = db.prepare("PRAGMA integrity_check").all();
  const findings = rows.map((row) => String(row.integrity_check ?? "")).filter((text) => text !== "ok");
  const foreign = db.prepare("PRAGMA foreign_key_check").all();
  const missing = [];
  for (const table of ["store_meta", "entities", "facts", "fact_sources", "tombstones", "operations", "proposals", "fact_secrets", "turn_summaries", "extract_runs"]) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!row) missing.push(table);
  }
  // The full-text index is derived data: a damaged FTS5 shadow table is fixed by
  // rebuilding it, so it must not be reported as a damaged fact store. This also
  // keeps a second process writing the same file (a stale FTS5 structure in a
  // long-lived connection) from looking like corruption.
  const isFts = (text) => /fts/i.test(text);
  const indexFindings = findings.filter(isFts);
  const storeFindings = findings.filter((text) => !isFts(text));
  return {
    ok: storeFindings.length === 0 && foreign.length === 0 && missing.length === 0,
    integrityOk: findings.length === 0,
    findings,
    storeFindings,
    indexOk: indexFindings.length === 0,
    indexFindings,
    foreign,
    missing,
  };
}

export { DDL, DROP };
