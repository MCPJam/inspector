import { readFileSync } from "node:fs";

/** Add a bounded extension point to the pinned bridge command dispatcher. */
export const bridgeControlPlugin = {
  name: "mcpjam-bridge-controls",
  setup(build) {
    build.onLoad(
      { filter: /[/\\]@ai-sdk[/\\]harness[/\\]dist[/\\]bridge[/\\]index\.js$/ },
      (args) => {
        const source = readFileSync(args.path, "utf8");
        const marker =
          "  const handleInbound = async (msg, ws) => {\n    switch (msg.type) {";
        if (source.split(marker).length !== 2) {
          throw new Error("The pinned bridge control dispatcher has changed.");
        }
        return {
          loader: "js",
          contents: source.replace(
            marker,
            `  const handleInbound = async (msg, ws) => {
    if (msg.type === "mcpjam-refresh-mcp") {
      let ok = false;
      try {
        if (typeof msg.id !== "string" || msg.id.length > 64 || !options.onMcpRefresh) throw new Error("Unavailable");
        await options.onMcpRefresh(msg.servers);
        ok = true;
      } catch {
        // The caller receives a refusal without configuration or credentials.
        ok = false;
      }
      sendControl(ws, { type: "mcpjam-mcp-refreshed", id: msg.id, ok });
      return;
    }
    switch (msg.type) {`,
          ),
        };
      },
    );
  },
};
