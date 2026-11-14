import assert from "node:assert/strict";
import { test } from "node:test";
import { isQuestion, judgeEntity, judgeFact, judgePredicate, judgeValue, plausibleSubject } from "../src/quality.js";

test("judgeEntity: real subjects pass", () => {
  for (const name of ["api", "user", "dsh-fact-memory", "DSH Fact Memory", "订单服务", "BAAI/bge-m3"]) {
    assert.equal(judgeEntity(name).ok, true, name);
  }
});

test("judgeEntity: sentence fragments are refused with a reason", () => {
  assert.equal(judgeEntity("对于记忆图谱，我").reason, "entity_has_punctuation");
  assert.equal(judgeEntity("ASSISTANT: 发现了一个真实").reason, "entity_has_punctuation");
  assert.equal(judgeEntity("上面").reason, "entity_discourse_head");
  assert.equal(judgeEntity("结论").reason, "entity_discourse_head");
  assert.equal(judgeEntity("核心闭环能用了").reason, "entity_fragment_tail");
  assert.equal(judgeEntity("8080").reason, "entity_is_number");
  assert.equal(judgeEntity("").reason, "entity_empty");
});

test("judgePredicate: short property names only", () => {
  assert.equal(judgePredicate("端口").ok, true);
  assert.equal(judgePredicate("记录格式说明").ok, true);
  assert.equal(judgePredicate("建议").reason, "predicate_is_conversation_meta");
  assert.equal(judgePredicate("是").reason, "predicate_too_short");
  assert.equal(judgePredicate("端口/地址").reason, "predicate_has_punctuation");
});

test("judgeValue: questions, orders and fillers are not values", () => {
  assert.equal(judgeValue("7801").ok, true);
  assert.equal(judgeValue("这个接口是做什么的？").reason, "value_is_question");
  assert.equal(judgeValue("请把端口改成 8080").reason, "value_is_request");
  assert.equal(judgeValue("好的").reason, "value_is_filler");
  assert.equal(judgeValue("a。b。c。").reason, "value_is_paragraph");
  assert.equal(judgeValue("x".repeat(241)).reason, "value_too_long");
});

test("judgeFact: cross-field shapes", () => {
  assert.equal(judgeFact({ entity: { name: "api" }, predicate: "端口", value: "7801" }).ok, true);
  assert.equal(judgeFact({ entity: { name: "api" }, predicate: "api", value: "7801" }).reason, "predicate_repeats_entity");
  assert.equal(judgeFact({ entity: "api", predicate: "名字", value: "API" }).reason, "value_repeats_entity");
});

test("plausibleSubject: known names and ASCII identifiers qualify, pronouns do not", () => {
  assert.equal(plausibleSubject("api"), true);
  assert.equal(plausibleSubject("dsh-fact-memory"), true);
  assert.equal(plausibleSubject("订单服务"), true);
  assert.equal(plausibleSubject("他"), false);
  assert.equal(plausibleSubject("我们的项目"), false);
  assert.equal(plausibleSubject("这个"), false);
  assert.equal(plausibleSubject("线上环境", { knownEntities: new Set(["线上环境"]) }), true);
});

test("judgePredicate: a change event is not a property", () => {
  // "新增/优化/修复" say what a commit did, not what is true now; they belong in a
  // changelog, and storing them as facts means the library grows with every edit.
  for (const predicate of ["新增", "增加", "删除", "移除", "优化", "修复", "重构", "改造", "更新", "升级", "迁移", "替换"]) {
    assert.equal(judgePredicate(predicate).reason, "predicate_is_change_event", predicate);
  }
  assert.equal(
    judgeFact({ entity: { name: "提取队列" }, predicate: "新增", value: "增加提取队列" }).reason,
    "predicate_is_change_event",
  );
  // A state noun after the verb makes it a property again: "上线状态" answers a
  // question about today, while "上线" only reports what a commit did.
  assert.equal(judgePredicate("上线状态").ok, true);
  assert.equal(judgePredicate("升级进度").ok, true);
  assert.equal(judgePredicate("上线时间").ok, true);
  assert.equal(judgeFact({ entity: { name: "dsh-fact-memory" }, predicate: "上线状态", value: "已正式上线" }).ok, true);
  assert.equal(judgePredicate("上线").reason, "predicate_is_change_event");
  // Property names are untouched — including the ones this rule must not eat.
  assert.equal(judgePredicate("默认图谱").ok, true);
  assert.equal(judgePredicate("自动刷新间隔").ok, true);
  assert.equal(judgePredicate("版本").ok, true);
});

test("isQuestion", () => {
  assert.equal(isQuestion("端口是多少？"), true);
  assert.equal(isQuestion("这样行吗"), true);
  assert.equal(isQuestion("端口是 8080"), false);
});
