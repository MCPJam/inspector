import "./types/hono";
import * as Sentry from "@sentry/node";
import fixPath from "fix-path";
import dotenv from "dotenv";
import { existsSync } from "fs";
import { serveStatic } from "@hono/node-server/serve-static";
import { MCPClientManager } from "@/sdk";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { join, dirname, resolve } from "path";
import path from "path";
import { fileURLToPath } from "url";
import mcpRoutes from "./routes/mcp/index";
import { rpcLogBus } from "./services/rpc-log-bus";
import { interceptorStore } from "./services/interceptor-store";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type MCPCLIServerConfig = {
  name: string;
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
};

export type MCPCLIConfig = {
  servers: MCPCLIServerConfig[];
  autoConnectServer?: string | null;
} | null;

export type CreateAppOptions = {
  env?: NodeJS.ProcessEnv;
  corsOrigins?: string[];
};

const defaultDevOrigins = (env: NodeJS.ProcessEnv): string[] => {
  const serverPort = env.PORT || "3001";
  return [`http://localhost:${serverPort}`, "http://localhost:3000"];
};

const parseOrigins = (origins: string[]): string | string[] => {
  if (origins.length === 0) {
    return "*";
  }
  if (origins.length === 1 && origins[0] === "*") {
    return "*";
  }
  return origins;
};

const resolveCorsOrigins = (
  env: NodeJS.ProcessEnv,
  explicit?: string[],
): string | string[] => {
  if (explicit && explicit.length > 0) {
    return parseOrigins(explicit);
  }

  const envOrigins = env.CORS_ORIGINS
    ? env.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean)
    : [];
  if (envOrigins.length > 0) {
    return parseOrigins(envOrigins);
  }

  if (env.NODE_ENV === "production") {
    const vercelUrl = env.VERCEL_URL ? `https://${env.VERCEL_URL}` : undefined;
    const clientOrigin = env.CLIENT_ORIGIN || env.FRONTEND_URL;
    const origins = [clientOrigin, vercelUrl].filter(Boolean) as string[];
    if (origins.length === 0) {
      return "*";
    }
    return parseOrigins(origins);
  }

  return parseOrigins(defaultDevOrigins(env));
};

export const getMCPConfigFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): MCPCLIConfig => {
  const configData = env.MCP_CONFIG_DATA;
  if (configData) {
    try {
      const config = JSON.parse(configData);
      if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
        const servers = Object.entries(config.mcpServers).map(
          ([name, serverConfig]: [string, any]) => ({
            name,
            type: serverConfig.type || "stdio",
            command: serverConfig.command,
            args: serverConfig.args || [],
            env: serverConfig.env || {},
            url: serverConfig.url,
          }),
        );
        const autoConnectServer = env.MCP_AUTO_CONNECT_SERVER || null;
        return {
          servers,
          autoConnectServer,
        };
      }
    } catch (error) {
      console.error("Failed to parse MCP_CONFIG_DATA:", error);
    }
  }

  const command = env.MCP_SERVER_COMMAND;
  if (!command) {
    return null;
  }

  const argsString = env.MCP_SERVER_ARGS;
  const args = argsString ? JSON.parse(argsString) : [];

  return {
    servers: [
      {
        command,
        args,
        name: "CLI Server",
        env: {},
      },
    ],
  };
};

export const createApp = ({
  env: providedEnv,
  corsOrigins,
}: CreateAppOptions = {}) => {
  const env = providedEnv || process.env;

  if (!env.CONVEX_HTTP_URL) {
    throw new Error(
      "CONVEX_HTTP_URL is required but not set. Please configure it via environment variable.",
    );
  }

  const app = new Hono().onError((err, c) => {
    console.error("Unhandled error:", err);
    Sentry.captureException(err);

    if (err instanceof HTTPException) {
      return err.getResponse();
    }

    return c.json({ error: "Internal server error" }, 500);
  });

  const allowedOrigins = resolveCorsOrigins(env, corsOrigins);

  const mcpClientManager = new MCPClientManager(
    {},
    {
      rpcLogger: ({ direction, message, serverId }) => {
        rpcLogBus.publish({
          serverId,
          direction,
          timestamp: new Date().toISOString(),
          message,
        });
      },
    },
  );

  if (env.DEBUG_MCP_SELECTION === "1") {
    console.log("[mcpjam][boot] DEBUG_MCP_SELECTION enabled");
  }

  app.use("*", async (c, next) => {
    c.mcpClientManager = mcpClientManager;
    await next();
  });

  app.use("*", logger());
  app.use(
    "*",
    cors({
      origin: allowedOrigins,
      credentials: true,
    }),
  );

  app.route("/api/mcp", mcpRoutes);

  app.options("/sse/message", (c) => {
    return c.body(null, 204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, Accept, Accept-Language",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin, Access-Control-Request-Headers",
    });
  });

  app.post("/sse/message", async (c) => {
    try {
      const url = new URL(c.req.url);
      const sessionId =
        url.searchParams.get("sessionId") || url.searchParams.get("sid") || "";
      if (!sessionId) {
        return c.json({ error: "Missing sessionId" }, 400);
      }
      const mapping = interceptorStore.getSessionMapping(sessionId);
      if (!mapping) {
        return c.json({ error: "Unknown sessionId" }, 404);
      }
      const entry = interceptorStore.get(mapping.interceptorId);
      if (!entry) {
        return c.json({ error: "Interceptor not found" }, 404);
      }

      let bodyText = "";
      try {
        bodyText = await c.req.text();
      } catch {}
      const headers = new Headers();
      c.req.raw.headers.forEach((v, k) => {
        const key = k.toLowerCase();
        if (
          [
            "connection",
            "keep-alive",
            "transfer-encoding",
            "upgrade",
            "proxy-authenticate",
            "proxy-authorization",
            "te",
            "trailer",
            "host",
            "content-length",
          ].includes(key)
        ) {
          return;
        }
        headers.set(k, v);
      });
      if (entry.injectHeaders) {
        for (const [k, v] of Object.entries(entry.injectHeaders)) {
          const key = k.toLowerCase();
          if (
            [
              "connection",
              "keep-alive",
              "transfer-encoding",
              "upgrade",
              "proxy-authenticate",
              "proxy-authorization",
              "te",
              "trailer",
              "host",
              "content-length",
            ].includes(key)
          ) {
            continue;
          }
          if (key === "authorization" && headers.has("authorization")) {
            continue;
          }
          headers.set(k, v);
        }
      }
      try {
        await fetch(new Request(mapping.url, { method: "POST", headers, body: bodyText }));
      } catch {}
      return c.body("Accepted", 202, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "*",
      });
    } catch (error: any) {
      return c.body(
        JSON.stringify({ error: error?.message || "Forward error" }),
        400,
        {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "*",
        },
      );
    }
  });

  app.get("/health", (c) => {
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/mcp-cli-config", (c) => {
    const config = getMCPConfigFromEnv(env);
    return c.json({ config });
  });

  return app;
};

export const createHonoApp = () => {
  const envFile =
    process.env.NODE_ENV === "production"
      ? ".env.production"
      : ".env.development";

  let envPath = envFile;

  if (process.env.IS_PACKAGED === "true" && (process as any).resourcesPath) {
    envPath = join((process as any).resourcesPath, envFile);
  } else if (process.env.ELECTRON_APP === "true") {
    envPath = join(process.env.ELECTRON_RESOURCES_PATH || ".", envFile);
  } else {
    const packageRoot = resolve(__dirname, "..", "..");
    const packageEnvPath = join(packageRoot, envFile);
    if (existsSync(packageEnvPath)) {
      envPath = packageEnvPath;
    }
  }

  dotenv.config({ path: envPath });

  if (!process.env.CONVEX_HTTP_URL) {
    throw new Error(
      `CONVEX_HTTP_URL is required but not set. Tried loading from: ${envPath}\n` +
        `IS_PACKAGED=${process.env.IS_PACKAGED}, resourcesPath=${(process as any).resourcesPath}\n` +
        `File exists: ${existsSync(envPath)}`,
    );
  }

  try {
    fixPath();
  } catch {}

  const app = createApp({
    env: process.env,
    corsOrigins: [
      "http://localhost:8080",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:5173",
    ],
  });

  const isElectron = process.env.ELECTRON_APP === "true";
  const isProduction = process.env.NODE_ENV === "production";
  const isPackaged = process.env.IS_PACKAGED === "true";

  if (isProduction || (isElectron && isPackaged)) {
    let root = "./dist/client";
    if (isElectron && isPackaged) {
      const resourcesRoot =
        process.env.ELECTRON_RESOURCES_PATH ||
        (process as any).resourcesPath ||
        ".";
      root = path.resolve(resourcesRoot, "client");
    }
    app.use("/*", serveStatic({ root }));
    app.get("/*", serveStatic({ path: `${root}/index.html` }));
  } else if (isElectron && !isPackaged) {
    const rendererDevUrl = process.env.ELECTRON_RENDERER_URL || "http://localhost:8080";
    app.get("/*", (c) => {
      const target = new URL(c.req.path, rendererDevUrl).toString();
      return c.redirect(target, 307);
    });
  } else {
    const serverPort = process.env.PORT || "3001";
    app.get("/", (c) => {
      return c.json({
        message: "MCPJam API Server",
        environment: process.env.NODE_ENV || "development",
        frontend: `http://localhost:${serverPort}`,
      });
    });
  }

  return app;
};

export type AppType = ReturnType<typeof createApp>;
