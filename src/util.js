/**
 * Pure helpers shared by the store, the extractor, retrieval and the JSONL
 * exchange format. No host imports, no I/O: everything here is unit-testable
 * with `node --test`.
 */
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const PLUGIN_ID = "dsh-fact-memory";
/** SQLite schema generation of this build. Must equal `PRAGMA user_version`. */
export const SCHEMA_VERSION = 15;
/** Parser generation of the text projection: bump when extraction rules change. */
export const PARSER_VERSION = "rules-2";

export const nowIso = () => new Date().toISOString();
export const uuid = () => randomUUID();
export const sha256 = (text) => createHash("sha256").update(String(text), "utf8").digest("hex");

export function oneLine(error) {
  const text = error && typeof error.message === "string" ? error.message : String(error ?? "");
  return text.replace(/\s+/g, " ").slice(0, 240);
}

/**
 * Parse a JSON body that may be followed by junk. Some gateways append an SSE
 * terminator (`data: [DONE]`) to a plain JSON answer, which makes `JSON.parse`
 * of the whole body fail; this returns the first complete JSON value instead.
 */
export function parseJsonLoose(raw) {
  const text = String(raw ?? "");
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to the prefix scan.
  }
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Host data root. The plugin never assumes it equals the working directory. */
export function defaultDataDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
  return join(home, "fact-memory");
}

export function hostTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// ── text normalisation ────────────────────────────────────────────────────
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const ASCII_TOKEN = /[a-z0-9_@$./\\:-]+/g;
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

export const casefold = (text) => String(text ?? "").normalize("NFKC").toLowerCase();
/** Comparison form for paths: forward slashes, no trailing slash, case folded. */
export function normPath(text) {
  return casefold(text).replace(/\\/g, "/").replace(/\/+$/, "");
}
/** Value form used for equality inside one fact slot. */
export function normValue(text) {
  return casefold(String(text ?? "")).replace(/\s+/g, " ").trim();
}

/**
 * Tokens for the FTS index: ASCII words plus CJK bigrams (and unigrams, so a
 * one-character query still hits). The plan requires bigram segmentation for
 * Chinese; producing the bigrams here means the SQLite tokenizer only ever sees
 * space-separated tokens and needs no ICU extension.
 */
export function tokenize(text) {
  const source = casefold(text);
  const tokens = new Set();
  for (const match of source.matchAll(ASCII_TOKEN)) {
    const raw = match[0].replace(/^[.:-]+|[.:-]+$/g, "");
    if (raw.length === 0) continue;
    tokens.add(raw);
    for (const part of raw.split(/[./\\:_-]+/)) if (part.length >= 2) tokens.add(part);
  }
  for (const run of source.match(CJK_RUN) ?? []) {
    for (let index = 0; index < run.length; index += 1) {
      tokens.add(run[index]);
      if (index + 1 < run.length) tokens.add(run.slice(index, index + 2));
    }
  }
  return [...tokens];
}

/** Space-joined token column stored in the FTS table. */
export const tokenText = (text) => tokenize(text).join(" ");

/** FTS5 MATCH expression: OR of quoted tokens; empty string when nothing usable. */
export function ftsMatch(query) {
  const tokens = tokenize(query).slice(0, 64);
  if (tokens.length === 0) return "";
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

// ── exact identifier channel ──────────────────────────────────────────────
const IDENTIFIER_RULES = [
  { kind: "url", re: /\bhttps?:\/\/[^\s"'<>）)]+/g, norm: (v) => v },
  { kind: "path", re: /\b[A-Za-z]:[\\/][^\s"'<>，。；：）)]*/g, norm: normPath },
  { kind: "path", re: /(?:^|[\s（(])((?:\/(?:[\w.@-]+\/)*[\w.@-]+))/g, norm: normPath, group: 1 },
  { kind: "pkg", re: /@[a-z0-9][\w.-]*\/[\w.-]+/gi, norm: casefold },
  { kind: "version", re: /\bv?\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/g, norm: (v) => v.replace(/^v/i, "").toLowerCase() },
  { kind: "ip", re: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g, norm: (v) => v },
  { kind: "port", re: /(?:端口|port)\s*[:：=]?\s*(\d{2,5})/gi, norm: (v) => String(Number(v)), group: 1 },
];

/**
 * Identifiers in a query that must survive BM25: paths, package names, versions,
 * ports, IPs, URLs. Returned de-duplicated by (kind, normalised value).
 */
export function parseIdentifiers(query) {
  const source = String(query ?? "");
  const found = new Map();
  for (const rule of IDENTIFIER_RULES) {
    rule.re.lastIndex = 0;
    for (const match of source.matchAll(rule.re)) {
      const raw = rule.group ? match[rule.group] : match[0];
      if (!raw || raw.length < 2) continue;
      const norm = rule.norm(raw);
      if (norm.length < 2) continue;
      found.set(`${rule.kind}\u0000${norm}`, { kind: rule.kind, value: raw, norm });
    }
  }
  return [...found.values()];
}

// ── privacy ───────────────────────────────────────────────────────────────
const SECRET_RULES = [
  { kind: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "api_key", re: /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}/ },
  { kind: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { kind: "aws_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "slack_token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "credential", re: /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*\S{6,}/i },
  { kind: "credential", re: /(?:密码|口令|密钥|令牌|私钥)\s*[:：=是为]\s*\S{4,}/ },
];

const PRIVACY_RULES = [
  { kind: "phone", re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { kind: "id_card", re: /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/ },
  { kind: "email", re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/ },
];

/** Credentials: never persisted, in any form, by any path. */
export function secretHits(text) {
  const source = String(text ?? "");
  return SECRET_RULES.filter((rule) => rule.re.test(source)).map((rule) => rule.kind);
}

/** High-sensitivity personal data: stored only on explicit request, never model-visible. */
export function privacyHits(text) {
  const source = String(text ?? "");
  return PRIVACY_RULES.filter((rule) => rule.re.test(source)).map((rule) => rule.kind);
}

// ── budgets ───────────────────────────────────────────────────────────────
/**
 * Character budget from a token budget. Chinese runs near one token per
 * 1.0–1.5 characters, English near four characters per token, so two characters
 * per token is the conservative unit the plan asks for when a tokenizer is not
 * available; the panel labels the result as an estimate.
 */
export const budgetChars = (tokens) => Math.max(0, Math.floor(Number(tokens || 0) * 2));

/** Truncate on code-point boundaries, never inside a surrogate pair. */
export function clampCodepoints(text, limit) {
  const chars = Array.from(String(text ?? ""));
  if (chars.length <= limit) return { text: chars.join(""), truncated: false };
  return { text: chars.slice(0, Math.max(0, limit)).join(""), truncated: true };
}

export function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export const json = (value) => JSON.stringify(value ?? null);
export const isCjk = (text) => CJK.test(String(text ?? ""));

/**
 * A conversation transcript is not user input.
 *
 * Compaction and title agents receive the transcript as a user-role prompt. Both
 * writers must refuse it: the rule path would read facts out of the assistant's
 * own prose, and the model pass would re-extract turns that were already handled
 * when they happened.
 */
export function looksLikeTranscript(text) {
  const value = String(text ?? "");
  if (/^\s*(?:USER|用户|Human)\s*[:：]/m.test(value)) return true;
  return /\n\s*(?:ASSISTANT|助手|Assistant)\s*(?:\[[^\]]*\])?\s*[:：]/.test(value);
}
