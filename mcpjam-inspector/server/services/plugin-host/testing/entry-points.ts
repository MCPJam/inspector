import { build } from "esbuild";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

/**
 * Disposable peer with one global entry point per entry-point rule, for
 * trying a client's left-rail Apps (Claude's rules or ChatGPT's):
 *
 * - `open_board`: visible to the model; its App supports fullscreen.
 * - `app_only_panel`: `_meta.ui.visibility: ["app"]`, so Claude skips it.
 * - `foo__bar`: two underscores in a row, so Claude lists it but won't open it.
 * - `inline_note`: its App declares only `inline`, so Claude opens it inline
 *   in a new chat.
 * - `sketch`: an OpenAI quick action, which Claude doesn't list.
 */
export async function createEntryPointsFixture() {
  const quickAction = {
    title: "New sketch",
    icons: [
      {
        src: `data:image/svg+xml,${encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" stroke="currentColor"/></svg>',
        )}`,
        mimeType: "image/svg+xml",
      },
    ],
    target: { type: "tool", name: "sketch", arguments: {} },
  };
  const cases: Record<
    string,
    {
      title: string;
      app: string[];
      visibility?: string[];
      quickAction?: typeof quickAction;
    }
  > = {
    open_board: { title: "Open board", app: ["inline", "fullscreen"] },
    app_only_panel: {
      title: "App-only panel",
      app: ["inline", "fullscreen"],
      visibility: ["app"],
    },
    foo__bar: { title: "Foo bar", app: ["inline", "fullscreen"] },
    inline_note: { title: "Inline note", app: ["inline"] },
    sketch: { title: "Sketch", app: ["inline", "fullscreen"], quickAction },
  };
  const html = new Map<string, string>();
  const activations = new Map<string, number>();
  const inputSchema = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };
  for (const [name, variant] of Object.entries(cases)) {
    const guest = await build({
      stdin: {
        resolveDir: fileURLToPath(new URL(".", import.meta.url)),
        loader: "ts",
        contents: `import { App } from "@modelcontextprotocol/ext-apps";
const app = new App({name:"entry-${name}",version:"1"},{availableDisplayModes:${JSON.stringify(
          variant.app,
        )}});
const show=()=>{document.querySelector('pre').textContent=JSON.stringify({context:app.getHostContext()});};
app.ontoolresult=show;app.onhostcontextchanged=show;
app.connect().then(()=>{document.querySelector('p').textContent='App ready';show();});`,
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      logLevel: "silent",
    });
    html.set(
      `ui://entry/${name}`,
      `<!doctype html><title>${variant.title}</title><main style="min-height:240px"><h1>${variant.title}</h1><p>Connecting</p><pre></pre></main><script>${guest.outputFiles[0].text}</script>`,
    );
  }
  const tools = Object.entries(cases).map(([name, variant]) => ({
    name,
    title: variant.title,
    inputSchema,
    annotations: { readOnlyHint: true },
    _meta: {
      ui: {
        resourceUri: `ui://entry/${name}`,
        visibility: variant.visibility ?? ["model", "app"],
      },
      "openai/ui": {
        entrypoints: [
          {
            type: "global",
            ...(variant.quickAction
              ? { quickAction: variant.quickAction }
              : {}),
          },
        ],
      },
    },
  }));
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
      const envelope =
        request.headers["mcp-protocol-version"] === "2026-07-28"
          ? { resultType: "complete", ttlMs: 0, cacheScope: "private" }
          : {};
      let result: unknown;
      switch (rpc.method) {
        case "initialize":
          result = {
            protocolVersion: rpc.params.protocolVersion,
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "disposable-entry-points", version: "1" },
          };
          break;
        case "tools/list":
          result = { ...envelope, tools };
          break;
        case "tools/call": {
          const name = rpc.params.name;
          if (!Object.hasOwn(cases, name)) throw new Error("Unknown tool");
          const count = (activations.get(name) ?? 0) + 1;
          activations.set(name, count);
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
            resources: [...html.keys()].map((uri) => ({
              uri,
              name: uri,
              mimeType: "text/html;profile=mcp-app",
            })),
          };
          break;
        case "resources/read": {
          const text = html.get(rpc.params.uri);
          if (text === undefined) throw new Error("Unknown resource");
          result = {
            ...envelope,
            contents: [
              {
                uri: rpc.params.uri,
                mimeType: "text/html;profile=mcp-app",
                text,
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
