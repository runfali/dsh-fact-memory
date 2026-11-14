import assert from "node:assert/strict";
import { test } from "node:test";
import { DEDUP_LIMITS, buildIdfFn, canonicalEntityKey, classifyPair, factTokens, tfidfCosine, vetoThetaFor, vetoFires } from "../src/dedup.js";

test("canonicalEntityKey folds spelling and role words, but not subject words", () => {
  assert.equal(canonicalEntityKey("DSH Fact Memory"), canonicalEntityKey("dsh-fact-memory插件"));
  assert.equal(canonicalEntityKey("dsh-fact-memory 项目"), canonicalEntityKey("dsh-fact-memory"));
  assert.notEqual(canonicalEntityKey("订单服务"), canonicalEntityKey("订单"));
  assert.notEqual(canonicalEntityKey("api"), canonicalEntityKey("web"));
  assert.equal(canonicalEntityKey("   "), "");
});

test("tfidfCosine is 1 for identical token bags and 0 for disjoint ones", () => {
  const idf = buildIdfFn([["a", "b"], ["c"], ["a", "d"]]);
  assert.equal(Math.round(tfidfCosine(["a", "b"], ["a", "b"], idf)), 1);
  assert.equal(tfidfCosine(["a"], ["c"], idf), 0);
});

test("the veto only fires on identifier-shaped tokens", () => {
  const idf = buildIdfFn([["端口", "7801"], ["端口", "7802"], ["项目", "完成"], ["服务", "启动"]]);
  // A rare ASCII token on one side means different things were said.
  assert.equal(vetoFires(["端口", "7801"], ["端口", "7802"], idf, vetoThetaFor(4)), true);
  // Chinese rewording must not be vetoed: the cosine is the judge there.
  assert.equal(vetoFires(["项目", "完成"], ["项目", "已完成"], idf, 0.5), false);
  // A date is a qualifier, not a discriminator.
  assert.equal(vetoFires(["完成", "2026-11-13"], ["完成", "2026-10-01"], idf, 0.1), false);
});

test("near-identical facts with different identifiers stay distinct", () => {
  const docs = [
    factTokens({ entity: "api", predicate: "端口", value: "7801" }),
    factTokens({ entity: "api", predicate: "端口", value: "7802" }),
    factTokens({ entity: "web", predicate: "端口", value: "8080" }),
    factTokens({ entity: "订单服务", predicate: "端口", value: "9000" }),
  ];
  const idf = buildIdfFn(docs);
  const verdict = classifyPair(docs[0], docs[1], idf, { ...DEDUP_LIMITS, cosineThreshold: 0.5, minSharedTokens: 2, docCount: docs.length });
  assert.equal(verdict.tier, "none");
});

test("rewording of one statement is a candidate", () => {
  const base = factTokens({ entity: "DSH Fact Memory", predicate: "首轮开发状态", value: "首轮开发完成，基础功能已实现（2026-11-13）" });
  const reworded = factTokens({ entity: "dsh-fact-memory插件", predicate: "开发状态", value: "首轮开发完成，基础功能已实现" });
  const docs = [
    base,
    reworded,
    factTokens({ entity: "DSH Fact Memory", predicate: "自动化测试状态", value: "58 个测试全部通过" }),
    factTokens({ entity: "DSH Fact Memory", predicate: "提案机制", value: "memory_write 支持 basis 和 confidence" }),
    factTokens({ entity: "DSH Fact Memory", predicate: "项目定位", value: "一个提供跨会话事实记忆的插件" }),
    factTokens({ entity: "user", predicate: "偏好", value: "用 pnpm 管理依赖" }),
    factTokens({ entity: "api", predicate: "端口", value: "7801" }),
  ];
  const idf = buildIdfFn(docs);
  const verdict = classifyPair(base, reworded, idf, { ...DEDUP_LIMITS, docCount: docs.length });
  assert.equal(verdict.tier, "candidate");
  assert.ok(verdict.score >= DEDUP_LIMITS.cosineThreshold);
});

test("an exact normal form merges even without a corpus", () => {
  const idf = buildIdfFn([]);
  assert.equal(classifyPair(["a", "b"], ["a", "b"], idf).tier, "exact");
  assert.equal(classifyPair([], [], idf).tier, "none");
});
