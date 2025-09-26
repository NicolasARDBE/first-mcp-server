// index.ts
// Run with:  ts-node src/index.ts  (or compile first)
// deps: npm i @modelcontextprotocol/sdk zod undici

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { httpCall} from "./helpers.js";

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