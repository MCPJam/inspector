#!/usr/bin/env node
// Reservation MCP fixture server for the docs screenshot captures.
//
// Ports the server + widget from docs/guides/first-mcp-app.mdx into a single
// runnable HTTP MCP server (no build step) on port 4801 at /mcp. The guide's
// server.ts and reservation.tsx are copied as faithfully as the single-file
// constraint allows -- see the two sections below for exactly what changed
// and why.
//
// Usage: node docs/scripts/screenshots/fixtures/reservation-server.mjs
// Probe: node cli/dist/index.js server probe --url http://localhost:4801/mcp
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";

const PORT = Number(process.env.PORT ?? "4801");

// --- Widget: ported from first-mcp-app.mdx's src/reservation.tsx ---
//
// The guide builds reservation.tsx (a React component using the `useApp`
// hook from "@modelcontextprotocol/ext-apps/react") with Vite +
// vite-plugin-singlefile into one self-contained HTML file. There is no
// bundler available to this fixture, so instead of shipping a build step we
// inline the ext-apps "app-with-deps" browser bundle -- the one build in the
// package that has zero external imports (React and zod folded in), meant
// exactly for embedding in a plain `<script type="module">` -- and
// reimplement the same component with plain DOM calls instead of React.
// The visible copy (heading, body text, button label) and behavior
// (appInfo, the exact sendMessage payload) match reservation.tsx verbatim;
// only the rendering mechanism (DOM vs. React) differs.
const EXT_APPS_BUNDLE_URL = import.meta.resolve(
  "@modelcontextprotocol/ext-apps/app-with-deps",
);
const extAppsBundleSrc = readFileSync(fileURLToPath(EXT_APPS_BUNDLE_URL), "utf8");

// The bundle ends in a single `export{...};` statement naming its local
// (minifier-chosen) identifiers. We don't need real module exports here --
// this whole bundle is inlined into one script tag alongside our own
// init code -- so find the local name bound to `App` and reuse it directly
// instead of emitting a fresh global.
function stripTrailingExport(src) {
  const exportMatch = src.match(/export\{[^}]*\};?\s*$/);
  if (!exportMatch) {
    throw new Error(
      "reservation-server: could not find the trailing export{} statement in the ext-apps app-with-deps bundle (package version may have changed its build output)",
    );
  }
  const appNameMatch = exportMatch[0].match(/(\w+) as App(?=[,};])/);
  if (!appNameMatch) {
    throw new Error(
      'reservation-server: could not find the "App" export in the ext-apps app-with-deps bundle',
    );
  }
  return { body: src.slice(0, exportMatch.index), appLocalName: appNameMatch[1] };
}

const { body: extAppsBundleBody, appLocalName: AppLocalName } =
  stripTrailingExport(extAppsBundleSrc);

const RESERVATION_APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light dark" />
  <title>Reservation App</title>
</head>
<body>
  <div id="root">Loading...</div>
  <script type="module">
${extAppsBundleBody}
const IMPLEMENTATION = { name: "Reservation App", version: "1.0.0" };
const app = new ${AppLocalName}(IMPLEMENTATION, {});

async function handleMenuRequest() {
  try {
    await app.sendMessage({
      role: "user",
      content: [{ type: "text", text: "What's on the menu at Jammy Wammy?" }],
    });
  } catch (e) {
    console.error("Failed to send message:", e);
  }
}

function render() {
  const root = document.getElementById("root");
  root.innerHTML = \`
    <main style="padding: 20px; font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
      <h1 style="font-size: 24px; margin-bottom: 16px;">\u{1F389} Reservation Confirmed!</h1>
      <p style="font-size: 16px; margin-bottom: 24px;">Your table at <strong>Jammy Wammy</strong> is ready!</p>
      <button id="menu-button" style="padding: 12px 24px; font-size: 16px; background-color: #007bff; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 500;">What's on the menu?</button>
    </main>
  \`;
  document.getElementById("menu-button").addEventListener("click", handleMenuRequest);
}

function renderError(message) {
  document.getElementById("root").innerHTML = "<div><strong>ERROR:</strong> " + message + "</div>";
}

app.connect().then(render).catch((err) => renderError(err.message));
  <\/script>
</body>
</html>`;

// --- MCP server: ported from first-mcp-app.mdx's server.ts (verbatim) ---
function createReservationMcpServer() {
  const server = new McpServer({
    name: "Jammy Wammy Reservation Server",
    version: "1.0.0",
  });

  const resourceUri = "ui://reservation/reservation-app.html";

  // Resource: The built HTML file
  registerAppResource(
    server,
    resourceUri,
    resourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => {
      return {
        contents: [
          { uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: RESERVATION_APP_HTML },
        ],
      };
    },
  );

  // Tool: get-reservation - Shows the reservation UI
  registerAppTool(
    server,
    "get-reservation",
    {
      title: "Get Reservation",
      description: "Make a reservation at Jammy Wammy restaurant.",
      inputSchema: {},
      _meta: { ui: { resourceUri } },
    },
    async () => {
      return {
        content: [{ type: "text", text: "Reservation confirmed at Jammy Wammy! \u{1F389}" }],
      };
    },
  );

  // Tool: get-menu - Returns the menu (no UI)
  server.registerTool(
    "get-menu",
    {
      title: "Get Menu",
      description: "Get the menu for Jammy Wammy restaurant.",
      inputSchema: {},
    },
    async () => {
      const menu = `
🍽️ Jammy Wammy Menu

Appetizers:
- Bruschetta - $8
- Calamari - $12

Main Courses:
- Margherita Pizza - $16
- Spaghetti Carbonara - $18
- Grilled Salmon - $24
- Chicken Parmesan - $20

Desserts:
- Tiramisu - $9
- Panna Cotta - $8

Beverages:
- House Wine (glass) - $10
- Craft Beer - $7
- Fresh Lemonade - $4
      `.trim();

      return { content: [{ type: "text", text: menu }] };
    },
  );

  return server;
}

// --- Transport wiring ---
//
// Default: streamable HTTP on port 4801 (same shape as
// examples/conformance/basic/mock-http-server.mjs), matching the guide and
// what `cli/dist/index.js server probe|apps conformance --url` targets.
//
// `--stdio`: the capture harness's `connect-widget-fixture` setup step adds
// this server via STDIO instead of HTTP. That is a deliberate deviation from
// the original plan (HTTP add-server through the web UI) -- see the docs/
// scripts/screenshots/README.md note next to SETUP_STEPS.connect-widget-
// fixture for why: the local dev app's HTTP "Add Server" flow is blocked by
// an unrelated Convex schema mismatch on the shared dev backend
// (`servers:createServerIfMissing`/`updateServer` reject the client's
// `authMethod` field), while STDIO adds work. The MCP server + widget are
// otherwise identical regardless of transport.
if (process.argv.includes("--stdio")) {
  const transport = new StdioServerTransport();
  await createReservationMcpServer().connect(transport);
} else {
  await startHttpServer();
}

async function startHttpServer() {
const sessions = new Map();

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  const sessionIdHeader = req.headers["mcp-session-id"];
  const activeSessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

  if (activeSessionId && sessions.has(activeSessionId)) {
    await sessions.get(activeSessionId).handleRequest(req, res);
    return;
  }

  if (req.method === "POST") {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };

    await createReservationMcpServer().connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  res.writeHead(405, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Method not allowed" }));
});

// Close every active transport first: their long-lived SSE responses hold
// sockets open, and `httpServer.close` alone would wait on those forever.
const shutdown = async () => {
  const transports = new Set(sessions.values());
  sessions.clear();
  await Promise.allSettled([...transports].map((transport) => transport.close()));
  httpServer.close(() => process.exit(0));
  httpServer.closeIdleConnections();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

httpServer.listen(PORT, "127.0.0.1", () => {
  console.error(`[reservation-fixture] ready on http://127.0.0.1:${PORT}/mcp`);
});
}
