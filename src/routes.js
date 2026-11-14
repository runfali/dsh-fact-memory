/**
 * One POST route helper for the settings card, plus the access check it needs.
 *
 * `/api` exact routes registered through `connection.fetch` bypass the host's
 * browser-auth gate, so a route that only parses its body is reachable from any
 * page in the browser (CSRF). The check below is the minimum for a same-origin,
 * JSON-only endpoint: refuse a non-JSON content type, refuse a cross-site
 * `Origin` (and `Origin: null`), refuse a cross-site `Sec-Fetch-Site`, and judge
 * same-origin against the `Host` header — the host bridges every request through
 * a synthetic base URL, so `request.url` never names the browser's origin.
 */
export const ROUTE_VERSION = 1;

const JSON_TYPE = "application/json";

export function oneLine(error) {
  const text = String(error?.message ?? error ?? "").replace(/\s+/g, " ").trim();
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

export function jsonBody(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const headerOf = (request, name) => (typeof request?.headers?.get === "function" ? request.headers.get(name) : null);

// A same-origin check (Origin === Host) does not stop DNS rebinding: an attacker
// page served from evil.example resolves to 127.0.0.1, and the browser then sends
// Host and Origin as evil.example for what it believes is its own origin. The
// Host header therefore has to be trusted on its own. Loopback, private and
// link-local IP literals are accepted (a remote GUI reached by IP keeps working);
// a hostname must be listed explicitly in this environment variable.
const HOSTS_ENV = "DSH_FACT_MEMORY_ALLOWED_HOSTS";

function hostName(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "") return "";
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end > 1 ? raw.slice(1, end) : "";
  }
  const colon = raw.lastIndexOf(":");
  return colon > 0 ? raw.slice(0, colon) : raw;
}

function isPrivateAddress(name) {
  if (name === "localhost" || name === "::1" || name === "0:0:0:0:0:0:0:1") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  return /^f[cd][0-9a-f]{0,2}:/.test(name) || /^fe[89ab][0-9a-f]?:/.test(name);
}

function hostAllowed(value) {
  const name = hostName(value);
  if (name === "") return false;
  if (isPrivateAddress(name)) return true;
  const extra = String(process.env[HOSTS_ENV] ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return extra.includes(name);
}

function parseUrl(value) {
  try {
    return new URL(String(value));
  } catch {
    return null;
  }
}

export function requestRefusal(request) {
  const host = headerOf(request, "host");
  if (host === null || !hostAllowed(host)) return { status: 403, error: "untrusted host" };
  const type = String(headerOf(request, "content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (type !== JSON_TYPE) return { status: 415, error: "expected a JSON request body" };
  const site = String(headerOf(request, "sec-fetch-site") ?? "").toLowerCase();
  if (site !== "" && site !== "same-origin" && site !== "none") return { status: 403, error: "cross-site request refused" };
  const origin = headerOf(request, "origin");
  if (origin !== null) {
    const claimed = String(origin).trim();
    if (claimed === "" || claimed === "null") return { status: 403, error: "cross-site request refused" };
    const host = String(headerOf(request, "host") ?? "").trim().toLowerCase();
    const claimedUrl = parseUrl(claimed);
    if (claimedUrl === null || claimedUrl.host.toLowerCase() !== host) return { status: 403, error: "cross-site request refused" };
  }
  return null;
}

function warn(ctx, message) {
  try {
    if (typeof ctx?.logger?.warn === "function") ctx.logger.warn(message);
  } catch {
    /* logging must never break apply() */
  }
}

/**
 * Register one POST route whose body is built by `build(body)`.
 * Capturing a broken route must cost the settings card one line, never apply().
 */
export function registerJsonRoute(ctx, { path, build, guard, label }) {
  if (typeof ctx?.inject !== "function") {
    warn(ctx, `dsh-fact-memory: ${path} not registered (no ctx.inject)`);
    return false;
  }
  const handler = async (request) => {
    const refusal = requestRefusal(request);
    if (refusal) return jsonBody({ version: ROUTE_VERSION, ok: false, error: refusal.error }, refusal.status);
    let body = {};
    try {
      const text = typeof request.text === "function" ? await request.text() : "";
      body = text ? JSON.parse(text) : {};
    } catch {
      return jsonBody({ version: ROUTE_VERSION, ok: false, error: "invalid JSON body" }, 400);
    }
    try {
      // A mutating route may declare a guard: it sees the body, decides whether
      // the page is still looking at a generation that exists, and calls run()
      // only then. Unread routes never pay for it.
      const result = typeof guard === "function" ? await guard(body, () => build(body)) : await build(body);
      return jsonBody({ version: ROUTE_VERSION, ...result });
    } catch (error) {
      warn(ctx, `dsh-fact-memory: ${path} failed: ${oneLine(error)}`);
      return jsonBody({ version: ROUTE_VERSION, ok: false, error: oneLine(error) }, 500);
    }
  };
  try {
    ctx.inject(["connection"], (scoped) => {
      try {
        const register = scoped?.connection?.fetch?.register;
        if (typeof register !== "function") {
          warn(ctx, `dsh-fact-memory: ${path} not registered (connection.fetch.register missing)`);
          return;
        }
        scoped.effect(
          () => scoped.connection.fetch.register({ path, methods: ["POST"], requestBody: "buffered", fetch: handler }),
          label ?? `dsh-fact-memory: ${path}`,
        );
      } catch (error) {
        warn(ctx, `dsh-fact-memory: ${path} not registered: ${oneLine(error)}`);
      }
    });
  } catch (error) {
    warn(ctx, `dsh-fact-memory: ${path} not registered: ${oneLine(error)}`);
    return false;
  }
  return true;
}
