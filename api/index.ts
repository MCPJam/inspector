import { handle } from "hono/adapter/vercel";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from "fs";
import { join } from "path";
import { createApp, getMCPConfigFromEnv } from "../server/app";

const app = createApp({ env: process.env });

const clientDistRoot = join(process.cwd(), "dist", "client");

app.use("/*.png", serveStatic({ root: "./public" }));
app.use("/*.svg", serveStatic({ root: "./public" }));
app.use("/*.jpg", serveStatic({ root: "./public" }));
app.use("/*.jpeg", serveStatic({ root: "./public" }));
app.use("/*.ico", serveStatic({ root: "./public" }));
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

export default handle(app);
