import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { MemoryStore, overlapsInTime } from "../src/store.js";

const dirs = [];
function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "fm-time-"));
  dirs.push(dir);
  return { store: MemoryStore.open({ dataDir: dir }), dir };
}
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* disposable */
    }
  }
});

const fact = (overrides = {}) => ({
  entity: { name: "api", type: "service" },
  predicate: "端口",
  value: "8080",
  cardinality: "single",
  evidenceLevel: "explicit_user",
  observedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

test("a scheduled fact becomes active once its start arrives", () => {
  const { store } = freshStore();
  const written = store.writeFact(fact({ value: "9090", validFrom: "2027-03-01" }));
  assert.equal(written.fact.status, "scheduled");
  // Before the start nothing moves.
  assert.deepEqual(store.advanceTime("2027-02-01T00:00:00.000Z"), {
    expired: 0,
    promoted: 0,
    conflicts: 0,
    changed: 0,
  });
  const after = store.advanceTime("2027-03-02T00:00:00.000Z");
  assert.equal(after.promoted, 1);
  assert.equal(store.getFact(written.fact.id).status, "active");
  store.close();
});

test("a fact whose window closed expires and leaves the live set", () => {
  const { store } = freshStore();
  const written = store.writeFact(fact({ validTo: "2026-02-01" }));
  assert.equal(written.fact.status, "active");
  const moved = store.advanceTime("2026-02-02T00:00:00.000Z");
  assert.equal(moved.expired, 1);
  assert.equal(store.getFact(written.fact.id).status, "expired");
  assert.equal(store.listFacts({ status: "live" }).length, 0);
  assert.equal(store.listFacts({ status: "expired" }).length, 1);
  store.close();
});

test("a future-dated change ends the old value at its start, then takes over", () => {
  const { store } = freshStore();
  const now = store.writeFact(fact({ value: "8080" }));
  const planned = store.writeFact(fact({ value: "9090", validFrom: "2027-03-01" }));
  assert.equal(planned.fact.status, "scheduled");
  assert.equal(store.getFact(now.fact.id).validTo, "2027-03-01");
  assert.equal(store.stats().active, 1);
  const moved = store.advanceTime("2027-03-02T00:00:00.000Z");
  assert.equal(moved.expired, 1);
  assert.equal(moved.promoted, 1);
  assert.equal(moved.conflicts, 0);
  assert.equal(store.getFact(now.fact.id).status, "expired");
  assert.equal(store.getFact(planned.fact.id).status, "active");
  store.close();
});

test("a scheduled rival or an explicit overlap still opens a conflict", () => {
  const { store } = freshStore();
  const now = store.writeFact(fact({ value: "8080", validTo: "2027-06-01" }));
  const planned = store.writeFact(fact({ value: "9090", validFrom: "2027-03-01" }));
  assert.equal(planned.status, "conflict");
  assert.equal(store.getFact(now.fact.id).status, "conflict");
  assert.equal(store.stats().conflict, 2);
  store.close();
});

test("overlapping validity windows are adjudicated, not silently replaced", () => {
  const { store } = freshStore();
  store.writeFact(fact({ value: "8080", validFrom: "2026-01-01" }));
  const next = store.writeFact(fact({ value: "9090", validFrom: "2026-02-01" }));
  assert.equal(next.status, "conflict");
  assert.equal(store.stats().active, 0);
  assert.equal(store.stats().conflict, 2);
  store.close();
});

test("a present-tense update of an open window still replaces", () => {
  const { store } = freshStore();
  store.writeFact(fact({ value: "8080" }));
  const next = store.writeFact(fact({ value: "9090" }));
  assert.equal(next.status, "superseded");
  assert.equal(next.fact.status, "active");
  store.close();
});

test("overlapsInTime treats touching endpoints as disjoint", () => {
  const current = { validFrom: "2026-01-01", validTo: "2026-02-01" };
  const next = { validFrom: "2026-02-01", validTo: "2026-03-01" };
  assert.equal(overlapsInTime(current, next, "2026-02-01T00:00:00.000Z"), false);
  assert.equal(overlapsInTime(current, { validFrom: "2026-01-15" }, "2026-02-01T00:00:00.000Z"), true);
});

test("confirming multi keeps every side active and marks the slot multi-valued", () => {
  const { store } = freshStore();
  const first = store.writeFact(fact({ value: "8080" }));
  const rival = store.writeFact(fact({ value: "9090", evidenceLevel: "observed" }));
  const resolved = store.resolveConflict({ factId: rival.fact.id, decision: "multi" });
  assert.equal(resolved.status, "ok");
  assert.equal(resolved.active, 2);
  assert.equal(store.getFact(first.fact.id).status, "active");
  assert.equal(store.getFact(rival.fact.id).status, "active");
  assert.equal(store.getFact(first.fact.id).cardinality, "multi");
  assert.equal(store.stats().conflict, 0);
  store.close();
});

test("dropping a conflict expires every side", () => {
  const { store } = freshStore();
  const first = store.writeFact(fact({ value: "8080" }));
  const rival = store.writeFact(fact({ value: "9090", evidenceLevel: "observed" }));
  const resolved = store.resolveConflict({ factId: rival.fact.id, decision: "drop" });
  assert.equal(resolved.status, "ok");
  assert.equal(resolved.dropped, 2);
  assert.equal(store.getFact(first.fact.id).status, "expired");
  assert.equal(store.getFact(rival.fact.id).status, "expired");
  store.close();
});

test("the library view filters, and one slot keeps a readable history", () => {
  const { store } = freshStore();
  store.writeFact(fact({ value: "8080", observedAt: "2026-01-01T00:00:00.000Z" }));
  store.writeFact(fact({ value: "9090", observedAt: "2026-02-01T00:00:00.000Z" }));
  const live = store.listFacts({ status: "live" });
  assert.equal(live.length, 1);
  assert.equal(live[0].value, "9090");
  assert.equal(store.listFacts({ query: "9090" }).length, 1);
  const history = store.factHistory({ factId: live[0].id });
  assert.equal(history.rows.length, 2);
  assert.deepEqual(
    history.rows.map((row) => row.status),
    ["active", "superseded"],
  );
  store.close();
});

test("a user edit bumps the revision and a stale editor is refused", () => {
  const { store } = freshStore();
  const written = store.writeFact(fact({ value: "8080" }));
  const updated = store.updateFact({
    factId: written.fact.id,
    value: "9090",
    expectedRevision: written.fact.recordRevision,
  });
  assert.equal(updated.status, "ok");
  assert.equal(store.stats().active, 1);
  assert.equal(store.listFacts({ status: "live" })[0].value, "9090");
  const stale = store.updateFact({ factId: written.fact.id, value: "7070", expectedRevision: 1 });
  assert.equal(stale.status, "stale");
  store.close();
});

test("expiring a fact keeps the row and drops it from the live set", () => {
  const { store } = freshStore();
  const written = store.writeFact(fact());
  const expired = store.expireFact({ factId: written.fact.id });
  assert.equal(expired.status, "ok");
  assert.equal(expired.fact.status, "expired");
  assert.equal(store.listFacts({ status: "live" }).length, 0);
  store.close();
});
