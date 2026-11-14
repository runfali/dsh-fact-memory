import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { MemoryStore } from "../src/store.js";
import { logSlotKey } from "../src/dedup.js";
import { collectFindings, groupFindings, isSelfReferential, runAudit } from "../src/audit.js";
import { applyProposal, listProposals, pruneProposal } from "../src/proposals.js";
import { formatFact, preferNewestPerSlot } from "../src/retrieve.js";

const dirs = [];
function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "fm-audit-"));
  dirs.push(dir);
  return MemoryStore.open({ dataDir: dir });
}
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may hold the WAL handle briefly */
    }
  }
});

const BACKUP_A = "OK    D:\\DSH\\backup\\cordis-patch\\cordis.patch.20261113-000036.yml";
const BACKUP_B = "OK    D:\\DSH\\backup\\cordis-patch\\cordis.patch.20261109-000023.yml";
const BACKUP_C = "OK    D:\\DSH\\backup\\cordis-patch\\cordis.patch.20261101-232418.yml";

const factCount = (store) => Number(store.db.prepare("SELECT COUNT(*) AS count FROM facts").get().count);
const entityId = (store, name) => store.db.prepare("SELECT id FROM entities WHERE name = ?").get(name)?.id ?? "";

/**
 * Rows from a library written before write-time folding existed — the shape the
 * health check is the safety net for. The fold is switched off for exactly this
 * write so the seed produces the rows the audit is meant to find.
 */
function writeWithoutFolding(store, input) {
  const slotFold = store.foldLogSlotInSlot;
  const rowFold = store.foldLogSlot;
  store.foldLogSlotInSlot = () => null;
  store.foldLogSlot = () => null;
  try {
    return store.writeFact(input);
  } finally {
    store.foldLogSlotInSlot = slotFold;
    store.foldLogSlot = rowFold;
  }
}

test("a log slot is the value with its one date blanked out, and nothing else", () => {
  assert.equal(logSlotKey(BACKUP_A), logSlotKey(BACKUP_B));
  assert.ok(logSlotKey(BACKUP_A));
  // The guard rails: a different number is a different fact, not another run.
  assert.equal(logSlotKey("187"), null);
  assert.equal(logSlotKey("188"), null);
  assert.equal(logSlotKey("port 7801"), null);
  assert.equal(logSlotKey("2026-11-13"), null);
});

test("the second run of the same job folds into the row instead of adding one", () => {
  const store = freshStore();
  const base = { entity: { name: "dsh", type: "project" }, predicate: "备份结果", cardinality: "single" };
  const first = store.writeFact({ ...base, value: BACKUP_A, observedAt: "2026-11-13T00:00:00.000Z" });
  assert.equal(first.status, "inserted");
  const second = store.writeFact({ ...base, value: BACKUP_B, observedAt: "2026-11-14T00:00:00.000Z" });
  assert.equal(second.status, "folded");
  assert.equal(second.fact.id, first.fact.id);
  assert.equal(second.fact.foldedCount, 1);
  assert.equal(factCount(store), 1);
  const page = formatFact(second.fact, { withId: false });
  assert.match(page, /2026-11-14/, "the row carries the newest run's date");
  assert.match(page, /共 2 次/, "and the number of runs behind it");
});

test("a pipeline written with cardinality unknown folds at write time, not six hours later", () => {
  const store = freshStore();
  // Extracted facts default to "unknown", and that is what most of a real library
  // holds — so a fold that only understood single-valued slots almost never fired,
  // and every pipeline waited for the health check.
  const base = { entity: { name: "dsh", type: "project" }, predicate: "备份结果", cardinality: "unknown" };
  const first = store.writeFact({ ...base, value: BACKUP_A, observedAt: "2026-11-13T00:00:00.000Z" });
  const second = store.writeFact({ ...base, value: BACKUP_B, observedAt: "2026-11-14T00:00:00.000Z" });
  assert.equal(second.status, "folded");
  assert.equal(second.fact.id, first.fact.id);
  assert.equal(second.fact.foldedCount, 1);
  assert.equal(factCount(store), 1);
});

test("within one slot the newest value is read first, and unrelated slots keep their rank", () => {
  const store = freshStore();
  const multi = { entity: { name: "dsh", type: "project" }, predicate: "端口", cardinality: "multi" };
  const oldest = store.writeFact({ ...multi, value: "7801", observedAt: "2026-11-01T00:00:00.000Z" });
  const middle = store.writeFact({ ...multi, value: "7803", observedAt: "2026-11-03T00:00:00.000Z" });
  const newest = store.writeFact({ ...multi, value: "7802", observedAt: "2026-11-05T00:00:00.000Z" });
  const other = store.writeFact({
    entity: { name: "user", type: "person" },
    predicate: "时区",
    value: "Asia/Shanghai",
    cardinality: "single",
  });
  const ordered = preferNewestPerSlot(store, [oldest.fact.id, other.fact.id, newest.fact.id, middle.fact.id]);
  assert.deepEqual(ordered, [newest.fact.id, middle.fact.id, oldest.fact.id, other.fact.id]);
});

test("the health check proves its three findings and files one proposal per class", () => {
  const store = freshStore();
  // 1. the value only restates the predicate
  store.writeFact({ entity: { name: "dsh-fact-memory", type: "project" }, predicate: "上线状态", value: "上线状态", cardinality: "single" });
  // 2. one recurring job already written as three rows
  const pipeline = { entity: { name: "dsh", type: "project" }, predicate: "备份结果", cardinality: "multi" };
  writeWithoutFolding(store, { ...pipeline, value: BACKUP_A, observedAt: "2026-11-13T00:00:00.000Z" });
  writeWithoutFolding(store, { ...pipeline, value: BACKUP_B, observedAt: "2026-11-09T00:00:00.000Z" });
  writeWithoutFolding(store, { ...pipeline, value: BACKUP_C, observedAt: "2026-11-01T00:00:00.000Z" });
  // 3. one subject split across two spellings
  store.writeFact({ entity: { name: "dsh-fact-memory插件", type: "project" }, predicate: "路径", value: "/srv/fm", cardinality: "single" });
  store.writeFact({ entity: { name: "dsh-fact-memory插件", type: "project" }, predicate: "版本", value: "0.3.0", cardinality: "single" });
  store.writeFact({ entity: { name: "DSH 插件 dsh-fact-memory", type: "project" }, predicate: "安装方式", value: "link", cardinality: "single" });

  const findings = collectFindings(store);
  const kinds = new Set(findings.map((finding) => finding.kind));
  assert.ok(kinds.has("self_referential"), "the self-restating value is found");
  assert.ok(kinds.has("log_pipeline"), "the pipeline is found");
  assert.ok(kinds.has("entity_fragment"), "the second spelling is found");
  assert.equal(isSelfReferential("端口", "8080"), false, "a short value under a property is not a restatement");

  const grouped = groupFindings(findings);
  assert.ok(grouped.every((group) => group.details.length > 0 && group.title && group.reason));

  const run = runAudit({ store });
  assert.equal(run.status, "ok");
  assert.ok(run.findings >= 3);
  assert.ok(run.proposals >= 1);
  const filed = listProposals(store).filter((proposal) => proposal.kind === "audit");
  assert.ok(filed.length >= 1);
  assert.ok(filed.every((proposal) => proposal.targets.length > 0));

  // Idempotent: an unchanged library does not queue the same card twice.
  const again = runAudit({ store });
  assert.equal(again.proposals, 0);
  assert.ok(again.duplicates >= 1);
  assert.equal(listProposals(store).filter((proposal) => proposal.kind === "audit").length, filed.length);
});

test("accepting a health-check card retires, folds or merges the whole batch", () => {
  const store = freshStore();
  store.writeFact({ entity: { name: "dsh-fact-memory", type: "project" }, predicate: "上线状态", value: "上线状态", cardinality: "single" });
  const pipeline = { entity: { name: "dsh", type: "project" }, predicate: "备份结果", cardinality: "multi" };
  writeWithoutFolding(store, { ...pipeline, value: BACKUP_A, observedAt: "2026-11-13T00:00:00.000Z" });
  writeWithoutFolding(store, { ...pipeline, value: BACKUP_B, observedAt: "2026-11-09T00:00:00.000Z" });
  writeWithoutFolding(store, { ...pipeline, value: BACKUP_C, observedAt: "2026-11-01T00:00:00.000Z" });
  store.writeFact({ entity: { name: "dsh-fact-memory插件", type: "project" }, predicate: "路径", value: "/srv/fm", cardinality: "single" });
  store.writeFact({ entity: { name: "DSH 插件 dsh-fact-memory", type: "project" }, predicate: "版本", value: "0.3.0", cardinality: "single" });
  runAudit({ store });
  const byAction = (action) => listProposals(store).find((proposal) => proposal.kind === "audit" && proposal.action === action);

  const retire = byAction("retire");
  assert.ok(retire, "a retire card was filed");
  const retired = applyProposal(store, { proposalId: retire.id });
  assert.equal(retired.status, "applied");
  assert.equal(retired.written, "expired");
  assert.equal(store.getFact(retire.targets[0].factId).status, "expired", "the row is retired, not deleted");

  const fold = byAction("fold_log");
  assert.ok(fold, "a fold card was filed");
  const keepTarget = fold.targets.find((target) => target.role === "keep");
  const dropTargets = fold.targets.filter((target) => target.role !== "keep");
  assert.ok(keepTarget && dropTargets.length >= 1);
  const folded = applyProposal(store, { proposalId: fold.id });
  assert.equal(folded.status, "applied");
  assert.equal(folded.written, "folded");
  assert.equal(store.getFact(keepTarget.factId).status, "active", "the newest run stays live");
  for (const target of dropTargets) assert.equal(store.getFact(target.factId).status, "superseded");

  const alias = byAction("alias");
  assert.ok(alias, "an alias card was filed");
  const canonicalTarget = alias.targets.find((target) => target.role === "canonical");
  const fragment = alias.targets.find((target) => target.role === "alias");
  const applied = applyProposal(store, { proposalId: alias.id });
  assert.equal(applied.status, "applied");
  const merged = store.getEntity(fragment.entityId);
  assert.equal(merged.status, "merged");
  assert.ok(
    JSON.parse(store.getEntity(canonicalTarget.entityId).aliases || "[]").includes(fragment.name),
    "the surviving subject learned the other spelling",
  );
});

test("a row can be struck out of an aggregated card before it is accepted", () => {
  const store = freshStore();
  const pipeline = { entity: { name: "dsh", type: "project" }, predicate: "备份结果", cardinality: "multi" };
  writeWithoutFolding(store, { ...pipeline, value: BACKUP_A, observedAt: "2026-11-13T00:00:00.000Z" });
  writeWithoutFolding(store, { ...pipeline, value: BACKUP_B, observedAt: "2026-11-09T00:00:00.000Z" });
  writeWithoutFolding(store, { ...pipeline, value: BACKUP_C, observedAt: "2026-11-01T00:00:00.000Z" });
  runAudit({ store });
  const fold = listProposals(store).find((proposal) => proposal.kind === "audit" && proposal.action === "fold_log");
  const keepTarget = fold.targets.find((target) => target.role === "keep");
  const dropTargets = fold.targets.filter((target) => target.role !== "keep");

  // The row that carries the surviving value is what the fold is for.
  assert.equal(pruneProposal(store, { proposalId: fold.id, dropFactIds: [keepTarget.factId] }).status, "refused");
  assert.equal(pruneProposal(store, { proposalId: fold.id, dropFactIds: ["nope"] }).status, "refused");

  const pruned = pruneProposal(store, { proposalId: fold.id, dropFactIds: [dropTargets[0].factId] });
  assert.equal(pruned.status, "ok");
  assert.equal(pruned.dropped, 1);
  assert.equal(pruned.proposal.targets.length, fold.targets.length - 1);
  assert.equal(pruned.proposal.revision, fold.revision + 1);

  const applied = applyProposal(store, { proposalId: fold.id });
  assert.equal(applied.status, "applied");
  assert.equal(store.getFact(dropTargets[0].factId).status, "active", "the struck-out row was left alone");
  assert.equal(store.getFact(dropTargets[1].factId).status, "superseded");
});

test("every batch of an aggregated card carries its own rows and its own keep", () => {
  // Two pipelines under one subject, both longer than the per-card limit, so the
  // card is split. Every chunk must describe the rows it actually lists.
  const findings = [];
  for (const [predicate, prefix] of [["备份结果", "a"], ["同步结果", "b"]]) {
    const details = Array.from({ length: 4 }, (_, index) => ({
      factId: `${prefix}${index}`,
      recordRevision: 1,
      value: `OK ${prefix}${index}`,
      observedAt: `2026-11-0${index + 1}T00:00:00.000Z`,
    }));
    findings.push({ kind: "log_pipeline", action: "fold_log", entity: "dsh", entityId: "e1", predicate, scope: "global", details });
  }
  const cards = groupFindings(findings, { maxDetailsPerProposal: 3 });
  assert.equal(cards.length, 4, "two pipelines split into two batches each");
  for (const card of cards) {
    const ids = new Set(card.targets.map((target) => target.factId));
    for (const detail of card.details) assert.ok(ids.has(detail.factId), "the target list describes this batch");
    assert.equal(card.targets.length, card.details.length, "no target from another batch leaks in");
    assert.equal(card.targets.filter((target) => target.role === "keep").length, 1, "each batch keeps exactly one row");
    const keep = card.targets.find((target) => target.role === "keep");
    const newest = [...card.details].sort((left, right) => String(right.observedAt).localeCompare(String(left.observedAt)))[0];
    assert.equal(keep.factId, newest.factId, "the newest run in this batch is the survivor");
  }
});

test("two findings about one subject produce targets for both, not just the first", () => {
  const findings = [
    { kind: "entity_fragment", action: "alias", entity: "dsh-fact-memory插件", entityId: "e1", predicate: "实体别名", scope: "global", details: [{ entityId: "e2", name: "dsh-fact-memory", facts: 2 }] },
    { kind: "entity_fragment", action: "alias", entity: "dsh-fact-memory插件", entityId: "e1", predicate: "实体别名", scope: "global", details: [{ entityId: "e3", name: "DSH 插件 dsh-fact-memory", facts: 1 }] },
  ];
  const [card] = groupFindings(findings);
  assert.equal(card.targets.length, 3, "one canonical row plus one alias row per detail");
  assert.deepEqual(card.targets.map((target) => target.role), ["canonical", "alias", "alias"]);
  assert.deepEqual(card.targets.slice(1).map((target) => target.entityId), ["e2", "e3"]);
});

test("a row that changed after the sweep is skipped instead of failing the whole card", () => {
  const store = freshStore();
  const pipeline = { entity: { name: "dsh", type: "project" }, predicate: "备份结果", cardinality: "multi" };
  writeWithoutFolding(store, { ...pipeline, value: BACKUP_A, observedAt: "2026-11-13T00:00:00.000Z" });
  writeWithoutFolding(store, { ...pipeline, value: BACKUP_B, observedAt: "2026-11-09T00:00:00.000Z" });
  writeWithoutFolding(store, { ...pipeline, value: BACKUP_C, observedAt: "2026-11-01T00:00:00.000Z" });
  runAudit({ store });
  const fold = listProposals(store).find((proposal) => proposal.kind === "audit" && proposal.action === "fold_log");
  const dropTargets = fold.targets.filter((target) => target.role !== "keep");
  const touched = dropTargets[0].factId;
  store.db.prepare("UPDATE facts SET record_revision = record_revision + 1 WHERE id = ?").run(touched);

  const applied = applyProposal(store, { proposalId: fold.id });
  assert.equal(applied.status, "applied", "the untouched rows are still folded");
  assert.equal(applied.skippedStale, 1);
  assert.equal(store.getFact(touched).status, "active", "the changed row is left alone");
  assert.equal(store.getFact(dropTargets[1].factId).status, "superseded");
});

test("a fold card refuses instead of claiming success when no merge lands", () => {
  const store = freshStore();
  const pipeline = { entity: { name: "dsh", type: "project" }, predicate: "备份结果", cardinality: "multi" };
  writeWithoutFolding(store, { ...pipeline, value: BACKUP_A, observedAt: "2026-11-13T00:00:00.000Z" });
  writeWithoutFolding(store, { ...pipeline, value: BACKUP_B, observedAt: "2026-11-09T00:00:00.000Z" });
  writeWithoutFolding(store, { ...pipeline, value: BACKUP_C, observedAt: "2026-11-01T00:00:00.000Z" });
  runAudit({ store });
  const fold = listProposals(store).find((proposal) => proposal.kind === "audit" && proposal.action === "fold_log");
  // Every drop target stops being live between the sweep and the click.
  for (const target of fold.targets.filter((entry) => entry.role !== "keep")) {
    store.db.prepare("UPDATE facts SET status = 'expired' WHERE id = ?").run(target.factId);
  }
  const applied = applyProposal(store, { proposalId: fold.id });
  assert.equal(applied.status, "refused");
  assert.equal(applied.reason, "merge_failed");
  const still = listProposals(store).find((proposal) => proposal.id === fold.id);
  assert.equal(still.status, "pending", "a refused card stays in the queue");
});

test("the survivor of a folded card remembers how many runs it absorbed", () => {
  const store = freshStore();
  const pipeline = { entity: { name: "dsh", type: "project" }, predicate: "备份结果", cardinality: "multi" };
  writeWithoutFolding(store, { ...pipeline, value: BACKUP_A, observedAt: "2026-11-13T00:00:00.000Z" });
  writeWithoutFolding(store, { ...pipeline, value: BACKUP_B, observedAt: "2026-11-09T00:00:00.000Z" });
  writeWithoutFolding(store, { ...pipeline, value: BACKUP_C, observedAt: "2026-11-01T00:00:00.000Z" });
  runAudit({ store });
  const fold = listProposals(store).find((proposal) => proposal.kind === "audit" && proposal.action === "fold_log");
  const keep = fold.targets.find((target) => target.role === "keep");
  const applied = applyProposal(store, { proposalId: fold.id });
  assert.equal(applied.status, "applied");
  assert.equal(applied.foldedCount, 2, "two older runs were absorbed");
  const survivor = store.getFact(keep.factId);
  assert.equal(survivor.foldedCount, 2);
  assert.match(formatFact(survivor, { withId: false }), /共 3 次/);
});

test("an alias card refuses when the fragment disappeared after the sweep", () => {
  const store = freshStore();
  store.writeFact({ entity: { name: "dsh-fact-memory插件", type: "project" }, predicate: "路径", value: "/srv/fm", cardinality: "single" });
  store.writeFact({ entity: { name: "DSH 插件 dsh-fact-memory", type: "project" }, predicate: "版本", value: "0.3.0", cardinality: "single" });
  runAudit({ store });
  const alias = listProposals(store).find((proposal) => proposal.kind === "audit" && proposal.action === "alias");
  const fragment = alias.targets.find((target) => target.role === "alias");
  const canonical = alias.targets.find((target) => target.role === "canonical");
  store.db.prepare("DELETE FROM facts WHERE entity_id = ?").run(fragment.entityId);
  store.db.prepare("DELETE FROM entities WHERE id = ?").run(fragment.entityId);

  const applied = applyProposal(store, { proposalId: alias.id });
  assert.equal(applied.status, "refused");
  assert.equal(applied.reason, "entity_missing");
  assert.equal(JSON.parse(store.getEntity(canonical.entityId).aliases || "[]").length, 0, "no alias was written");
});

