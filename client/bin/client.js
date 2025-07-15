#!/usr/bin/env node

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import handler from "serve-handler";
import http from "http";
import open from "open";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = join(__dirname, "../dist");

const server = http.createServer((request, response) => {
  const handlerOptions = {
    public: distPath,
    rewrites: [{ source: "/**", destination: "/index.html" }],
    headers: [
      {
        // Ensure index.html is never cached
        source: "index.html",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, max-age=0",
          },
        ],
      },
      {
        // Allow long-term caching for hashed assets
        source: "assets/**",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ],
  };

  return handler(request, response, handlerOptions);
});

const defaultPort = process.env.PORT || 6274;
let port = Number(defaultPort);

// Try ports sequentially until one works
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`⚠️  Port ${port} was in use, trying ${port + 1}`);
    port++;
    server.listen(port);
  } else {
    console.error(`❌  MCPJam Inspector failed to start: ${err.message}`);
  }
});

server.on("listening", () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(
    `🔍 MCPJam Inspector is up and running at \u001B]8;;${url}\u0007${url}\u001B]8;;\u0007 🚀`,
  );

  if (process.env.MCP_AUTO_OPEN_ENABLED !== "false") {
    console.log(
      `🌐 Opening browser at \u001B]8;;${url}\u0007${url}\u001B]8;;\u0007`,
    );
    open(url);
  }
});

server.listen(port);
