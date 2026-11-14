/**
 * Rule-based extraction: cheap, deterministic, and the only path that can run
 * without a model. The model-assisted extractor lives in src/autoextract.js and
 * shares nothing here except the candidate shape.
 *
 * Precision beats recall. Every rule is anchored on an explicit phrasing, the
 * sentence has to be short, and the result must pass the shared fact-shape gate
 * (src/quality.js). A rule that fires on an ordinary sentence is worse than no
 * rule at all: it teaches the library to store fragments such as
 * "结论先说：核心闭环能" as if they were subjects.
 */
import { casefold, normValue, parseIdentifiers } from "./util.js";
import { isQuestion, judgeFact, plausibleSubject } from "./quality.js";

const MARKER = /^(?:请?记住|记一下|记下来|记下|帮我记(?:住)?|别忘了|以后都|今后都|remember that|remember|please remember|keep in mind|note that?)\s*[：:，,、-]?\s*/i;

const MAX_VALUE = 200;
const MAX_SENTENCE = 240;

/**
 * The rule path's last resort: the whole sentence stored as a value. Nothing
 * about it is structured, and the model extractor turns the same sentence into a
 * real triple — writing both is how one statement becomes three facts.
 */
export const NOTE_PREDICATE = "备忘";

/** True when the user is explicitly asking memory to remember something. */
export function isMemoryRequest(text) {
  return /(请?记住|记一下|记下来|记下|帮我记|别忘了|以后都|今后都|remember|keep in mind|note that)/i.test(String(text ?? ""));
}

const LEADING_MARKS = /^[\s"“”'‘’「」【】]+/;
const TRAILING_NOISE = /[\s，。；、,.;]+$/;
const QUOTE_PAIRS = [
  ["「", "」"],
  ["『", "』"],
  ["【", "】"],
  ["“", "”"],
  ["‘", "’"],
  ['"', '"'],
  ["'", "'"],
];

/**
 * Trim a captured value without cutting a quoted phrase in half. Stripping every
 * trailing 「」/“” turned "看到「有没有东西在跑」" into "看到「有没有东西在跑" — an
 * unmatched opening mark that reads as a truncated value in the UI. A closing
 * mark is dropped only when its opener is not part of the value (i.e. the whole
 * value was wrapped in quotes).
 */
const clean = (value) => {
  let text = String(value ?? "").replace(LEADING_MARKS, "").trim();
  for (;;) {
    const before = text;
    text = text.replace(TRAILING_NOISE, "").trim();
    const last = text.slice(-1);
    const pair = QUOTE_PAIRS.find(([, close]) => close === last);
    if (pair && !text.slice(0, -1).includes(pair[0])) text = text.slice(0, -1).trim();
    if (text === before) break;
  }
  return text.slice(0, MAX_VALUE);
};

/**
 * Every rule names the subject it matched (index 1) or fixes it to "user". A
 * subject rule only fires when the subject survives plausibleSubject(), which is
 * what stops "X 的 Y 是 Z" from turning any sentence with that pattern into a
 * fact. The deliberately dropped rule is the bare "X 用 Y": it matched the verb
 * 用 anywhere in a sentence, so "核心闭环能用了" became a fact about "核心闭环能".
 */
const RULES = [
  // ── the user's own slots ────────────────────────────────────────────────
  { re: /^我叫\s*(.+)$/, build: (m) => ({ entity: "user", type: "person", predicate: "名字", value: m[1], cardinality: "single" }) },
  { re: /^我的名字(?:是|叫)\s*(.+)$/, build: (m) => ({ entity: "user", type: "person", predicate: "名字", value: m[1], cardinality: "single" }) },
  { re: /^我的\s*([^\s，。；：]{1,12})\s*(?:是|为|：|:|=)\s*(.+)$/, build: (m) => ({ entity: "user", type: "person", predicate: clean(m[1]), value: m[2], cardinality: "single" }) },
  { re: /^我(?:更|比较|通常|一般|平时|还是)?(?:喜欢|偏好|习惯|倾向(?:于)?)\s*(.+)$/, build: (m) => ({ entity: "user", type: "person", predicate: "偏好", value: m[1], cardinality: "multi" }) },
  { re: /^我(?:不|别)(?:喜欢|要|用|使用)\s*(.+)$/, build: (m) => ({ entity: "user", type: "person", predicate: "避免", value: m[1], cardinality: "multi" }) },
  { re: /^我(?:们)?(?:统一|一律|都)?(?:用|使用|采用)\s*(.+)$/, build: (m) => ({ entity: "user", type: "person", predicate: "使用", value: m[1], cardinality: "multi" }) },
  // ── another subject, but only a believable one ───────────────────────────
  { re: /^(.{1,40}?)(?:的)?\s*(?:端口|port)\s*(?:是|为|：|:|=)?\s*(\d{2,5})$/i, subject: 1, build: (m) => ({ entity: m[1], predicate: "端口", value: m[2], cardinality: "single" }) },
  { re: /^(.{1,40}?)的\s*([^\s，。；：]{1,12})\s*(?:是|为|：|:|=)\s*(.+)$/, subject: 1, build: (m) => ({ entity: m[1], predicate: clean(m[2]), value: m[3], cardinality: "single" }) },
  { re: /^(.{1,40}?)\s*(?:统一|一律|必须|应该)\s*(?:用|使用|采用|走)\s*(.+)$/, subject: 1, build: (m) => ({ entity: m[1], predicate: "约定", value: m[2], cardinality: "multi" }) },
  // ── English ─────────────────────────────────────────────────────────────
  { re: /^my\s+([a-z][\w ]{1,24}?)\s+is\s+(.+)$/i, build: (m) => ({ entity: "user", type: "person", predicate: clean(m[1]), value: m[2], cardinality: "single" }) },
  { re: /^i\s+(?:prefer|like|usually use|always use|use)\s+(.+)$/i, build: (m) => ({ entity: "user", type: "person", predicate: "偏好", value: m[1], cardinality: "multi" }) },
];

function candidate(entityName, matched, now, text) {
  const name = clean(entityName);
  const value = clean(matched.value);
  if (name === "" || value === "") return null;
  const built = {
    entity: { name, type: matched.type ?? (casefold(name) === "user" ? "person" : "project") },
    predicate: String(matched.predicate ?? "").trim(),
    value,
    cardinality: matched.cardinality ?? "multi",
    scope: "global",
    qualifiers: {},
    evidenceLevel: "explicit_user",
    observedAt: now,
    validFrom: null,
    validTo: null,
    timePrecision: "unknown",
    identifiers: parseIdentifiers(text).map((identifier) => identifier.norm),
  };
  // Only facts that look like facts leave here. The same gate runs on the model
  // path, so the two cannot disagree about what counts as a fragment.
  if (!judgeFact(built).ok) return null;
  return built;
}

/**
 * Extract candidate facts from one user message. Returns at most `maxFacts`
 * candidates, de-duplicated by (entity, predicate, value).
 *
 * Without an explicit memory marker a message yields at most one fact, and only
 * from a subject-anchored rule — the default is silence, not a best guess.
 */
export function extractFacts(text, { now = new Date().toISOString(), maxFacts = 2, knownEntities } = {}) {
  const source = String(text ?? "");
  if (source.length === 0) return [];
  const chunks = source
    .split(/[。！？!?；;\n]+/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== "" && Array.from(chunk).length <= MAX_SENTENCE);
  const out = [];
  const seen = new Set();
  for (const chunk of chunks) {
    const marker = MARKER.exec(chunk);
    const marked = marker !== null;
    const body = (marked ? chunk.slice(marker[0].length) : chunk).trim();
    if (body === "") continue;
    // A question is not a fact, and an unmarked fragment is not a subject.
    if (isQuestion(body)) continue;
    let built = null;
    for (const rule of RULES) {
      const match = rule.re.exec(body);
      if (!match) continue;
      if (rule.subject && !plausibleSubject(match[rule.subject], { knownEntities })) continue;
      let spec = null;
      try {
        spec = rule.build(match);
      } catch {
        spec = null;
      }
      if (!spec) continue;
      built = candidate(spec.entity ?? match[1] ?? "", spec, now, body);
      if (built) break;
    }
    if (!built && marked) {
      // An explicit "remember this" that matches no template is still a request
      // to keep the sentence; the gate decides whether it is shaped like a fact.
      built = candidate("user", { predicate: NOTE_PREDICATE, value: body, cardinality: "multi" }, now, body);
    }
    if (!built) continue;
    const key = [normValue(built.entity.name), casefold(built.predicate), normValue(built.value)].join("\u0001");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(built);
    if (out.length >= (marked ? Math.max(1, maxFacts) : 1)) break;
  }
  return out;
}

/** Long identifiers (paths, URLs) mentioned in a message: used to widen retrieval. */
export function mentionedIdentifiers(text) {
  return parseIdentifiers(text).map((identifier) => identifier.norm).filter((value) => value.length >= 4);
}
