/**
 * Model access for automatic fact extraction.
 *
 * The plan (§E.2) keeps exactly one model configuration for extraction:
 *
 *  - `host`   — reuse the model the running agent already uses. The selection
 *               arrives in the `agent/pre-step` payload (`modelSelection`), so no
 *               second credential is stored and no new outbound destination is
 *               introduced. This is the default.
 *  - `custom` — an OpenAI-compatible chat-completions endpoint configured by the
 *               user. It is an explicit opt-in because the conversation text then
 *               leaves the machine for that endpoint.
 *
 * Neither path gives the model tools or database access: it receives one prompt
 * and returns text that is parsed locally with a strict schema.
 */

const DEFAULT_TIMEOUT_MS = 60_000;

export function hostModelOf(selection) {
  if (!selection || typeof selection !== "object") return null;
  const provider = String(selection.provider ?? "").trim();
  const model = String(selection.model ?? "").trim();
  if (provider === "" || model === "") return null;
  return { provider, model, reasoningEffort: selection.reasoningEffort };
}

function timeoutSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason ?? new Error("aborted"));
  if (signal && typeof signal.addEventListener === "function") {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Call the host's model runtime and collect the text deltas. The runtime streams
 * `{type:'text-delta', text}` chunks and ends with `{type:'finish', reason}`;
 * anything other than `kind:'stop'` is a failed extraction, never a partial
 * success (plan §E.2).
 */
/**
 * Effort ids that mean "do not think", most explicit first. The host validates
 * the id against the model's own capability list and rejects before any provider
 * I/O, so probing costs nothing — and the winner is cached per provider/model.
 */
const THINKING_OFF_EFFORTS = ["none", "off", "minimal"];
const effortCache = new Map(); // provider\0model -> effort id | null (none worked)
const customThinkingCache = new Map(); // baseUrl\0model -> false when the endpoint rejects the fields

function effortCandidates(thinking, cacheKey, reasoningEffort) {
  if (thinking !== false) return reasoningEffort ? [reasoningEffort] : [undefined];
  const all = [...THINKING_OFF_EFFORTS, undefined];
  if (!effortCache.has(cacheKey)) return all;
  // The cached value is only a starting point: a provider that accepted it
  // yesterday may reject it today, so the rest stay available as fallbacks.
  const cached = effortCache.get(cacheKey);
  return [cached, ...all.filter((effort) => effort !== cached)];
}

export async function streamHostText(llm, { provider, model, reasoningEffort, thinking, system, prompt, signal, timeoutMs = DEFAULT_TIMEOUT_MS, maxTokens = 2048 }) {
  if (!llm || typeof llm.stream !== "function") throw Object.assign(new Error("host model runtime is unavailable"), { code: "host_unavailable" });
  const guard = timeoutSignal(signal, timeoutMs);
  const cacheKey = `${provider}\u0000${model}`;
  const attempts = effortCandidates(thinking, cacheKey, reasoningEffort);
  let lastError = null;
  try {
    for (const effort of attempts) {
      try {
        const stream = llm.stream({
          provider,
          model,
          ...(effort ? { reasoningEffort: effort } : {}),
          system,
          messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
          temperature: 0,
          maxTokens,
          signal: guard.signal,
          purpose: "dsh-fact-memory:extract",
        });
        let text = "";
        for await (const chunk of stream) {
          if (!chunk || typeof chunk !== "object") continue;
          if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
          if (chunk.type === "finish") {
            const reason = chunk.reason ?? {};
            if (reason.kind !== "stop") {
              const message = reason.failure?.message ?? reason.kind ?? "unknown";
              throw Object.assign(new Error(`model stopped early: ${message}`), { code: reason.kind === "aborted" ? "aborted" : "model_error" });
            }
          }
        }
        // Remember what this provider accepted so the next pass starts there.
        if (thinking === false) effortCache.set(cacheKey, effort ?? null);
        return text;
      } catch (error) {
        // Only an unsupported effort is retryable: the provider rejected the
        // field before spending tokens, so the next candidate is tried.
        const unsupported = error?.code === "UNSUPPORTED_REASONING_EFFORT" || /UNSUPPORTED_REASONING_EFFORT/.test(String(error?.message));
        if (!unsupported) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new Error("host model runtime rejected the call");
  } finally {
    guard.clear();
  }
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Text of a non-streaming chat.completion body. */
function textFromPayload(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
  return "";
}

/** Concatenate text deltas of an SSE chat.completion stream. */
function textFromSse(raw) {
  let text = "";
  for (const line of String(raw).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "" || data === "[DONE]") continue;
    const payload = parseJson(data);
    if (!payload) continue;
    text += textFromPayload(payload) || String(payload?.choices?.[0]?.delta?.content ?? "");
  }
  return text;
}

/**
 * Call a user-supplied OpenAI-compatible endpoint. `response_format: json_object`
 * is requested first and dropped once if the endpoint rejects it; the local
 * schema check is the authority either way.
 */
export async function callCustomText(provider, { system, prompt, signal, timeoutMs = DEFAULT_TIMEOUT_MS, jsonMode = true, thinking = false, schema = null, maxTokens = 2048 }) {
  const baseUrl = String(provider.baseUrl ?? "").replace(/\/+$/, "");
  const model = String(provider.model ?? "").trim();
  if (baseUrl === "" || model === "") throw Object.assign(new Error("custom model is not configured"), { code: "custom_unconfigured" });
  // A resolved key (host credential store) wins; the environment stays as the
  // fallback for CI and for callers that only know an env name.
  const apiKey = typeof provider.apiKey === "string" && provider.apiKey !== ""
    ? provider.apiKey
    : provider.apiKeyEnv
      ? process.env[provider.apiKeyEnv]
      : undefined;
  if (!apiKey && provider.apiKeyEnv) {
    throw Object.assign(
      new Error(`没有找到密钥「${provider.apiKeyEnv}」：设置卡里可以粘贴保存，或设置同名环境变量。`),
      { code: "missing_key" },
    );
  }
  const guard = timeoutSignal(signal, timeoutMs);
  // `reasoning_effort` and `enable_thinking` are the two spellings OpenAI-
  // compatible gateways accept for "do not think". A strict gateway may reject an
  // unknown field, so a refused attempt is retried once without them and the
  // endpoint is remembered as "no thinking switch" for the rest of the process.
  const thinkingKey = `${baseUrl}\u0000${model}`;
  let sendThinkingOff = thinking === false && customThinkingCache.get(thinkingKey) !== false;

  const send = async ({ json, suppressThinking }) => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        ...(json && schema
          ? { response_format: { type: "json_schema", json_schema: { name: "facts", strict: true, schema } } }
          : json
            ? { response_format: { type: "json_object" } }
            : {}),
        ...(suppressThinking ? { reasoning_effort: "none", enable_thinking: false } : {}),
      }),
      signal: guard.signal,
    });
    if (response.ok) return { ok: true, content: await readText(response) };
    const body = await response.text().catch(() => "");
    return { ok: false, status: response.status, detail: body.trim().slice(0, 300) };
  };

  try {
    let json = jsonMode;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await send({ json, suppressThinking: sendThinkingOff });
      if (result.ok) {
        if (typeof result.content === "string" && result.content !== "") return result.content;
        throw Object.assign(new Error("custom model returned no text"), { code: "custom_error" });
      }
      const text = `${result.status} ${result.detail}`;
      // A gateway that refuses the suppression fields still answers a plain
      // request; a gateway without json_object still answers without it.
      if (sendThinkingOff && /unknown|unrecognized|unsupported|extra|invalid|unexpected|400|422/i.test(text)) {
        sendThinkingOff = false;
        customThinkingCache.set(thinkingKey, false);
        continue;
      }
      if (json && schema && /response_format|json_schema|400|422/i.test(text)) {
        // Structured output is a preference, not a requirement: fall back to a
        // plain JSON object, and finally to no response_format at all.
        schema = null;
        continue;
      }
      if (json && /response_format|json_object|400|422/i.test(text)) {
        json = false;
        continue;
      }
      throw Object.assign(new Error(`custom model returned ${result.status}${result.detail ? `: ${result.detail}` : ""}`), { code: "custom_error" });
    }
    throw Object.assign(new Error("custom model rejected every request shape"), { code: "custom_error" });
  } finally {
    guard.clear();
  }
}

/** Body text of a response that may be plain JSON or an SSE stream. */
async function readText(response) {
  const raw = await response.text();
  return /^\s*data:/.test(raw) ? textFromSse(raw) : textFromPayload(parseJson(raw));
}
