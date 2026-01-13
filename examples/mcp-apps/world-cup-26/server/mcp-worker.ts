/**
 * MCP Server implementation for Cloudflare Workers
 */

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

// Type for assets binding provided by Wrangler when using `assets = { directory = "./ui/dist" }`
type AssetsBinding = {
  fetch: (request: Request) => Promise<Response>;
};

// UI resource URI key for metadata (SEP-1865)
const UI_RESOURCE_URI_KEY = "ui/resourceUri";

// --------------------------------------------------------------------------
// In-memory prediction store (in a real app, use Cloudflare KV or D1)
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
// Helper: Load HTML from Assets binding
// --------------------------------------------------------------------------
async function loadHtml(
  assets: AssetsBinding | undefined,
  htmlPath: string,
): Promise<string> {
  if (!assets) {
    throw new Error("ASSETS binding not available");
  }

  const buildRequest = (path: string) => {
    // Ensure path starts with /
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(normalizedPath, "https://assets.invalid").toString();
    console.log(`[MCP] Loading asset: ${normalizedPath} (full URL: ${url})`);
    return new Request(url);
  };

  const request = buildRequest(htmlPath);
  const htmlResponse = await assets.fetch(request);
  
  console.log(`[MCP] Asset fetch response for ${htmlPath}: ${htmlResponse.status} ${htmlResponse.statusText}`);
  
  if (!htmlResponse.ok) {
    const errorText = await htmlResponse.text().catch(() => "");
    console.error(`[MCP] Failed to fetch ${htmlPath}: ${htmlResponse.status} ${htmlResponse.statusText}`);
    console.error(`[MCP] Error response body: ${errorText.substring(0, 500)}`);
    throw new Error(`Failed to fetch ${htmlPath}: ${htmlResponse.status} ${htmlResponse.statusText}. ${errorText.substring(0, 200)}`);
  }

  const content = await htmlResponse.text();
  // Verify it's not empty
  if (!content || content.trim().length === 0) {
    throw new Error(`Empty response for ${htmlPath}`);
  }
  
  console.log(`[MCP] Successfully loaded ${htmlPath}, content length: ${content.length}`);
  return content;
}

// --------------------------------------------------------------------------
// Helper: Build self-contained HTML with inlined assets
// --------------------------------------------------------------------------
async function buildMcpAppHtml(
  assets: AssetsBinding,
  resourceUri: string,
): Promise<string> {
  // Load the main HTML file (built widget)
  // Vite outputs to widgets/worldcup-widget.html
  // Assets binding root is ui/dist/widgets, so path is /widgets/worldcup-widget.html
  let html = await loadHtml(assets, "/widgets/worldcup-widget.html");

  // Find and inline JS asset
  // HTML references /assets/..., which should be at /assets/... relative to Assets root
  // Find the first script tag to get the path, then replace ALL occurrences at once
  const jsPattern = /<script[^>]*src=["'](\/assets\/[^"']+\.js)["'][^>]*>[\s\S]*?<\/script>/;
  const firstMatch = html.match(jsPattern);
  
  if (firstMatch && firstMatch[1]) {
    const jsPath = firstMatch[1];
    console.log(`[MCP] Found JS script tag to inline, path: ${jsPath}`);
    
    try {
      // Load the JS content once
      const jsContent = await loadHtml(assets, jsPath);
      if (!jsContent || jsContent.trim().length === 0) {
        throw new Error(`Empty JS content for ${jsPath}`);
      }
      console.log(`[MCP] Loaded JS content, length: ${jsContent.length}`);
      
      // Use global replace to replace ALL script tags with this src in one operation
      // This is more efficient and avoids issues with matches changing during replacement
      const globalPattern = new RegExp(`<script[^>]*src=["']${jsPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>[\\s\\S]*?</script>`, 'g');
      
      // Count matches before replacement
      const matchesBefore = Array.from(html.matchAll(globalPattern));
      console.log(`[MCP] Found ${matchesBefore.length} script tag(s) to replace`);
      
      const beforeLength = html.length;
      html = html.replace(globalPattern, `<script type="module">${jsContent}</script>`);
      const afterLength = html.length;
      const replaced = beforeLength !== afterLength;
      
      if (replaced) {
        console.log(`[MCP] ✓ Replaced JS tag(s) using global replace, HTML length: ${beforeLength} -> ${afterLength}`);
        
        // Verify the replacement worked by checking the head section
        // The head should now contain <script type="module"> with inlined content, not src=
        const headMatch = html.match(/<head>[\s\S]*?<\/head>/i);
        if (headMatch) {
          const headContent = headMatch[0];
          const hasInlinedScript = headContent.includes('<script type="module">') && !headContent.match(/<script[^>]*src=["']\/assets\/[^"']+\.js["']/);
          if (hasInlinedScript) {
            console.log(`[MCP] ✓ Verification: Head section contains inlined script (no external src)`);
          } else {
            console.error(`[MCP] ✗ Verification: Head section still contains external script src!`);
            // Log a sample of the head to debug
            console.error(`[MCP] Head sample: ${headContent.substring(0, 500)}`);
          }
        }
      } else {
        console.error(`[MCP] ✗ Global replace found no matches - replacement failed!`);
        console.error(`[MCP] Pattern was: ${globalPattern}`);
        console.error(`[MCP] HTML sample: ${html.substring(0, 500)}`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[MCP] Failed to load JS asset ${jsPath}:`, errorMsg);
      // If we can't inline, return error - MCP Apps need inlined assets
      throw new Error(`Failed to inline JS asset: ${errorMsg}`);
    }
  } else {
    // Try to find any script tags to debug
    const allScriptTags = html.match(/<script[^>]*>/g);
    console.warn(`[MCP] No JS script tag found matching pattern. Found ${allScriptTags?.length || 0} script tags total.`);
    if (allScriptTags) {
      console.warn(`[MCP] Script tags found:`, allScriptTags);
    }
    console.warn(`[MCP] HTML preview: ${html.substring(0, 800)}`);
  }

  // Find and inline CSS asset
  // Match link tag (self-closing, may have whitespace)
  const cssMatch = html.match(/<link\s+rel="stylesheet"\s+crossorigin\s+href="(\/assets\/[^"]+\.css)"\s*\/?>/);
  if (cssMatch && cssMatch[1]) {
    try {
      const cssPath = cssMatch[1];
      const cssContent = await loadHtml(assets, cssPath);
      if (!cssContent || cssContent.trim().length === 0) {
        throw new Error(`Empty CSS content for ${cssPath}`);
      }
      html = html.replace(cssMatch[0], `<style>${cssContent}</style>`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[MCP] Failed to load CSS asset ${cssMatch[1]}:`, errorMsg);
      // If we can't inline, return error - MCP Apps need inlined assets
      throw new Error(`Failed to inline CSS asset: ${errorMsg}`);
    }
  }

  // Verify we have a valid HTML document
  if (!html.includes("<!doctype html") && !html.includes("<html")) {
    throw new Error("Invalid HTML: missing doctype or html tag");
  }

  // Final check: ensure no external script references remain in the HTML structure
  // Note: We need to be careful - the inlined JS content may contain script tag strings,
  // so we should only check for script tags that are actual HTML elements, not strings in JS code.
  // A simple heuristic: look for script tags with src that are NOT inside <script> tags
  // For now, we'll do a simple check but be aware that false positives may occur from JS strings
  
  // Check for script tags with external src - but only count them, don't try to fix
  // because any matches at this point are likely false positives from inlined JS strings
  const remainingExternalScriptsPattern = /<script[^>]*src=["'](\/assets\/[^"']+\.(js|mjs))["'][^>]*>[\s\S]*?<\/script>/g;
  const remainingMatches = Array.from(html.matchAll(remainingExternalScriptsPattern));
  
  // Filter out matches that are likely inside already-inlined script tags
  // (This is a heuristic - if a match is very long, it's probably the inlined content itself)
  const suspiciousMatches = remainingMatches.filter(match => {
    // If the match is longer than 1000 chars, it's probably the inlined JS content, not a real tag
    return match[0].length < 1000;
  });
  
  if (suspiciousMatches.length > 0) {
    console.warn(`[MCP] Found ${suspiciousMatches.length} potential external script reference(s) after inlining`);
    console.warn(`[MCP] These may be false positives from string literals in the inlined JS code`);
    // Don't try to fix - they're likely false positives
  }

  // Inject resource URI
  html = html.replace(
    "</head>",
    `<script>window.__MCP_RESOURCE_URI__ = "${resourceUri}";</script></head>`
  );

  // Final verification - check for any remaining external script references
  // Note: We can't reliably check for script tags after inlining because the inlined JS
  // may contain script tag strings. Instead, we'll just log that inlining completed.
  // The browser will tell us if there are real issues.
  const allScriptTags = html.match(/<script[^>]*>/g);
  const inlineScriptTags = allScriptTags?.filter(tag => !tag.includes('src=')) || [];
  const externalScriptTags = allScriptTags?.filter(tag => tag.includes('src=') && tag.includes('/assets/')) || [];
  
  if (externalScriptTags.length > 0) {
    // These might be false positives from JS strings, but log them anyway
    console.warn(`[MCP] Note: Found ${externalScriptTags.length} potential external script tag(s) after inlining`);
    console.warn(`[MCP] These may be false positives from string literals in the inlined JS code`);
  } else {
    console.log(`[MCP] Inlining complete - ${inlineScriptTags.length} inline script tag(s) found, no external script tags detected`);
  }

  return html;
}

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

  "worldcup.getDataForWidget": async () => {
    const prediction = savedPrediction ?? defaultPrediction();
    return {
      data: { teams, groups, bracketTemplate, prediction, playoffSlots },
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
// MCP Tools definitions
// --------------------------------------------------------------------------
const mcpTools = [
  {
    name: "worldcup.getInitialData",
    description: "Return teams, groups, bracket template, and any saved prediction. Opens the World Cup prediction UI.",
    inputSchema: {
      type: "object" as const,
      properties: {
        includeSaved: { type: "boolean" },
      },
    },
    _meta: {
      "ui/resourceUri": "ui://worldcup/groups",
    },
  },
  {
    name: "worldcup.getDataForWidget",
    description: "Return teams, groups, bracket template, and any saved prediction for the widget UI.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "worldcup.savePrediction",
    description: "Persist a World Cup prediction (in-memory).",
    inputSchema: {
      type: "object" as const,
      properties: {
        prediction: { type: "object" },
      },
      required: ["prediction"],
    },
  },
];

// MCP UI Resources
// SEP-1865 requires "text/html;profile=mcp-app" as the MIME type
const MCP_RESOURCES = [
  { uri: "ui://worldcup/groups", name: "World Cup Groups", mimeType: "text/html;profile=mcp-app" },
  { uri: "ui://worldcup/third-place", name: "Third Place Selection", mimeType: "text/html;profile=mcp-app" },
  { uri: "ui://worldcup/bracket", name: "Knockout Bracket", mimeType: "text/html;profile=mcp-app" },
];


// --------------------------------------------------------------------------
// MCP Server
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

class McpServer {
  private assets: AssetsBinding;

  constructor(assets: AssetsBinding) {
    this.assets = assets;
  }

  async handleRequest(req: JsonRpcRequest | JsonRpcRequest[]): Promise<JsonRpcResponse | JsonRpcResponse[]> {
    if (Array.isArray(req)) {
      return Promise.all(req.map((r) => this.handleSingleRequest(r)));
    }
    return this.handleSingleRequest(req);
  }

  private async handleSingleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = req.id ?? null;
    console.log(`[MCP] handleSingleRequest - method: ${req.method}, id: ${id}, params:`, JSON.stringify(req.params));

    switch (req.method) {
      case "initialize": {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {},
              resources: {},
              prompts: {},
              extensions: {
                "io.modelcontextprotocol/ui": {
                  mimeTypes: ["text/html;profile=mcp-app"],
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
          result: {
            tools: mcpTools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              _meta: tool._meta,
            })),
          },
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
          const toolDef = mcpTools.find((t) => t.name === toolName);
          const toolMeta = toolDef?._meta;

          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              ...(toolMeta ? { _meta: toolMeta } : {}),
            },
          };
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
          console.error(`[MCP] Unknown resource: ${uri}`);
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: `Unknown resource: ${uri}` },
          };
        }

        try {
          console.log(`[MCP] Building HTML for ${uri}...`);
          const html = await buildMcpAppHtml(this.assets, uri);
          // Verify we got HTML, not JS
          if (!html.includes("<!doctype html") && !html.includes("<html")) {
            throw new Error(`Expected HTML but got: ${html.substring(0, 100)}...`);
          }
          console.log(`[MCP] Built HTML for ${uri}, length: ${html.length}`);

          const response = {
            jsonrpc: "2.0" as const,
            id,
            result: {
              contents: [
                {
                  uri: resource.uri,
                  mimeType: resource.mimeType,
                  text: html,
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
          
          console.log(`[MCP] Returning resource for ${uri}, mimeType: ${resource.mimeType}, html length: ${html.length}`);
          console.log(`[MCP] Response structure:`, JSON.stringify({
            jsonrpc: response.jsonrpc,
            id: response.id,
            result: {
              contents: response.result.contents.map(c => ({
                uri: c.uri,
                mimeType: c.mimeType,
                textLength: c.text?.length,
                hasMeta: !!c._meta
              }))
            }
          }));
          return response;
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          console.error(`[MCP] Failed to build resource ${uri}:`, errorMessage);
          console.error(`[MCP] Error stack:`, err instanceof Error ? err.stack : String(err));
          return {
            jsonrpc: "2.0",
            id,
            error: { 
              code: -32000, 
              message: `Failed to build resource: ${errorMessage}`,
              data: { uri, error: errorMessage }
            },
          };
        }
      }

      case "ping": {
        return { jsonrpc: "2.0", id, result: {} };
      }

      case "prompts/list": {
        return { jsonrpc: "2.0", id, result: { prompts: [] } };
      }

      case "logging/setLevel": {
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
  }
}

export function createMcpServer(assets: AssetsBinding): McpServer {
  return new McpServer(assets);
}


