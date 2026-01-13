/**
 * World Cup 2026 MCP Server — HTTP-based
 *
 * Implements proper MCP protocol over HTTP:
 * - POST /mcp → MCP JSON-RPC endpoint (initialize, tools/list, tools/call)
 * - POST /rpc → Direct tool calls (for the React app)
 * - GET /ui/worldcup/* → HTML MCP App views
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// UI resource URI key for metadata (SEP-1865)
const UI_RESOURCE_URI_KEY = "ui/resourceUri";
import {
  Bracket,
  GroupPrediction,
  KnockoutSlot,
  KnockoutSlotSource,
  ResolvedBracket,
  WorldCupPrediction,
} from "../shared/types";
import { bracketTemplate } from "./bracket-template";
import { groups, teams, playoffSlots } from "./teams";

// --------------------------------------------------------------------------
// In-memory prediction store
// --------------------------------------------------------------------------
let savedPrediction: WorldCupPrediction | null = null;

const defaultGroupPredictions = (): GroupPrediction[] =>
  groups.map((group) => ({
    groupId: group.id,
    positions: {
      1: "" as string,
      2: "" as string,
      3: "" as string,
      4: "" as string,
    },
  }));

const emptyKnockout = () => ({ winnersByMatchId: {} });

const defaultPrediction = (): WorldCupPrediction => ({
  groups: defaultGroupPredictions(),
  thirdPlaceSelection: {
    advancingThirdPlaceTeamIds: [],
  },
  knockout: emptyKnockout(),
});

// --------------------------------------------------------------------------
// Bracket resolution logic
// --------------------------------------------------------------------------
const resolveSource = (
  source: KnockoutSlotSource | undefined,
  prediction: WorldCupPrediction
): string | undefined => {
  if (!source) return undefined;

  switch (source.type) {
    case "group-position": {
      const group = prediction.groups.find((g) => g.groupId === source.groupId);
      return group?.positions[source.position];
    }
    case "third-ranked": {
      return prediction.thirdPlaceSelection.advancingThirdPlaceTeamIds[source.rankIndex];
    }
    case "winner-of-match": {
      return prediction.knockout.winnersByMatchId[source.matchId];
    }
    default:
      return undefined;
  }
};

const resolveSlotTeamId = (
  slot: KnockoutSlot,
  prediction: WorldCupPrediction
): string | undefined => {
  return resolveSource(slot.source, prediction);
};

const resolveBracket = (prediction: WorldCupPrediction): ResolvedBracket => {
  const matches = bracketTemplate.matches.map((match) => ({
    ...match,
    homeTeamId: resolveSlotTeamId(match.homeSlot, prediction),
    awayTeamId: resolveSlotTeamId(match.awaySlot, prediction),
  }));
  return { matches };
};

// --------------------------------------------------------------------------
// MCP Tool definitions
// --------------------------------------------------------------------------
interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  _meta?: Record<string, unknown>;
}

// SEP-1865: Tools that return a UI should include _meta["ui/resourceUri"]
const mcpTools: McpTool[] = [
  {
    name: "worldcup.getInitialData",
    description: "Return teams, groups, bracket template, and any saved prediction. Opens the World Cup prediction UI.",
    inputSchema: {
      type: "object",
      properties: {
        includeSaved: {
          type: "boolean",
          description: "Whether to include saved prediction",
        },
      },
    },
    _meta: {
      "ui/resourceUri": "ui://worldcup/groups",
    },
  },
  {
    name: "worldcup.savePrediction",
    description: "Persist a World Cup prediction (in-memory).",
    inputSchema: {
      type: "object",
      properties: {
        prediction: {
          type: "object",
          description: "The WorldCupPrediction object to save",
        },
      },
      required: ["prediction"],
    },
  },
];

// --------------------------------------------------------------------------
// Tool handlers
// --------------------------------------------------------------------------
type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

const toolHandlers: Record<string, ToolHandler> = {
  "worldcup.getInitialData": async () => {
    const prediction = savedPrediction ?? defaultPrediction();
    return {
      data: { teams, groups, bracketTemplate, prediction, playoffSlots },
      metadata: { [UI_RESOURCE_URI_KEY]: "ui://worldcup/groups" },
    };
  },

  // Private tool for widget - NO ui/resourceUri (won't trigger UI reload)
  // Per SEP-1865: "MCP servers MAY expose private tools specifically designed for UI interaction"
  "worldcup.getDataForWidget": async () => {
    const prediction = savedPrediction ?? defaultPrediction();
    return {
      data: { teams, groups, bracketTemplate, prediction, playoffSlots },
      // NO metadata with ui/resourceUri - this prevents MCP Jam from reloading the UI
    };
  },

  "worldcup.savePrediction": async (args) => {
    const incoming = args.prediction as WorldCupPrediction;
    if (!incoming) throw new Error("Missing prediction parameter");
    if (incoming.thirdPlaceSelection.advancingThirdPlaceTeamIds.length !== 8) {
      throw new Error("thirdPlaceSelection must contain exactly 8 team ids");
    }
    savedPrediction = incoming;
    return { ok: true, summary: "Prediction saved", snapshot: incoming };
  },
};

// --------------------------------------------------------------------------
// MCP Protocol Handler
// --------------------------------------------------------------------------
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const SERVER_INFO = {
  name: "worldcup-2026",
  version: "1.0.0",
};

/**
 * Build the self-contained HTML for a given UI resource.
 * Reads index.html and inlines all JS/CSS assets.
 */
const buildMcpAppHtml = (resourceUri: string): string => {
  const indexPath = path.join(UI_DIST, "index.html");
  let html = fs.readFileSync(indexPath, "utf-8");

  // Find and inline the JS asset
  const jsMatch = html.match(/<script type="module" crossorigin src="(\/assets\/[^"]+\.js)"><\/script>/);
  if (jsMatch && jsMatch[1]) {
    const jsFilePath = path.join(UI_DIST, jsMatch[1]);
    const jsContent = fs.readFileSync(jsFilePath, "utf-8");
    html = html.replace(jsMatch[0], () => `<script type="module">${jsContent}</script>`);
  }

  // Find and inline the CSS asset
  const cssMatch = html.match(/<link rel="stylesheet" crossorigin href="(\/assets\/[^"]+\.css)">/);
  if (cssMatch && cssMatch[1]) {
    const cssFilePath = path.join(UI_DIST, cssMatch[1]);
    const cssContent = fs.readFileSync(cssFilePath, "utf-8");
    html = html.replace(cssMatch[0], () => `<style>${cssContent}</style>`);
  }

  // Inject the resource URI
  html = html.replace(
    "</head>",
    () => `<script>window.__MCP_RESOURCE_URI__ = "${resourceUri}";</script></head>`
  );

  return html;
};

// MCP UI Resources - using text/html+mcp as per mcp-apps-everything
const MCP_RESOURCES = [
  { uri: "ui://worldcup/groups", name: "World Cup Groups", mimeType: "text/html+mcp" },
  { uri: "ui://worldcup/third-place", name: "Third Place Selection", mimeType: "text/html+mcp" },
  { uri: "ui://worldcup/bracket", name: "Knockout Bracket", mimeType: "text/html+mcp" },
];


const handleMcpRequest = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
  const id = req.id ?? null;
  console.log(`[MCP] ${req.method}`, req.params ? JSON.stringify(req.params).slice(0, 100) : "");

  switch (req.method) {
    case "initialize": {
      // SEP-1865: Advertise the UI extension capability
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
            // Advertise MCP Apps UI extension
            extensions: {
              "io.modelcontextprotocol/ui": {
                mimeTypes: ["text/html+mcp"],
              },
            },
          },
          serverInfo: SERVER_INFO,
        },
      };
    }

    case "notifications/initialized": {
      return { jsonrpc: "2.0", id, result: {} };
    }

    case "tools/list": {
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: mcpTools },
      };
    }

    case "tools/call": {
      const params = req.params as { name: string; arguments?: Record<string, unknown> };
      const toolName = params?.name;
      const toolArgs = params?.arguments ?? {};

      const handler = toolHandlers[toolName];
      if (!handler) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unknown tool: ${toolName}` },
        };
      }

      try {
        const result = await handler(toolArgs);
        
        // SEP-1865: Find the tool definition to get its _meta
        const toolDef = mcpTools.find((t) => t.name === toolName);
        const toolMeta = toolDef?._meta;
        
        // Build the response with _meta at the result level (not inside content)
        const response: JsonRpcResponse = {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            // Include _meta at the result level for MCP Apps UI rendering
            ...(toolMeta ? { _meta: toolMeta } : {}),
          },
        };
        
        console.log(`[MCP] tools/call ${toolName} response _meta:`, toolMeta);
        return response;
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: (err as Error).message },
        };
      }
    }

    case "resources/list": {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resources: MCP_RESOURCES.map((r) => ({
            uri: r.uri,
            name: r.name,
            mimeType: r.mimeType,
          })),
        },
      };
    }

    case "resources/read": {
      const params = req.params as { uri: string };
      const uri = params?.uri;
      console.log(`[MCP] resources/read - URI: ${uri}`);
      
      const resource = MCP_RESOURCES.find((r) => r.uri === uri);
      if (!resource) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown resource: ${uri}` },
        };
      }

      try {
        const html = buildMcpAppHtml(uri);
        console.log(`[MCP] resources/read - Built HTML, length: ${html.length}, starts with: ${html.slice(0, 50)}`);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [
              {
                uri: resource.uri,
                mimeType: resource.mimeType,
                text: html,
                // SEP-1865: Include UI metadata
                _meta: {
                  ui: {
                    csp: {
                      connectDomains: [],
                      resourceDomains: [],
                    },
                    prefersBorder: false,
                  },
                },
              },
            ],
          },
        };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: `Failed to build resource: ${(err as Error).message}` },
        };
      }
    }

    case "ping": {
      return { jsonrpc: "2.0", id, result: {} };
    }

    case "prompts/list": {
      // Return empty prompts list - we don't have any prompts
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    }

    case "logging/setLevel": {
      // Acknowledge logging level change
      return { jsonrpc: "2.0", id, result: {} };
    }

    default: {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      };
    }
  }
};

// Direct JSON-RPC handler for React app
const handleDirectRpc = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
  const id = req.id ?? null;
  const handler = toolHandlers[req.method];
  
  if (!handler) {
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${req.method}` } };
  }
  
  try {
    const result = await handler(req.params ?? {});
    return { jsonrpc: "2.0", id, result };
  } catch (err) {
    return { jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message } };
  }
};

const parseJsonRpc = (body: string): JsonRpcRequest | JsonRpcRequest[] | null => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};

// --------------------------------------------------------------------------
// Static file serving
// --------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_DIST = path.resolve(__dirname, "../ui/dist");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const serveStatic = (res: http.ServerResponse, filePath: string) => {
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    fs.createReadStream(filePath).pipe(res);
  });
};

/**
 * Serve MCP App HTML with inlined CSS and JS assets.
 * This is required for MCP Jam and other MCP clients that render
 * the HTML in a sandboxed environment without access to external URLs.
 */
const serveMcpAppHtml = (res: http.ServerResponse, resourceUri: string) => {
  const indexPath = path.join(UI_DIST, "index.html");
  
  fs.readFile(indexPath, "utf-8", (err, html) => {
    if (err) {
      console.error("Failed to read index.html:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load MCP App HTML");
      return;
    }

    try {
      // Find and inline the JS asset
      const jsMatch = html.match(/<script type="module" crossorigin src="(\/assets\/[^"]+\.js)"><\/script>/);
      if (jsMatch && jsMatch[1]) {
        const jsFilePath = path.join(UI_DIST, jsMatch[1]);
        const jsContent = fs.readFileSync(jsFilePath, "utf-8");
        // Use function replacement to avoid $ pattern interpretation
        html = html.replace(jsMatch[0], () => `<script type="module">${jsContent}</script>`);
      }

      // Find and inline the CSS asset
      const cssMatch = html.match(/<link rel="stylesheet" crossorigin href="(\/assets\/[^"]+\.css)">/);
      if (cssMatch && cssMatch[1]) {
        const cssFilePath = path.join(UI_DIST, cssMatch[1]);
        const cssContent = fs.readFileSync(cssFilePath, "utf-8");
        // Use function replacement to avoid $ pattern interpretation
        html = html.replace(cssMatch[0], () => `<style>${cssContent}</style>`);
      }

      // Inject the resource URI for the app to detect which view to render
      html = html.replace(
        "</head>",
        () => `<script>window.__MCP_RESOURCE_URI__ = "${resourceUri}";</script></head>`
      );

      res.writeHead(200, { "Content-Type": "text/html+mcp" });
      res.end(html);
    } catch (inlineErr) {
      console.error("Failed to inline assets:", inlineErr);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to inline assets for MCP App HTML");
    }
  });
};

// --------------------------------------------------------------------------
// HTTP Server
// --------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT ?? "3000", 10);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // MCP Protocol endpoint (for MCP clients like Cursor)
  if ((pathname === "/mcp" || pathname === "/") && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    
    const parsed = parseJsonRpc(body);
    if (!parsed) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      return;
    }

    if (Array.isArray(parsed)) {
      const responses = await Promise.all(parsed.map(handleMcpRequest));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responses));
    } else {
      const response = await handleMcpRequest(parsed);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    }
    return;
  }

  // Direct RPC endpoint (for React app)
  if (pathname === "/rpc" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    
    const parsed = parseJsonRpc(body);
    if (!parsed) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      return;
    }

    if (Array.isArray(parsed)) {
      const responses = await Promise.all(parsed.map(handleDirectRpc));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responses));
    } else {
      const response = await handleDirectRpc(parsed);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    }
    return;
  }

  // MCP App UI routes
  if (pathname === "/ui/worldcup/groups" || pathname === "/ui/worldcup/groups/") {
    serveMcpAppHtml(res, "ui://worldcup/groups");
    return;
  }
  if (pathname === "/ui/worldcup/third-place" || pathname === "/ui/worldcup/third-place/") {
    serveMcpAppHtml(res, "ui://worldcup/third-place");
    return;
  }
  if (pathname === "/ui/worldcup/bracket" || pathname === "/ui/worldcup/bracket/") {
    serveMcpAppHtml(res, "ui://worldcup/bracket");
    return;
  }

  // UI redirects
  if (pathname === "/ui" || pathname === "/ui/" || pathname === "/ui/worldcup" || pathname === "/ui/worldcup/") {
    res.writeHead(302, { Location: "/ui/worldcup/groups" });
    res.end();
    return;
  }

  // Static assets
  if (pathname.startsWith("/assets/")) {
    serveStatic(res, path.join(UI_DIST, pathname));
    return;
  }

  // Other static files
  if (pathname !== "/" && !pathname.startsWith("/rpc") && !pathname.startsWith("/mcp")) {
    const staticPath = path.join(UI_DIST, pathname);
    fs.stat(staticPath, (err, stats) => {
      if (!err && stats.isFile()) {
        serveStatic(res, staticPath);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }
    });
    return;
  }

  // Root GET → redirect to UI
  if (pathname === "/" && req.method === "GET") {
    res.writeHead(302, { Location: "/ui/worldcup/groups" });
    res.end();
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`\n🏆 World Cup 2026 MCP Server running at http://localhost:${PORT}`);
  console.log(`   MCP endpoint:      POST http://localhost:${PORT}/mcp`);
  console.log(`   Direct RPC:        POST http://localhost:${PORT}/rpc`);
  console.log(`   MCP App (groups):  GET  http://localhost:${PORT}/ui/worldcup/groups`);
  console.log(`   MCP App (bracket): GET  http://localhost:${PORT}/ui/worldcup/bracket\n`);
});

export { server, toolHandlers };
