import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { MemoryStore } from "../src/store.js";
import { applyProposal, createProposal, getProposal, listProposals, rejectProposal, reviseProposal } from "../src/proposals.js";

const dirs = [];
function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "fm-proposal-"));
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

const proposalInput = (overrides = {}) => ({
  kind: "low_confidence",
  action: "create",
  entityName: "api",
  predicate: "端口",
  value: "8080",
  cardinality: "single",
  scope: "global",
  qualifiers: {},
  evidence: [{ kind: "model_inference" }],
  evidenceLevel: "unverified",
  confidence: 0.4,
  reason: "测试",
  ...overrides,
});

test("a proposal is created once, carries its diff, and applies into a fact", () => {
  const { store } = freshStore();
  const created = createProposal(store, proposalInput());
  assert.equal(created.status, "created");
  const again = createProposal(store, proposalInput());
  assert.equal(again.status, "duplicate");
  assert.equal(again.proposal.id, created.proposal.id);
  assert.equal(again.proposal.status, "pending");
  assert.equal(again.proposal.revision, 1);

  const listed = listProposals(store);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].value, "8080");

  const applied = applyProposal(store, { proposalId: created.proposal.id });
  assert.equal(applied.status, "applied");
  const fact = store.getFact(applied.factId);
  assert.equal(fact.value, "8080");
  assert.equal(fact.evidenceLevel, "confirmed_user");
  assert.equal(getProposal(store, created.proposal.id).status, "applied");

  // A double accept returns the first result instead of writing a second fact.
  const replay = applyProposal(store, { proposalId: created.proposal.id });
  assert.equal(replay.status, "already");
  assert.equal(replay.factId, applied.factId);
  assert.equal(store.stats().active, 1);
});

test("a proposal whose target changed after filing is stale, not applied", () => {
  const { store } = freshStore();
  const first = store.writeFact({
    entity: { name: "api", type: "service" },
    predicate: "端口",
    value: "8080",
    cardinality: "single",
    evidenceLevel: "explicit_user",
    observedAt: "2026-01-01T00:00:00.000Z",
  });
  const created = createProposal(
    store,
    proposalInput({
      action: "replace",
      value: "9090",
      targets: [{ factId: first.fact.id, recordRevision: 1, entity: "api", predicate: "端口", value: "8080" }],
    }),
  );
  // The user settles the slot while the proposal is waiting.
  store.writeFact({
    entity: { name: "api", type: "service" },
    predicate: "端口",
    value: "7070",
    cardinality: "single",
    evidenceLevel: "explicit_user",
    observedAt: "2026-02-01T00:00:00.000Z",
  });
  const applied = applyProposal(store, { proposalId: created.proposal.id });
  assert.equal(applied.status, "stale");
  assert.equal(applied.reason, "target_changed");
  assert.equal(getProposal(store, created.proposal.id).status, "stale");
  // The newer user value wins; the stale proposal did not overwrite it.
  const current = store.db.prepare("SELECT value_text FROM facts WHERE status = 'active'").get();
  assert.equal(current.value_text, "7070");
});

test("a forgotten claim cannot come back through a proposal", () => {
  const { store: second } = freshStore();
  const fact = second.writeFact({
    entity: { name: "api", type: "service" },
    predicate: "端口",
    value: "8080",
    cardinality: "single",
    evidenceLevel: "explicit_user",
  });
  const pending = createProposal(second, proposalInput({ value: "9090", action: "replace", targets: [{ factId: fact.fact.id, recordRevision: 1 }] }));
  second.forget({
    factId: fact.fact.id,
    scope: "global",
    reasonCode: "user_request",
    originStoreId: second.meta.storeId,
    namespace: "tool",
  });
  const applied = applyProposal(second, { proposalId: pending.proposal.id });
  assert.equal(applied.status, "stale");
  // The forgotten row still exists, so the fence sees a changed revision rather
  // than a missing target; either way the proposal may not write.
  assert.ok(["tombstoned", "target_missing", "target_changed"].includes(applied.reason));
  assert.equal(second.stats().active, 0);
});

test("reject is terminal and revise re-runs the fence on a new revision", () => {
  const { store } = freshStore();
  const created = createProposal(store, proposalInput({ value: "8080" }));
  const revised = reviseProposal(store, { proposalId: created.proposal.id, value: "8081" });
  assert.equal(revised.status, "revised");
  assert.equal(revised.proposal.revision, 2);
  assert.equal(revised.proposal.value, "8081");
  assert.equal(applyProposal(store, { proposalId: created.proposal.id }).status, "applied");
  assert.equal(store.db.prepare("SELECT value_text FROM facts WHERE status = 'active'").get().value_text, "8081");

  const other = createProposal(store, proposalInput({ predicate: "路径", value: "/srv/x" }));
  assert.equal(rejectProposal(store, { proposalId: other.proposal.id }).status, "rejected");
  assert.equal(applyProposal(store, { proposalId: other.proposal.id }).status, "rejected");
  assert.equal(rejectProposal(store, { proposalId: other.proposal.id }).status, "already");
});

test("accepting a proposal still applies the privacy gate", () => {
  const { store } = freshStore();
  const created = createProposal(store, proposalInput({ entityName: "user", predicate: "手机号", value: "13800138000" }));
  const applied = applyProposal(store, { proposalId: created.proposal.id });
  assert.equal(applied.status, "applied");
  const fact = store.getFact(applied.factId);
  assert.equal(fact.privacyClass, "sensitive");
  assert.equal(fact.modelUseAllowed, false);
});

test("revising one proposal onto another open value is refused, not a crash", () => {
  const { store } = freshStore();
  const first = createProposal(store, proposalInput({ value: "8080" }));
  const second = createProposal(store, proposalInput({ value: "9090" }));
  assert.equal(first.status, "created");
  assert.equal(second.status, "created");

  // Two open proposals may not carry the same value; the unique index would
  // otherwise surface as a 500 from the route.
  const result = reviseProposal(store, { proposalId: second.proposal.id, value: "8080" });
  assert.equal(result.status, "refused");
  assert.match(result.message, /待审提案/);
  assert.equal(getProposal(store, second.proposal.id).value, "9090");
});
