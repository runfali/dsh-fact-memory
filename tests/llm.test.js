import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { callCustomText } from "../src/llm.js";

/**
 * Serve one reply per request (a function receives the request index) and keep
 * every request body, so a test can assert both the answer and what was sent.
 */
async function serve(replies) {
  const state = { bodies: [] };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      state.bodies.push(JSON.parse(body));
      const index = state.bodies.length - 1;
      const reply = typeof replies === "function" ? replies(index, state.bodies[index]) : replies[Math.min(index, replies.length - 1)];
      const status = reply && typeof reply === "object" ? reply.status ?? 200 : 200;
      const text = reply && typeof reply === "object" ? reply.text : reply;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(text);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${server.address().port}/v1`;
  state.close = () => new Promise((resolve) => server.close(resolve));
  return state;
}

const ask = (url, extra = {}) =>
  callCustomText({ baseUrl: url, model: "small", apiKeyEnv: "" }, { system: "s", prompt: "p", timeoutMs: 5000, ...extra });

const body = (payload) => JSON.stringify(payload);

test("a JSON body followed by a stray SSE terminator still yields its text", async () => {
  // What the gateway on 10.200.0.5:20128 does: a complete chat.completion body
  // with `data: [DONE]` appended, which used to fail JSON.parse and surface as
  // "custom model returned no text".
  const server = await serve([`${body({ choices: [{ message: { content: '{"facts":[]}' } }] })}data: [DONE]\n\n`]);
  try {
    assert.equal(await ask(server.url), '{"facts":[]}');
  } finally {
    await server.close();
  }
});

test("content parts, legacy completions and Responses bodies are all understood", async () => {
  const parts = body({ choices: [{ message: { content: [{ type: "text", text: '{"facts"' }, { type: "text", text: ":[]}" }] } }] });
  const legacy = body({ choices: [{ text: '{"facts":[]}' }] });
  const responses = body({ output: [{ content: [{ type: "text", text: '{"facts":[]}' }] }] });
  const flat = body({ output_text: '{"facts":[]}' });
  for (const reply of [parts, legacy, responses, flat]) {
    const server = await serve([reply]);
    try {
      assert.equal(await ask(server.url), '{"facts":[]}');
    } finally {
      await server.close();
    }
  }
});

test("an SSE stream whose deltas carry content parts still yields its text", async () => {
  const chunk = body({ choices: [{ delta: { content: [{ type: "text", text: '{"facts":[]}' }] } }] });
  const server = await serve([`\n\ndata: ${chunk}\n\ndata: [DONE]\n\n`]);
  try {
    assert.equal(await ask(server.url), '{"facts":[]}');
  } finally {
    await server.close();
  }
});

test("an empty answer is retried once without response_format", async () => {
  const server = await serve((index) =>
    index === 0 ? body({ choices: [{ message: { content: "" } }] }) : body({ choices: [{ message: { content: '{"facts":[]}' } }] }),
  );
  try {
    assert.equal(await ask(server.url), '{"facts":[]}');
    assert.equal(server.bodies.length, 2);
    assert.deepEqual(server.bodies[0].response_format, { type: "json_object" });
    assert.equal(server.bodies[1].response_format, undefined);
  } finally {
    await server.close();
  }
});

test("an answer that only fills reasoning_content says so", async () => {
  const server = await serve([
    body({ choices: [{ message: { content: "", reasoning_content: "let me think about the facts" }, finish_reason: "stop" }] }),
  ]);
  try {
    await assert.rejects(() => ask(server.url), /reasoning_content/);
  } finally {
    await server.close();
  }
});

test("a token-budget stop with no content names the budget instead of the body", async () => {
  const server = await serve([body({ choices: [{ message: { content: "" }, finish_reason: "length" }] })]);
  try {
    await assert.rejects(() => ask(server.url), /maxTokens/);
  } finally {
    await server.close();
  }
});

test("a model that rejects max_tokens is retried with max_completion_tokens", async () => {
  const server = await serve((index, sent) =>
    sent.max_completion_tokens !== undefined
      ? body({ choices: [{ message: { content: '{"facts":[]}' } }] })
      : { status: 400, text: body({ error: { message: "Unsupported parameter: max_tokens. Use max_completion_tokens instead." } }) },
  );
  try {
    assert.equal(await ask(server.url), '{"facts":[]}');
    const last = server.bodies[server.bodies.length - 1];
    assert.equal(last.max_completion_tokens, 2048);
    assert.equal(last.max_tokens, undefined);
  } finally {
    await server.close();
  }
});

test("a 200 carrying an error payload reports the endpoint's own message", async () => {
  const server = await serve([body({ error: { message: "quota exceeded" } })]);
  try {
    await assert.rejects(() => ask(server.url), /quota exceeded/);
  } finally {
    await server.close();
  }
});

test("thinking is switched off with every known spelling and the accepted one is remembered", async () => {
  const server = await serve([body({ choices: [{ message: { content: '{"facts":[]}' }, finish_reason: "stop" }] })]);
  try {
    assert.equal(await ask(server.url), '{"facts":[]}');
    const first = server.bodies[0];
    // The model behind "custom model returned no text" ignores reasoning_effort
    // and only obeys chat_template_kwargs; all three spellings go out together.
    assert.deepEqual(first.chat_template_kwargs, { enable_thinking: false });
    assert.equal(first.enable_thinking, false);
    assert.equal(first.reasoning_effort, "none");
    // The widest shape was accepted, so the next call starts there instead of
    // probing the endpoint again.
    assert.equal(await ask(server.url), '{"facts":[]}');
    assert.deepEqual(server.bodies[1].chat_template_kwargs, { enable_thinking: false });
    assert.equal(server.bodies.length, 2);
  } finally {
    await server.close();
  }
});

test("a gateway that refuses the thinking-off fields narrows the spelling instead of failing", async () => {
  const server = await serve((index, sent) =>
    sent.chat_template_kwargs !== undefined || sent.enable_thinking !== undefined
      ? { status: 400, text: body({ error: { message: "Unrecognized request argument supplied" } }) }
      : body({ choices: [{ message: { content: '{"facts":[]}' } }] }),
  );
  try {
    assert.equal(await ask(server.url), '{"facts":[]}');
    // full → legacy → none: each refusal drops the fields the endpoint choked on.
    assert.equal(server.bodies.length, 3);
    assert.deepEqual(server.bodies[0].chat_template_kwargs, { enable_thinking: false });
    assert.equal(server.bodies[1].chat_template_kwargs, undefined);
    assert.equal(server.bodies[1].enable_thinking, false);
    assert.equal(server.bodies[2].enable_thinking, undefined);
    assert.equal(server.bodies[2].reasoning_effort, undefined);
  } finally {
    await server.close();
  }
});

test("a truncated answer gets one doubled budget before any retry without response_format", async () => {
  const server = await serve((index) =>
    index === 0
      ? body({ choices: [{ message: { content: "" }, finish_reason: "length" }] })
      : body({ choices: [{ message: { content: '{"facts":[]}' } }] }),
  );
  try {
    assert.equal(await ask(server.url, { maxTokens: 1024 }), '{"facts":[]}');
    assert.deepEqual(server.bodies.map((sent) => sent.max_tokens), [1024, 2048]);
  } finally {
    await server.close();
  }
});

test("a model that spends the whole budget thinking is reported, never retried", async () => {
  const server = await serve([
    body({ choices: [{ message: { content: "", reasoning_content: "x".repeat(1200) }, finish_reason: "length" }] }),
  ]);
  try {
    await assert.rejects(() => ask(server.url, { maxTokens: 512 }), /reasoning_content \(1200 chars\)/);
    // A bigger budget is only more thinking for this model, so no second call.
    assert.equal(server.bodies.length, 1);
    assert.equal(server.bodies[0].max_tokens, 512);
  } finally {
    await server.close();
  }
});
