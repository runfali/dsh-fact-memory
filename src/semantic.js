/**
 * Semantic layer: embeddings, a vector recall channel, a rerank adapter and the
 * calibration that decides whether rerank scores may be treated as relevance.
 *
 * The host exposes no embedding or rerank capability today, so both providers
 * are opt-in HTTP adapters. When they are not configured the caller degrades to
 * the exact + BM25 path and MUST report that vector recall was not used; nothing
 * here invents a local model to keep a switch lit.
 */
import { sha256, oneLine } from "./util.js";
import { visibleSql } from "./store.js";

export const EMBEDDING_TEMPLATE = "{entity} · {predicate}: {value}";
const DEFAULT_EMBED_TIMEOUT = 800;
const DEFAULT_RERANK_TIMEOUT = 1500;
const MAX_EMBED_BATCH = 32;

export const embeddingText = (fact) =>
  `${fact.entity ?? ""} · ${fact.predicate ?? ""}: ${fact.value ?? ""}`.trim();

/**
 * The fingerprint pins every knob that changes the meaning of a vector: a store
 * built with model A is never queried with model B, and a dimension change
 * retires the old vectors instead of silently mixing them.
 */
export function embeddingFingerprint(provider) {
  if (!provider || provider.source !== "openai" || !provider.baseUrl || !provider.model) return null;
  return sha256(
    JSON.stringify({
      provider: "openai-embeddings",
      baseUrl: provider.baseUrl.replace(/\/+$/, ""),
      model: provider.model,
      dim: Number(provider.dim) || 0,
      template: EMBEDDING_TEMPLATE,
      normalize: "l2",
    }),
  );
}

export function rerankFingerprint(provider) {
  if (!provider || provider.source !== "json" || !provider.baseUrl || !provider.model) return null;
  return sha256(
    JSON.stringify({
      provider: "rerank-json",
      baseUrl: provider.baseUrl.replace(/\/+$/, ""),
      model: provider.model,
      scoreMode: provider.scoreMode ?? "unit_interval",
    }),
  );
}

function joinUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, "")}${path}`;
}

function apiKeyOf(provider) {
  // A key resolved from the host credential store wins; the environment stays
  // as the fallback for CI and for plain provider objects.
  const direct = typeof provider?.apiKey === "string" ? provider.apiKey.trim() : "";
  if (direct !== "") return direct;
  const name = String(provider?.apiKeyEnv ?? "").trim();
  if (name === "") return "";
  return String(process.env[name] ?? "").trim();
}

function timeoutSignal(ms, outer) {
  const signals = [];
  if (typeof AbortSignal?.timeout === "function") signals.push(AbortSignal.timeout(Math.max(1, ms)));
  if (outer) signals.push(outer);
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

async function postJson(url, body, { timeoutMs, signal, apiKey }) {
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: timeoutSignal(timeoutMs, signal),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${text.slice(0, 160)}`.trim());
  }
  return response.json();
}

const finiteVector = (value) =>
  Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "number" && Number.isFinite(item));

/** Unit length, so cosine similarity is a dot product. */
export function l2normalize(vector) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (!(norm > 0)) return vector.map(() => 0);
  return vector.map((value) => value / norm);
}

export function cosine(left, right) {
  if (!left || !right || left.length !== right.length) return 0;
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += left[index] * right[index];
  return sum;
}

export function vectorToBlob(vector) {
  return Buffer.from(Float64Array.from(vector).buffer);
}

export function blobToVector(blob) {
  const bytes = Buffer.from(blob);
  return Array.from(new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8));
}

/** Embed one batch. Returns unit-length vectors in input order or throws. */
export async function embedTexts(provider, texts, { timeoutMs = DEFAULT_EMBED_TIMEOUT, signal } = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const payload = await postJson(
    joinUrl(provider.baseUrl, "/embeddings"),
    { model: provider.model, input: texts },
    { timeoutMs, signal, apiKey: apiKeyOf(provider) },
  );
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  if (rows.length !== texts.length) {
    throw new Error(`embedding response has ${rows.length} rows for ${texts.length} inputs`);
  }
  const out = new Array(texts.length);
  let dim = Number(provider.dim) || 0;
  for (const row of rows) {
    const index = Number(row?.index);
    if (!Number.isInteger(index) || index < 0 || index >= texts.length) throw new Error(`embedding index ${row?.index} is out of range`);
    if (out[index]) throw new Error(`embedding index ${index} is duplicated`);
    if (!finiteVector(row.embedding)) throw new Error(`embedding at ${index} is not a finite vector`);
    if (dim > 0 && row.embedding.length !== dim) {
      throw new Error(`embedding at ${index} has dimension ${row.embedding.length}, configured ${dim}`);
    }
    dim = dim || row.embedding.length;
    out[index] = l2normalize(row.embedding);
  }
  if (out.some((vector) => !vector)) throw new Error("embedding response is missing an index");
  return out;
}

/**
 * Rebuild the vector projection for every visible fact. Vectors whose fact text
 * has not changed since the last build are reused, so a re-index after one write
 * costs one embedding call rather than the whole store.
 */
export async function indexVectors(store, provider, { signal, timeoutMs = DEFAULT_EMBED_TIMEOUT, includeSensitive = false } = {}) {
  const fingerprint = embeddingFingerprint(provider);
  if (!fingerprint) throw new Error("embedding provider is not configured");
  const rows = store.db
    .prepare(
      `SELECT id, entity AS entity, predicate AS predicate, value AS value, updated_at AS updated_at FROM (
         SELECT f.id AS id, e.name AS entity, f.predicate AS predicate, f.value_text AS value, f.updated_at AS updated_at
         FROM facts f JOIN entities e ON e.id = f.entity_id
         WHERE f.status IN ('active','scheduled') AND ${visibleSql({ alias: "f", includeSensitive })}
       ) ORDER BY updated_at DESC`,
    )
    .all();
  const known = new Map(
    store.db
      .prepare("SELECT fact_id, updated_at FROM fact_vectors WHERE fingerprint = ?")
      .all(fingerprint)
      .map((row) => [row.fact_id, row.updated_at]),
  );
  const pending = rows.filter((row) => known.get(row.id) !== row.updated_at);
  let indexed = 0;
  for (let offset = 0; offset < pending.length; offset += MAX_EMBED_BATCH) {
    const batch = pending.slice(offset, offset + MAX_EMBED_BATCH);
    const vectors = await embedTexts(provider, batch.map((row) => embeddingText(row)), { timeoutMs, signal });
    const at = new Date().toISOString();
    store.tx(() => {
      const insert = store.db.prepare(
        `INSERT INTO fact_vectors (fact_id, fingerprint, dim, vector, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (fact_id, fingerprint) DO UPDATE SET dim = excluded.dim, vector = excluded.vector, updated_at = excluded.updated_at`,
      );
      batch.forEach((row, index) => {
        insert.run(row.id, fingerprint, vectors[index].length, vectorToBlob(vectors[index]), row.updated_at ?? at);
        indexed += 1;
      });
    });
  }
  // A fact that stopped being visible must not keep a vector that could be
  // recalled; deleting by the current generation keeps the projection honest.
  const liveIds = new Set(rows.map((row) => row.id));
  const stale = [...known.keys()].filter((id) => !liveIds.has(id));
  if (stale.length > 0) {
    store.tx(() => {
      const remove = store.db.prepare("DELETE FROM fact_vectors WHERE fact_id = ? AND fingerprint = ?");
      for (const id of stale) remove.run(id, fingerprint);
    });
  }
  return { fingerprint, dim: Number(provider.dim) || 0, indexed, reused: rows.length - pending.length, removed: stale.length, total: rows.length };
}

/** Cosine recall over the stored projection. Returns [{factId, score}] desc. */
export function vectorChannel(store, { fingerprint, vector, limit = 60, where = "1 = 1" } = {}) {
  if (!fingerprint || !vector) return [];
  // The projection can lag behind the facts (a row may have been superseded or
  // forgotten since it was indexed), so visibility is decided by the fact row,
  // never by "a vector exists".
  const rows = store.db
    .prepare(
      `SELECT v.fact_id AS fact_id, v.vector AS vector
         FROM fact_vectors v JOIN facts f ON f.id = v.fact_id
        WHERE v.fingerprint = ? AND ${where}`,
    )
    .all(fingerprint);
  const scored = [];
  for (const row of rows) {
    const score = cosine(vector, blobToVector(row.vector));
    if (score > 0) scored.push({ factId: row.fact_id, score });
  }
  scored.sort((left, right) => right.score - left.score);
  return scored.slice(0, limit);
}

/** One embedding for a query; returns null when the provider is unusable. */
export async function embedQuery(provider, query, { timeoutMs = DEFAULT_EMBED_TIMEOUT, signal } = {}) {
  try {
    const [vector] = await embedTexts(provider, [String(query ?? "")], { timeoutMs, signal });
    return vector ?? null;
  } catch {
    return null;
  }
}

const SCORE_MODES = new Set(["unit_interval", "logit", "native"]);

/**
 * Cross-encoder rerank. Every declared index must come back exactly once and
 * every score must sit inside the adapter's declared scoreMode; anything else is
 * a failed rerank, never a partially trusted ordering.
 */
export async function rerank(provider, query, documents, { topN, timeoutMs = DEFAULT_RERANK_TIMEOUT, signal } = {}) {
  if (!provider || provider.source !== "json" || documents.length === 0) return null;
  const scoreMode = SCORE_MODES.has(provider.scoreMode) ? provider.scoreMode : "unit_interval";
  // Rerank APIs disagree on the document shape: Cohere/Jina take `[{text}]`,
  // SiliconFlow and most OpenAI-compatible relays take plain strings. Send the
  // plain form first and retry the object form only when the server rejects it,
  // so one config works against either family.
  const request = (docs) => ({
    model: provider.model,
    query: String(query ?? ""),
    documents: docs,
    top_n: Math.min(documents.length, Math.max(1, Number(topN ?? documents.length))),
  });
  let payload;
  try {
    payload = await postJson(joinUrl(provider.baseUrl, "/rerank"), request(documents.map((text) => String(text))), {
      timeoutMs,
      signal,
      apiKey: apiKeyOf(provider),
    });
  } catch (error) {
    const message = String(error?.message ?? "");
    const shapeRejected = /HTTP 4\d\d/.test(message) && /(string|document|text)/i.test(message);
    if (!shapeRejected) throw error;
    payload = await postJson(joinUrl(provider.baseUrl, "/rerank"), request(documents.map((text) => ({ text: String(text) }))), {
      timeoutMs,
      signal,
      apiKey: apiKeyOf(provider),
    });
  }
  const rows = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload?.data) ? payload.data : null;
  // A response must cover every submitted document: a missing row means the
  // server silently dropped a candidate, and its order would be a lie.
  if (!rows || rows.length !== documents.length) {
    throw new Error(`rerank returned ${rows ? rows.length : 0} rows for ${documents.length} documents`);
  }
  const seen = new Set();
  const scored = new Array(documents.length);
  for (const row of rows) {
    const index = Number(row?.index);
    if (!Number.isInteger(index) || index < 0 || index >= documents.length) throw new Error(`rerank index ${row?.index} is out of range`);
    if (seen.has(index)) throw new Error(`rerank index ${index} is duplicated`);
    seen.add(index);
    const score = Number(row.relevance_score ?? row.score);
    if (!Number.isFinite(score)) throw new Error(`rerank score at ${index} is not finite`);
    if (scoreMode === "unit_interval" && (score < 0 || score > 1)) throw new Error(`rerank score ${score} is outside unit_interval`);
    scored[index] = score;
  }
  return { scores: scored, scoreMode };
}

/**
 * Pick a threshold from labelled pairs. The plan's bar: precision at least 95%
 * with recall at least 80%; below that the semantic path stays "uncalibrated"
 * and its scores may only order candidates, never declare relevance.
 */
export function calibrate(pairs, { minPrecision = 0.95, minRecall = 0.8 } = {}) {
  const rows = (pairs ?? [])
    .map((pair) => ({ score: Number(pair?.score), relevant: pair?.relevant === true }))
    .filter((pair) => Number.isFinite(pair.score));
  const totalRelevant = rows.filter((row) => row.relevant).length;
  const totalIrrelevant = rows.length - totalRelevant;
  if (rows.length < 20 || totalRelevant < 20 || totalIrrelevant < 20) {
    // Not enough evidence to certify anything; report it instead of guessing.
    return { ok: false, reason: "insufficient_samples", samples: rows.length, relevant: totalRelevant, irrelevant: totalIrrelevant };
  }
  const sorted = [...rows].sort((left, right) => right.score - left.score);
  let best = null;
  for (let index = 0; index < sorted.length; index += 1) {
    const threshold = sorted[index].score;
    if (index > 0 && sorted[index - 1].score === threshold) continue;
    const taken = sorted.slice(0, index + 1).filter((row) => row.score >= threshold);
    const truePositive = taken.filter((row) => row.relevant).length;
    const precision = truePositive / taken.length;
    const recall = truePositive / totalRelevant;
    if (precision < minPrecision || recall < minRecall) continue;
    if (!best || recall > best.recall || (recall === best.recall && precision > best.precision)) {
      best = { threshold, precision, recall, accepted: taken.length };
    }
  }
  if (!best) {
    const fallback = { samples: rows.length, relevant: totalRelevant, maxPrecision: 0, maxRecall: 0 };
    for (let index = 0; index < sorted.length; index += 1) {
      const taken = sorted.slice(0, index + 1);
      const truePositive = taken.filter((row) => row.relevant).length;
      fallback.maxPrecision = Math.max(fallback.maxPrecision, truePositive / taken.length);
      fallback.maxRecall = Math.max(fallback.maxRecall, truePositive / totalRelevant);
    }
    return { ok: false, reason: "threshold_not_found", samples: rows.length, relevant: totalRelevant, ...fallback };
  }
  return { ok: true, samples: rows.length, relevant: totalRelevant, ...best };
}

/** Persist a passed calibration so retrieval can use it until the model changes. */
export function saveCalibration(store, { kind, fingerprint, result }) {
  if (!fingerprint) throw new Error("calibration has no provider fingerprint");
  const at = new Date().toISOString();
  store.tx(() => {
    store.db
      .prepare(
        `INSERT INTO calibrations (id, kind, fingerprint, threshold, precision, recall, samples, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (kind, fingerprint) DO UPDATE SET
           threshold = excluded.threshold, precision = excluded.precision, recall = excluded.recall,
           samples = excluded.samples, details = excluded.details, created_at = excluded.created_at`,
      )
      .run(
        sha256(`${kind}:${fingerprint}`),
        kind,
        fingerprint,
        Number(result.threshold),
        Number(result.precision),
        Number(result.recall),
        Number(result.samples),
        JSON.stringify({ accepted: result.accepted ?? null, relevant: result.relevant ?? null }),
        at,
      );
  });
  return result;
}

export function loadCalibration(store, { kind, fingerprint }) {
  if (!fingerprint) return null;
  const row = store.db.prepare("SELECT * FROM calibrations WHERE kind = ? AND fingerprint = ?").get(kind, fingerprint);
  if (!row) return null;
  return {
    threshold: Number(row.threshold),
    precision: Number(row.precision),
    recall: Number(row.recall),
    samples: Number(row.samples),
    createdAt: row.created_at,
  };
}

/** One line for the panel and for tool receipts: what actually ran this query. */
export function semanticPaths({ vectorProvider, rerankProvider, vectorUsed, rerankUsed, rerankCalibrated }) {
  return {
    vectorConfigured: Boolean(embeddingFingerprint(vectorProvider)),
    vectorUsed: vectorUsed === true,
    rerankConfigured: rerankReady(rerankProvider),
    rerankUsed: rerankUsed === true,
    rerankCalibrated: rerankCalibrated === true,
  };
}

function rerankReady(provider) {
  return Boolean(provider && provider.source === "json" && provider.baseUrl && provider.model);
}

export { oneLine };
