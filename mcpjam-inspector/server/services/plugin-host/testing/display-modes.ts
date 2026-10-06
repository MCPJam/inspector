import { build } from "esbuild";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

/** Disposable independent peer for the display cases absent from Bits & Bolts. */
export async function createDisplayModesFixture() {
  const cases = {
    preferred: {
      resource: { preferredDisplayMode: "fullscreen" },
      app: ["fullscreen"],
    },
    omitted: { resource: undefined, app: ["inline", "fullscreen"] },
    narrowed: {
      resource: { availableDisplayModes: ["inline", "fullscreen"] },
      app: ["inline"],
    },
    unsupported: {
      resource: { availableDisplayModes: ["inline"] },
      app: ["fullscreen"],
    },
  } as const;
  const resources = new Map<string, { html: string; metadata: unknown }>();
  const activations = new Map<string, number>();
  for (const [name, variant] of Object.entries(cases)) {
    const guest = await build({
      stdin: {
        resolveDir: fileURLToPath(new URL("../../../../", import.meta.url)),
        loader: "ts",
        contents: `import { App } from "@modelcontextprotocol/ext-apps";
const app = new App({name:"display-${name}",version:"1"},{availableDisplayModes:${JSON.stringify(
          variant.app,
        )}});
window.boot=crypto.randomUUID();window.initialResults=0;
const show=()=>{document.querySelector('pre').textContent=JSON.stringify({boot:window.boot,context:app.getHostContext(),initialResults:window.initialResults});};
app.ontoolresult=()=>{window.initialResults++;show();};app.onhostcontextchanged=show;
app.connect().then(()=>{document.querySelector('p').textContent='App ready';show();});`,
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      logLevel: "silent",
    });
    resources.set(`ui://display/${name}`, {
      html: `<!doctype html><title>Display ${name}</title><p>Connecting</p><pre></pre><script>${guest.outputFiles[0].text}</script>`,
      metadata: variant.resource
        ? { "openai/ui": variant.resource }
        : undefined,
    });
  }
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/mcp") {
      response.writeHead(405).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65536) throw new Error("Request limit");
        chunks.push(Buffer.from(chunk));
      }
      const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const modern = request.headers["mcp-protocol-version"] === "2026-07-28";
      const envelope = modern
        ? { resultType: "complete", ttlMs: 0, cacheScope: "private" }
        : {};
      let result: unknown;
      switch (rpc.method) {
        case "initialize":
          result = {
            protocolVersion: rpc.params.protocolVersion,
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "disposable-display-modes", version: "1" },
          };
          break;
        case "tools/list":
          result = {
            ...envelope,
            tools: Object.keys(cases).map((name) => ({
              name,
              title: `Display ${name}`,
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
              annotations: { readOnlyHint: true },
              _meta: {
                ui: {
                  resourceUri: `ui://display/${name}`,
                  visibility: ["model", "app"],
                },
                "openai/ui": { entrypoints: [{ type: "thread" }] },
              },
            })),
          };
          break;
        case "tools/call": {
          if (!(rpc.params.name in cases)) throw new Error("Unknown tool");
          const count = (activations.get(rpc.params.name) ?? 0) + 1;
          activations.set(rpc.params.name, count);
          result = {
            ...envelope,
            content: [
              { type: "text", text: JSON.stringify({ activations: count }) },
            ],
          };
          break;
        }
        case "resources/list":
          result = {
            ...envelope,
            resources: [...resources].map(([uri, value]) => ({
              uri,
              name: uri,
              mimeType: "text/html;profile=mcp-app",
              _meta: value.metadata,
            })),
          };
          break;
        case "resources/read": {
          const item = resources.get(rpc.params.uri);
          if (!item) throw new Error("Unknown resource");
          result = {
            ...envelope,
            contents: [
              {
                uri: rpc.params.uri,
                mimeType: "text/html;profile=mcp-app",
                text: item.html,
                _meta: item.metadata,
              },
            ],
          };
          break;
        }
        default:
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              error: { code: -32601, message: "Unsupported" },
            }),
          );
          return;
      }
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture address");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    activations,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
