/**
 * The fact-shape gate.
 *
 * One place decides whether a candidate triple is a fact at all, whoever proposed
 * it — a rule, the model, or a tool call. The failure it exists for is universal:
 * a sentence fragment becomes the "entity", a discourse marker ("上面",
 * "结论先说") becomes the subject, and the library fills with things that are not
 * facts. Anchoring the check in one module keeps the three write paths from
 * drifting apart.
 *
 * Precision over recall: a rejected true fact costs one memory, an accepted false
 * one costs the credibility of the whole library.
 */

import { isCjk } from "./util.js";

const MAX_ENTITY = 40;
const MAX_PREDICATE = 24;
const MAX_VALUE = 240;

/** Punctuation that can only occur inside a sentence, never inside a name. */
const PUNCT = /[，。；：、！？（）()【】「」『』《》“”‘’"':,;!?`*|]/;

/** Openers that mean the following text is discourse, not a subject. */
const HEAD =
  /^(?:上面|上边|上述|下面|下边|以下|其次|再次|首先|然后|接着|最后|于是|因此|所以|但是|不过|然而|而且|并且|另外|此外|同时|例如|比如|总之|综上|总结|结论|这里|这边|那里|那段|这段|那句话|这句话|本次|本轮|当前|现在|刚才|之前|后来|起初|原来|我们|咱们|我|你|您|他|她|它|这|那|该|其|此)/;

/** Word endings that make a "name" a clause tail. */
const TAIL = /(?:了|吗|呢|吧|啊|呀|嘛|呗|的)$/;

const NUMERIC = /^[\d\s.,:%+\-/]+$/;
const QUESTION = /^(?:什么|啥|怎么|怎样|如何|为什么|为啥|哪个|哪些|哪|几个|几个|多少|是不是|能不能|可不可以)$/;

/** Values that say nothing on their own. */
const FILLER = new Set(["是", "对", "好", "嗯", "可以", "可以了", "是的", "对的", "好的", "行", "没有", "无", "有"]);

/**
 * Predicates that name a change event, not a property. "新增" / "优化" say what a
 * commit did; they answer nothing later and grow with the changelog. A property
 * is "端口", "版本", "默认图谱" — stable, and true or false today.
 *
 * A change verb that carries a state noun is a property again: "上线状态" answers
 * "is it live yet" and "上线时间" answers "when", while "上线" on its own only
 * reports what a commit did. The compound form is the state the changelog was
 * standing in for, so the suffix wins.
 */
const CHANGE_HEAD =
  /^(?:新增|增加|添加|删除|移除|去掉|优化|改进|修复|重构|改造|调整|更新|升级|迁移|替换|上线|下线|实现)/;

const CHANGE_STATE = /(?:状态|情况|进度|阶段|结果|时间|日期|版本)$/;

/** Imperative openers: an instruction is a task, not a fact. */
const REQUEST_HEAD = /^(?:请|麻烦|帮我|帮忙|你帮|你看|看看|试一下|试试|能不能|可不可以|把[\u3400-\u9fff]+(?:改成|换成|删掉|加上|去掉))/;

/** Subjects that only exist because someone is talking about the conversation. */
const META = new Set([
  "用户", "助手", "模型", "对话", "内容", "文本", "原文", "示例", "例子", "格式", "说明",
  "开头", "结尾", "回答", "回复", "建议", "问题", "提示", "结论", "总结", "摘要",
  "上面", "下面", "以上", "以下", "前面", "后面", "这里", "那里", "这段", "那一段",
  "这句话", "那句话", "本次", "本轮", "当前", "现在", "刚才", "todo", "TODO",
]);

const chars = (text) => Array.from(text).length;
const fold = (text) => String(text ?? "").normalize("NFKC").toLowerCase().trim();

/** A subject name: short, noun-ish, not punctuation-bearing, not discourse. */
export function judgeEntity(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return { ok: false, reason: "entity_empty" };
  if (chars(text) > MAX_ENTITY) return { ok: false, reason: "entity_too_long" };
  if (PUNCT.test(text)) return { ok: false, reason: "entity_has_punctuation" };
  if (HEAD.test(text)) return { ok: false, reason: "entity_discourse_head" };
  if (TAIL.test(text)) return { ok: false, reason: "entity_fragment_tail" };
  if (NUMERIC.test(text)) return { ok: false, reason: "entity_is_number" };
  if (QUESTION.test(text)) return { ok: false, reason: "entity_is_question" };
  if (META.has(text)) return { ok: false, reason: "entity_is_conversation_meta" };
  if (!/[\p{L}\p{N}]/u.test(text)) return { ok: false, reason: "entity_not_word" };
  // A long Chinese "entity" that still contains pronouns is a clause, not a name.
  if (isCjk(text) && chars(text) >= 12 && /[了我你他她它们]/.test(text)) {
    return { ok: false, reason: "entity_sentence_fragment" };
  }
  return { ok: true };
}

/** A property name: short, punctuation-free, not a discourse word. */
export function judgePredicate(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return { ok: false, reason: "predicate_empty" };
  if (chars(text) > MAX_PREDICATE) return { ok: false, reason: "predicate_too_long" };
  if (chars(text) < 2) return { ok: false, reason: "predicate_too_short" };
  if (CHANGE_HEAD.test(text) && !CHANGE_STATE.test(text)) return { ok: false, reason: "predicate_is_change_event" };
  // A property name is one label: a separator such as "/" means two names were
  // joined ("端口/地址"), which would create a slot nobody can query.
  if (PUNCT.test(text) || text.includes("/")) return { ok: false, reason: "predicate_has_punctuation" };
  if (TAIL.test(text)) return { ok: false, reason: "predicate_fragment_tail" };
  if (QUESTION.test(text)) return { ok: false, reason: "predicate_is_question" };
  if (META.has(text)) return { ok: false, reason: "predicate_is_conversation_meta" };
  if (!/[\p{L}\p{N}]/u.test(text)) return { ok: false, reason: "predicate_not_word" };
  return { ok: true };
}

/** A value: concrete, short-ish, not a question, not an instruction to someone. */
export function judgeValue(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return { ok: false, reason: "value_empty" };
  if (chars(text) > MAX_VALUE) return { ok: false, reason: "value_too_long" };
  if (!/[\p{L}\p{N}]/u.test(text)) return { ok: false, reason: "value_not_word" };
  if (/[？?]\s*$/.test(text)) return { ok: false, reason: "value_is_question" };
  if (REQUEST_HEAD.test(text)) return { ok: false, reason: "value_is_request" };
  if (FILLER.has(text)) return { ok: false, reason: "value_is_filler" };
  // Three sentence terminators means a paragraph got smuggled into one value.
  if ((text.match(/[。！？!?]/g) ?? []).length >= 3) return { ok: false, reason: "value_is_paragraph" };
  return { ok: true };
}

/**
 * The whole gate. Reasons are stable strings so a caller can log them, count
 * them, or explain a refusal without re-deriving the rule.
 */
export function judgeFact(candidate) {
  const entity = String(candidate?.entity?.name ?? candidate?.entity ?? "").trim();
  const predicate = String(candidate?.predicate ?? "").trim();
  const value = String(candidate?.value ?? "").trim();
  const e = judgeEntity(entity);
  if (!e.ok) return e;
  const p = judgePredicate(predicate);
  if (!p.ok) return p;
  const v = judgeValue(value);
  if (!v.ok) return v;
  const entityKey = fold(entity);
  if (fold(value) === entityKey) return { ok: false, reason: "value_repeats_entity" };
  if (fold(predicate) === entityKey) return { ok: false, reason: "predicate_repeats_entity" };
  return { ok: true };
}

/**
 * Is this word a believable subject *outside* an explicit memory request? The
 * rule path uses it to stop "X 的 Y 是 Z" from firing on any sentence that
 * happens to contain the pattern: the subject must be a known entity, an ASCII
 * identifier, or a short name with no pronoun in it.
 */
export function plausibleSubject(raw, { knownEntities } = {}) {
  const text = String(raw ?? "").trim();
  if (text === "") return false;
  if (!judgeEntity(text).ok) return false;
  if (knownEntities && typeof knownEntities.has === "function" && knownEntities.has(fold(text))) return true;
  if (/^[A-Za-z][\w.@/\\-]{0,39}$/.test(text)) return true;
  if (chars(text) > 20) return false;
  if (/[我你他她它们]/.test(text)) return false;
  if (/^(?:这|那|该|其|此|本|每|各)/.test(text)) return false;
  return true;
}

/** True when the text is a bare question, so no fact can be read out of it. */
export function isQuestion(text) {
  const value = String(text ?? "").trim();
  if (value === "") return false;
  return /[？?]\s*$/.test(value) || /(?:吗|呢|么)\s*$/.test(value);
}

export const QUALITY_LIMITS = { MAX_ENTITY, MAX_PREDICATE, MAX_VALUE };
