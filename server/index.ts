import "./sentry";

import { serve } from "@hono/node-server";
import dotenv from "dotenv";
import fixPath from "fix-path";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { createApp, getMCPConfigFromEnv } from "./app";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logBox = (content: string, title?: string) => {
  const lines = content.split("\n");
  const maxLength = Math.max(...lines.map((line) => line.length));
  const width = maxLength + 4;

  console.log("┌" + "─".repeat(width) + "┐");
  if (title) {
    const titlePadding = Math.floor((width - title.length - 2) / 2);
    console.log(
      "│" +
        " ".repeat(titlePadding) +
        title +
        " ".repeat(width - title.length - titlePadding) +
        "│",
    );
    console.log("├" + "─".repeat(width) + "┤");
  }

  lines.forEach((line) => {
    const padding = width - line.length - 2;
    console.log("│ " + line + " ".repeat(padding) + " │");
  });

  console.log("└" + "─".repeat(width) + "┘");
};

try {
  fixPath();
} catch {}

const envFile =
  process.env.NODE_ENV === "production"
    ? ".env.production"
    : ".env.development";

let envPath = envFile;
if (
  process.env.ELECTRON_APP === "true" &&
  process.env.ELECTRON_RESOURCES_PATH
) {
  envPath = join(process.env.ELECTRON_RESOURCES_PATH, envFile);
} else {
  const packageRoot = resolve(__dirname, "..", "..");
  const packageEnvPath = join(packageRoot, envFile);
  if (existsSync(packageEnvPath)) {
    envPath = packageEnvPath;
  }
}

dotenv.config({ path: envPath });

const app = createApp({ env: process.env });

if (process.env.NODE_ENV !== "production") {
  const serverPort = process.env.PORT || "3001";
  app.get("/", (c) => {
    return c.json({
      message: "MCPJam API Server",
      environment: process.env.NODE_ENV || "development",
      frontend: `http://localhost:${serverPort}`,
    });
  });
}

if (process.env.NODE_ENV === "production") {
  app.use("/*.png", serveStatic({ root: "./public" }));
  app.use("/*.svg", serveStatic({ root: "./public" }));
  app.use("/*.jpg", serveStatic({ root: "./public" }));
  app.use("/*.jpeg", serveStatic({ root: "./public" }));
  app.use("/*.ico", serveStatic({ root: "./public" }));

  const clientDistRoot = join(process.cwd(), "dist", "client");
  app.use("/*", serveStatic({ root: clientDistRoot }));

  app.get("*", async (c) => {
    const path = c.req.path;
    if (path.startsWith("/api/")) {
      return c.notFound();
    }

    const indexPath = join(clientDistRoot, "index.html");
    let htmlContent = readFileSync(indexPath, "utf-8");
    const mcpConfig = getMCPConfigFromEnv(process.env);
    if (mcpConfig) {
      const configScript = `<script>window.MCP_CLI_CONFIG = ${JSON.stringify(mcpConfig)};</script>`;
      htmlContent = htmlContent.replace("</head>", `${configScript}</head>`);
    }

    return c.html(htmlContent);
  });
}

const port = parseInt(process.env.PORT || "3001", 10);
const hostname =
  process.env.NODE_ENV === "production" ? "127.0.0.1" : "localhost";

logBox(`http://${hostname}:${port}`, "🚀 Inspector Launched");

const server = serve({
  fetch: app.fetch,
  port,
  hostname: "0.0.0.0",
});

process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down gracefully...");
  server.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n🛑 Shutting down gracefully...");
  server.close();
  process.exit(0);
});
