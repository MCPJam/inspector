import express, { type Express } from "express";
import type { Server } from "node:http";
import { getConfig, resourceUrl, asIssuer } from "./config.ts";

const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";

export function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // "Who guards me" sign (RFC 9728): points the debugger at this same server
  // as its own authorization server.
  app.get("/.well-known/oauth-protected-resource", (req, res) => {
    res.json({
      resource: resourceUrl(req),
      authorization_servers: [asIssuer(req)],
    });
  });

  // "Front desk info" sign (RFC 8414): advertises the jwt-bearer grant + token
  // endpoint.
  app.get("/.well-known/oauth-authorization-server", (req, res) => {
    const issuer = asIssuer(req);
    res.json({
      issuer,
      token_endpoint: `${issuer}/token`,
      grant_types_supported: [JWT_BEARER],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  return app;
}

export async function startServer(env: Record<string, string> = {}): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  Object.assign(process.env, env);
  const app = buildApp();
  const port = Number(process.env.PORT ?? 8080);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(port, () => resolve(s));
  });
  const actualPort = (server.address() as { port: number }).port;
  return {
    url: `http://localhost:${actualPort}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// Boot when run directly.
if (process.argv[1]?.endsWith("server.ts")) {
  const cfg = getConfig();
  startServer().then((app) =>
    console.log(
      `xaa-demo listening on ${app.url} (audience required: ${cfg.canonicalUrl})`,
    ),
  );
}
