// helpers.ts
import { setTimeout as delay } from "node:timers/promises";
import { request } from "undici";

// ---------- Config (env or defaults) ----------
const BASE_URL = process.env.API_BASE_URL ?? "https://api.example.com";
const API_TOKEN = process.env.API_TOKEN ?? ""; // e.g., "Bearer xyz"
const DEFAULT_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS ?? 12000);
const MAX_RETRIES = Number(process.env.API_MAX_RETRIES ?? 2);

// ---------- Utility: tiny helpers ----------
export const redactHeaders = (headers: Record<string, string>) => {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    h[k] = lower.includes("authorization") || lower.includes("api-key")
      ? "🔒[redacted]"
      : v;
  }
  return h;
};

// naive dot-path (supports a.b[0].c)
export function getByDotPath(obj: unknown, path: string): unknown {
  if (path === "" || path === ".") return obj;
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean)
    .reduce<any>((acc, key) => (acc != null ? acc[key] : undefined), obj as any);
}

export function asJsonMaybe(text: string) {
  try { return JSON.parse(text); } catch { return undefined; }
}

// Core HTTP with retries and timeout using undici
export async function httpCall(opts: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  timeoutMs?: number;
}) {
  const { url, method, headers = {}, query, body, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  const qs =
    query && Object.keys(query).length
      ? "?" +
        Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join("&")
      : "";

  const target = url + qs;

  const payload =
    body == null
      ? undefined
      : typeof body === "string"
      ? body
      : JSON.stringify(body);

  const finalHeaders: Record<string, string> = {
    "user-agent": "mcp-api-tester/1.0",
    ...(payload ? { "content-type": "application/json" } : {}),
    ...(API_TOKEN ? { authorization: API_TOKEN } : {}),
    ...headers,
  };

  let lastErr: unknown;
  const started = Date.now();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(new Error("timeout")), timeoutMs);

      const res = await request(target, {
        method,
        headers: finalHeaders,
        body: payload,
        signal: ctl.signal,
      });

      clearTimeout(t);

      const text = await res.body.text();
      const json = asJsonMaybe(text);
      const latencyMs = Date.now() - started;

      const hdrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        hdrs[k] = Array.isArray(v) ? v.join(", ") : String(v);
      }

      return {
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        latencyMs,
        headers: hdrs,
        text,
        json,
        url: target,
        method,
        requestHeaders: redactHeaders(finalHeaders),
      };
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await delay(150 * (attempt + 1) + Math.random() * 200); // jittered backoff
        continue;
      }
    }
  }

  const latencyMs = Date.now() - started;

  return {
    ok: false,
    status: 0,
    latencyMs,
    headers: {},
    text: "",
    json: undefined,
    url: target,
    method,
    requestHeaders: redactHeaders(finalHeaders),
    error: String(lastErr instanceof Error ? lastErr.message : lastErr),
  };
}
