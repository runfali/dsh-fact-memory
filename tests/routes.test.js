import assert from "node:assert/strict";
import { test } from "node:test";
import { requestRefusal } from "../src/routes.js";

function request(host, { origin = null, type = "application/json" } = {}) {
  const headers = new Map([
    ["host", host],
    ["content-type", type],
  ]);
  if (origin !== null) headers.set("origin", origin);
  return { headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null } };
}

test("loopback and private IP hosts are trusted without configuration", () => {
  for (const host of ["127.0.0.1:36664", "localhost:36664", "[::1]:36664", "10.0.0.5:36664", "192.168.1.9:36664"]) {
    assert.equal(requestRefusal(request(host)), null, host);
  }
});

test("a hostname is refused unless it is listed explicitly", () => {
  const previous = process.env.DSH_FACT_MEMORY_ALLOWED_HOSTS;
  try {
    delete process.env.DSH_FACT_MEMORY_ALLOWED_HOSTS;
    assert.equal(requestRefusal(request("evil.example:36664", { origin: "http://evil.example:36664" }))?.status, 403);
    process.env.DSH_FACT_MEMORY_ALLOWED_HOSTS = "gui.example, other.example";
    assert.equal(requestRefusal(request("gui.example:36664", { origin: "http://gui.example:36664" })), null);
  } finally {
    if (previous === undefined) delete process.env.DSH_FACT_MEMORY_ALLOWED_HOSTS;
    else process.env.DSH_FACT_MEMORY_ALLOWED_HOSTS = previous;
  }
});

test("a cross-site Origin is refused even on a trusted host", () => {
  assert.equal(requestRefusal(request("127.0.0.1:36664", { origin: "http://evil.example" }))?.status, 403);
});

test("a non-JSON body is refused before it is parsed", () => {
  assert.equal(requestRefusal(request("127.0.0.1:36664", { type: "text/plain" }))?.status, 415);
});
