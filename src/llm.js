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

import { parseJsonLoose } from "./util.js";

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
// How an endpoint accepted "do not think": the widest shape, the OpenAI-ish
// pair only, or neither. Probed once per endpoint because a strict gateway
// rejects unknown fields outright.
const customThinkingCache = new Map(); // baseUrl\0model -> 'full' | 'legacy' | 'none'
// `chat_template_kwargs` is the spelling vLLM / SGLang templates read; the other
// two are the OpenAI-ish ones. Most gateways ignore what they do not know, so the
// widest shape is tried first and narrowed only when an endpoint says 400.
const THINKING_OFF_FIELDS = {
  full: { reasoning_effort: "none", enable_thinking: false, chat_template_kwargs: { enable_thinking: false } },
  legacy: { reasoning_effort: "none", enable_thinking: false },
};
// A truncated answer may fit a bigger budget; beyond this a model that thinks
// instead of answering would just think longer.
const CUSTOM_MAX_TOKENS_CAP = 8192;

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

const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/**
 * Text of one content part. Gateways disagree on the shape: a plain string, an
 * array of `{type:'text',text}` parts (chat completions, Responses, Anthropic),
 * `{type:'text',text:{value}}` (SDK-typed parts), or a nested `content` array.
 */
function textOfPart(part) {
  if (typeof part === "string") return part;
  if (Array.isArray(part)) return part.map(textOfPart).join("");
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.text?.value === "string") return part.text.value;
  if (typeof part.content === "string") return part.content;
  if (Array.isArray(part.content)) return part.content.map(textOfPart).join("");
  return "";
}

/**
 * Text of one non-streaming body across the shapes OpenAI-compatible gateways
 * actually send: chat.completion (`choices[].message.content`), legacy
 * completions (`choices[].text`), Responses (`output_text` / `output[]`), and
 * the top-level `message` / `content` / `response` wrappers some proxies add.
 */
function textFromPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  const pieces = [
    textOfPart(choice?.message?.content),
    textOfPart(choice?.delta?.content),
    textOfPart(choice?.text),
    textOfPart(payload.output_text),
    Array.isArray(payload.output) ? payload.output.map(textOfPart).join("") : "",
    textOfPart(payload.message),
    textOfPart(payload.content),
    textOfPart(payload.response),
  ];
  return pieces.find((piece) => piece !== "") ?? "";
}

/** Concatenate the text deltas of an SSE stream (chat completions or Responses). */
function textFromSse(raw) {
  let text = "";
  for (const line of String(raw).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "" || data === "[DONE]") continue;
    const payload = parseJson(data);
    if (!payload) continue;
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    // A chunk normally carries a delta; a final one may carry the whole message.
    // Responses streams put the text in a bare `delta` string.
    text +=
      textOfPart(choice?.delta?.content) ||
      textOfPart(choice?.message?.content) ||
      textOfPart(choice?.text) ||
      textOfPart(payload.delta) ||
      textOfPart(payload.output_text);
  }
  return text;
}

const looksLikeSse = (body) => /^\s*data:/.test(body) || /\ndata:/.test(body);

/**
 * Text of a response body, whatever the endpoint wrapped it in: plain JSON, an
 * SSE stream, or plain JSON with a stray stream terminator appended. `parseJson`
 * is tried first so an SSE chunk is never mistaken for the whole answer.
 */
function textOfBody(raw) {
  const body = String(raw ?? "").trim();
  if (body === "") return "";
  const strict = parseJson(body);
  if (strict) {
    const text = textFromPayload(strict);
    if (text !== "") return text;
  }
  if (looksLikeSse(body)) {
    const text = textFromSse(body);
    if (text !== "") return text;
  }
  return textFromPayload(parseJsonLoose(body));
}

/** Stop reason and how much thinking an empty 200 carried. */
function emptyShape(raw) {
  const whole = parseJsonLoose(String(raw ?? "").trim());
  const choice = Array.isArray(whole?.choices) ? whole.choices[0] : null;
  const reasoning = choice?.message?.reasoning_content ?? choice?.delta?.reasoning_content ?? "";
  return {
    finish: choice?.finish_reason ?? whole?.finish_reason ?? null,
    reasoning: typeof reasoning === "string" ? reasoning.length : 0,
  };
}

/**
 * Why an empty 200 carried no text. Reported with the error so the settings card
 * can say what to change instead of only "no text".
 */
function describeEmptyBody(raw) {
  const body = String(raw ?? "").trim();
  if (body === "") return "the endpoint sent an empty body";
  const whole = parseJsonLoose(body);
  const choice = Array.isArray(whole?.choices) ? whole.choices[0] : null;
  if (whole?.error) return `the endpoint returned an error: ${oneLine(whole.error?.message ?? whole.error)}`;
  const finish = choice?.finish_reason ?? whole?.finish_reason ?? null;
  const reasoning = choice?.message?.reasoning_content ?? choice?.delta?.reasoning_content ?? "";
  if (finish === "length" && typeof reasoning === "string" && reasoning !== "") {
    // The trap: this model's reasoning grows with the budget, so a bigger
    // maxTokens buys more thinking, never an answer. The size makes that clear.
    return `finish_reason=length: the whole budget went to reasoning_content (${reasoning.length} chars) and no answer came back; disable thinking at the gateway or pick a non-thinking model (raising maxTokens only buys more thinking)`;
  }
  if (finish === "length") return "finish_reason=length: the token budget ran out before any answer, raise maxTokens or turn thinking off";
  if (typeof reasoning === "string" && reasoning !== "") return "only reasoning_content came back, the answer content is empty";
  return `unrecognised body: ${oneLine(body).slice(0, 200)}`;
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
  // "Do not think" has three spellings in the wild; a strict gateway may reject
  // an unknown field, so the widest shape goes first and a refusal narrows it.
  // The accepted shape is cached per endpoint for the rest of the process.
  const thinkingKey = `${baseUrl}\u0000${model}`;
  // Widest shape first; each refusal narrows it and the endpoint remembers where
  // it settled. "none" means it refused every spelling we know.
  let suppressed = thinking === false ? customThinkingCache.get(thinkingKey) ?? "full" : "none";
  // An answer cut off by the budget may fit a doubled one; escalating once keeps
  // "slightly too short" apart from "thinks until the budget is gone".
  let budget = maxTokens;
  let escalated = false;
  // Newer OpenAI models renamed the output budget from `max_tokens` to
  // `max_completion_tokens`; the first refusal flips this for the retry.
  let tokenField = "max_tokens";

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
        [tokenField]: budget,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        ...(json && schema
          ? { response_format: { type: "json_schema", json_schema: { name: "facts", strict: true, schema } } }
          : json
            ? { response_format: { type: "json_object" } }
            : {}),
        ...(suppressThinking ? THINKING_OFF_FIELDS[suppressThinking] : {}),
      }),
      signal: guard.signal,
    });
    const raw = await response.text().catch(() => "");
    if (response.ok) return { ok: true, content: textOfBody(raw), raw };
    return { ok: false, status: response.status, detail: raw.trim().slice(0, 300) };
  };

  try {
    let json = jsonMode;
    // A 200 with no text is sometimes a gateway refusing the requested output
    // shape without saying so; one retry without response_format separates that
    // from a model that simply produced nothing.
    let retriedPlain = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = await send({ json, suppressThinking: suppressed === "none" ? null : suppressed });
      if (result.ok) {
        if (typeof result.content === "string" && result.content !== "") {
          // Remember the narrowest shape that still answers, so the next call
          // starts there instead of re-probing the endpoint.
          if (thinking === false) customThinkingCache.set(thinkingKey, suppressed);
          return result.content;
        }
        const shape = emptyShape(result.raw);
        // A model whose reasoning grows with the budget will spend a bigger one
        // the same way: another call would only buy another empty answer.
        if (shape.finish === "length" && shape.reasoning > 0) {
          throw Object.assign(new Error(`custom model returned no text (${describeEmptyBody(result.raw)})`), { code: "custom_error" });
        }
        // A genuinely truncated answer may fit a doubled budget; try that once.
        if (shape.finish === "length" && !escalated && budget < CUSTOM_MAX_TOKENS_CAP) {
          escalated = true;
          budget = Math.min(budget * 2, CUSTOM_MAX_TOKENS_CAP);
          continue;
        }
        if (json && !retriedPlain) {
          json = false;
          retriedPlain = true;
          continue;
        }
        throw Object.assign(new Error(`custom model returned no text (${describeEmptyBody(result.raw)})`), { code: "custom_error" });
      }
      const text = `${result.status} ${result.detail}`;
      // A gateway that refuses the suppression fields still answers a plain
      // request; narrow the shape rather than dropping every switch at once.
      if (suppressed !== "none" && /unknown|unrecognized|unsupported|extra|invalid|unexpected|400|422/i.test(text)) {
        suppressed = suppressed === "full" ? "legacy" : "none";
        if (suppressed === "none") customThinkingCache.set(thinkingKey, "none");
        continue;
      }
      if (tokenField === "max_tokens" && /max_completion_tokens/i.test(text)) {
        tokenField = "max_completion_tokens";
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
