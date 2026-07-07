import express, { type Express } from "express";
import type { Server } from "node:http";
import { getConfig, resourceUrl, asIssuer } from "./config.ts";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { verifyIdJag } from "./idjag.ts";
import { mintAccessToken, verifyAccessToken } from "./access-token.ts";
import { buildMcpServer } from "./mcp.ts";

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

  // Front desk (jwt-bearer grant, RFC 7523): verify the signed pass, then mint
  // a keycard bound to the resource the pass requested.
  app.post("/token", async (req, res) => {
    const cfg = getConfig();
    const { assertion, resource } = req.body as {
      assertion?: string;
      resource?: string;
    };
    if (!assertion || !resource) {
      return res.status(400).json({ error: "invalid_request" });
    }
    try {
      const verified = await verifyIdJag(assertion, {
        audience: asIssuer(req),
        trustedIssuer: cfg.trustedIssuer,
      });
      const accessToken = await mintAccessToken({
        subject: verified.sub,
        audience: resource,
        scope: verified.scope,
        issuer: asIssuer(req),
        secret: cfg.accessTokenSecret,
      });
      res.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
      });
    } catch (err) {
      res.status(400).json({
        error: "invalid_grant",
        error_description: String((err as Error).message),
      });
    }
  });

  // The office door: the MCP endpoint. Guarded — it checks the keycard's
  // stamped address (`aud`) against the address this server requires. Mismatch
  // → 401 (the bug the how-to teaches). Match → serve MCP.
  app.post("/mcp", async (req, res) => {
    const cfg = getConfig();
    const auth = req.header("authorization");
    const sendUnauthorized = (desc: string) => {
      res
        .status(401)
        .set(
          "WWW-Authenticate",
          `Bearer resource_metadata="${asIssuer(req)}/.well-known/oauth-protected-resource", error="invalid_token", error_description="${desc}"`,
        )
        .json({ error: "invalid_token", error_description: desc });
    };
    if (!auth?.startsWith("Bearer ")) {
      return sendUnauthorized("missing bearer token");
    }
    try {
      await verifyAccessToken(auth.slice("Bearer ".length), {
        issuer: asIssuer(req),
        audience: cfg.canonicalUrl,
        secret: cfg.accessTokenSecret,
      });
    } catch {
      return sendUnauthorized(
        `token audience does not match this server's required audience (${cfg.canonicalUrl})`,
      );
    }
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
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
