// Cloudflare Worker entrypoint for World Cup 2026 MCP Server + UI
// Serves MCP endpoints and inlined UI assets from the ASSETS binding.
// Build trigger

import { bracketTemplate } from "../server/bracket-template";
import { groups, teams, playoffSlots } from "../server/teams";
import type {
  Bracket,
  GroupId,
  GroupPrediction,
  KnockoutSlot,
  KnockoutSlotSource,
  ResolvedBracket,
  ResolvedMatch,
  TeamId,
  ThirdPlaceSelection,
  WorldCupPrediction,
} from "../shared/types";

// Minimal type for assets binding provided by Wrangler when using `assets = { directory = "./ui/dist" }`
type AssetsBinding = {
  fetch: (request: Request) => Promise<Response>;
};

// ------------------------------------------------------------
// Prediction defaults
// ------------------------------------------------------------
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

const emptyKnockout = () => ({ winnersByMatchId: {} as Record<string, string | undefined> });

const defaultPrediction = (): WorldCupPrediction => ({
  groups: defaultGroupPredictions(),
  thirdPlaceSelection: { advancingThirdPlaceTeamIds: [] },
  knockout: emptyKnockout(),
});

// ------------------------------------------------------------
// Bracket resolution helpers
// ------------------------------------------------------------

/**
 * Get which group a team belongs to (from group predictions)
 */
const getTeamGroup = (teamId: TeamId, prediction: WorldCupPrediction): GroupId | undefined => {
  for (const group of prediction.groups) {
    for (const pos of [1, 2, 3, 4] as const) {
      if (group.positions[pos] === teamId) {
        return group.groupId;
      }
    }
  }
  return undefined;
};

/**
 * Constraint-satisfying third-place assignment using backtracking with MRV.
 * Assigns exactly 8 teams to 8 slots such that each team's group letter
 * is contained in the slot's allowed group letters.
 */
type QualifiedThird = { id: TeamId; groupLetter: GroupId };
type Slot = { slotId: string; label: string; letters: string };

/**
 * Get candidates for a slot (teams that can be assigned to it)
 */
const getCandidates = (
  slot: Slot,
  qualifiedThirds: QualifiedThird[],
  usedTeams: Set<TeamId>
): QualifiedThird[] => {
  return qualifiedThirds.filter(
    (team) => !usedTeams.has(team.id) && slot.letters.includes(team.groupLetter)
  );
};

/**
 * Find the slot with minimum remaining values (fewest candidates)
 */
const selectSlotMRV = (
  remainingSlots: Slot[],
  qualifiedThirds: QualifiedThird[],
  usedTeams: Set<TeamId>
): Slot | null => {
  if (remainingSlots.length === 0) return null;

  let minSlot = remainingSlots[0];
  let minCount = getCandidates(minSlot, qualifiedThirds, usedTeams).length;

  for (let i = 1; i < remainingSlots.length; i++) {
    const count = getCandidates(remainingSlots[i], qualifiedThirds, usedTeams).length;
    if (count < minCount) {
      minSlot = remainingSlots[i];
      minCount = count;
    }
  }

  return minSlot;
};

/**
 * Backtracking solver with MRV heuristic
 */
const assignThirdPlacesBacktracking = (
  qualifiedThirds: QualifiedThird[],
  slots: Slot[]
): Map<string, TeamId> => {
  const assignments = new Map<string, TeamId>();
  const usedTeams = new Set<TeamId>();

  const backtrack = (remainingSlots: Slot[]): boolean => {
    if (remainingSlots.length === 0) {
      return true; // All slots assigned
    }

    // MRV: select slot with fewest candidates
    const slot = selectSlotMRV(remainingSlots, qualifiedThirds, usedTeams);
    if (!slot) return false;

    const candidates = getCandidates(slot, qualifiedThirds, usedTeams);
    
    // Try candidates in ranked order (best→worst) for deterministic output
    for (const team of candidates) {
      // Try this assignment
      assignments.set(slot.slotId, team.id);
      usedTeams.add(team.id);

      // Recurse with remaining slots
      const remaining = remainingSlots.filter((s) => s.slotId !== slot.slotId);
      if (backtrack(remaining)) {
        return true;
      }

      // Backtrack
      assignments.delete(slot.slotId);
      usedTeams.delete(team.id);
    }

    return false; // No valid assignment found
  };

  if (!backtrack([...slots])) {
    // Build detailed debug info
    const remainingTeams = qualifiedThirds.filter((t) => !usedTeams.has(t.id));
    const remainingSlots = slots.filter((s) => !assignments.has(s.slotId));
    const candidatesPerSlot = remainingSlots.map((slot) => {
      const candidates = getCandidates(slot, qualifiedThirds, usedTeams);
      return `  ${slot.label}(${slot.letters}): ${candidates.length} candidates [${candidates.map((t) => `${t.id}(${t.groupLetter})`).join(", ")}]`;
    });

    throw new Error(
      `Cannot assign third-place teams to slots: unsatisfiable constraints.\n` +
      `Qualified teams (${qualifiedThirds.length}): ${qualifiedThirds.map((t) => `${t.id}(${t.groupLetter})`).join(", ")}\n` +
      `Remaining teams: ${remainingTeams.map((t) => `${t.id}(${t.groupLetter})`).join(", ")}\n` +
      `Remaining slots: ${remainingSlots.map((s) => s.label).join(", ")}\n` +
      `Candidates per slot:\n${candidatesPerSlot.join("\n")}`
    );
  }

  return assignments;
};

const assignThirdPlaceTeams = (
  prediction: WorldCupPrediction
): Map<string, TeamId> => {
  // Get all 12 third-place teams with their groups
  const thirdPlaceTeams: Array<{ teamId: TeamId; groupId: GroupId }> = [];
  for (const group of prediction.groups) {
    const teamId = group.positions[3];
    if (teamId) {
      thirdPlaceTeams.push({ teamId, groupId: group.groupId });
    }
  }

  // Get exactly 8 qualified teams (by order in advancingThirdPlaceTeamIds)
  // Array order maintains rank (best→worst) for deterministic output
  const qualifiedThirds: QualifiedThird[] = [];
  for (let i = 0; i < prediction.thirdPlaceSelection.advancingThirdPlaceTeamIds.length && qualifiedThirds.length < 8; i++) {
    const teamId = prediction.thirdPlaceSelection.advancingThirdPlaceTeamIds[i];
    const team = thirdPlaceTeams.find((t) => t.teamId === teamId);
    if (team) {
      qualifiedThirds.push({ id: teamId, groupLetter: team.groupId });
    } else {
      // Try to find group from all positions
      const groupId = getTeamGroup(teamId, prediction);
      if (groupId) {
        qualifiedThirds.push({ id: teamId, groupLetter: groupId });
      }
    }
  }

  // If not exactly 8 teams, return empty assignments (partial selection or initial state)
  // The UI will show TBD until all 8 teams are selected
  if (qualifiedThirds.length !== 8) {
    return new Map<string, TeamId>();
  }

  // Define slots with their constraints
  const slots: Slot[] = [
    { slotId: "R32-M3-A", label: "3ABCDF", letters: "ABCDF" },
    { slotId: "R32-M6-A", label: "3CDFGH", letters: "CDFGH" },
    { slotId: "R32-M7-A", label: "3CEFHI", letters: "CEFHI" },
    { slotId: "R32-M10-A", label: "3BEFIJ", letters: "BEFIJ" },
    { slotId: "R32-M9-A", label: "3AEHIJ", letters: "AEHIJ" },
    { slotId: "R32-M13-A", label: "3EFGIJ", letters: "EFGIJ" },
    { slotId: "R32-M8-A", label: "3EHIJK", letters: "EHIJK" },
    { slotId: "R32-M16-A", label: "3DEIJL", letters: "DEIJL" },
  ];

  return assignThirdPlacesBacktracking(qualifiedThirds, slots);
};

const resolveSource = (
  source: KnockoutSlotSource | undefined,
  prediction: WorldCupPrediction,
  thirdPlaceAssignments?: Map<string, TeamId>,
  slotId?: string
): string | undefined => {
  if (!source) return undefined;
  switch (source.type) {
    case "group-position": {
      const group = prediction.groups.find((g) => g.groupId === source.groupId);
      return group?.positions[source.position];
    }
    case "third-ranked": {
      if (!thirdPlaceAssignments || !slotId) {
        // If assignments not provided, return undefined (will show as TBD)
        return undefined;
      }
      const assigned = thirdPlaceAssignments.get(slotId);
      // If no assignment found (e.g., teams not yet selected), return undefined
      // This allows the UI to show TBD until third-place teams are selected
      return assigned;
    }
    case "winner-of-match":
      return prediction.knockout.winnersByMatchId[source.matchId];
    default:
      return undefined;
  }
};

const resolveSlotTeamId = (
  slot: KnockoutSlot,
  prediction: WorldCupPrediction,
  thirdPlaceAssignments?: Map<string, TeamId>
): string | undefined => {
  return resolveSource(slot.source, prediction, thirdPlaceAssignments, slot.id);
};

const resolveBracket = (prediction: WorldCupPrediction): ResolvedBracket => {
  // Compute third-place assignments using FIFA algorithm
  const thirdPlaceAssignments = assignThirdPlaceTeams(prediction);

  const matches = bracketTemplate.matches.map((match) => ({
    ...match,
    homeTeamId: resolveSlotTeamId(match.homeSlot, prediction, thirdPlaceAssignments),
    awayTeamId: resolveSlotTeamId(match.awaySlot, prediction, thirdPlaceAssignments),
  }));
  return { matches };
};

// ------------------------------------------------------------
// MCP tool definitions
// ------------------------------------------------------------
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

const UI_RESOURCE_URI_KEY = "ui/resourceUri";

const mcpTools: McpTool[] = [
  {
    name: "worldcup.getInitialData",
    description: "Return teams, groups, bracket template, and any saved prediction. Opens the World Cup prediction UI.",
    inputSchema: {
      type: "object",
      properties: {
        includeSaved: { type: "boolean", description: "Whether to include saved prediction" },
      },
    },
    _meta: { "ui/resourceUri": "ui://worldcup/groups" },
  },
  {
    name: "worldcup.savePrediction",
    description: "Persist a World Cup prediction (in-memory).",
    inputSchema: {
      type: "object",
      properties: {
        prediction: { type: "object", description: "The WorldCupPrediction object to save" },
      },
      required: ["prediction"],
    },
  },
];

// ------------------------------------------------------------
// In-memory prediction store
// ------------------------------------------------------------
let savedPrediction: WorldCupPrediction | null = null;

// ------------------------------------------------------------
// MCP handlers
// ------------------------------------------------------------
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
    return { data: { teams, groups, bracketTemplate, prediction, playoffSlots } };
  },
  "worldcup.savePrediction": async (args) => {
    const incoming = args.prediction as WorldCupPrediction;
    if (!incoming) throw new Error("Missing prediction parameter");
    savedPrediction = incoming;
    return { ok: true, summary: "Prediction saved", snapshot: incoming };
  },
};

// ------------------------------------------------------------
// MCP protocol helpers
// ------------------------------------------------------------
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

const SERVER_INFO = { name: "worldcup-2026", version: "1.0.0" };

// ------------------------------------------------------------
// HTML loading helpers (from ASSETS binding)
// ------------------------------------------------------------
const loadAssetText = async (env: { ASSETS: AssetsBinding }, path: string): Promise<string> => {
  const url = new URL(path, "https://assets.invalid");
  const res = await env.ASSETS.fetch(new Request(url.toString()));
  if (!res.ok) throw new Error(`Failed to load asset ${path}: ${res.status}`);
  return res.text();
};

const buildMcpAppHtml = async (env: { ASSETS: AssetsBinding }, resourceUri: string): Promise<string> => {
  // Fetch index.html from assets
  let html = await loadAssetText(env, "/index.html");

  // Normalize meta content-type to SEP-1865 expected value
  html = html.replace(
    /<meta http-equiv="Content-Type" content="text\/html\+mcp"\s*\/?>/i,
    `<meta http-equiv="Content-Type" content="text/html;profile=mcp-app" />`
  );

  // Inline JS asset (escape closing script tags to avoid premature termination)
  const jsMatch = html.match(/<script type="module" crossorigin src="(\/assets\/[^"]+\.js)"><\/script>/);
  if (jsMatch && jsMatch[1]) {
    let jsContent = await loadAssetText(env, jsMatch[1]);
    // Replace </script with \x3c/script - the \x3c is JavaScript hex for '<'
    // This prevents the HTML parser from seeing a closing script tag
    jsContent = jsContent.replace(/<\/script/gi, "\\x3c/script");
    // IMPORTANT: Use function replacement to avoid $ patterns being interpreted
    html = html.replace(jsMatch[0], () => `<script type="module">${jsContent}</script>`);
  }

  // Inline CSS asset
  const cssMatch = html.match(/<link rel="stylesheet" crossorigin href="(\/assets\/[^"]+\.css)">/);
  if (cssMatch && cssMatch[1]) {
    const cssContent = await loadAssetText(env, cssMatch[1]);
    html = html.replace(cssMatch[0], `<style>${cssContent}</style>`);
  }

  // Inject the resource URI
  html = html.replace(
    "</head>",
    `<script>window.__MCP_RESOURCE_URI__ = "${resourceUri}";</script></head>`
  );

  return html;
};

// ------------------------------------------------------------
// MCP request handler
// ------------------------------------------------------------
const handleMcpRequest = async (req: JsonRpcRequest, env: { ASSETS: AssetsBinding }): Promise<JsonRpcResponse> => {
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
            extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
          },
          serverInfo: SERVER_INFO,
        },
      };
    case "notifications/initialized":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: mcpTools } };
    case "tools/call": {
      const params = req.params as { name: string; arguments?: Record<string, unknown> };
      const toolName = params?.name;
      const toolArgs = params?.arguments ?? {};
      const handler = toolHandlers[toolName];
      if (!handler) {
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${toolName}` } };
      }
      try {
        const result = await handler(toolArgs);
        const toolDef = mcpTools.find((t) => t.name === toolName);
        const toolMeta = toolDef?._meta;
        const response: JsonRpcResponse = {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            ...(toolMeta ? { _meta: toolMeta } : {}),
          },
        };
        return response;
      } catch (err) {
        return { jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message } };
      }
    }
    case "resources/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resources: [
            { uri: "ui://worldcup/groups", name: "World Cup Groups", mimeType: "text/html;profile=mcp-app" },
            { uri: "ui://worldcup/third-place", name: "Third Place Selection", mimeType: "text/html;profile=mcp-app" },
            { uri: "ui://worldcup/bracket", name: "Knockout Bracket", mimeType: "text/html;profile=mcp-app" },
          ],
        },
      };
    case "resources/read": {
      const params = req.params as { uri: string };
      const uri = params?.uri;
      if (!uri) {
        return { jsonrpc: "2.0", id, error: { code: -32602, message: "Missing resource URI" } };
      }
      try {
        const html = await buildMcpAppHtml(env, uri);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [
              {
                uri,
                mimeType: "text/html;profile=mcp-app",
                text: html,
                _meta: {
                  ui: {
                    csp: { connectDomains: [], resourceDomains: [] },
                    prefersBorder: false,
                  },
                },
              },
            ],
            _meta: {
              ui: {
                csp: { connectDomains: [], resourceDomains: [] },
                prefersBorder: false,
              },
            },
          },
        };
      } catch (err) {
        return { jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message } };
      }
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    case "logging/setLevel":
      return { jsonrpc: "2.0", id, result: {} };
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${req.method}` } };
  }
};

// Direct JSON-RPC handler for React app
const handleDirectRpc = async (req: JsonRpcRequest, env: { ASSETS: AssetsBinding }): Promise<JsonRpcResponse> => {
  const id = req.id ?? null;
  const handler = toolHandlers[req.method];
  if (!handler) return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${req.method}` } };
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

// ------------------------------------------------------------
// HTTP handler
// ------------------------------------------------------------
export default {
  async fetch(request: Request, env: { ASSETS: AssetsBinding }): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // MCP endpoint
    if ((pathname === "/mcp" || pathname === "/") && request.method === "POST") {
      const body = await request.text();
      const parsed = parseJsonRpc(body);
      if (!parsed) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (Array.isArray(parsed)) {
        const responses = await Promise.all(parsed.map((r) => handleMcpRequest(r as any, env)));
        return new Response(JSON.stringify(responses), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const response = await handleMcpRequest(parsed as any, env);
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Direct RPC endpoint
    if (pathname === "/rpc" && request.method === "POST") {
      const body = await request.text();
      const parsed = parseJsonRpc(body);
      if (!parsed) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (Array.isArray(parsed)) {
        const responses = await Promise.all(parsed.map((r) => handleDirectRpc(r as any, env)));
        return new Response(JSON.stringify(responses), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const response = await handleDirectRpc(parsed, env);
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // UI routes
    if (pathname === "/ui/worldcup/groups" || pathname === "/ui/worldcup/groups/") {
      const html = await buildMcpAppHtml(env, "ui://worldcup/groups");
      return new Response(html, { status: 200, headers: { ...corsHeaders, "Content-Type": "text/html;profile=mcp-app" } });
    }
    if (pathname === "/ui/worldcup/third-place" || pathname === "/ui/worldcup/third-place/") {
      const html = await buildMcpAppHtml(env, "ui://worldcup/third-place");
      return new Response(html, { status: 200, headers: { ...corsHeaders, "Content-Type": "text/html;profile=mcp-app" } });
    }
    if (pathname === "/ui/worldcup/bracket" || pathname === "/ui/worldcup/bracket/") {
      const html = await buildMcpAppHtml(env, "ui://worldcup/bracket");
      return new Response(html, { status: 200, headers: { ...corsHeaders, "Content-Type": "text/html;profile=mcp-app" } });
    }
    if (pathname === "/ui" || pathname === "/ui/" || pathname === "/ui/worldcup" || pathname === "/ui/worldcup/") {
      return Response.redirect(url.origin + "/ui/worldcup/groups", 302);
    }

    // Static assets served from ASSETS binding
    if (pathname.startsWith("/assets/") || pathname === "/index.html") {
      const assetResponse = await env.ASSETS.fetch(request);
      return new Response(assetResponse.body, {
        status: assetResponse.status,
        headers: { ...Object.fromEntries(assetResponse.headers), ...corsHeaders },
      });
    }

    // Root GET -> redirect to UI
    if (pathname === "/" && request.method === "GET") {
      return Response.redirect(url.origin + "/ui/worldcup/groups", 302);
    }

    // Fallback: try assets
    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.ok) {
      return new Response(assetResponse.body, {
        status: assetResponse.status,
        headers: { ...Object.fromEntries(assetResponse.headers), ...corsHeaders },
      });
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  },
};
