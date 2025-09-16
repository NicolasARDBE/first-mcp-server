// index.ts
// Run with:  ts-node src/index.ts  (or compile first)
// deps: npm i @modelcontextprotocol/sdk zod undici

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { request } from "undici"; // modern, robust fetch for Node

// ---------- Config (env or defaults) ----------
const BASE_URL = process.env.API_BASE_URL ?? "https://api.example.com";
const API_TOKEN = process.env.API_TOKEN ?? ""; // e.g., "Bearer xyz"
const DEFAULT_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS ?? 12000);
const MAX_RETRIES = Number(process.env.API_MAX_RETRIES ?? 2);

// ---------- Utility: tiny helpers ----------
const redactHeaders = (headers: Record<string, string>) => {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    h[k] = lower.includes("authorization") || lower.includes("api-key") ? "🔒[redacted]" : v;
  }
  return h;
};

// naive dot-path (supports a.b[0].c)
function getByDotPath(obj: unknown, path: string): unknown {
  if (path === "" || path === ".") return obj;
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean)
    .reduce<any>((acc, key) => (acc != null ? acc[key] : undefined), obj as any);
}

function asJsonMaybe(text: string) {
  try { return JSON.parse(text); } catch { return undefined; }
}

// Core HTTP with retries and timeout using undici
async function httpCall(opts: {
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

      // Normalize headers to a simple record
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
        // jittered backoff
        await delay(150 * (attempt + 1) + Math.random() * 200);
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

// ---------- MCP Server ----------
const server = new McpServer({
  name: "API Tester MCP",
  version: "2.0.0",
});

// (keep your arithmetic tool as an example)
server.tool(
  "add",
  { a: z.number(), b: z.number() },
  async ({ a, b }) => ({
    content: [{ type: "text", text: String(a + b) }],
  })
);

server.tool(
  "sub",
  { a: z.number(), b: z.number() },
  async ({ a, b }) => ({
    content: [{ type: "text", text: String(a - b) }],
  })
);

// ---------- New Tools ----------
// 1) Generic HTTP request tool
server.tool(
  "http_request",
  {
    url: z.string().url(),
    method: z.enum(["GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS"]).optional(),
    headers: z.record(z.string()).optional(),
    query: z.record(z.string()).optional(),
    body: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
  },
  async (args, _extra) => {
    // Guard (helps during inspector experiments)
    if (!args.url) {
      return {
        isError: true,
        content: [{ type: "text", text: 'Missing required "url" (absolute URL).' }],
      };
    }

    const method = args.method ?? "GET";

    // Optional: coerce query from strings → number/bool when obvious
    const normQuery: Record<string, string | number | boolean> | undefined =
      args.query
        ? Object.fromEntries(
            Object.entries(args.query).map(([k, v]) => {
              if (v === "true") return [k, true];
              if (v === "false") return [k, false];
              const n = Number(v);
              return Number.isFinite(n) && v.trim() !== "" ? [k, n] : [k, v];
            })
          )
        : undefined;

    const res = await httpCall({
      url: args.url,
      method,
      headers: args.headers,
      query: normQuery,
      body: args.body,                 // treat as text; JSON is fine if you pass a stringified body
      timeoutMs: args.timeoutMs,
    });

    const summary = `HTTP ${method} ${res.url} → ${res.status} in ${res.latencyMs}ms`;
    const bodyPreview = (res.json ? JSON.stringify(res.json, null, 2) : res.text) ?? "";
    const trimmed = bodyPreview.length > 8000 ? bodyPreview.slice(0, 8000) + "…[truncated]" : bodyPreview;

    return {
      content: [
        { type: "text", text: `✅ ${summary}` },
        { type: "text", text: "Response preview:\n```json\n" + trimmed + "\n```" },
      ],
      // Machine-readable details for clients/agents:
      structuredContent: {
        ok: res.ok,
        status: res.status,
        latencyMs: res.latencyMs,
        headers: res.headers,
        request: { method: res.method, headers: res.requestHeaders, url: res.url },
        bodyJson: res.json ?? null,
        bodyTextPreview: trimmed,
        error: (res as any).error ?? null,
      },
    };
  }
);

// ---------- Resources ----------

// Dynamic greeting (your original)
server.resource(
  "greeting",
  new ResourceTemplate("greeting://{name}", { list: undefined }),
  async (uri, { name }) => ({
    contents: [{ uri: uri.href, text: `Hello, ${name}!` }],
  })
);

// ---------- Wire up stdio ----------
const transport = new StdioServerTransport();
server.connect(transport);