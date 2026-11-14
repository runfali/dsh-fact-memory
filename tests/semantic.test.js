import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { MemoryStore } from "../src/store.js";
import { search } from "../src/retrieve.js";
import {
  calibrate,
  cosine,
  embedTexts,
  embeddingFingerprint,
  indexVectors,
  l2normalize,
  loadCalibration,
  rerank,
  rerankFingerprint,
  saveCalibration,
  vectorChannel,
} from "../src/semantic.js";

const dirs = [];
const cleanup = [];
function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "fm-semantic-"));
  dirs.push(dir);
  return MemoryStore.open({ dataDir: dir });
}
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* disposable temp dir */
    }
  }
  for (const fn of cleanup) {
    try {
      fn();
    } catch {
      /* disposable server */
    }
  }
});

/** A deterministic 6-dim "embedding": a bag of character buckets, L2 normalised. */
function fakeVector(text) {
  const vector = new Array(6).fill(0);
  for (const char of String(text)) vector[char.codePointAt(0) % 6] += 1;
  return l2normalize(vector);
}

/** One local HTTP server standing in for both semantic providers. */
async function fakeProvider(handler) {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const payload = body === "" ? {} : JSON.parse(body);
      const answer = handler(request.url, payload);
      response.writeHead(answer.status ?? 200, { "content-type": "application/json" });
      response.end(JSON.stringify(answer.body ?? answer));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => server.close());
  const port = server.address().port;
  return { baseUrl: `http://127.0.0.1:${port}`, server };
}

const cache = new Map();
async function embeddingProvider() {
  const { baseUrl } = await fakeProvider((url, payload) => {
    if (url !== "/embeddings") return { status: 404, body: { error: "nope" } };
    return {
      data: payload.input.map((text, index) => {
        const key = `${payload.model}:${text}`;
        if (!cache.has(key)) cache.set(key, fakeVector(text));
        return { index, embedding: cache.get(key) };
      }),
    };
  });
  return { source: "openai", baseUrl, model: "fake-embed", dim: 6, apiKeyEnv: "" };
}

test("embedding batches are validated and normalised", async () => {
  const provider = await embeddingProvider();
  const vectors = await embedTexts(provider, ["api · 端口: 8080", "user · 时区: UTC"]);
  assert.equal(vectors.length, 2);
  for (const vector of vectors) {
    assert.equal(vector.length, 6);
    assert.ok(Math.abs(Math.hypot(...vector) - 1) < 1e-9);
  }
  assert.equal(embeddingFingerprint(provider).length, 64);
  assert.notEqual(embeddingFingerprint(provider), embeddingFingerprint({ ...provider, model: "other" }));
});

test("indexing stores vectors, reuses unchanged rows and recalls by cosine", async () => {
  const store = freshStore();
  store.writeFact({
    entity: { name: "api", type: "service" },
    predicate: "端口",
    value: "8080",
    cardinality: "single",
    evidenceLevel: "explicit_user",
  });
  store.writeFact({
    entity: { name: "user", type: "person" },
    predicate: "时区",
    value: "Asia/Shanghai",
    cardinality: "single",
    evidenceLevel: "explicit_user",
  });
  const provider = await embeddingProvider();
  const first = await indexVectors(store, provider);
  assert.equal(first.indexed, 2);
  const second = await indexVectors(store, provider);
  assert.equal(second.indexed, 0);
  assert.equal(second.reused, 2);

  const fingerprint = embeddingFingerprint(provider);
  const [query] = await embedTexts(provider, ["api · 端口: 8080"]);
  const recalled = vectorChannel(store, { fingerprint, vector: query, limit: 5 });
  assert.equal(recalled.length, 2);
  assert.equal(store.getFact(recalled[0].factId).predicate, "端口");
  assert.ok(cosine(query, query) > 0.999);
  assert.doesNotThrow(() => store.close());
});

test("search reports when the vector path did not run", async () => {
  const store = freshStore();
  store.writeFact({
    entity: { name: "api", type: "service" },
    predicate: "端口",
    value: "8080",
    cardinality: "single",
    evidenceLevel: "explicit_user",
  });
  const lexical = await search(store, { query: "端口" });
  assert.equal(lexical.paths.vectorUsed, false);
  assert.equal(lexical.paths.vectorConfigured, false);

  const provider = await embeddingProvider();
  await indexVectors(store, provider);
  const semantic = await search(store, { query: "端口", vectorProvider: provider });
  assert.equal(semantic.paths.vectorUsed, true);
  assert.ok(semantic.channels.vector >= 1);
  assert.ok(semantic.items.length >= 1);
  store.close();
});

test("rerank rejects malformed responses instead of trusting a partial order", async () => {
  const { baseUrl } = await fakeProvider((url, payload) => {
    if (url.startsWith("/dup/")) {
      return { results: [{ index: 0, relevance_score: 0.9 }, { index: 0, relevance_score: 0.8 }] };
    }
    if (url.startsWith("/range/")) return { results: [{ index: 0, relevance_score: 2 }] };
    if (url.startsWith("/short/")) return { results: [{ index: 0, relevance_score: 0.5 }] };
    return { results: payload.documents.map((_doc, index) => ({ index, relevance_score: 0.5 })) };
  });
  const provider = (prefix, scoreMode = "unit_interval") => ({ source: "json", baseUrl: `${baseUrl}${prefix}`, model: "fake-rerank", scoreMode });
  await assert.rejects(() => rerank(provider("/dup"), "q", ["a", "a"], {}));
  await assert.rejects(() => rerank(provider("/range"), "q", ["a"], {}));
  await assert.rejects(() => rerank(provider("/short"), "q", ["a", "b"], {}));
  const good = await rerank(provider(""), "q", ["a", "b"], {});
  assert.deepEqual(good.scores, [0.5, 0.5]);
  assert.equal(rerankFingerprint(provider("")).length, 64);
});

test("rerank adapts to both document shapes and never invents a score", async () => {
  // SiliconFlow/OpenAI-compatible relays take plain strings and reject objects;
  // Cohere/Jina take {text} objects. One config must work against either.
  const { baseUrl } = await fakeProvider((url, payload) => {
    const first = payload.documents[0];
    if (url.startsWith("/strings-only") && typeof first !== "string") {
      return { status: 400, body: { message: "Input should be a valid string" } };
    }
    if (url.startsWith("/objects-only") && (first === null || typeof first !== "object")) {
      return { status: 400, body: { message: "documents must be objects with a text field" } };
    }
    return { results: payload.documents.map((_doc, index) => ({ index, relevance_score: 0.5 + index * 0.1 })) };
  });
  const provider = (prefix) => ({ source: "json", baseUrl: `${baseUrl}${prefix}`, model: "fake-rerank", scoreMode: "unit_interval" });
  const viaStrings = await rerank(provider("/strings-only"), "q", ["a", "b"], {});
  assert.deepEqual(viaStrings.scores, [0.5, 0.6]);
  const viaObjects = await rerank(provider("/objects-only"), "q", ["a", "b"], {});
  assert.deepEqual(viaObjects.scores, [0.5, 0.6]);
});

test("calibration enforces the sample floor and the precision/recall bar", () => {
  const thin = calibrate([{ score: 0.9, relevant: true }]);
  assert.equal(thin.ok, false);
  assert.equal(thin.reason, "insufficient_samples");

  // 20 relevant scored above 0.6, 20 irrelevant below it: a clean threshold.
  const pairs = [];
  for (let index = 0; index < 20; index += 1) pairs.push({ score: 0.6 + index * 0.01, relevant: true });
  for (let index = 0; index < 20; index += 1) pairs.push({ score: 0.1 + index * 0.01, relevant: false });
  const result = calibrate(pairs);
  assert.equal(result.ok, true);
  assert.ok(result.threshold >= 0.6);
  assert.ok(result.precision >= 0.95);
  assert.ok(result.recall >= 0.8);

  // Separable only at a bar the plan refuses: all pairs below 0.6 score, no
  // threshold reaches 95% precision.
  const mixed = pairs.map((pair, index) => ({ ...pair, relevant: index % 2 === 0 ? pair.relevant : !pair.relevant }));
  assert.equal(calibrate(mixed).ok, false);
});

test("a calibrated rerank filters, an uncalibrated one only orders", async () => {
  const store = freshStore();
  for (const value of ["8080", "9090", "7070"]) {
    store.writeFact({
      entity: { name: "api", type: "service" },
      predicate: `端口-${value}`,
      value,
      cardinality: "single",
      evidenceLevel: "explicit_user",
    });
  }
  const { baseUrl, server } = await fakeProvider((url, payload) => {
    if (url !== "/rerank") return { status: 404, body: {} };
    const scores = payload.documents.map((doc, index) => {
      const text = typeof doc === "string" ? doc : doc.text;
      return { index, relevance_score: text.includes("9090") ? 0.95 : 0.2 };
    });
    return { results: scores };
  });
  const provider = { source: "json", baseUrl, model: "fake-rerank", scoreMode: "unit_interval" };
  const uncalibrated = await search(store, { query: "端口", rerankProvider: provider });
  assert.equal(uncalibrated.paths.rerankUsed, true);
  assert.equal(uncalibrated.paths.rerankCalibrated, false);
  assert.ok(uncalibrated.degraded.includes("rerank_uncalibrated"));
  assert.equal(uncalibrated.items[0].value, "9090");

  const fingerprint = rerankFingerprint(provider);
  const calibration = calibrate([
    ...Array.from({ length: 20 }, (_unused, index) => ({ score: 0.9 + index * 0.001, relevant: true })),
    ...Array.from({ length: 20 }, (_unused, index) => ({ score: 0.1 + index * 0.001, relevant: false })),
  ]);
  saveCalibration(store, { kind: "rerank", fingerprint, result: calibration });
  assert.ok(loadCalibration(store, { kind: "rerank", fingerprint }));

  const calibrated = await search(store, { query: "端口", rerankProvider: provider });
  assert.equal(calibrated.paths.rerankCalibrated, true);
  assert.equal(calibrated.items.length, 1);
  assert.equal(calibrated.items[0].value, "9090");
  server.close();
  store.close();
});
