import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod";
import { httpCall} from "./helpers.js";

const app = express();
app.use(express.json());

// Map to store transports by session ID
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

// Handle POST requests for client-to-server communication
app.post('/mcp', async (req, res) => {
  // Check for existing session ID
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    // Reuse existing transport
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    // New initialization request
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        // Store the transport by session ID
        transports[sessionId] = transport;
      },

      // DNS rebinding protection is disabled by default for backwards compatibility. If you are running this server
      // locally, make sure to set:
        enableDnsRebindingProtection: true,
        allowedHosts: ["localhost", "localhost:3000", "127.0.0.1", "127.0.0.1:3000"]
    });

    // Clean up transport when closed
    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
      }
    };
    const server = new McpServer({
      name: "API Tester MCP HTTPS",
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


    // Connect to the MCP server
    await server.connect(transport);
  } else {
    // Invalid request
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Bad Request: No valid session ID provided',
      },
      id: null,
    });
    return;
  }

  // Handle the request
  await transport.handleRequest(req, res, req.body);
});

// Reusable handler for GET and DELETE requests
const handleSessionRequest = async (req: express.Request, res: express.Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  
  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
};

// Handle GET requests for server-to-client notifications via SSE
app.get('/mcp', handleSessionRequest);

// Handle DELETE requests for session termination
app.delete('/mcp', handleSessionRequest);

app.listen(3000);