/**
 * Duplicate and near-duplicate detection for facts.
 *
 * The library accumulates the same statement from several paths: the rule
 * extractor, the model extractor and explicit `memory_write` calls all describe
 * "the project finished its first round" in slightly different words. Left alone
 * the graph fills with near-identical nodes until retrieval is useless.
 *
 * The design is deliberately conservative, and it borrows the tiering that
 * claude-mem (Apache-2.0) landed for observation titles — adapted to Chinese
 * triples rather than English titles:
 *
 *   - exact       same normal form → safe to merge silently;
 *   - candidate   IDF-weighted cosine above the threshold AND no discriminating
 *                 token on one side only → a duplicate worth folding;
 *   - none        everything else.
 *
 * The IDF veto is the load-bearing idea: two statements can be lexically almost
 * identical and still differ in exactly the token that matters ("7801" vs
 * "7802", "bge-m3" vs "bge-large"). A rare token present on one side only is
 * strong evidence of NON-match (Fellegi-Sunter), so it vetoes the merge no
 * matter how high the cosine is. Here the veto only looks at identifier-shaped
 * (ASCII) tokens: a difference between two Chinese bigrams is exactly what the
 * cosine is for, while a difference between two identifiers is not.
 *
 * Pure functions only — no store, no I/O, so `node --test` can pin the thresholds.
 */
import { normValue, tokenize } from "./util.js";

export const DEDUP_LIMITS = {
  /** Minimum IDF-weighted cosine for a fuzzy duplicate. */
  cosineThreshold: 0.72,
  /** A token seen in at most this many facts is discriminating. */
  vetoMaxDf: 2,
  /** Short texts make cosine jumpy; require this many shared tokens first. */
  minSharedTokens: 3,
  /** Below this many active facts the corpus is too small for IDF to mean anything. */
  minCorpus: 12,
};

/**
 * The residue a log-style value leaves once its date token is removed.
 *
 * Some facts are not statements but the output of a recurring job: "backup OK
 * D:\...\cordis.patch.20261113-000036.yml", once per night. Written one row per
 * run they bury the library, yet they are not duplicates either — each run is a
 * real, distinct observation.
 *
 * Two values fold into one row only when everything BUT the date is identical.
 * The date is required to be a real calendar date, which is what keeps
 * "测试结果 187" and "测试结果 188" (no date at all) and "port 7801" / "7802"
 * apart: a bare number is never evidence of a recurring run.
 *
 * Returns null when the value carries no single usable date token, so a caller
 * can treat null as "not a log slot" without a second check.
 */
const DATE_TOKEN = /(?:19|20)\d{2}[-_/]?(?:0[1-9]|1[0-2])[-_/]?(?:0[1-9]|[12]\d|3[01])(?:[-_ T]?(?:[01]\d|2[0-3])[-_:]?[0-5]\d(?:[-_:]?[0-5]\d)?)?/g;

export function logSlotKey(value) {
  const text = String(value ?? "");
  if (text.length < 12) return null;
  // Exactly one date: two independent dates ("from 20260101 to 20260201") could be
  // a range whose endpoints matter, and folding one into the other would erase it.
  const tokens = [...text.matchAll(DATE_TOKEN)];
  if (tokens.length !== 1) return null;
  const [token] = tokens;
  const residue = `${text.slice(0, token.index)}⟨date⟩${text.slice(token.index + token[0].length)}`.replace(/\s+/g, " ").trim();
  // The date must not be the whole message: "2026-11-13" alone says nothing to fold.
  if (residue.replace("⟨date⟩", "").replace(/[^\p{L}\p{N}]/gu, "").length < 4) return null;
  return residue;
}

/**
 * The IDF above which a token counts as rare. Derived from the corpus size
 * instead of being a constant: an absolute cutoff either never fires on a small
 * library or fires on ordinary words in a large one.
 */
export function vetoThetaFor(docCount, maxDf = DEDUP_LIMITS.vetoMaxDf) {
  return Math.log(1 + Math.max(1, docCount) / (maxDf + 0.5));
}

/** Tokens that look like identifiers: digits, versions, paths, package names. */
const IDENTIFIER_ISH = /[0-9a-z]/i;

/**
 * Dates and clock times are qualifiers, not discriminators: "首轮开发完成" and
 * "首轮开发完成（2026-11-13）" are the same statement, and letting the date veto
 * the merge would keep every re-statement that adds a timestamp.
 */
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}|^\d{1,2}:\d{2}/;

/**
 * Identity key for an entity name: fold case, drop separators, and drop a
 * trailing role word when a real name survives it ("dsh-fact-memory插件" and
 * "DSH Fact Memory" are the same subject; "订单服务" and "订单" are not).
 */
export function canonicalEntityKey(name) {
  const folded = normValue(name);
  const compact = folded.replace(/[\s\-_./\\:·]+/g, "");
  if (compact === "") return "";
  if (/[a-z]/.test(compact)) {
    const stripped = compact.replace(/(插件|项目|服务|系统|模块|平台|工具|plugin|project|service)$/, "");
    if (stripped.length >= 3) return stripped;
  }
  return compact;
}

/**
 * The comparable text of a fact: subject, property and value together. The
 * subject enters as its canonical key, not its spelling — "DSH Fact Memory" and
 * "dsh-fact-memory插件" are one subject, and letting the raw spelling through
 * would make every re-spelling look like a discriminating token difference.
 */
export function factText({ entity, predicate, value }) {
  return [canonicalEntityKey(entity ?? ""), predicate, value]
    .filter((part) => part !== null && part !== undefined && part !== "")
    .join(" ");
}

export function factTokens(fact) {
  return [...new Set(tokenize(factText(fact)))];
}

/**
 * Smoothed inverse document frequency over the current corpus. `df` is how many
 * facts contain the token; a token nobody else has gets the largest weight.
 */
export function buildIdfFn(documents) {
  const total = documents.length;
  const df = new Map();
  for (const tokens of documents) {
    for (const token of new Set(tokens)) df.set(token, (df.get(token) ?? 0) + 1);
  }
  return (token) => Math.log(1 + total / ((df.get(token) ?? 0) + 0.5));
}

/** Cosine of the two IDF-weighted bags (tf = 1: facts are short). */
export function tfidfCosine(left, right, idfFn) {
  const a = new Set(left);
  const b = new Set(right);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const token of a) {
    const weight = idfFn(token);
    normA += weight * weight;
    if (b.has(token)) dot += weight * weight;
  }
  for (const token of b) {
    const weight = idfFn(token);
    normB += weight * weight;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

/**
 * True when the two texts differ in a rare identifier-shaped token. Only those
 * tokens count: "2026-11-13" or "7801" appearing on one side means the
 * statements talk about different things, while a differing Chinese bigram is
 * ordinary rewording and must not block a merge.
 */
export function vetoFires(left, right, idfFn, thetaIdf) {
  const a = new Set(left);
  const b = new Set(right);
  // Tokenisation splits "2026-11-13" into its parts, so those parts have to be
  // exempted too — otherwise every timestamp would veto its own merge.
  const dateParts = new Set();
  for (const token of [...a, ...b]) {
    if (!DATE_LIKE.test(token)) continue;
    for (const part of token.split(/[^0-9]+/)) if (part !== "") dateParts.add(part);
  }
  for (const token of a) {
    if (dateParts.has(token)) continue;
    if (!IDENTIFIER_ISH.test(token) || DATE_LIKE.test(token)) continue;
    if (!b.has(token) && idfFn(token) > thetaIdf) return true;
  }
  for (const token of b) {
    if (dateParts.has(token)) continue;
    if (!IDENTIFIER_ISH.test(token) || DATE_LIKE.test(token)) continue;
    if (!a.has(token) && idfFn(token) > thetaIdf) return true;
  }
  return false;
}

/**
 * Tier decision for one pair. `exact` needs a non-empty normal form so that two
 * facts which normalise to nothing cannot collapse into each other.
 */
export function classifyPair(left, right, idfFn, thresholds = DEDUP_LIMITS) {
  const leftText = normValue(left.map((token) => token).join(" "));
  const rightText = normValue(right.map((token) => token).join(" "));
  if (leftText !== "" && leftText === rightText) return { tier: "exact", score: 1, method: "exact" };
  const a = new Set(left);
  const b = new Set(right);
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  if (shared < (thresholds.minSharedTokens ?? 2)) return { tier: "none", score: 0, method: "none" };
  const score = tfidfCosine(left, right, idfFn);
  const theta = thresholds.vetoThetaIdf ?? vetoThetaFor(thresholds.docCount ?? 50, thresholds.vetoMaxDf);
  if (score >= thresholds.cosineThreshold && !vetoFires(left, right, idfFn, theta)) {
    return { tier: "candidate", score, method: "idf_cosine" };
  }
  return { tier: "none", score, method: "none" };
}
