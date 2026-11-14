/**
 * JSONL exchange: the human-editable form of the store.
 *
 * Export is a complete, deterministic dump of the visible facts (entities are
 * re-created by name on import, so 0.1.0 carries no separate entity rows).
 * Import is two-step: preview classifies every record against the live store and
 * returns a token bound to the file bytes; commit re-hashes the file, applies the
 * `new` records only, and never overwrites a local fact. Conflicting rows are
 * reported, not silently merged — the plan's conflict ladder starts with "keep
 * both sides and ask", and there is no proposal UI yet.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimKeyOf, qualifierKey } from "./store.js";
import { PARSER_VERSION, SCHEMA_VERSION, json, nowIso, privacyHits, sha256 } from "./util.js";

export const FORMAT_VERSION = 1;
export const EXPORT_MODE = "complete";
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_RECORDS = 100000;
const MAX_LINE = 2 * 1024 * 1024;

const normEntity = (value) => String(value ?? "").trim().toLowerCase();

function factRecord(fact) {
  return {
    kind: "fact",
    id: fact.id,
    base: { store_id: null, generation: null, record_revision: fact.recordRevision },
    data: {
      entity: fact.entity,
      entity_type: fact.entityType ?? "project",
      predicate: fact.predicate,
      value: fact.value,
      cardinality: fact.cardinality,
      scope: fact.scope,
      qualifiers: fact.qualifiers ?? {},
      evidence_level: fact.evidenceLevel,
      privacy_class: fact.privacyClass,
      model_use_allowed: fact.modelUseAllowed,
      observed_at: fact.observedAt,
      valid_from: fact.validFrom,
      valid_to: fact.validTo,
      status: fact.status,
    },
  };
}

/** Export the visible store to one JSONL file; returns its path and counts. */
export function exportFile(store, { dir, now = nowIso() } = {}) {
  const meta = store.meta;
  const targetDir = dir ?? join(store.dataDir, "exports");
  mkdirSync(targetDir, { recursive: true });
  const facts = store.db
    .prepare("SELECT f.id FROM facts f WHERE f.status != 'forgotten' ORDER BY f.created_at, f.id")
    .all()
    .map((row) => store.getFact(row.id))
    .filter(Boolean);
  const records = facts.map((fact) => ({ ...factRecord(fact), base: { store_id: meta.storeId, generation: meta.generation, record_revision: fact.recordRevision } }));
  const lines = records.map((record) => JSON.stringify(record));
  const recordsHash = sha256(lines.map((line) => `${line}\n`).join(""));
  const manifest = {
    kind: "manifest",
    format_version: FORMAT_VERSION,
    schema_version: SCHEMA_VERSION,
    store_id: meta.storeId,
    base_generation: meta.generation,
    export_mode: EXPORT_MODE,
    record_count: records.length,
    records_sha256: recordsHash,
    parser_version: PARSER_VERSION,
    exported_at: now,
  };
  const stamp = now.replace(/[:.]/g, "-");
  const path = join(targetDir, `facts-${stamp}.jsonl`);
  const body = [JSON.stringify(manifest), ...lines].join("\n") + "\n";
  writeFileSync(`${path}.tmp`, body, "utf8");
  renameSync(`${path}.tmp`, path);
  const manifestHash = sha256(body);
  return { path, count: records.length, bytes: Buffer.byteLength(body), manifestHash };
}

function readBuffer(path) {
  const stat = statSync(path);
  if (stat.size > MAX_BYTES) throw Object.assign(new Error("file exceeds 256 MiB"), { code: "TOO_LARGE" });
  return readFileSync(path);
}

function readLines(path, buffer = null) {
  const bytes = buffer ?? readBuffer(path);
  let text = bytes.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) throw Object.assign(new Error("file starts with a BOM"), { code: "BAD_ENCODING" });
  text = text.replace(/\r\n/g, "\n");
  if (!text.endsWith("\n")) throw Object.assign(new Error("file does not end with LF"), { code: "TRUNCATED" });
  const raw = text.slice(0, -1).split("\n");
  if (raw.length === 0) throw Object.assign(new Error("file is empty"), { code: "EMPTY" });
  if (raw.length - 1 > MAX_RECORDS) throw Object.assign(new Error("too many records"), { code: "TOO_MANY" });
  const parsed = [];
  for (let index = 0; index < raw.length; index += 1) {
    const line = raw[index];
    if (line.trim() === "") throw Object.assign(new Error(`blank line at ${index + 1}`), { code: "BLANK_LINE" });
    if (Buffer.byteLength(line) > MAX_LINE) throw Object.assign(new Error(`line ${index + 1} too long`), { code: "LINE_TOO_LONG" });
    try {
      parsed.push(JSON.parse(line));
    } catch {
      throw Object.assign(new Error(`invalid JSON at line ${index + 1}`), { code: "BAD_JSON" });
    }
  }
  const [manifest, ...records] = parsed;
  if (!manifest || manifest.kind !== "manifest") throw Object.assign(new Error("missing manifest line"), { code: "NO_MANIFEST" });
  if (manifest.format_version !== FORMAT_VERSION) throw Object.assign(new Error("unsupported format_version"), { code: "BAD_VERSION" });
  // A manifest is a record list, not a schema dump: an older store version
  // describes the same record shape, so an export made before an upgrade must
  // still import after it. Only a newer layout is unsafe to read.
  const manifestSchema = Number(manifest.schema_version ?? 0);
  if (!Number.isInteger(manifestSchema) || manifestSchema < 1 || manifestSchema > SCHEMA_VERSION) {
    throw Object.assign(new Error("unsupported schema_version"), { code: "BAD_VERSION" });
  }
  const recordLines = raw.slice(1);
  return { manifest, records, recordLines, fileHash: sha256(bytes) };
}

function validateFactRecord(record, index) {
  if (record?.kind !== "fact") return { error: `record ${index + 1}: unknown kind ${String(record?.kind)}` };
  const data = record.data;
  if (!data || typeof data !== "object") return { error: `record ${index + 1}: missing data` };
  for (const field of ["entity", "predicate", "value"]) {
    if (typeof data[field] !== "string" || data[field].trim() === "") return { error: `record ${index + 1}: data.${field} required` };
  }
  const cardinality = data.cardinality ?? "multi";
  if (!["single", "multi", "unknown"].includes(cardinality)) return { error: `record ${index + 1}: bad cardinality` };
  if (data.qualifiers !== undefined && (typeof data.qualifiers !== "object" || data.qualifiers === null || Array.isArray(data.qualifiers))) {
    return { error: `record ${index + 1}: bad qualifiers` };
  }
  const status = data.status ?? "active";
  if (!["active", "scheduled", "conflict", "expired", "superseded"].includes(status)) {
    return { error: `record ${index + 1}: bad status` };
  }
  return { ok: true, cardinality, status };
}

function classify(store, data) {
  const entityRow = store.db.prepare("SELECT id FROM entities WHERE norm_name = ? AND scope = ?").get(normEntity(data.entity), data.scope ?? "global");
  if (!entityRow) return { kind: "new" };
  const claimKey = claimKeyOf({ entityName: data.entity, predicate: data.predicate, qualifiers: data.qualifiers ?? {}, value: data.value });
  if (store.isTombstoned({ namespace: "import", claimKey })) return { kind: "tombstoned", claimKey };
  const qualifiersK = qualifierKey(data.qualifiers ?? {});
  const same = store.factByClaimKey(claimKey);
  if (same && same.status === "forgotten") return { kind: "tombstoned", claimKey };
  if (same && same.status === "active") return { kind: "duplicate", claimKey, factId: same.id };
  const slot = store.db
    .prepare(`SELECT id, value_text FROM facts WHERE entity_id = ? AND predicate = ? AND scope = ? AND qualifiers_key = ?
              AND status IN ('active','scheduled') LIMIT 1`)
    .get(entityRow.id, data.predicate, data.scope ?? "global", qualifiersK);
  if (slot) return { kind: "conflict", claimKey, factId: slot.id, localValue: slot.value_text };
  return { kind: "new", claimKey };
}

/** Classify a file without writing. The token binds commit to these bytes. */
export function previewImport(store, path, { buffer = null } = {}) {
  if (!existsSync(path)) return { ok: false, error: "file not found" };
  const parsed = readLines(path, buffer);
  const counts = { total: parsed.records.length, new: 0, duplicate: 0, conflict: 0, tombstoned: 0, invalid: 0 };
  const examples = [];
  const accepted = [];
  parsed.records.forEach((record, index) => {
    const valid = validateFactRecord(record, index);
    if (!valid.ok) {
      counts.invalid += 1;
      if (examples.length < 5) examples.push(valid.error);
      return;
    }
    const kind = classify(store, record.data);
    counts[kind.kind] = (counts[kind.kind] ?? 0) + 1;
    if (kind.kind === "new") accepted.push(record);
    if (kind.kind === "conflict" && examples.length < 5) examples.push(`${record.data.entity}·${record.data.predicate}: 本地已有「${kind.localValue}」，文件里是「${record.data.value}」`);
  });
  const computed = sha256(parsed.recordLines.map((line) => `${line}\n`).join(""));
  const edited = computed !== parsed.manifest.records_sha256 || parsed.manifest.record_count !== parsed.records.length;
  return {
    ok: counts.invalid === 0,
    path,
    counts,
    edited,
    examples,
    token: sha256(`${parsed.fileHash}:${store.meta.storeId}:${store.meta.generation}`),
    fileHash: parsed.fileHash,
    records: accepted.length,
  };
}

/** Apply the `new` records of a previewed file. Never overwrites a local fact. */
export function commitImport(store, { path, token, applyConflicts = true }) {
  if (!existsSync(path)) return { ok: false, error: "file not found" };
  // Read once: the token, the preview and the rows applied all describe the
  // same bytes, so replacing the file after preview cannot swap in unseen data.
  const buffer = readBuffer(path);
  const preview = previewImport(store, path, { buffer });
  if (!preview.ok && preview.counts?.invalid > 0) return { ok: false, error: "file has invalid records", preview };
  if (token !== preview.token) return { ok: false, error: "file or store changed since preview; re-import to preview again", preview };
  const parsed = readLines(path, buffer);
  const applied = [];
  const conflicts = [];
  // Restore history before the values that replaced it: a superseded row must
  // hold the slot first, otherwise the live value would be written, the old one
  // would look like a contradiction, and the backup would come back as a
  // conflict instead of its original state.
  const records = [];
  parsed.records.forEach((record, index) => {
    const valid = validateFactRecord(record, 0);
    if (valid.ok) records.push({ record, index, status: valid.status });
  });
  const phase = (status) => (status === "expired" || status === "superseded" ? 0 : status === "conflict" ? 2 : 1);
  records.sort((a, b) => phase(a.status) - phase(b.status) || a.index - b.index);
  store.tx(() => {
    for (const { record, status: wanted } of records) {
      const kind = classify(store, record.data).kind;
      // A conflicting record is applied as an observed fact instead of being
      // dropped: the two values then sit in one conflict group and show up in the
      // panel's resolution queue, which is where the plan wants them.
      if (kind !== "new" && !(applyConflicts && kind === "conflict")) continue;
      // The file is human-editable, so its own privacy flags cannot be trusted:
      // a personal value is re-classified from the text, and an import never
      // grants model visibility to one (credentials are forced by writeFact).
      const personal = privacyHits(String(record.data.value ?? "")).length > 0;
      const sensitive = personal || record.data.privacy_class === "sensitive";
      const result = store.writeFact({
        entity: { name: record.data.entity, type: record.data.entity_type ?? "project" },
        predicate: record.data.predicate,
        value: record.data.value,
        cardinality: record.data.cardinality ?? "multi",
        scope: record.data.scope ?? "global",
        qualifiers: record.data.qualifiers ?? {},
        evidenceLevel: "observed",
        privacyClass: sensitive ? "sensitive" : "standard",
        modelUseAllowed: !sensitive && record.data.model_use_allowed !== false,
        observedAt: record.data.observed_at ?? nowIso(),
        validFrom: record.data.valid_from ?? null,
        validTo: record.data.valid_to ?? null,
        source: {
          sourceType: "import",
          namespace: "import",
          sessionId: null,
          seq: null,
          messageId: record.id,
          role: null,
          textRange: null,
          evidenceHash: sha256(json(record.data)),
          quote: `${record.data.entity}·${record.data.predicate}`,
        },
      });
      applied.push(result.fact.id);
      if (result.status !== "duplicate" && (wanted === "expired" || wanted === "superseded")) {
        store.db
          .prepare("UPDATE facts SET status = ?, valid_from = ?, valid_to = ?, updated_at = ? WHERE id = ?")
          .run(wanted, record.data.valid_from ?? null, record.data.valid_to ?? null, nowIso(), result.fact.id);
      }
      if (result.status === "conflict" && result.conflictGroupId) conflicts.push(result.conflictGroupId);
    }
    store.bumpGeneration();
  });
  return {
    ok: true,
    applied: applied.length,
    appliedConflicts: conflicts.length,
    conflictGroupIds: [...new Set(conflicts)],
    counts: preview.counts,
    generation: store.meta.generation,
  };
}
