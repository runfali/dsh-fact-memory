/**
 * Dreaming: the second, slower memory layer (plan: docs/plans/2026-11-15-dsh-fact-memory-dream.md).
 *
 * Facts answer "what is still true"; a dream answers "what happened, and why it
 * mattered". The two never share a row: this module reads conversation material
 * and writes prose, and it never touches the facts tables.
 *
 * Everything except runDreamPass is a pure function, because the only way to be
 * sure a memory system does what it claims is to test the decision and the
 * validation on their own.
 */

import { nowIso, privacyHits, secretHits } from "./util.js";

export const DREAM_PROMPT_VERSION = "v1";

/** Further attempts stay parked this long after a failure (plan 7.6). */
export const DREAM_RETRY_MS = 4 * 3600_000;

/** Aggregated and consumed by the panel, not by anything on the write path. */
export const DREAM_LIMITS = {
  maxPerMessage: 1200,
  maxMessages: 20000,
  maxLines: 8,
  maxLineChars: 120,
  // The prompt asks for 35 characters; 45 is what the parser accepts, because
  // a model overshooting by a few characters is normal, and cutting at 35 lost
  // tails that mattered ("...$host 会 4" instead of "...$host 会 404").
  maxTitleAsk: 35,
  maxTitle: 45,
  maxTopics: 8,
};

/**
 * Keep a title inside `maxTitle` without silently halving it.
 *
 * A hard slice at 30 characters produced titles like "nginx proxy_pass 带变量必须配
 * resolv", where the tail (the word `resolver`) was simply gone and the note read
 * like a different, wrong note. Past the limit we cut at the last natural break and
 * mark the cut, so a clipped title never pretends to be complete.
 */
export function clipTitle(raw, limit = DREAM_LIMITS.maxTitle) {
  const text = String(raw ?? "").trim();
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  const head = chars.slice(0, Math.max(1, limit - 1)).join("");
  const breakAt = Math.max(
    head.lastIndexOf(" "),
    head.lastIndexOf("，"),
    head.lastIndexOf("、"),
    head.lastIndexOf("："),
    head.lastIndexOf("；"),
    head.lastIndexOf(","),
    head.lastIndexOf(";"),
    head.lastIndexOf(":"),
  );
  // Only a late break is honoured: cutting at the first space of a long English
  // title would discard most of the words for the sake of tidiness.
  const kept = breakAt >= Math.floor((limit - 1) * 0.6) ? head.slice(0, breakAt) : head;
  return kept.trimEnd() + "…";
}

/**
 * Retrieve notes by topic, for the `dream_read` tool.
 *
 * The caller arrives with words, not with an id: either the cue just showed it a
 * title, or the user asked "how did we do this last time". Matching mirrors the
 * cue (substring probes plus CJK bigram coverage) but is scored, because one
 * query can pull several notes and the most on-topic one has to come first.
 */
export function searchDreams(dreams, query, limit = 3) {
  const asked = String(query ?? "").normalize("NFKC").toLowerCase().trim();
  if (asked === "") return [];
  const tokens = queryTokens(asked);
  const hits = [];
  for (const dream of Array.isArray(dreams) ? dreams : []) {
    if (!dream || String(dream.body ?? "").trim() === "") continue;
    const title = String(dream.title ?? "").toLowerCase();
    const key = String(dream.topicKey ?? "").toLowerCase();
    const topics = (Array.isArray(dream.topics) ? dream.topics : []).map((topic) => String(topic).toLowerCase());
    // The key is matched both as written and with its dashes turned into spaces:
    // someone quoting the cue types "release-process", someone describing it says
    // "release process", and both mean the same note.
    const named = [key, key.replace(/-/g, " "), ...topics].filter((probe) => probe.length >= 2);
    const body = String(dream.body ?? "").toLowerCase();
    let score = 0;
    // A whole-phrase match outranks any number of loose tokens: it is what the
    // cue showed the model, and it is what the user just said.
    if (asked.length >= 2 && title.includes(asked)) score += 6;
    if (named.some((probe) => probe.includes(asked) || asked.includes(probe))) score += 4;
    if (asked.length >= 2 && body.includes(asked)) score += 3;
    for (const token of tokens) {
      if (title.includes(token)) score += 3;
      if (named.some((probe) => probe.includes(token))) score += 2;
      if (body.includes(token)) score += 1;
    }
    if (score > 0) hits.push({ ...dream, score });
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.hitCount ?? 0) - Number(a.hitCount ?? 0) ||
      String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")),
  );
  const wanted = Math.min(5, Math.max(1, Math.trunc(Number(limit) || 3)));
  return hits.slice(0, wanted);
}

/** Latin words and CJK bigrams — the units that survive how people rephrase. */
function queryTokens(text) {
  const source = String(text);
  const tokens = new Set();
  for (const word of source.match(/[a-z0-9][a-z0-9._-]+/g) ?? []) {
    tokens.add(word);
    // "release-process" also has to match a note written as "release process".
    for (const part of word.split(/[._-]+/)) if (part.length >= 2) tokens.add(part);
  }
  for (const run of source.match(/[\u4e00-\u9fff]+/g) ?? []) {
    const chars = Array.from(run);
    if (chars.length === 1) tokens.add(run);
    for (let index = 0; index + 1 < chars.length; index += 1) tokens.add(chars[index] + chars[index + 1]);
  }
  return [...tokens];
}

export const TOPIC_PATTERN = /^[a-z0-9-]{2,40}$/;

/** User messages a session needs before it counts as material rather than a draft. */
export const DREAM_MIN_USER_MESSAGES = 3;

/**
 * Worth a pass? Four thresholds and three damping rules, all of them overridable
 * from the settings card.
 *
 * The shapes come from peer systems but the numbers do not: Claude Code asks for
 * "24h and 5 sessions", which a user with two long sessions never reaches. The
 * measured library here was 88k characters in a single day from six sessions, so
 * characters - not sessions - are the primary signal.
 */
export function decideDream(state, cfg, now = Date.now()) {
  const s = {
    pendingChars: 0,
    // Sessions with material waiting (what the panel shows) versus sessions that
    // would survive the collector's per-session floor (what T2 counts).
    pendingSessions: 0,
    eligibleSessions: 0,
    lastRunAt: null,
    lastRunStatus: "",
    runsToday: 0,
    eventPending: false,
    ...(state ?? {}),
  };
  if (cfg?.dreamEnabled !== true) return { run: false, reason: "disabled" };
  if (s.lastRunStatus === "error" && s.lastRunAt != null && now - s.lastRunAt < DREAM_RETRY_MS) {
    return { run: false, reason: "error_backoff", nextAt: s.lastRunAt + DREAM_RETRY_MS };
  }
  const minGap = Number(cfg.dreamMinGapMs ?? 21600000);
  if (s.lastRunAt != null && Number.isFinite(minGap) && minGap > 0 && now - s.lastRunAt < minGap) {
    return { run: false, reason: "min_gap", nextAt: s.lastRunAt + minGap };
  }
  const cap = Number(cfg.dreamDailyCap ?? 2);
  if (Number.isFinite(cap) && s.runsToday >= cap) return { run: false, reason: "daily_cap" };
  // The event path is gated by the same damping above; it only skips the
  // accumulation thresholds, because the material is already known to be big.
  if (s.eventPending === true && cfg.dreamEventTrigger !== false) {
    return { run: true, reason: "event" };
  }
  const minChars = Number(cfg.dreamMinChars ?? 10000);
  if (s.pendingChars >= minChars) return { run: true, reason: "chars" };
  const minSessions = Number(cfg.dreamMinSessions ?? 3);
  if (s.eligibleSessions >= minSessions && s.pendingChars >= 2000) return { run: true, reason: "sessions" };
  const floorDays = Number(cfg.dreamIdleFloorDays ?? 7);
  const floorChars = Number(cfg.dreamIdleFloorChars ?? 2000);
  // "Went quiet for a week" presupposes a previous pass: a library that never ran
  // would otherwise fall through this floor and dream at the first 2k characters,
  // which is not what "at least dreamMinChars" says.
  const idle = s.lastRunAt != null && now - s.lastRunAt >= floorDays * 86400_000;
  if (idle && s.pendingChars >= floorChars) return { run: true, reason: "idle_floor" };
  return { run: false, reason: "not_enough" };
}

/** Verdict reasons, said in the panel's language instead of the rule's. */
const REASON_TEXT = {
  not_enough: "素材还不够",
  min_gap: "距上次整理未满最小间隔",
  daily_cap: "已达每日上限",
  error_backoff: "上次整理失败，稍后重试",
};

/** The line under the tab title: never let "why is nothing happening" be a guess. */
export function dreamStateLine({ pendingChars = 0, pendingSessions = 0, lastRunAt = null, verdict = null, now = Date.now() } = {}) {
  const parts = [];
  parts.push(pendingChars > 0 ? pendingChars + " 字符待整理" : "没有待整理素材");
  if (pendingSessions > 0) parts.push(pendingSessions + " 个会话");
  if (lastRunAt != null) {
    const hours = Math.max(0, Math.round((now - lastRunAt) / 3600_000));
    parts.push("上次整理 " + (hours < 1 ? "不到 1 小时前" : hours + " 小时前"));
  } else {
    parts.push("从未整理");
  }
  if (verdict && verdict.nextAt) {
    const minutes = Math.max(1, Math.round((verdict.nextAt - now) / 60_000));
    parts.push("下次可自动整理：约 " + (minutes >= 60 ? Math.round(minutes / 60) + " 小时后" : minutes + " 分钟后"));
  } else if (verdict && verdict.run === false && verdict.reason && verdict.reason !== "disabled") {
    parts.push("暂不整理：" + (REASON_TEXT[verdict.reason] ?? verdict.reason));
  }
  return parts.join(" · ");
}

const dateOf = (at) => String(at ?? "").slice(0, 10);

/**
 * Turn feed rows into one bounded material block.
 *
 * Order matters: a whole session is taken or left behind, because half a
 * conversation produces a dream that is wrong rather than short. A session with
 * fewer than three user messages is left in the feed - it is probably still
 * growing - unless every session is that thin, in which case waiting forever
 * would only keep the pending counter lit.
 */
export function collectMaterial(rows, { maxChars = 40000, maxPerMessage = DREAM_LIMITS.maxPerMessage, minUserMessages = DREAM_MIN_USER_MESSAGES, maxSessions = 12 } = {}) {
  const groups = new Map();
  const skipped = { thin: 0, secrets: 0, private: 0, empty: 0 };
  // Rows that can never become material: they are reported separately so the
  // caller can drop them instead of leaving them to keep the pending counter lit.
  const droppedIds = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const text = String(row?.text ?? "").trim();
    if (text === "") {
      skipped.empty += 1;
      droppedIds.push(Number(row.id));
      continue;
    }
    // A credential must never reach a model, and a phone number is not something
    // a dream needs: the row is dropped whole instead of being partially masked.
    if (secretHits(text).length > 0) {
      skipped.secrets += 1;
      droppedIds.push(Number(row.id));
      continue;
    }
    if (privacyHits(text).length > 0) {
      skipped.private += 1;
      droppedIds.push(Number(row.id));
      continue;
    }
    const sessionId = String(row.session_id ?? row.sessionId ?? "");
    if (sessionId === "") {
      droppedIds.push(Number(row.id));
      continue;
    }
    let group = groups.get(sessionId);
    if (!group) {
      group = { sessionId, rows: [], userMessages: 0, chars: 0, firstAt: String(row.at ?? ""), lastAt: String(row.at ?? "") };
      groups.set(sessionId, group);
    }
    const clipped = text.slice(0, maxPerMessage);
    group.rows.push({
      id: Number(row.id),
      seq: Number(row.seq ?? 0),
      at: String(row.at ?? ""),
      role: row.role === "user" ? "user" : "assistant",
      text: clipped,
    });
    if (row.role === "user") group.userMessages += 1;
    group.chars += clipped.length;
    group.lastAt = String(row.at ?? group.lastAt);
  }

  // A session with one or two user messages is usually still growing, so it waits.
  // But when every session is thin, waiting strands the whole feed: the character
  // threshold keeps firing, the pass finds nothing to send, and the pending
  // counter never drops. In that case the floor is relaxed to one.
  const floor =
    minUserMessages > 1 && [...groups.values()].every((group) => group.userMessages < minUserMessages) ? 1 : minUserMessages;

  const sessions = [];
  let used = 0;
  for (const group of groups.values()) {
    if (group.userMessages < floor) {
      skipped.thin += 1;
      continue;
    }
    if (sessions.length >= maxSessions) break;
    // Whole sessions only, except the first one, which is truncated to fit: a
    // single huge session is the common case on this host, and refusing it would
    // mean the feature never runs.
    if (sessions.length > 0 && used + group.chars > maxChars) break;
    const label = "S" + (sessions.length + 1);
    const lines = [];
    const kept = [];
    let chars = 0;
    for (const row of group.rows) {
      const line = "[" + label + " " + dateOf(row.at) + "] " + (row.role === "user" ? "用户" : "助手") + "：" + row.text;
      if (chars + line.length > maxChars) break;
      lines.push(line);
      // Only a row that made it into the material may be consumed: the tail cut
      // off by the budget is material the model never saw.
      kept.push(row);
      chars += line.length + 1;
    }
    if (kept.length === 0) continue;
    sessions.push({
      sessionId: group.sessionId,
      label,
      ids: kept.map((row) => row.id),
      fromSeq: Math.min(...kept.map((row) => row.seq)),
      toSeq: Math.max(...kept.map((row) => row.seq)),
      messages: kept.length,
      userMessages: kept.filter((row) => row.role === "user").length,
      chars,
      firstAt: group.firstAt,
      lastAt: kept[kept.length - 1].at,
      userText: kept.filter((row) => row.role === "user").map((row) => row.text).join("\n"),
      lines,
    });
    used += chars;
  }

  const text = sessions.map((session) => session.lines.join("\n")).join("\n\n");
  // World time for the note this material becomes: the earliest message it covers.
  const firstAt = sessions
    .map((session) => String(session.firstAt ?? ""))
    .filter((at) => at !== "")
    .sort()[0] ?? "";
  return {
    sessions,
    firstAt,
    text,
    chars: text.length,
    messages: sessions.reduce((sum, session) => sum + session.messages, 0),
    consumedIds: sessions.flatMap((session) => session.ids),
    droppedIds: droppedIds.filter((id) => Number.isFinite(id)),
    skipped,
  };
}

export const DREAM_SYSTEM = [
  "你是记忆整理器。你只输出 JSON，不解释、不加前言。",
  "你会收到：最近若干轮对话的摘录（标了会话 S1/S2 与日期），以及用户已有的主题标题、他拒绝过的主题。",
  "任务：只提取「下次会话仍然成立、且现有主题没有覆盖」的知识，写成短叙述。",
  "硬性规则：",
  "1. 只写源文本里出现过的事实；不得编造数字、版本、路径、端口、日期。",
  "2. 用户后续的纠正胜过先前的说法；矛盾时取后说的。",
  "3. 相对日期一律换算成绝对日期（源里每条消息带日期）。",
  "4. 每条 dream 最多 8 行，每行 <=120 字；写成「做了什么 / 为什么 / 结论」，不写心路历程。",
  "5. title 是这条笔记的名字，最多 35 字：概括主题、能当索引，不照抄整句，结尾不加句号。",
  "6. 与「已有主题」重复的，op 用 noop，不要改写措辞再提一遍。",
  "7. 猜测性内容一律不写。",
  '8. 最多 5 条；没有值得记的就输出 {"dreams":[]}。',
  "topic_key 用小写英文或拼音加连字符，2-40 字符，例如 dsh-plugin-migration、postgres-backup。",
  "sources 必须指向素材里真实存在的会话标签与序号；没有来源的条目会被丢弃。",
].join("\n");

/** Shape handed to endpoints that honour structured output. */
export const DREAM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["dreams"],
  properties: {
    dreams: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op", "topic_key", "title", "lines", "sources", "novelty"],
        properties: {
          op: { type: "string", enum: ["add", "update", "supersede", "noop"] },
          topic_key: { type: "string" },
          title: { type: "string" },
          lines: { type: "array", items: { type: "string" } },
          topics: { type: "array", items: { type: "string" } },
          sources: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["session", "from", "to"],
              properties: {
                session: { type: "string" },
                from: { type: "number" },
                to: { type: "number" },
              },
            },
          },
          novelty: { type: "string", enum: ["high", "low"] },
          novelty_reason: { type: "string" },
        },
      },
    },
  },
};

export function buildDreamPrompt({ material, sessions = [], existing = [], rejects = [], focus = "" }) {
  const known = existing
    .slice(0, 40)
    .map((row) => "- " + String(row.topicKey ?? row.topic_key ?? "") + "：" + String(row.title ?? ""))
    .join("\n");
  const refused = rejects
    .slice(0, 10)
    .map((row) => "- " + String(row.topicKey ?? row.topic_key ?? "") + (row.reason ? "（" + row.reason + "）" : ""))
    .join("\n");
  const ranges = sessions
    .map((session) => "- " + session.label + "：" + session.sessionId + "，序号 " + session.fromSeq + "-" + session.toSeq + "，" + session.messages + " 条消息")
    .join("\n");
  return [
    known === "" ? "【已有主题】无" : "【已有主题，重复就输出 op=noop】\n" + known,
    refused === "" ? "" : "【用户拒绝过的主题，不要再提】\n" + refused,
    String(focus ?? "").trim() === "" ? "" : "【本次聚焦】\n" + String(focus).slice(0, 400),
    "【会话区间（sources 只能引用这里的 S 标签与序号范围）】\n" + ranges,
    "【素材】",
    String(material ?? ""),
    "",
    '只输出一个 JSON 对象，形如 {"dreams":[{"op":"add","topic_key":"...","title":"...","lines":["..."],"topics":["..."],"sources":[{"session":"S1","from":12,"to":40}],"novelty":"high","novelty_reason":"..."}]}；没有就输出 {"dreams":[]}。',
  ]
    .filter((part) => part !== "")
    .join("\n");
}

/** Pull the first JSON object out of an answer; fences and chatter tolerated. */
export function parseDreamAnswer(raw) {
  const text = String(raw ?? "");
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "model returned no JSON object" };
  let parsed;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch (error) {
    return { ok: false, error: "model returned invalid JSON: " + String(error?.message ?? error).slice(0, 160) };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "model returned a non-object" };
  const dreams = Array.isArray(parsed) ? parsed : parsed.dreams;
  if (!Array.isArray(dreams)) return { ok: false, error: "model output has no dreams array" };
  return { ok: true, dreams };
}

const IDENTIFIER_PATTERNS = [
  /https?:\/\/[^\s"'<>）)]+/g,
  /\b[A-Za-z]:[\\/][^\s"'<>，。；：）)]*/g,
  /\bv?\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/g,
  /\b\d{3,6}\b/g,
];

/** Every number, version, path and URL a dream asserts. R6 checks them one by one. */
export function identifiersOf(text) {
  const found = new Set();
  for (const pattern of IDENTIFIER_PATTERNS) {
    for (const match of String(text ?? "").matchAll(pattern)) {
      const value = String(match[0] ?? "").trim();
      if (value !== "") found.add(value);
      if (found.size >= 400) return [...found];
    }
  }
  return [...found];
}

const fold = (text) => String(text ?? "").toLowerCase();

const asArray = (value) => (Array.isArray(value) ? value : []);

/**
 * A Chinese title rarely appears verbatim in what the user said ("端口配置" vs
 * "端口 8080"), so the two-character stems are what the evidence check looks for.
 */
function cjkBigrams(text) {
  const chars = [...String(text ?? "")];
  const out = [];
  const isCjk = (char) => /[\u4e00-\u9fff]/.test(char);
  for (let index = 0; index + 1 < chars.length; index += 1) {
    if (isCjk(chars[index]) && isCjk(chars[index + 1])) out.push(chars[index] + chars[index + 1]);
  }
  return out;
}

/**
 * R1-R12, in order and all local. A dream the rules cannot prove stays out; an
 * identifier that is not in the source downgrades the whole entry to unverified
 * instead of dropping it, because a missing path is usually a phrasing
 * difference and a person can decide.
 */
export function validateDreams({ dreams, material = "", sessions = [], existing = [], rejects = [], maxDreams = 5 } = {}) {
  const accepted = [];
  const dropped = [];
  const labels = new Map(sessions.map((session) => [session.label, session]));
  const rejectedTopics = new Set(rejects.map((row) => String(row.topicKey ?? row.topic_key ?? "")));
  const existingByTopic = new Map();
  for (const row of existing) {
    const key = String(row.topicKey ?? row.topic_key ?? "");
    if (key !== "" && !existingByTopic.has(key)) existingByTopic.set(key, row);
  }
  const haystack = fold(material);

  const list = asArray(dreams);
  list.forEach((item, index) => {
    const drop = (reason) => dropped.push({ index, reason });
    if (!item || typeof item !== "object") return drop("not_object");
    if (accepted.length >= maxDreams) return drop("too_many");
    const topicKey = String(item.topic_key ?? item.topicKey ?? "").trim().toLowerCase();
    if (!TOPIC_PATTERN.test(topicKey)) return drop("bad_topic_key");
    const op = ["add", "update", "supersede", "noop"].includes(item.op) ? item.op : "add";
    if (op === "noop") return drop("noop");
    if (item.novelty === "low") return drop("low_novelty");
    if (rejectedTopics.has(topicKey)) return drop("rejected_topic");

    const title = clipTitle(item.title);
    const rawLines = asArray(item.lines).map((line) => String(line ?? "").trim()).filter((line) => line !== "");
    if (rawLines.length === 0) return drop("no_lines");
    // Half the lines truncated away is no longer the same text.
    if (rawLines.length > DREAM_LIMITS.maxLines * 2) return drop("too_many_lines");
    const lines = rawLines.slice(0, DREAM_LIMITS.maxLines).map((line) => line.slice(0, DREAM_LIMITS.maxLineChars));

    const sources = [];
    for (const source of asArray(item.sources)) {
      const label = String(source?.session ?? "").trim();
      const session = labels.get(label);
      if (!session) continue;
      const from = Number(source?.from);
      const to = Number(source?.to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) continue;
      if (from < session.fromSeq || to > session.toSeq) continue;
      sources.push({ sessionId: session.sessionId, label, fromSeq: from, toSeq: to });
    }
    if (sources.length === 0) return drop("no_valid_source");

    const body = lines.join("\n");
    const identifiers = identifiersOf(title + "\n" + body);
    const unverified = identifiers.some((value) => !haystack.includes(fold(value)));
    const topics = asArray(item.topics).map((topic) => String(topic ?? "").trim()).filter((topic) => topic !== "").slice(0, DREAM_LIMITS.maxTopics);
    const probe = [...new Set([topicKey.replaceAll("-", ""), title, ...topics, ...cjkBigrams(title)].map(fold))].filter((token) => token.length >= 2);
    let userStated = false;
    for (const source of sources) {
      const session = labels.get(source.label);
      if (!session?.userText) continue;
      const said = fold(session.userText);
      if (probe.some((token) => said.includes(token))) {
        userStated = true;
        break;
      }
    }
    // Evidence is what the check found, never what the op implies: labelling a
    // correction "user_stated" without finding the words would put a claim in the
    // store that nothing supports.
    const evidence = userStated ? "user_stated" : "inferred";
    accepted.push({
      index,
      op,
      topicKey,
      title: title === "" ? topicKey : title,
      body,
      lines,
      topics,
      sources,
      evidence,
      novelty: item.novelty === "high" ? "high" : "low",
      noveltyReason: String(item.novelty_reason ?? "").slice(0, 80),
      unverified,
      supersedes: existingByTopic.has(topicKey) ? existingByTopic.get(topicKey) : null,
    });
  });
  // Duplicate topic keys inside one answer: the later one wins, so a model that
  // repeats itself cannot create its own supersede chain.
  const seen = new Map();
  for (const dream of accepted) {
    const prior = seen.get(dream.topicKey);
    if (prior) {
      dropped.push({ index: prior.index, reason: "duplicate_topic_in_answer" });
      prior.index = dream.index;
      Object.assign(prior, dream);
    } else {
      seen.set(dream.topicKey, dream);
    }
  }
  return { accepted: [...seen.values()], dropped, droppedCount: dropped.length };
}

/**
 * One pass. Dependencies are injected so the module stays testable without a
 * host: callModel(prompt) returns the raw answer, store is a MemoryStore.
 */
export async function runDreamPass({
  store,
  cfg = {},
  callModel,
  focus = "",
  sessionIds = null,
  dryRun = false,
  model = "",
} = {}) {
  const startedAt = Date.now();
  const maxChars = Number(cfg.dreamMaxChars ?? 40000);
  const maxDreams = Number(cfg.dreamMaxDreams ?? 5);
  let rows = store.dreamFeedRows({ afterId: 0, limit: DREAM_LIMITS.maxMessages });
  if (Array.isArray(sessionIds) && sessionIds.length > 0) {
    const wanted = new Set(sessionIds.map((id) => String(id)));
    rows = rows.filter((row) => wanted.has(String(row.session_id)));
  }
  const material = collectMaterial(rows, { maxChars, maxPerMessage: DREAM_LIMITS.maxPerMessage });
  if (material.sessions.length === 0) {
    // A feed of unfilterable rows would otherwise stay lit forever: they can never
    // be sent to a model, so they are retired here instead of next time.
    if (!dryRun && material.droppedIds.length > 0) store.dreamFeedDelete({ ids: material.droppedIds });
    return { status: "skipped", reason: "no_material", material, proposed: 0, accepted: 0, dropped: 0, cursorId: 0, durationMs: Date.now() - startedAt };
  }
  const existing = store.dreamIndex({ limit: 40 });
  const rejects = store.dreamRejects({ limit: 10 });
  const prompt = buildDreamPrompt({ material: material.text, sessions: material.sessions, existing, rejects, focus });

  let raw;
  try {
    raw = await callModel(prompt);
  } catch (error) {
    return {
      status: "error",
      reason: "model_failed",
      error: String(error?.message ?? error).slice(0, 240),
      material,
      proposed: 0,
      accepted: 0,
      dropped: 0,
      cursorId: 0,
      durationMs: Date.now() - startedAt,
    };
  }
  const parsed = parseDreamAnswer(raw);
  if (!parsed.ok) {
    return { status: "error", reason: parsed.error, material, proposed: 0, accepted: 0, dropped: 0, cursorId: 0, durationMs: Date.now() - startedAt };
  }
  const validated = validateDreams({
    dreams: parsed.dreams,
    material: material.text,
    sessions: material.sessions,
    existing,
    rejects,
    maxDreams,
  });

  const created = [];
  const dropped = [...validated.dropped];
  if (!dryRun) {
    for (const dream of validated.accepted) {
      const result = store.dreamCreate({
        topicKey: dream.topicKey,
        title: dream.title,
        body: dream.body,
        topics: dream.topics,
        sources: dream.sources,
        evidence: dream.evidence,
        novelty: dream.novelty,
        unverified: dream.unverified,
        supersedesId: dream.supersedes ? String(dream.supersedes.id ?? "") : null,
        validFrom: material.firstAt || null,
        model: String(model ?? ""),
        promptVersion: DREAM_PROMPT_VERSION,
      });
      if (result.status === "created") {
        created.push(result.id);
      } else {
        dropped.push({ index: dream.index, reason: result.status === "duplicate" ? "duplicate_content" : String(result.reason ?? result.status) });
      }
    }
    // A pass that kept nothing still consumes its material: otherwise the same
    // words are re-read forever (plan 7.6, all_dropped). Rows the collector refused
    // outright go with them.
    const ids = [...material.consumedIds, ...material.droppedIds];
    if (ids.length > 0) store.dreamFeedDelete({ ids });
  }

  // A dry run has no stored rows to count, but it still knows what it would have
  // kept: reporting zero (and "all_dropped") would describe a rejection that never
  // happened.
  const acceptedCount = dryRun ? validated.accepted.length : created.length;
  const status = acceptedCount === 0 ? "skipped" : "ok";
  const cursorId = !dryRun && material.consumedIds.length > 0 ? Math.max(...material.consumedIds) : 0;
  return {
    status,
    reason: acceptedCount === 0 ? "all_dropped" : "",
    material,
    proposed: parsed.dreams.length,
    accepted: acceptedCount,
    dropped: dropped.length,
    droppedReasons: dropped,
    created,
    cursorId,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * The tab's topic index: one short line per live note, generated by rule, never by
 * a model. Twenty lines is a map you can read at a glance; a longer one is a list
 * nobody scans, and the panel already pages the full notes.
 */
export const DREAM_INDEX_LINES = 20;

export function buildTopicIndex(dreams, { limit = DREAM_INDEX_LINES } = {}) {
  const rows = Array.isArray(dreams) ? dreams : [];
  return rows.slice(0, Math.max(1, Number(limit) || DREAM_INDEX_LINES)).map((dream) => ({
    topicKey: String(dream?.topicKey ?? ""),
    title: String(dream?.title ?? "").trim() || String(dream?.topicKey ?? ""),
    sources: Array.isArray(dream?.sources) ? dream.sources.length : 0,
    hitCount: Number(dream?.hitCount ?? 0),
    validFrom: dream?.validFrom ?? null,
    updatedAt: dream?.updatedAt ?? null,
  }));
}

/** Feed retention, called by the scheduler. */
export function pruneFeed(store, { days = 30 } = {}) {
  const before = new Date(Date.now() - Math.max(1, Number(days) || 30) * 86400_000).toISOString();
  return store.dreamFeedPrune({ before });
}
