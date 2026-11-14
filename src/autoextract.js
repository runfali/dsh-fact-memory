/**
 * Automatic fact extraction (plan §E.1–E.3).
 *
 * The pipeline is deliberately conservative: a cheap local signal decides whether
 * the model is called at all, the model only sees the new raw text, its answer is
 * parsed and validated locally, and nothing is written as a fact unless the
 * candidate carries a quote that really occurs in the input. Low confidence and
 * inferred content become proposals instead of facts.
 */

import { judgeFact } from "./quality.js";
import { claimKeyOf, qualifierKey } from "./store.js";
import { casefold, normValue } from "./util.js";

/**
 * Signals that a passage is worth the model call. Two tiers, because a false
 * positive costs one refused model answer while a false negative is a fact the
 * user believes was remembered.
 *
 * 1. Durable cues — explicit memory requests, standing decisions/conventions,
 *    and preferences, in Chinese and English. Peer memory systems (Mem0,
 *    LangMem, Zep/Graphiti, Letta) ask the model on every turn or batch and let
 *    the prompt refuse small talk; this tier is the cheap version of that
 *    "worth asking at all" decision.
 * 2. Config binding — a property word bound to a value ("端口是 8080",
 *    "port is 9911"). The binding is required so ordinary dev chatter about
 *    "这个版本" does not buy a model call.
 */
const SIGNAL_DURABLE_ZH = /(记住|请记得|要记得|帮我记住|记一下|记下|记在|别忘了|存一下|保存一下|备注一下|以后都|以后用|下次|此后|今后|从此|往后|每次|约定|默认|总是|永远|永久|长期|一律|统一|固定|锁定|别再|不要再|不要用|不再用|不许|禁止|只能|必须|规定|规范|铁律|我们决定|决定了|决定用|改成|改用|换成|切成|迁移到|部署在|统一到|偏好|我喜欢|我不喜欢|讨厌|倾向于|宁可|习惯)/i;
const SIGNAL_DURABLE_EN = /\b(?:remember|memorize|note that|keep in mind|don'?t forget|make a note|from now on|going forward|in future|henceforth|always|never|every time|by default|defaults? to|permanently|we decided|decided to|agreed|convention|policy|prefer|preference|i like|i don'?t like|i hate|rather than|switch(?:ed)? to|migrat(?:e|ed|ing) to|deploy(?:ed|ing)? (?:on|to|at)|pin(?:ned)? to|no longer|use [\w./-]{1,30} instead)\b/i;
const SIGNAL_CONFIG = /((端口|路径|版本|地址|域名|仓库|分支|目录|密钥|账号|用户名)\s*(?:是|为|设为|改成|换成|改为|[:：=])\s*[^\s，。；！？]{2,80})|((端口|路径|版本|地址|域名|仓库|分支|目录)\s+\d{1,6})|(\b(?:port|path|version|endpoint|base url|url|repo|repository|branch|directory|token|account)\b\s*(?:is|are|was|set to|=|:)\s*[\w./:@-]{2,80})|(\b(?:port|path|version)\b\s+\d{1,6})/i;

const MAX_FACT_TEXT = 500;
const MAX_NAME = 80;

export const EXTRACT_SYSTEM = [
  "你是一个事实抽取器。只输出 JSON，不要解释。",
  '输出格式：{"facts":[{"entity":"","entityType":"person|project|host|service|convention","predicate":"","value":"","cardinality":"single|multi|unknown","confidence":0.0,"quote":""}]}',
  "抽取标准：只抽取「下一次会话仍然成立、并且真的会用到」的稳定陈述——事实、配置、决定、约定、偏好、约束。",
  "文本里可能同时有「用户：」与「助手：」。用户的话常是安排、提问或确认，本身不一定含事实；助手的话常是查完、改完之后的结论，事实更常出现在这里。",
  "助手明确报告「查到是 / 已改成 / 已部署 / 确认是」并带具体值的，可以作为事实；助手的建议、猜测、计划、对自己的复述（「我刚才说…」）不算事实，带「可能 / 建议 / 可以试试 / 如果要」的一律不抽。",
  "助手回复里的一次性运行时值（本次进程 PID、随机端口、临时目录、这条命令这次的输出）不算稳定事实；只抽长期配置、约定，或用户明确要求记住的内容。",
  "宁可漏，不可错：拿不准就不输出，空数组是合格答案。凑数抽出来的伪事实，比漏抽贵得多。",
  "entity 必须是稳定主体的名称：产品名、项目名、服务名、主机名、包名、文件名、人名，或 user。",
  "  · 只能是一个名词短语，不超过 20 字，不能含标点（，。；：、！？（）「」），不能含 ** 或反引号。",
  "  · 禁止把句子片段当 entity：不能以「上面/下面/结论/首先/其次/但是/不过/而且/另外/因此/所以/如果/我们/我/这/那」开头。",
  "  · 反例：结论先说：核心闭环能 ／ ASSISTANT: 发现了一个真实 ／ 对于记忆图谱，我 —— 输出这些就说明抽错了。",
  "predicate 是属性名，2~12 字，同样不能含标点、不能是整句或半句。",
  "value 必须是一个具体的值：号码、路径、版本、命令、地址、一句简短的结论；不超过 120 字。",
  "  · 禁止把整段总结、评价、建议、代码片段、对助手的指令当成 value。",
  "  · 疑问句、命令句、假设句都不是事实：「如果改成 8080」不是「端口是 8080」。",
  "不要抽取：寒暄、提问、对助手工作过程的描述与评价、模型自己的推断与建议、临时步骤、当前这次任务的中间状态、文件全文。",
  "否定、假设、过去式、计划态必须保留原意：例如「以前用 8080」不是「用 8080」；「如果改端口」不是「端口已改」。",
  "同一主体同一属性只输出一条；一条事实只表达一个属性。",
  "quote 必须是原文里逐字出现的一段话（不超过 80 字），用来核对证据；没有逐字依据就不要输出该条。",
  "confidence 是你对这条事实被正确抽取的把握（0 到 1）；拿不准就给低分，不要编造。",
  "如果没有值得记住的内容，输出 {\"facts\":[]}。",
  "注意：顶层必须是对象 {\"facts\":[...]}，不能是数组；键名必须用英文 entity / entityType / predicate / value / confidence / quote，不能用中文键名。",
  '正例：{"facts":[{"entity":"dsh-fact-memory","entityType":"project","predicate":"端口","value":"7801","cardinality":"single","confidence":0.9,"quote":"dsh-fact-memory 的端口是 7801"}]}',
  '反例（这样输出就是错的）：{"facts":[{"entity":"对于记忆图谱，我","predicate":"建议","value":"参考这个项目的星云图谱","confidence":0.5,"quote":"对于记忆图谱，我的建议是参考"}]}',
].join("\n");

/** Shape handed to endpoints that honour structured output. */
export const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["facts"],
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["entity", "entityType", "predicate", "value", "confidence", "quote"],
        properties: {
          entity: { type: "string" },
          entityType: { type: "string", enum: ["person", "project", "host", "service", "convention"] },
          predicate: { type: "string" },
          value: { type: "string" },
          cardinality: { type: "string", enum: ["single", "multi", "unknown"] },
          confidence: { type: "number" },
          quote: { type: "string" },
        },
      },
    },
  },
};

/** Second attempt after an unusable answer: reshape it, never re-invent facts. */
export function buildRepairPrompt({ previous, error, text }) {
  return [
    `你上一条回答不是约定的 JSON 对象（${error}）。`,
    "上一条回答：",
    String(previous ?? "").slice(0, 4000),
    "",
    "原文（quote 必须从这里面逐字复制）：",
    String(text ?? "").slice(0, 12_000),
    "",
    '请只输出这样的对象，不要数组、不要解释、不要中文键名：',
    '{"facts":[{"entity":"...","entityType":"project","predicate":"...","value":"...","cardinality":"single","confidence":0.8,"quote":"原文里逐字出现的一段"}]}',
    "上一条回答里没有逐字依据的条目直接丢掉。",
  ].join("\n");
}

export function buildExtractPrompt({ text, prior = "", maxFacts = 8, knownEntities = [] }) {
  const context = String(prior ?? "").trim();
  // Naming the subjects that already exist is the cheapest normalization lever we
  // have: the rules path already prefers a known name, and without the same hint
  // the model invents a second spelling for a subject it has seen before.
  const known = [...new Set((Array.isArray(knownEntities) ? knownEntities : []).map((name) => String(name ?? "").trim()))]
    .filter((name) => name !== "")
    .slice(0, 40);
  return [
    context === "" ? "" : `【上文，仅供参考，不要从中抽取】\n${context}\n`,
    known.length === 0 ? "" : `【已经记过的主体，能对上就逐字照抄，不要再造一个写法】\n${known.join("、").slice(0, 800)}\n`,
    "【待抽取文本】",
    String(text ?? ""),
    "",
    `最多输出 ${maxFacts} 条。只输出一个 JSON 对象，形如 {"facts":[{"entity":"","entityType":"project","predicate":"","value":"","confidence":0.0,"quote":"原文逐字片段"}]}；没有就输出 {"facts":[]}。`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Cheap prefilter: no cue, no model call. The fallback pass covers misses. */
export function shouldExtract(text) {
  const value = String(text ?? "").trim();
  if (value.length < 6) return false;
  return SIGNAL_DURABLE_ZH.test(value) || SIGNAL_DURABLE_EN.test(value) || SIGNAL_CONFIG.test(value);
}

/** Pull the first JSON object out of a model answer (fences tolerated). */
export function parseExtraction(raw) {
  const text = String(raw ?? "");
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  let slice = "";
  if (trimmed.startsWith("[") && arrayStart >= 0 && arrayEnd > arrayStart) slice = trimmed.slice(arrayStart, arrayEnd + 1);
  else if (start >= 0 && end > start) slice = trimmed.slice(start, end + 1);
  else return { ok: false, error: "model returned no JSON object" };
  let parsed;
  try {
    parsed = JSON.parse(slice);
  } catch (error) {
    return { ok: false, error: `model returned invalid JSON: ${error.message}` };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "model returned a non-object" };
  // A bare array is still a facts list: accept it instead of spending a repair.
  const facts = Array.isArray(parsed) ? parsed : parsed.facts;
  if (!Array.isArray(facts)) return { ok: false, error: "model output has no facts array" };
  return { ok: true, facts };
}

const collapse = (text) => casefold(text).replace(/\s+/g, " ").trim();

/**
 * Validate candidates against the input. A quote that does not occur verbatim in
 * the source is treated as a fabricated anchor and the candidate is dropped — the
 * plan forbids treating an invalid anchor as a partial success.
 */
export function normalizeCandidates(rawFacts, sourceText, { confidenceMin = 0.6 } = {}) {
  const haystack = collapse(sourceText);
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  for (const [index, item] of (Array.isArray(rawFacts) ? rawFacts : []).entries()) {
    if (!item || typeof item !== "object") {
      rejected.push({ index, reason: "not_an_object" });
      continue;
    }
    const entity = String(item.entity ?? "").trim();
    const predicate = String(item.predicate ?? "").trim();
    const value = String(item.value ?? "").trim();
    const quote = String(item.quote ?? "").trim();
    if (entity === "" || predicate === "" || value === "") {
      rejected.push({ index, reason: "missing_field" });
      continue;
    }
    if (entity.length > MAX_NAME || predicate.length > MAX_NAME || value.length > MAX_FACT_TEXT) {
      rejected.push({ index, reason: "too_long" });
      continue;
    }
    if (quote === "") {
      rejected.push({ index, reason: "no_quote" });
      continue;
    }
    if (!haystack.includes(collapse(quote))) {
      rejected.push({ index, reason: "quote_not_in_source" });
      continue;
    }
    // A verified quote proves the words were said, not that they form a fact. The
    // same shape gate the rule path uses runs here, which is what stops
    // "上面 · 记录格式说明" or "结论先说：核心闭环能 · 使用" from being stored.
    const shape = judgeFact({ entity: { name: entity }, predicate, value });
    if (!shape.ok) {
      rejected.push({ index, reason: shape.reason });
      continue;
    }
    const cardinality = ["single", "multi", "unknown"].includes(item.cardinality) ? item.cardinality : "unknown";
    const confidence = Math.max(0, Math.min(1, Number(item.confidence ?? 0.5)));
    // Must stay within the facts table's CHECK set, or the write fails at SQLite.
    const entityType = ["person", "project", "host", "service", "convention"].includes(item.entityType) ? item.entityType : "project";
    const key = claimKeyOf({ entityName: entity, predicate, value });
    if (seen.has(key)) {
      rejected.push({ index, reason: "duplicate_in_batch" });
      continue;
    }
    seen.add(key);
    accepted.push({
      entity: { name: entity, type: entityType },
      predicate,
      value,
      cardinality,
      confidence,
      quote: quote.slice(0, 200),
      evidenceLevel: confidence >= confidenceMin ? "observed" : "inferred",
      // Inferred content is never auto-stored: it becomes a proposal.
      pendingOnly: confidence < confidenceMin,
    });
  }
  return { candidates: accepted, rejected };
}

/**
 * Split long text into extraction chunks. Each chunk keeps the whole user message
 * it came from; the caller advances the cursor only past included messages.
 */
export function packChunks(items, { maxChars = 24_000 } = {}) {
  const chunks = [];
  const SEP = "\n---\n";
  // One pasted log must not become one enormous prompt: a single message is cut
  // at the same budget as a whole chunk, with a marker saying so.
  const limit = Number(maxChars) > 0 ? Number(maxChars) : 24_000;
  let current = { text: "", items: [] };
  for (const item of items) {
    let text = String(item.text ?? "").trim();
    if (text === "") continue;
    if (text.length > limit) text = `${text.slice(0, limit - 24)}\n（本条消息过长，已截断）`;
    if (current.text !== "" && current.text.length + text.length + SEP.length > limit) {
      chunks.push(current);
      current = { text: "", items: [] };
    }
    current.text = current.text === "" ? text : `${current.text}${SEP}${text}`;
    current.items.push(item);
    if (current.text.length >= limit) {
      chunks.push(current);
      current = { text: "", items: [] };
    }
  }
  if (current.text !== "") chunks.push(current);
  return chunks;
}

// ── merging chunks ────────────────────────────────────────────────────────

/** One candidate per claim, regardless of which chunk produced it. */
export function mergeCandidates(candidates) {
  const byKey = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    // Dedupe on the full claim *including* the value: `claimKeyOf` drops the
    // value for single-cardinality slots, which would silently swallow a real
    // contradiction between two chunks.
    const key = [
      casefold(candidate.entity.name),
      casefold(candidate.predicate),
      qualifierKey(candidate.qualifiers ?? {}),
      normValue(candidate.value),
    ].join("\u0000");
    const existing = byKey.get(key);
    if (existing) {
      existing.sources = [...new Set([...(existing.sources ?? []), ...(candidate.sources ?? [])])];
      existing.confidence = Math.max(Number(existing.confidence ?? 0), Number(candidate.confidence ?? 0));
      if (candidate.quote && !(existing.quotes ?? []).includes(candidate.quote)) {
        existing.quotes = [...(existing.quotes ?? []), candidate.quote].slice(0, 3);
      }
      continue;
    }
    byKey.set(key, {
      ...candidate,
      sources: [...new Set(candidate.sources ?? [])],
      quotes: candidate.quote ? [candidate.quote] : [],
    });
  }
  // Same subject and predicate with different values is a contradiction the
  // caller must surface (conflict or proposal), never something to silently pick.
  const slots = new Map();
  for (const candidate of byKey.values()) {
    const slot = `${casefold(candidate.entity.name)}\u0000${casefold(candidate.predicate)}`;
    const values = slots.get(slot) ?? new Set();
    values.add(normValue(candidate.value));
    slots.set(slot, values);
  }
  const collisions = [...slots.entries()]
    .filter(([, values]) => values.size > 1)
    .map(([slot, values]) => ({ slot, values: [...values] }));
  return { candidates: [...byKey.values()], duplicates: candidates.length - byKey.size, collisions };
}

export const MERGE_SYSTEM = [
  "你是一个事实候选的合并器。输入是同一段对话被分段抽取出的候选事实，编号从 0 开始。",
  "你的任务是合并重复项、把同一主体同一属性的不同表述归一，并去掉明显无价值的候选。",
  "硬性规则：",
  "1. 输出必须是 JSON：{\"facts\":[{\"entity\":\"\",\"predicate\":\"\",\"value\":\"\",\"sources\":[0,2],\"confidence\":0.8}]}。",
  "2. 每条输出的 entity / predicate / value 必须逐字来自 sources 指向的某条候选，禁止改写、概括或发明新事实。",
  "3. 数值冲突（同一属性两个不同值）不要自行裁决：保留两条，各自带自己的 sources。",
  "4. 只输出 JSON，不要解释。",
].join("\n");

/** Structured-output shape for the merge call: sources are mandatory here. */
export const MERGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["facts"],
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["entity", "predicate", "value", "sources"],
        properties: {
          entity: { type: "string" },
          predicate: { type: "string" },
          value: { type: "string" },
          sources: { type: "array", items: { type: "integer" } },
          confidence: { type: "number" },
        },
      },
    },
  },
};

export function buildMergePrompt({ candidates }) {
  const lines = candidates.map((candidate, index) =>
    `${index}. entity=${candidate.entity.name} | predicate=${candidate.predicate} | value=${candidate.value} | confidence=${candidate.confidence ?? 0.5}`,
  );
  return `【候选事实】\n${lines.join("\n")}\n\n合并后请输出 JSON。`;
}

/**
 * Validate a merge answer against the candidates it was given. Any invented
 * field, out-of-range source, or empty source list makes the whole answer
 * unusable — the deterministic merge is then kept instead.
 */
export function parseMerge(raw, candidates) {
  const text = String(raw ?? "");
  const trimmed = text.trim();
  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  const slice = trimmed.startsWith("[") && arrayStart >= 0 && arrayEnd > arrayStart
    ? trimmed.slice(arrayStart, arrayEnd + 1)
    : start >= 0 && end > start
      ? trimmed.slice(start, end + 1)
      : "";
  if (slice === "") return { ok: false, error: "no JSON object" };
  let parsed;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  // Some models answer with the bare array instead of the wrapper object; that
  // is still a facts list, so accept it rather than burning a repair call.
  const facts = Array.isArray(parsed) ? parsed : parsed?.facts;
  if (!Array.isArray(facts)) return { ok: false, error: "missing facts array" };
  const merged = [];
  for (const entry of facts) {
    const sources = Array.isArray(entry?.sources) ? entry.sources : [];
    if (sources.length === 0) return { ok: false, error: "empty sources" };
    if (sources.some((index) => !Number.isInteger(index) || index < 0 || index >= candidates.length)) {
      return { ok: false, error: "source out of range" };
    }
    const referenced = sources.map((index) => candidates[index]);
    const matches = (field, value) => referenced.some((candidate) =>
      (field === "entity" ? casefold(candidate.entity.name) : field === "predicate" ? casefold(candidate.predicate) : normValue(candidate.value)) ===
      (field === "entity" || field === "predicate" ? casefold(String(value ?? "")) : normValue(String(value ?? ""))),
    );
    if (!matches("entity", entry.entity)) return { ok: false, error: "entity not in sources" };
    if (!matches("predicate", entry.predicate)) return { ok: false, error: "predicate not in sources" };
    if (!matches("value", entry.value)) return { ok: false, error: "value not in sources" };
    const base = referenced[0];
    merged.push({
      ...base,
      entity: { ...base.entity, name: String(entry.entity) },
      predicate: String(entry.predicate),
      value: String(entry.value),
      confidence: Math.max(0, Math.min(1, Number(entry.confidence ?? base.confidence ?? 0.5))),
      sources: [...new Set(sources.flatMap((index) => candidates[index].sources ?? []))],
      quotes: [...new Set(sources.flatMap((index) => candidates[index].quotes ?? []))].slice(0, 3),
    });
  }
  if (merged.length === 0) return { ok: false, error: "empty result" };
  return { ok: true, candidates: merged };
}

/** Split one long text at paragraph boundaries, never above the budget. */
export function splitText(text, maxChars = 24_000) {
  const source = String(text ?? "");
  const limit = Number(maxChars) > 0 ? Number(maxChars) : 24_000;
  if (source.length <= limit) return [source];
  const parts = [];
  let rest = source;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf("。"));
    const at = cut > limit * 0.4 ? cut + 1 : limit;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest !== "") parts.push(rest);
  return parts;
}
