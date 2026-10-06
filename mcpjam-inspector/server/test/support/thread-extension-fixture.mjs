import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const directory = process.argv[2];
if (!directory) throw new Error("Pass a disposable output directory");
await mkdir(directory, { recursive: true, mode: 0o700 });
const bundle = await build({
  stdin: {
    resolveDir: fileURLToPath(new URL("../../../", import.meta.url)),
    loader: "ts",
    contents: `
  import { App } from '@modelcontextprotocol/ext-apps';
  import { OpenAIExtensions } from '@openai/mcp-extensions/app';
  const app = new App({name:'Disposable live extension',version:'0.0.0'},{});
  const extensions = new OpenAIExtensions(app);
  let count = 0;
  app.ontoolresult = result => document.getElementById('initial').textContent = JSON.stringify(result);
  document.getElementById('increment').onclick = () => document.getElementById('count').textContent = String(++count);
  document.getElementById('call').onclick = async () => {
    try { document.getElementById('result').textContent = JSON.stringify(await app.callServerTool({name:'fixture-read',arguments:{}})); }
    catch(error) { document.getElementById('result').textContent = error.message; }
  };
  app.connect().then(() => { document.getElementById('ready').textContent = 'App ready'; app.callServerTool({name:'fixture-read',arguments:{}}).then(result => document.getElementById('load-result').textContent = JSON.stringify(result)).catch(error => document.getElementById('load-result').textContent = error.message); document.getElementById('link').textContent = JSON.stringify(extensions.deepLink.getCurrent() ?? null); }).catch(error => document.getElementById('ready').textContent = error.message);
`,
  },
  bundle: true,
  platform: "browser",
  format: "iife",
  write: false,
  logLevel: "silent",
});
const html = `<!doctype html><html><body><h2>Disposable live extension</h2><p id="ready">Connecting</p><pre id="initial"></pre><pre id="load-result"></pre><button id="increment">Increment</button><output id="count">0</output><button id="call">Call disposable tool</button><pre id="result"></pre><pre id="link"></pre><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></body></html>`;
const events = [];
let calls = 0;
const server = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new Error("bounded fixture request");
      chunks.push(chunk);
    }
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    events.push({ method: request.method, tool: request.params?.name });
    await writeFile(
      directory + "/requests.json",
      JSON.stringify({ calls, events }, null, 2),
    );
    if (request.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const modern = req.headers["mcp-protocol-version"] === "2026-07-28";
    const envelope = modern
      ? { resultType: "complete", ttlMs: 0, cacheScope: "private" }
      : {};
    let result;
    if (request.method === "initialize")
      result = {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "Disposable live extension", version: "0.0.0" },
        capabilities: { tools: {}, resources: {} },
      };
    else if (request.method === "server/discover")
      result = {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        serverInfo: { name: "Disposable live extension", version: "0.0.0" },
        capabilities: { tools: {}, resources: {} },
      };
    else if (request.method === "ping") result = {};
    else if (request.method === "tools/list")
      result = {
        ...envelope,
        tools: [
          {
            name: "fixture-app",
            title: "Disposable live app",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
            _meta: {
              ui: {
                resourceUri: "ui://disposable-live",
                visibility: ["app", "model"],
              },
              "openai/ui": {
                entrypoints: [
                  {
                    type: "global",
                  },
                  { type: "thread" },
                  { type: "settings", searchTerms: ["disposable"] },
                ],
              },
            },
          },
          {
            name: "fixture-second-app",
            title: "Second disposable app",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
            _meta: {
              ui: {
                resourceUri: "ui://disposable-second",
                visibility: ["app", "model"],
              },
              "openai/ui": { entrypoints: [{ type: "thread" }] },
            },
          },
          {
            name: "fixture-read",
            title: "Read disposable fixture",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
            _meta: { ui: { visibility: ["app", "model"] } },
          },
        ],
      };
    else if (
      request.method === "tools/call" &&
      ["fixture-app", "fixture-second-app", "fixture-read"].includes(
        request.params?.name,
      )
    ) {
      calls++;
      result = {
        content: [{ type: "text", text: "Disposable fixture response" }],
        structuredContent: { calls, fixture: true },
        ...(modern ? { resultType: "complete" } : {}),
      };
    } else if (
      request.method === "resources/read" &&
      ["ui://disposable-live", "ui://disposable-second"].includes(
        request.params?.uri,
      )
    )
      result = {
        ...envelope,
        contents: [
          {
            uri: request.params.uri,
            mimeType: "text/html;profile=mcp-app",
            text: html,
            _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
          },
        ],
      };
    else if (
      ["resources/list", "resources/templates/list", "prompts/list"].includes(
        request.method,
      )
    )
      result = {
        ...envelope,
        ...(request.method === "resources/list"
          ? { resources: [] }
          : request.method === "prompts/list"
            ? { prompts: [] }
            : { resourceTemplates: [] }),
      };
    await writeFile(
      directory + "/requests.json",
      JSON.stringify({ calls, events }, null, 2),
    );
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        ...(result
          ? { result }
          : {
              error: {
                code: -32601,
                message: "Unsupported disposable fixture method",
              },
            }),
      }),
    );
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise((resolve) =>
  server.listen(Number(process.env.FIXTURE_PORT ?? 0), "127.0.0.1", resolve),
);
await writeFile(
  directory + "/ready.json",
  JSON.stringify({
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    node: process.version,
  }),
);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
