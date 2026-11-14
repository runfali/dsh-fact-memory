import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFacts, isMemoryRequest, mentionedIdentifiers } from "../src/extract.js";

const one = (text) => extractFacts(text, { now: "2026-01-01T00:00:00.000Z" })[0];

test("strips the memory marker and extracts an explicit slot", () => {
  assert.equal(isMemoryRequest("记住：api 的端口是 8080"), true);
  const fact = one("记住：api 的端口是 8080");
  assert.equal(fact.entity.name, "api");
  assert.equal(fact.predicate, "端口");
  assert.equal(fact.value, "8080");
  assert.equal(fact.cardinality, "single");
  assert.equal(fact.evidenceLevel, "explicit_user");
});

test("reads preferences and negations on the user entity", () => {
  const preferred = one("我喜欢用 pnpm 管理依赖");
  assert.equal(preferred.entity.name, "user");
  assert.equal(preferred.predicate, "偏好");
  assert.match(preferred.value, /pnpm/);
  const avoided = one("我不用 yarn");
  assert.equal(avoided.predicate, "避免");
  assert.equal(avoided.value, "yarn");
});

test("a marker with no specific rule still becomes a note (never silently dropped)", () => {
  const note = one("以后都用 pnpm 装依赖");
  assert.equal(note.predicate, "备忘");
  assert.equal(note.value, "用 pnpm 装依赖");
});

test("plain chat yields nothing: precision over recall", () => {
  assert.deepEqual(extractFacts("今天天气不错，随便聊聊"), []);
  assert.deepEqual(extractFacts(""), []);
});

test("long identifiers survive into the candidate for mention-based recall", () => {
  const fact = one("记住：服务部署在 /srv/fact-memory 目录");
  assert.ok(fact);
  assert.ok(fact.identifiers.some((value) => value.includes("/srv/fact-memory")));
  assert.ok(mentionedIdentifiers("看下 /srv/fact-memory 和 https://example.com/x").length >= 2);
});

test("sentences longer than the cap are ignored rather than half-read", () => {
  const long = `记住：${"很长的内容".repeat(80)}`;
  assert.deepEqual(extractFacts(long), []);
});

// ── regression anchors: the fragments that really polluted the library ──
test("conversation fragments never become facts", () => {
  const junk = [
    "对于记忆图谱，我的建议是参考 https://github.com/hanhan9999999999999999999/dsh-memory-nebula 项目的星云图谱展示形式，看起来就高大上",
    "上面 记录格式说明 用 ## 用户 开头的是真人输入，ASSISTANT: 开头的是模型回复",
    "结论先说：**核心闭环能用了，但方案定义的「完整交付」还差四大块",
    "ASSISTANT: 发现了一个真实的 bug：jsx(type, props, key) 的第三个参数是 key",
  ];
  for (const text of junk) assert.deepEqual(extractFacts(text), [], text.slice(0, 24));
});

test("a subject rule needs a believable subject", () => {
  assert.deepEqual(extractFacts("他的建议是参考这个项目的做法"), []);
  const fact = extractFacts("dsh-fact-memory 的端口是 7801", { knownEntities: new Set(["dsh-fact-memory"]) })[0];
  assert.equal(fact.entity.name, "dsh-fact-memory");
  assert.equal(fact.predicate, "端口");
  assert.equal(fact.value, "7801");
});

test("a question is never a fact, even with a marker", () => {
  assert.deepEqual(extractFacts("记住：api 的端口是 8080 吗"), []);
});

test("a quoted phrase keeps its closing mark", () => {
  // Trimming every trailing 「」 cut this value after 跑 — an unmatched opening
  // mark that reads as a truncated value in both the detail pane and the history.
  const fact = extractFacts("页签上的数字是这四项之和，不打开页签也能看到「有没有东西在跑」。")[0];
  assert.equal(fact.entity.name, "页签上");
  assert.equal(fact.predicate, "数字");
  assert.equal(fact.value, "这四项之和，不打开页签也能看到「有没有东西在跑」");
});

test("a value that is entirely wrapped in quotes drops both marks", () => {
  const fact = extractFacts("记住：我的名字是「张三」")[0];
  assert.equal(fact.value, "张三");
});

test("without a marker one message yields at most one fact", () => {
  const facts = extractFacts("api 的端口是 8080。web 的端口是 9090。");
  assert.equal(facts.length, 1);
});
