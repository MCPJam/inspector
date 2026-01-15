/**
 * Shared utilities for running MCP servers with Streamable HTTP transport.
 */

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import type { Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";

export interface ServerOptions {
  port: number;
  name?: string;
}

/**
 * Starts an MCP server with Streamable HTTP transport in stateless mode.
 *
 * @param createServer - Factory function that creates a new McpServer instance per request.
 * @param options - Server configuration options.
 */
type ServerFactoryOptions = {
  authToken?: string;
};

export async function startServer(
  createServer: (options?: ServerFactoryOptions) => McpServer,
  options: ServerOptions,
): Promise<void> {
  const { port, name = "MCP Server" } = options;
  const baseUrl = process.env.PUBLIC_URL ?? `http://localhost:${port}`;
  const authkitIssuer = normalizeIssuer(process.env.AUTHKIT_DOMAIN);
  if (!authkitIssuer) {
    throw new Error("Missing AUTHKIT_DOMAIN.");
  }

  const app = createMcpExpressApp({ host: "0.0.0.0" });
  app.use(cors());
  app.use(createAuthMetadataRoutes({ app, baseUrl, authkitIssuer }));

  app.all(
    "/mcp",
    authkitBearerAuth({ baseUrl, authkitIssuer, allowAnonymous: true }),
    async (req: Request, res: Response) => {
    const authToken = extractBearerToken(req.headers.authorization);
    const server = createServer({ authToken });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
    },
  );

  const httpServer = app.listen(port, (err) => {
    if (err) {
      console.error("Failed to start server:", err);
      process.exit(1);
    }
    console.log(`${name} listening on http://localhost:${port}/mcp`);
  });

  const shutdown = () => {
    console.log("\nShutting down...");
    httpServer.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function extractBearerToken(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const [type, token] = value.split(" ");
  if (type?.toLowerCase() !== "bearer" || !token) {
    return undefined;
  }
  return token;
}

function normalizeIssuer(domain: string | undefined): string | undefined {
  if (!domain) {
    return undefined;
  }
  if (domain.startsWith("http://") || domain.startsWith("https://")) {
    return domain.replace(/\/+$/, "");
  }
  return `https://${domain.replace(/\/+$/, "")}`;
}

function createAuthMetadataRoutes({
  app,
  baseUrl,
  authkitIssuer,
}: {
  app: ReturnType<typeof createMcpExpressApp>;
  baseUrl: string;
  authkitIssuer: string;
}) {
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: baseUrl,
      authorization_servers: [authkitIssuer],
      bearer_methods_supported: ["header"],
    });
  });

  app.get("/.well-known/oauth-authorization-server", async (_req, res) => {
    const response = await fetch(
      `${authkitIssuer}/.well-known/oauth-authorization-server`,
    );
    const metadata = await response.json();
    res.json(metadata);
  });

  return (_req: Request, _res: Response, next: () => void) => next();
}

function authkitBearerAuth({
  baseUrl,
  authkitIssuer,
  allowAnonymous,
}: {
  baseUrl: string;
  authkitIssuer: string;
  allowAnonymous?: boolean;
}) {
  const jwks = createRemoteJWKSet(new URL(`${authkitIssuer}/oauth2/jwks`));
  const resourceMetadata = new URL(
    "/.well-known/oauth-protected-resource",
    baseUrl,
  ).toString();
  const wwwAuthenticate = [
    'Bearer error="unauthorized"',
    'error_description="Authorization needed"',
    `resource_metadata="${resourceMetadata}"`,
  ].join(", ");

  return async (req: Request, res: Response, next: () => void) => {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      if (allowAnonymous) {
        next();
        return;
      }
      res
        .set("WWW-Authenticate", wwwAuthenticate)
        .status(401)
        .json({ error: "No token provided." });
      return;
    }

    try {
      await jwtVerify(token, jwks, { issuer: authkitIssuer });
      next();
    } catch {
      res
        .set("WWW-Authenticate", wwwAuthenticate)
        .status(401)
        .json({ error: "Invalid bearer token." });
    }
  };
}
