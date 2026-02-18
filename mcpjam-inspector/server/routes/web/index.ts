import { Hono } from "hono";
import { z } from "zod";
import { convertToModelMessages, type ToolSet } from "ai";
import { MCPClientManager } from "@mcpjam/sdk";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  McpUiResourceCsp,
  McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps";

import type { ChatV2Request } from "@/shared/chat-v2";
import {
  isAnthropicCompatibleModel,
  getInvalidAnthropicToolNames,
  scrubMcpAppsToolResultsForBackend,
  scrubChatGPTAppsToolResultsForBackend,
} from "../../utils/chat-helpers.js";
import { getSkillToolsAndPrompt } from "../../utils/skill-tools.js";
import { handleMCPJamFreeChatModel } from "../../utils/mcpjam-stream-handler.js";
import { logger } from "../../utils/logger.js";
import {
  mapModelIdToTokenizerBackend,
  estimateTokensFromChars,
} from "../../utils/tokenizer-helpers.js";
import { isGPT5Model, isMCPJamProvidedModel } from "@/shared/types";
import {
  WEB_CONNECT_TIMEOUT_MS,
  WEB_CALL_TIMEOUT_MS,
  WEB_STREAM_TIMEOUT_MS,
  CORS_ORIGINS,
} from "../../config.js";
import { CHATGPT_APPS_RUNTIME_SCRIPT } from "../apps/chatgpt-apps/OpenAIRuntime.bundled.js";
import { MCP_APPS_OPENAI_COMPATIBLE_RUNTIME_SCRIPT } from "../apps/mcp-apps/McpAppsOpenAICompatibleRuntime.bundled.js";
import {
  CHATGPT_APPS_SANDBOX_PROXY_HTML,
  MCP_APPS_SANDBOX_PROXY_HTML,
} from "../apps/SandboxProxyHtml.bundled.js";
import type { HttpServerConfig } from "@mcpjam/sdk";
import oauthWeb from "./oauth.js";

const web = new Hono();

const DEFAULT_TEMPERATURE = 0.7;
const MCP_APPS_MIMETYPE = RESOURCE_MIME_TYPE;

const LOCALHOST_FRAME_SOURCES = [
  "http://localhost:*",
  "http://127.0.0.1:*",
  "https://localhost:*",
  "https://127.0.0.1:*",
];

function buildFrameAncestors(): string {
  const origins = new Set<string>(["'self'", ...LOCALHOST_FRAME_SOURCES]);
  for (const origin of CORS_ORIGINS) {
    if (origin.startsWith("https://")) {
      origins.add(origin);
    }
  }
  return `frame-ancestors ${Array.from(origins).join(" ")}`;
}

const ErrorCode = {
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
  FEATURE_NOT_SUPPORTED: "FEATURE_NOT_SUPPORTED",
  SERVER_UNREACHABLE: "SERVER_UNREACHABLE",
  TIMEOUT: "TIMEOUT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

class WebRouteError extends Error {
  status: number;
  code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function webError(c: any, status: number, code: ErrorCode, message: string) {
  return c.json({ code, message }, status);
}

function parseErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mapRuntimeError(error: unknown): WebRouteError {
  if (error instanceof WebRouteError) return error;

  const message = parseErrorMessage(error);
  const lower = message.toLowerCase();

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return new WebRouteError(504, ErrorCode.TIMEOUT, message);
  }

  if (
    lower.includes("connect") ||
    lower.includes("connection") ||
    lower.includes("refused") ||
    lower.includes("econn")
  ) {
    return new WebRouteError(502, ErrorCode.SERVER_UNREACHABLE, message);
  }

  return new WebRouteError(500, ErrorCode.INTERNAL_ERROR, message);
}

function assertBearerToken(c: any): string {
  const authHeader = c.req.header("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new WebRouteError(
      401,
      ErrorCode.UNAUTHORIZED,
      "Missing or invalid bearer token",
    );
  }
  return authHeader.slice("Bearer ".length);
}

async function readJsonBody<T>(c: any): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Invalid JSON body",
    );
  }
}

function parseWithSchema<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      issue?.message ?? "Request validation failed",
    );
  }
  return parsed.data;
}

const workspaceServerSchema = z.object({
  workspaceId: z.string().min(1),
  serverId: z.string().min(1),
  oauthAccessToken: z.string().optional(),
});

const toolsListSchema = workspaceServerSchema.extend({
  modelId: z.string().optional(),
  cursor: z.string().optional(),
});

const toolsExecuteSchema = workspaceServerSchema.extend({
  toolName: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).default({}),
  taskOptions: z.record(z.string(), z.unknown()).optional(),
});

const resourcesListSchema = workspaceServerSchema.extend({
  cursor: z.string().optional(),
});

const resourcesReadSchema = workspaceServerSchema.extend({
  uri: z.string().min(1),
});

const promptsListSchema = workspaceServerSchema.extend({
  cursor: z.string().optional(),
});

const promptsListMultiSchema = z.object({
  workspaceId: z.string().min(1),
  serverIds: z.array(z.string().min(1)).min(1),
  oauthTokens: z.record(z.string(), z.string()).optional(),
});

const promptsGetSchema = workspaceServerSchema.extend({
  promptName: z.string().min(1),
  arguments: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
});

const hostedChatSchema = z
  .object({
    workspaceId: z.string().min(1),
    selectedServerIds: z.array(z.string().min(1)),
    oauthTokens: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

type ConvexAuthorizeResponse = {
  authorized: boolean;
  role: "owner" | "admin" | "member";
  serverConfig: {
    transportType: "stdio" | "http";
    url?: string;
    headers?: Record<string, string>;
    useOAuth?: boolean;
  };
};

async function authorizeServer(
  bearerToken: string,
  workspaceId: string,
  serverId: string,
): Promise<ConvexAuthorizeResponse> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration",
    );
  }

  let response: Response;
  try {
    response = await fetch(`${convexUrl}/web/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({ workspaceId, serverId }),
    });
  } catch (error) {
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      `Failed to reach authorization service: ${parseErrorMessage(error)}`,
    );
  }

  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // ignored
  }

  if (!response.ok) {
    const code = typeof body?.code === "string" ? body.code : ErrorCode.INTERNAL_ERROR;
    const message =
      typeof body?.message === "string"
        ? body.message
        : `Authorization failed (${response.status})`;
    throw new WebRouteError(
      response.status,
      code as ErrorCode,
      message,
    );
  }

  if (!body?.authorized || !body?.serverConfig) {
    throw new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      "Authorization denied for server",
    );
  }

  return body as ConvexAuthorizeResponse;
}

function toHttpConfig(
  authResponse: ConvexAuthorizeResponse,
  timeoutMs: number,
  oauthAccessToken?: string,
): HttpServerConfig {
  if (authResponse.serverConfig.transportType !== "http") {
    throw new WebRouteError(
      400,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      "Only HTTP transport is supported in hosted mode",
    );
  }

  if (!authResponse.serverConfig.url) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Authorized server is missing URL",
    );
  }

  const headers: Record<string, string> = {
    ...(authResponse.serverConfig.headers ?? {}),
  };

  if (oauthAccessToken) {
    headers["Authorization"] = `Bearer ${oauthAccessToken}`;
  }

  return {
    url: authResponse.serverConfig.url,
    requestInit: {
      headers,
    },
    timeout: timeoutMs,
  };
}

async function createAuthorizedManager(
  bearerToken: string,
  workspaceId: string,
  serverIds: string[],
  timeoutMs: number,
  oauthTokens?: Record<string, string>,
): Promise<MCPClientManager> {
  const uniqueServerIds = Array.from(new Set(serverIds));
  const configEntries = await Promise.all(
    uniqueServerIds.map(async (serverId) => {
      const auth = await authorizeServer(bearerToken, workspaceId, serverId);
      const oauthToken = oauthTokens?.[serverId];

      if (auth.serverConfig.useOAuth && !oauthToken) {
        throw new WebRouteError(
          401,
          ErrorCode.UNAUTHORIZED,
          `Server "${serverId}" requires OAuth authentication. Please complete the OAuth flow first.`,
        );
      }

      return [serverId, toHttpConfig(auth, timeoutMs, oauthToken)] as const;
    }),
  );

  return new MCPClientManager(Object.fromEntries(configEntries), {
    defaultTimeout: timeoutMs,
  });
}

async function withManager<T>(
  managerPromise: Promise<MCPClientManager>,
  fn: (manager: MCPClientManager) => Promise<T>,
): Promise<T> {
  const manager = await managerPromise;
  try {
    return await fn(manager);
  } finally {
    await manager.disconnectAllServers();
  }
}

async function countToolsTokens(
  tools: any[],
  modelId: string,
): Promise<number> {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  const mappedModelId = mapModelIdToTokenizerBackend(modelId);
  const useBackendTokenizer = mappedModelId !== null && !!convexHttpUrl;

  try {
    const toolsText = JSON.stringify(tools);

    if (useBackendTokenizer && mappedModelId) {
      const response = await fetch(`${convexHttpUrl}/tokenizer/count`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: toolsText, model: mappedModelId }),
      });

      if (response.ok) {
        const data = (await response.json()) as {
          ok?: boolean;
          tokenCount?: number;
        };
        if (data.ok) {
          return data.tokenCount || 0;
        }
      }
    }

    return estimateTokensFromChars(toolsText);
  } catch (error) {
    logger.warn("[web/tools] Error counting tokens", {
      error: parseErrorMessage(error),
    });
    return 0;
  }
}

function serializeForInlineScript(value: unknown) {
  return JSON.stringify(value ?? null)
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function extractHtmlFromResourceContent(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const record = content as Record<string, unknown>;

  if (typeof record.text === "string") return record.text;
  if (typeof record.blob === "string") {
    return Buffer.from(record.blob, "base64").toString("utf-8");
  }
  return "";
}

function injectMcpAppsCompat(
  html: string,
  widgetData: {
    toolId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    toolOutput: unknown;
    theme?: string;
    viewMode?: string;
    viewParams?: Record<string, unknown>;
  },
): string {
  const configJson = serializeForInlineScript({
    toolId: widgetData.toolId,
    toolName: widgetData.toolName,
    toolInput: widgetData.toolInput,
    toolOutput: widgetData.toolOutput,
    theme: widgetData.theme ?? "dark",
    viewMode: widgetData.viewMode ?? "inline",
    viewParams: widgetData.viewParams ?? {},
  });

  const configScript = `<script type="application/json" id="openai-compat-config">${configJson}</script>`;
  const escapedRuntime = MCP_APPS_OPENAI_COMPATIBLE_RUNTIME_SCRIPT.replace(
    /<\//g,
    "<\\/",
  );
  const runtimeScript = `<script>${escapedRuntime}</script>`;
  const headContent = `${configScript}${runtimeScript}`;

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, `$&${headContent}`);
  }
  return `<!DOCTYPE html><html><head>${headContent}<meta charset="UTF-8"></head><body>${html}</body></html>`;
}

function extractBaseUrl(html: string): string {
  const baseMatch = html.match(/<base\s+href\s*=\s*["']([^"']+)["']\s*\/?>/i);
  if (baseMatch) return baseMatch[1];
  const innerMatch = html.match(/window\.innerBaseUrl\s*=\s*["']([^"']+)["']/);
  if (innerMatch) return innerMatch[1];
  return "";
}

function generateUrlPolyfillScript(baseUrl: string): string {
  if (!baseUrl) return "";
  return `<script>(function(){
var BASE="${baseUrl}";window.__widgetBaseUrl=BASE;var OrigURL=window.URL;
function isRelative(u){return typeof u==="string"&&!u.match(/^[a-z][a-z0-9+.-]*:/i);}
window.URL=function URL(u,b){
var base=b;if(base===void 0||base===null||base==="null"||base==="about:srcdoc"){base=BASE;}
else if(typeof base==="string"&&base.startsWith("null")){base=BASE;}
try{return new OrigURL(u,base);}catch(e){if(isRelative(u)){try{return new OrigURL(u,BASE);}catch(e2){}}throw e;}
};
window.URL.prototype=OrigURL.prototype;window.URL.createObjectURL=OrigURL.createObjectURL;
window.URL.revokeObjectURL=OrigURL.revokeObjectURL;window.URL.canParse=OrigURL.canParse;
})();</script>`;
}

const WIDGET_BASE_CSS = `<style>
html, body {
  margin: 0;
  padding: 0;
  overflow-x: hidden;
  overflow-y: auto;
}
</style>`;

const CONFIG_SCRIPT_ID = "openai-runtime-config";

function buildChatGptRuntimeConfigScript(config: Record<string, unknown>) {
  return `<script type="application/json" id="${CONFIG_SCRIPT_ID}">${serializeForInlineScript(config)}</script>`;
}

function injectChatGptRuntime(html: string, headContent: string) {
  if (/<html[^>]*>/i.test(html) && /<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, `$&${headContent}`);
  }
  return `<!DOCTYPE html><html><head>${headContent}<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body>${html}</body></html>`;
}

type CspMode = "permissive" | "widget-declared";

interface WidgetCspMeta {
  connect_domains?: string[];
  resource_domains?: string[];
  frame_domains?: string[];
}

function buildChatGptCspHeader(mode: CspMode, widgetCsp?: WidgetCspMeta | null) {
  const localhostSources = [
    "http://localhost:*",
    "http://127.0.0.1:*",
    "https://localhost:*",
    "https://127.0.0.1:*",
  ];

  const wsSources = [
    "ws://localhost:*",
    "ws://127.0.0.1:*",
    "wss://localhost:*",
  ];

  let connectDomains: string[];
  let resourceDomains: string[];
  let frameDomains: string[];

  if (mode === "widget-declared") {
    connectDomains = [
      "'self'",
      ...(widgetCsp?.connect_domains || []),
      ...localhostSources,
      ...wsSources,
    ];
    resourceDomains = [
      "'self'",
      "data:",
      "blob:",
      ...(widgetCsp?.resource_domains || []),
      ...localhostSources,
    ];
    frameDomains =
      widgetCsp?.frame_domains && widgetCsp.frame_domains.length > 0
        ? widgetCsp.frame_domains
        : [];
  } else {
    connectDomains = [
      "'self'",
      "https:",
      "wss:",
      "ws:",
      ...localhostSources,
      ...wsSources,
    ];
    resourceDomains = [
      "'self'",
      "data:",
      "blob:",
      "https:",
      ...localhostSources,
    ];
    frameDomains = ["*", "data:", "blob:", "https:", "http:", "about:"];
  }

  const connectSrc = connectDomains.join(" ");
  const resourceSrc = resourceDomains.join(" ");
  const imgSrc =
    mode === "widget-declared"
      ? `'self' data: blob: ${(widgetCsp?.resource_domains || []).join(" ")} ${localhostSources.join(" ")}`
      : `'self' data: blob: https: ${localhostSources.join(" ")}`;
  const mediaSrc =
    mode === "widget-declared"
      ? `'self' data: blob: ${(widgetCsp?.resource_domains || []).join(" ")} ${localhostSources.join(" ")}`
      : "'self' data: blob: https:";

  const frameAncestors = buildFrameAncestors();
  const frameSrc =
    frameDomains.length > 0
      ? `frame-src ${frameDomains.join(" ")}`
      : "frame-src 'none'";

  const headerString = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${resourceSrc}`,
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    `style-src 'self' 'unsafe-inline' ${resourceSrc}`,
    `img-src ${imgSrc}`,
    `media-src ${mediaSrc}`,
    `font-src 'self' data: ${resourceSrc}`,
    `connect-src ${connectSrc}`,
    frameSrc,
    frameAncestors,
  ].join("; ");

  return {
    mode,
    connectDomains,
    resourceDomains,
    frameDomains,
    headerString,
  };
}

async function handleRoute<T>(
  c: any,
  handler: () => Promise<T>,
  successStatus = 200,
) {
  try {
    const result = await handler();
    return c.json(result, successStatus);
  } catch (error) {
    const routeError = mapRuntimeError(error);
    return webError(c, routeError.status, routeError.code, routeError.message);
  }
}

web.post("/servers/validate", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(
      workspaceServerSchema,
      await readJsonBody<unknown>(c),
    );
    const auth = await authorizeServer(
      bearerToken,
      body.workspaceId,
      body.serverId,
    );

    if (auth.serverConfig.useOAuth && !body.oauthAccessToken) {
      throw new WebRouteError(
        401,
        ErrorCode.UNAUTHORIZED,
        `Server "${body.serverId}" requires OAuth authentication. Please complete the OAuth flow first.`,
      );
    }

    const manager = new MCPClientManager(
      {
        [body.serverId]: toHttpConfig(auth, WEB_CONNECT_TIMEOUT_MS, body.oauthAccessToken),
      },
      {
        defaultTimeout: WEB_CONNECT_TIMEOUT_MS,
      },
    );

    try {
      await manager.getToolsForAiSdk([body.serverId]);
      return { success: true, status: "connected" };
    } finally {
      await manager.disconnectAllServers();
    }
  }),
);

web.post("/tools/list", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(
      toolsListSchema,
      await readJsonBody<unknown>(c),
    );

    const oauthTokens = body.oauthAccessToken
      ? { [body.serverId]: body.oauthAccessToken }
      : undefined;

    return withManager(
      createAuthorizedManager(
        bearerToken,
        body.workspaceId,
        [body.serverId],
        WEB_CALL_TIMEOUT_MS,
        oauthTokens,
      ),
      async (manager) => {
        const result = await manager.listTools(
          body.serverId,
          body.cursor ? { cursor: body.cursor } : undefined,
        );
        const toolsMetadata = manager.getAllToolsMetadata(body.serverId);
        const tokenCount = body.modelId
          ? await countToolsTokens(result.tools, body.modelId)
          : undefined;

        return {
          ...result,
          toolsMetadata,
          tokenCount,
          nextCursor: result.nextCursor,
        };
      },
    );
  }),
);

web.post("/tools/execute", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(
      toolsExecuteSchema,
      await readJsonBody<unknown>(c),
    );

    if (body.taskOptions) {
      throw new WebRouteError(
        400,
        ErrorCode.FEATURE_NOT_SUPPORTED,
        "Task-augmented tool execution is not supported in hosted mode",
      );
    }

    const oauthTokens = body.oauthAccessToken
      ? { [body.serverId]: body.oauthAccessToken }
      : undefined;

    return withManager(
      createAuthorizedManager(
        bearerToken,
        body.workspaceId,
        [body.serverId],
        WEB_CALL_TIMEOUT_MS,
        oauthTokens,
      ),
      async (manager) => {
        const result = await manager.executeTool(
          body.serverId,
          body.toolName,
          body.parameters,
        );
        return {
          status: "completed",
          result,
        };
      },
    );
  }),
);

web.post("/resources/list", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(
      resourcesListSchema,
      await readJsonBody<unknown>(c),
    );

    const oauthTokens = body.oauthAccessToken
      ? { [body.serverId]: body.oauthAccessToken }
      : undefined;

    return withManager(
      createAuthorizedManager(
        bearerToken,
        body.workspaceId,
        [body.serverId],
        WEB_CALL_TIMEOUT_MS,
        oauthTokens,
      ),
      async (manager) => {
        const result = await manager.listResources(
          body.serverId,
          body.cursor ? { cursor: body.cursor } : undefined,
        );
        return {
          resources: result.resources ?? [],
          nextCursor: result.nextCursor,
        };
      },
    );
  }),
);

web.post("/resources/read", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(
      resourcesReadSchema,
      await readJsonBody<unknown>(c),
    );

    const oauthTokens = body.oauthAccessToken
      ? { [body.serverId]: body.oauthAccessToken }
      : undefined;

    return withManager(
      createAuthorizedManager(
        bearerToken,
        body.workspaceId,
        [body.serverId],
        WEB_CALL_TIMEOUT_MS,
        oauthTokens,
      ),
      async (manager) => {
        const content = await manager.readResource(body.serverId, {
          uri: body.uri,
        });
        return { content };
      },
    );
  }),
);

web.post("/prompts/list", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(
      promptsListSchema,
      await readJsonBody<unknown>(c),
    );

    const oauthTokens = body.oauthAccessToken
      ? { [body.serverId]: body.oauthAccessToken }
      : undefined;

    return withManager(
      createAuthorizedManager(
        bearerToken,
        body.workspaceId,
        [body.serverId],
        WEB_CALL_TIMEOUT_MS,
        oauthTokens,
      ),
      async (manager) => {
        const result = await manager.listPrompts(
          body.serverId,
          body.cursor ? { cursor: body.cursor } : undefined,
        );
        return {
          prompts: result.prompts ?? [],
          nextCursor: result.nextCursor,
        };
      },
    );
  }),
);

web.post("/prompts/list-multi", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(
      promptsListMultiSchema,
      await readJsonBody<unknown>(c),
    );

    return withManager(
      createAuthorizedManager(
        bearerToken,
        body.workspaceId,
        body.serverIds,
        WEB_CALL_TIMEOUT_MS,
        body.oauthTokens,
      ),
      async (manager) => {
        const promptsByServer: Record<string, unknown[]> = {};
        const errors: Record<string, string> = {};

        await Promise.all(
          body.serverIds.map(async (serverId) => {
            try {
              const { prompts } = await manager.listPrompts(serverId);
              promptsByServer[serverId] = prompts ?? [];
            } catch (error) {
              const errorMessage = parseErrorMessage(error);
              errors[serverId] = errorMessage;
              promptsByServer[serverId] = [];
            }
          }),
        );

        const payload: Record<string, unknown> = {
          prompts: promptsByServer,
        };
        if (Object.keys(errors).length > 0) {
          payload.errors = errors;
        }
        return payload;
      },
    );
  }),
);

web.post("/prompts/get", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(
      promptsGetSchema,
      await readJsonBody<unknown>(c),
    );

    const oauthTokens = body.oauthAccessToken
      ? { [body.serverId]: body.oauthAccessToken }
      : undefined;

    return withManager(
      createAuthorizedManager(
        bearerToken,
        body.workspaceId,
        [body.serverId],
        WEB_CALL_TIMEOUT_MS,
        oauthTokens,
      ),
      async (manager) => {
        const promptArguments = body.arguments
          ? Object.fromEntries(
              Object.entries(body.arguments).map(([key, value]) => [
                key,
                String(value),
              ]),
            )
          : undefined;

        const content = await manager.getPrompt(body.serverId, {
          name: body.promptName,
          arguments: promptArguments,
        });
        return { content };
      },
    );
  }),
);

web.post("/chat-v2", async (c) => {
  // NOTE: This route does NOT use handleRoute() because handleMCPJamFreeChatModel
  // returns a streaming Response. Wrapping it in handleRoute → c.json() would
  // serialize the Response object as '{}' instead of forwarding the stream.
  try {
    const bearerToken = assertBearerToken(c);
    const rawBody = await readJsonBody<Record<string, unknown>>(c);
    const hostedBody = parseWithSchema(hostedChatSchema, rawBody);
    const body = rawBody as unknown as ChatV2Request & {
      workspaceId: string;
      selectedServerIds: string[];
    };

    const {
      messages,
      model,
      systemPrompt,
      temperature,
      requireToolApproval,
      selectedServerIds,
    } = body;

    if (!Array.isArray(messages) || messages.length === 0) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "messages are required",
      );
    }

    const modelDefinition = model;
    if (!modelDefinition) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "model is not supported",
      );
    }

    const manager = await createAuthorizedManager(
      bearerToken,
      hostedBody.workspaceId,
      selectedServerIds,
      WEB_STREAM_TIMEOUT_MS,
      hostedBody.oauthTokens,
    );

    try {
      const mcpTools = await manager.getToolsForAiSdk(
        selectedServerIds,
        requireToolApproval ? { needsApproval: requireToolApproval } : undefined,
      );
      const { tools: skillTools, systemPromptSection: skillsPromptSection } =
        await getSkillToolsAndPrompt();

      const finalSkillTools = requireToolApproval
        ? Object.fromEntries(
            Object.entries(skillTools).map(([name, tool]) => [
              name,
              { ...tool, needsApproval: true },
            ]),
          )
        : skillTools;

      const allTools = { ...mcpTools, ...finalSkillTools };

      if (isAnthropicCompatibleModel(modelDefinition, body.customProviders)) {
        const invalidNames = getInvalidAnthropicToolNames(Object.keys(allTools));
        if (invalidNames.length > 0) {
          const nameList = invalidNames.map((name) => `'${name}'`).join(", ");
          throw new WebRouteError(
            400,
            ErrorCode.VALIDATION_ERROR,
            `Invalid tool name(s) for Anthropic: ${nameList}. Tool names must only contain letters, numbers, underscores, and hyphens (max 64 characters).`,
          );
        }
      }

      const enhancedSystemPrompt = systemPrompt
        ? systemPrompt + skillsPromptSection
        : skillsPromptSection;

      const resolvedTemperature = isGPT5Model(modelDefinition.id)
        ? undefined
        : (temperature ?? DEFAULT_TEMPERATURE);

      const scrubMessages = (msgs: ModelMessage[]) =>
        scrubChatGPTAppsToolResultsForBackend(
          scrubMcpAppsToolResultsForBackend(msgs, manager, selectedServerIds),
          manager,
          selectedServerIds,
        );

      if (modelDefinition.id && isMCPJamProvidedModel(modelDefinition.id)) {
        if (!process.env.CONVEX_HTTP_URL) {
          throw new WebRouteError(
            500,
            ErrorCode.INTERNAL_ERROR,
            "Server missing CONVEX_HTTP_URL configuration",
          );
        }
      } else {
        throw new WebRouteError(
          400,
          ErrorCode.FEATURE_NOT_SUPPORTED,
          "Only MCPJam hosted models are supported in hosted mode",
        );
      }

      const modelMessages = await convertToModelMessages(messages);
      return handleMCPJamFreeChatModel({
        messages: scrubMessages(modelMessages as ModelMessage[]),
        modelId: String(modelDefinition.id),
        systemPrompt: enhancedSystemPrompt,
        temperature: resolvedTemperature,
        tools: allTools as ToolSet,
        authHeader: c.req.header("authorization"),
        mcpClientManager: manager,
        selectedServers: selectedServerIds,
        requireToolApproval,
        onStreamComplete: () => manager.disconnectAllServers(),
      });
    } catch (error) {
      await manager.disconnectAllServers();
      throw error;
    }
  } catch (error) {
    const routeError = mapRuntimeError(error);
    return webError(c, routeError.status, routeError.code, routeError.message);
  }
});

web.get("/apps/mcp-apps/sandbox-proxy", (c) => {
  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Cache-Control", "no-cache, no-store, must-revalidate");
  c.header("Content-Security-Policy", buildFrameAncestors());
  c.res.headers.delete("X-Frame-Options");
  return c.body(MCP_APPS_SANDBOX_PROXY_HTML);
});

web.get("/apps/chatgpt-apps/sandbox-proxy", (c) => {
  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Cache-Control", "public, max-age=3600");
  c.header("Content-Security-Policy", buildFrameAncestors());
  c.res.headers.delete("X-Frame-Options");
  return c.body(CHATGPT_APPS_SANDBOX_PROXY_HTML);
});

type MpcAppsWidgetBody = {
  workspaceId: string;
  serverId: string;
  resourceUri: string;
  toolInput: Record<string, unknown>;
  toolOutput: unknown;
  toolId: string;
  toolName: string;
  theme?: "light" | "dark";
  cspMode?: CspMode;
  template?: string;
  viewMode?: string;
  viewParams?: Record<string, unknown>;
};

web.post("/apps/mcp-apps/widget-content", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(
      z.object({
        workspaceId: z.string().min(1),
        serverId: z.string().min(1),
        resourceUri: z.string().min(1),
        toolInput: z.record(z.string(), z.unknown()).default({}),
        toolOutput: z.unknown().optional(),
        toolId: z.string().min(1),
        toolName: z.string().min(1),
        theme: z.enum(["light", "dark"]).optional(),
        cspMode: z.enum(["permissive", "widget-declared"]).optional(),
        template: z.string().optional(),
        viewMode: z.string().optional(),
        viewParams: z.record(z.string(), z.unknown()).optional(),
        oauthAccessToken: z.string().optional(),
      }),
      await readJsonBody<unknown>(c),
    ) as MpcAppsWidgetBody & { oauthAccessToken?: string };

    if (body.template && !body.template.startsWith("ui://")) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Template must use ui:// protocol",
      );
    }

    const resolvedResourceUri = body.template || body.resourceUri;
    const effectiveCspMode = body.cspMode ?? "widget-declared";

    const oauthTokens = body.oauthAccessToken
      ? { [body.serverId]: body.oauthAccessToken }
      : undefined;

    return withManager(
      createAuthorizedManager(
        bearerToken,
        body.workspaceId,
        [body.serverId],
        WEB_CALL_TIMEOUT_MS,
        oauthTokens,
      ),
      async (manager) => {
        const resourceResult = await manager.readResource(body.serverId, {
          uri: resolvedResourceUri,
        });

        const contents = (resourceResult as any)?.contents || [];
        const content = contents[0];
        if (!content) {
          throw new WebRouteError(404, ErrorCode.NOT_FOUND, "No content in resource");
        }

        const contentMimeType = (content as { mimeType?: string }).mimeType;
        const mimeTypeValid = contentMimeType === MCP_APPS_MIMETYPE;
        const mimeTypeWarning = !mimeTypeValid
          ? contentMimeType
            ? `Invalid mimetype "${contentMimeType}" - SEP-1865 requires "${MCP_APPS_MIMETYPE}"`
            : `Missing mimetype - SEP-1865 requires "${MCP_APPS_MIMETYPE}"`
          : null;

        let html = extractHtmlFromResourceContent(content);
        if (!html) {
          throw new WebRouteError(404, ErrorCode.NOT_FOUND, "No HTML content in resource");
        }

        const uiMeta = (content._meta as { ui?: any } | undefined)?.ui as
          | {
              csp?: McpUiResourceCsp;
              permissions?: McpUiResourcePermissions;
              prefersBorder?: boolean;
            }
          | undefined;

        html = injectMcpAppsCompat(html, {
          toolId: body.toolId,
          toolName: body.toolName,
          toolInput: body.toolInput ?? {},
          toolOutput: body.toolOutput,
          theme: body.theme,
          viewMode: body.viewMode,
          viewParams: body.viewParams,
        });

        return {
          html,
          csp: effectiveCspMode === "permissive" ? undefined : uiMeta?.csp,
          permissions: uiMeta?.permissions,
          permissive: effectiveCspMode === "permissive",
          cspMode: effectiveCspMode,
          prefersBorder: uiMeta?.prefersBorder,
          mimeType: contentMimeType,
          mimeTypeValid,
          mimeTypeWarning,
        };
      },
    );
  }),
);

type ChatGptWidgetBody = {
  workspaceId: string;
  serverId: string;
  uri: string;
  toolInput: Record<string, unknown>;
  toolOutput: unknown;
  toolResponseMetadata?: Record<string, unknown> | null;
  toolId: string;
  toolName: string;
  theme?: "light" | "dark";
  cspMode?: CspMode;
  locale?: string;
  deviceType?: "mobile" | "tablet" | "desktop";
};

web.post("/apps/chatgpt-apps/widget-content", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(
      z.object({
        workspaceId: z.string().min(1),
        serverId: z.string().min(1),
        uri: z.string().min(1),
        toolInput: z.record(z.string(), z.unknown()).default({}),
        toolOutput: z.unknown().optional(),
        toolResponseMetadata: z
          .record(z.string(), z.unknown())
          .nullable()
          .optional(),
        toolId: z.string().min(1),
        toolName: z.string().min(1),
        theme: z.enum(["light", "dark"]).optional(),
        cspMode: z.enum(["permissive", "widget-declared"]).optional(),
        locale: z.string().optional(),
        deviceType: z.enum(["mobile", "tablet", "desktop"]).optional(),
        oauthAccessToken: z.string().optional(),
      }),
      await readJsonBody<unknown>(c),
    ) as ChatGptWidgetBody & { oauthAccessToken?: string };

    const oauthTokens = body.oauthAccessToken
      ? { [body.serverId]: body.oauthAccessToken }
      : undefined;

    return withManager(
      createAuthorizedManager(
        bearerToken,
        body.workspaceId,
        [body.serverId],
        WEB_CALL_TIMEOUT_MS,
        oauthTokens,
      ),
      async (manager) => {
        const content = await manager.readResource(body.serverId, {
          uri: body.uri,
        });
        const contentsArray = Array.isArray((content as any)?.contents)
          ? (content as any).contents
          : [];
        const firstContent = contentsArray[0];
        if (!firstContent) {
          throw new WebRouteError(404, ErrorCode.NOT_FOUND, "No HTML content found");
        }

        const htmlContent = extractHtmlFromResourceContent(firstContent);
        if (!htmlContent) {
          throw new WebRouteError(404, ErrorCode.NOT_FOUND, "No HTML content found");
        }

        const resourceMeta = firstContent?._meta as Record<string, unknown> | undefined;
        const widgetCspRaw = resourceMeta?.["openai/widgetCSP"] as
          | WidgetCspMeta
          | undefined;
        const effectiveCspMode = body.cspMode ?? "widget-declared";
        const cspConfig = buildChatGptCspHeader(effectiveCspMode, widgetCspRaw);

        const baseUrl = extractBaseUrl(htmlContent);
        const runtimeConfig = {
          toolId: body.toolId,
          toolName: body.toolName,
          toolInput: body.toolInput,
          toolOutput: body.toolOutput ?? null,
          toolResponseMetadata: body.toolResponseMetadata ?? null,
          theme: body.theme ?? "dark",
          locale: body.locale ?? "en-US",
          deviceType: body.deviceType ?? "desktop",
          viewMode: "inline",
          viewParams: {},
          useMapPendingCalls: true,
        };

        const runtimeHeadContent =
          `${WIDGET_BASE_CSS}` +
          `${generateUrlPolyfillScript(baseUrl)}` +
          `${baseUrl ? `<base href="${baseUrl}">` : ""}` +
          `${buildChatGptRuntimeConfigScript(runtimeConfig)}` +
          `<script>${CHATGPT_APPS_RUNTIME_SCRIPT}</script>`;

        const modifiedHtml = injectChatGptRuntime(htmlContent, runtimeHeadContent);

        return {
          html: modifiedHtml,
          csp: {
            mode: cspConfig.mode,
            connectDomains: cspConfig.connectDomains,
            resourceDomains: cspConfig.resourceDomains,
            frameDomains: cspConfig.frameDomains,
            headerString: cspConfig.headerString,
            widgetDeclared: widgetCspRaw ?? null,
          },
          widgetDescription: resourceMeta?.["openai/widgetDescription"] as
            | string
            | undefined,
          prefersBorder:
            (resourceMeta?.["openai/widgetPrefersBorder"] as boolean | undefined) ??
            true,
          closeWidget:
            (resourceMeta?.["openai/closeWidget"] as boolean | undefined) ??
            false,
        };
      },
    );
  }),
);

web.post("/apps/chatgpt-apps/upload-file", async (c) =>
  handleRoute(c, async () => {
    assertBearerToken(c);
    throw new WebRouteError(
      400,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      "File upload is not supported in hosted mode",
    );
  }),
);

web.get("/apps/chatgpt-apps/file/:id", async (c) =>
  handleRoute(c, async () => {
    assertBearerToken(c);
    throw new WebRouteError(
      400,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      "File download is not supported in hosted mode",
    );
  }),
);

// Mount OAuth proxy routes (authenticated, for hosted mode)
web.route("/oauth", oauthWeb);

web.onError((error, c) => {
  const routeError = mapRuntimeError(error);
  return webError(c, routeError.status, routeError.code, routeError.message);
});

export default web;
