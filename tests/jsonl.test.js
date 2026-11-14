import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { commitImport, exportFile, previewImport } from "../src/jsonl.js";
import { SCHEMA_VERSION, sha256 } from "../src/util.js";
import { MemoryStore } from "../src/store.js";

const dirs = [];
function store() {
  const dir = mkdtempSync(join(tmpdir(), "fm-jsonl-"));
  dirs.push(dir);
  return { store: MemoryStore.open({ dataDir: dir }), dir };
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

const seed = (s) => {
  s.writeFact({ entity: { name: "api", type: "service" }, predicate: "端口", value: "8080", cardinality: "single", observedAt: "2026-01-01T00:00:00.000Z" });
  s.writeFact({
    entity: { name: "user", type: "person" },
    predicate: "手机号",
    value: "13800138000",
    privacyClass: "sensitive",
    modelUseAllowed: false,
    observedAt: "2026-01-01T00:00:00.000Z",
  });
};

test("export writes one manifest plus one line per visible fact", () => {
  const { store: s } = store();
  seed(s);
  const out = exportFile(s, {});
  assert.equal(out.count, 2);
  const lines = readFileSync(out.path, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 3);
  const manifest = JSON.parse(lines[0]);
  assert.equal(manifest.kind, "manifest");
  assert.equal(manifest.format_version, 1);
  assert.equal(manifest.record_count, 2);
  assert.equal(lines.some((line) => line.includes("sk-")), false);
  s.close();
});

test("re-importing your own export is all duplicates and writes nothing", () => {
  const { store: s } = store();
  seed(s);
  const out = exportFile(s, {});
  const preview = previewImport(s, out.path);
  assert.equal(preview.ok, true);
  assert.equal(preview.counts.duplicate, 2);
  assert.equal(preview.counts.new, 0);
  const committed = commitImport(s, { path: out.path, token: preview.token });
  assert.equal(committed.applied, 0);
  assert.equal(s.stats().facts, 2);
  s.close();
});

test("an export made before a schema bump still imports after the upgrade", () => {
  const source = store();
  seed(source.store);
  const out = exportFile(source.store, {});
  source.store.close();
  const lines = readFileSync(out.path, "utf8").trimEnd().split("\n");
  const manifest = JSON.parse(lines[0]);
  const write = (name, version) => {
    const copy = { ...manifest, schema_version: version };
    const path = join(source.dir, name);
    writeFileSync(path, [JSON.stringify(copy), ...lines.slice(1)].join("\n") + "\n", "utf8");
    return path;
  };

  const target = store();
  const older = write("older.jsonl", 6);
  const preview = previewImport(target.store, older);
  assert.equal(preview.ok, true, "an older manifest describes the same record shape");
  assert.equal(preview.counts.new, 2);
  const committed = commitImport(target.store, { path: older, token: preview.token });
  assert.equal(committed.applied, 2);
  // A newer layout is still refused: this build cannot promise to read it.
  const newer = write("newer.jsonl", SCHEMA_VERSION + 1);
  assert.throws(() => previewImport(target.store, newer), /schema_version/);
  target.store.close();
});

test("a backup restores superseded and expired rows as history, not as live values", () => {
  const source = store();
  source.store.writeFact({
    entity: { name: "api", type: "service" }, predicate: "端口", value: "8080", cardinality: "single",
    evidenceLevel: "explicit_user", observedAt: "2026-01-01T00:00:00.000Z",
  });
  source.store.writeFact({
    entity: { name: "api", type: "service" }, predicate: "端口", value: "9090", cardinality: "single",
    evidenceLevel: "explicit_user", observedAt: "2026-02-01T00:00:00.000Z",
  });
  const cache = source.store.writeFact({
    entity: { name: "cache", type: "service" }, predicate: "状态", value: "旧",
    evidenceLevel: "explicit_user", observedAt: "2026-01-01T00:00:00.000Z",
  });
  source.store.expireFact({ factId: cache.fact.id, expectedRevision: cache.fact.recordRevision });
  const out = exportFile(source.store, {});
  source.store.close();

  const target = store();
  const preview = previewImport(target.store, out.path);
  assert.equal(preview.ok, true);
  commitImport(target.store, { path: out.path, token: preview.token });
  const rows = target.store.db
    .prepare("SELECT predicate, value_text, status FROM facts ORDER BY predicate, value_text")
    .all()
    .map((row) => `${row.predicate}:${row.value_text}:${row.status}`);
  assert.deepEqual(rows, ["状态:旧:expired", "端口:8080:superseded", "端口:9090:active"]);
  assert.equal(target.store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE predicate = '端口' AND status = 'active'").get().n, 1);
  target.store.close();
});

test("a fresh store imports the new records, downgrades sensitive evidence", () => {
  const source = store();
  seed(source.store);
  const out = exportFile(source.store, {});
  source.store.close();

  const target = store();
  const preview = previewImport(target.store, out.path);
  assert.equal(preview.counts.new, 2);
  const committed = commitImport(target.store, { path: out.path, token: preview.token });
  assert.equal(committed.applied, 2);
  assert.equal(target.store.stats().facts, 2);
  const phone = target.store.db.prepare("SELECT privacy_class, model_use_allowed, evidence_level FROM facts WHERE predicate = '手机号'").get();
  assert.equal(phone.privacy_class, "sensitive");
  assert.equal(phone.model_use_allowed, 0);
  assert.equal(phone.evidence_level, "observed");
  target.store.close();
});

test("a stale token refuses instead of applying half a file", () => {
  const source = store();
  seed(source.store);
  const out = exportFile(source.store, {});
  const target = store();
  const preview = previewImport(target.store, out.path);
  target.store.writeFact({ entity: { name: "other", type: "project" }, predicate: "备注", value: "changed", observedAt: "2026-01-01T00:00:00.000Z" });
  target.store.bumpGeneration();
  const refused = commitImport(target.store, { path: out.path, token: preview.token });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /changed since preview/);
  assert.equal(target.store.stats().facts, 1);
  source.store.close();
  target.store.close();
});

test("an imported contradiction lands in the resolution queue instead of being dropped", () => {
  const source = store();
  source.store.writeFact({
    entity: { name: "api", type: "service" },
    predicate: "端口",
    value: "9090",
    cardinality: "single",
    evidenceLevel: "explicit_user",
    observedAt: "2026-02-01T00:00:00.000Z",
  });
  const out = exportFile(source.store, {});
  source.store.close();

  const target = store();
  target.store.writeFact({
    entity: { name: "api", type: "service" },
    predicate: "端口",
    value: "8080",
    cardinality: "single",
    evidenceLevel: "explicit_user",
    observedAt: "2026-01-01T00:00:00.000Z",
  });
  const preview = previewImport(target.store, out.path);
  assert.equal(preview.counts.conflict, 1);
  const committed = commitImport(target.store, { path: out.path, token: preview.token });
  assert.equal(committed.ok, true);
  assert.equal(committed.appliedConflicts, 1);
  const groups = target.store.listConflicts();
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].rows.map((row) => row.value).sort(), ["8080", "9090"]);
  // Turning the switch off keeps the old behaviour: nothing is written.
  const skipped = store();
  skipped.store.writeFact({ entity: { name: "api", type: "service" }, predicate: "端口", value: "8080", cardinality: "single", evidenceLevel: "explicit_user" });
  const preview2 = previewImport(skipped.store, out.path);
  const result2 = commitImport(skipped.store, { path: out.path, token: preview2.token, applyConflicts: false });
  assert.equal(result2.appliedConflicts, 0);
  assert.equal(skipped.store.listConflicts().length, 0);
  target.store.close();
  skipped.store.close();
});
test("edited bytes and bad encodings are rejected loudly", () => {
  const source = store();
  seed(source.store);
  const out = exportFile(source.store, {});
  const text = readFileSync(out.path, "utf8").replace('"8080"', '"9090"');
  writeFileSync(out.path, text, "utf8");
  const preview = previewImport(source.store, out.path);
  assert.equal(preview.edited, true);
  assert.equal(previewImport(source.store, `${out.path}.missing`).ok, false);
  const bomPath = join(source.dir, "bom.jsonl");
  writeFileSync(bomPath, `\uFEFF${text}`, "utf8");
  assert.throws(() => previewImport(source.store, bomPath), /BOM/);
  source.store.close();
});

test("an imported record cannot grant model visibility to a personal value", async () => {
  // Build a real export, then hand-edit it the way a user would: the file claims
  // the phone number is standard and model-visible.
  const source = store();
  source.store.writeFact({
    entity: { name: "user", type: "person" },
    predicate: "手机号",
    value: "13900002222",
    cardinality: "single",
    evidenceLevel: "explicit_user",
    privacyClass: "sensitive",
    modelUseAllowed: false,
  });
  const exported = exportFile(source.store, { dir: source.dir });
  const raw = readFileSync(exported.path, "utf8").trimEnd().split("\n");
  const manifest = JSON.parse(raw[0]);
  const record = JSON.parse(raw[1]);
  record.data.privacy_class = "standard";
  record.data.model_use_allowed = true;
  const lines = [JSON.stringify(record)];
  manifest.records_sha256 = sha256(lines.map((line) => `${line}\n`).join(""));
  const edited = join(source.dir, "edited.jsonl");
  writeFileSync(edited, `${JSON.stringify(manifest)}\n${lines[0]}\n`, "utf8");

  const target = store();
  const preview = previewImport(target.store, edited);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const commit = commitImport(target.store, { path: edited, token: preview.token });
  assert.equal(commit.ok, true);

  const row = target.store.db.prepare("SELECT privacy_class AS privacy, model_use_allowed AS visible FROM facts").get();
  assert.equal(row.privacy, "sensitive");
  assert.equal(row.visible, 0, "an import must not make a personal value model-visible");
});
