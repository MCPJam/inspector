/**
 * Local App documents on the Inspector's own port.
 *
 * Each admitted MCP App gets a `<uuid>.localhost` origin on the port the
 * browser already uses for the Inspector, so it loads wherever that one port
 * is forwarded (Docker, SSH tunnels, devcontainers). Mounted ahead of every
 * other middleware and route: a `localhost` subdomain answers its admitted
 * document and 404s everything else, never the app shell, assets or API, and
 * the document keeps the exact headers the registry sets.
 */
import type { Hono } from "hono";
import { sandboxViews } from "../services/sandbox-view-registry.js";

/** Register on `app` before any other middleware or route. */
export function mountLocalSandboxViewHost(app: Hono): void {
  app.use("*", async (c, next) => {
    const response = sandboxViews.respond(c.req.raw);
    if (response) return response;
    await next();
  });
}
