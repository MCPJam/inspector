import { Hono } from "hono";
import type {
  ElicitRequest,
  ElicitResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import "../../types/hono"; // Type extensions
import {
  mapModelIdToTokenizerBackend,
  estimateTokensFromChars,
} from "../../utils/tokenizer-helpers";

const tools = new Hono();

/**
 * Count tokens for tools, using backend tokenizer or char fallback.
 * Accepts already-fetched tools to avoid duplicate listTools calls.
 */
async function countToolsTokens(
  tools: ListToolsResult["tools"],
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
    console.warn("[tools] Error counting tokens:", error);
    return 0;
  }
}

type ElicitationPayload = {
  executionId: string;
  requestId: string;
  request: ElicitRequest["params"];
  issuedAt: string;
  serverId: string;
};

type ExecutionContext = {
  id: string;
  serverId: string;
  toolName: string;
  execPromise: Promise<ListToolsResult>;
  queue: ElicitationPayload[];
  waiter?: (payload: ElicitationPayload) => void;
};

let activeExecution: ExecutionContext | null = null;

const pendingResponses = new Map<
  string,
  {
    serverId: string;
    resolve: (value: ElicitResult) => void;
    reject: (error: unknown) => void;
  }
>();

function makeExecutionId() {
  return `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function takeNextRequest(
  context: ExecutionContext,
): Promise<ElicitationPayload> {
  if (context.queue.length > 0) {
    return Promise.resolve(context.queue.shift()!);
  }
  return new Promise((resolve) => {
    context.waiter = resolve;
  });
}

function enqueueRequest(
  context: ExecutionContext,
  payload: ElicitationPayload,
) {
  if (context.waiter) {
    const resolve = context.waiter;
    context.waiter = undefined;
    resolve(payload);
    return;
  }
  context.queue.push(payload);
}

function resetExecution(context: ExecutionContext | null, clear: () => void) {
  if (!context) return;
  clear();
  if (activeExecution === context) {
    activeExecution = null;
  }
  if (context.queue.length > 0) {
    context.queue.length = 0;
  }
  context.waiter = undefined;
  for (const [requestId, pending] of Array.from(pendingResponses.entries())) {
    if (pending.serverId !== context.serverId) continue;
    pendingResponses.delete(requestId);
    pending.reject(new Error("Execution finished"));
  }
}

function serializeMcpError(error: unknown) {
  const anyErr = error as any;
  const base = {
    name: anyErr?.name ?? "Error",
    message: anyErr?.message ?? String(error),
    code: anyErr?.code ?? anyErr?.error?.code,
    data: anyErr?.data ?? anyErr?.error?.data,
  } as Record<string, unknown>;
  const cause = anyErr?.cause;
  if (cause && typeof cause === "object") {
    base.cause = {
      name: (cause as any)?.name,
      message: (cause as any)?.message,
      code: (cause as any)?.code,
      data: (cause as any)?.data,
    };
  }
  if (process.env.NODE_ENV === "development" && anyErr?.stack) {
    base.stack = anyErr.stack;
  }
  return base;
}

function jsonError(c: any, error: unknown, fallbackStatus = 500) {
  const details = serializeMcpError(error);
  const status =
    typeof (error as any)?.status === "number"
      ? (error as any).status
      : fallbackStatus;
  return c.json(
    { error: details.message as string, mcpError: details },
    status,
  );
}

tools.post("/list", async (c) => {
  try {
    const { serverId, modelId } = (await c.req.json()) as {
      serverId?: string;
      modelId?: string;
    };
    if (!serverId) {
      return c.json({ error: "serverId is required" }, 400);
    }

    // Normalize serverId - try to find a case-insensitive match if exact match fails
    let normalizedServerId = serverId;
    const availableServers = c.mcpClientManager
      .listServers()
      .filter((id: string) => Boolean(c.mcpClientManager.getClient(id)));

    if (!availableServers.includes(serverId)) {
      const match = availableServers.find(
        (name: string) => name.toLowerCase() === serverId.toLowerCase(),
      );
      if (match) {
        normalizedServerId = match;
      }
    }

    const result = (await c.mcpClientManager.listTools(
      normalizedServerId,
    )) as ListToolsResult;

    // Get cached metadata map for O(1) frontend lookups
    const toolsMetadata =
      c.mcpClientManager.getAllToolsMetadata(normalizedServerId);

    // If modelId provided, also compute token count using already-fetched tools
    let tokenCount: number | undefined;
    if (modelId) {
      tokenCount = await countToolsTokens(result.tools, modelId);
    }

    return c.json({ ...result, toolsMetadata, tokenCount });
  } catch (error) {
    return jsonError(c, error, 500);
  }
});

tools.post("/execute", async (c) => {
  if (activeExecution) {
    return c.json({ error: "Another execution is already in progress" }, 409);
  }

  const {
    serverId,
    toolName,
    parameters = {},
  } = (await c.req.json()) as {
    serverId?: string;
    toolName?: string;
    parameters?: Record<string, unknown>;
  };

  if (!serverId) return c.json({ error: "serverId is required" }, 400);
  if (!toolName) return c.json({ error: "toolName is required" }, 400);

  const manager = c.mcpClientManager;
  const client = manager.getClient(serverId);
  if (!client) {
    return c.json({ error: `Server '${serverId}' is not connected` }, 400);
  }

  const executionId = makeExecutionId();

  const context: ExecutionContext = {
    id: executionId,
    serverId,
    toolName,
    execPromise: manager.executeTool(
      serverId,
      toolName,
      parameters,
    ) as unknown as Promise<ListToolsResult>,
    queue: [],
  };

  activeExecution = context;

  manager.setElicitationHandler(serverId, async (params) => {
    const payload: ElicitationPayload = {
      executionId,
      requestId: makeRequestId(),
      request: params,
      issuedAt: new Date().toISOString(),
      serverId,
    };

    enqueueRequest(context, payload);

    return new Promise<ElicitResult>((resolve, reject) => {
      pendingResponses.set(payload.requestId, {
        serverId,
        resolve: (value) => {
          pendingResponses.delete(payload.requestId);
          resolve(value);
        },
        reject: (err) => {
          pendingResponses.delete(payload.requestId);
          reject(err);
        },
      });
    });
  });

  try {
    const next = await Promise.race([
      context.execPromise.then((result) => ({ kind: "done" as const, result })),
      takeNextRequest(context).then((payload) => ({
        kind: "elicitation" as const,
        payload,
      })),
    ]);

    if (next.kind === "done") {
      resetExecution(context, () => manager.clearElicitationHandler(serverId));
      return c.json({ status: "completed", result: next.result });
    }

    return c.json(
      {
        status: "elicitation_required",
        executionId,
        requestId: next.payload.requestId,
        request: next.payload.request,
        timestamp: next.payload.issuedAt,
      },
      202,
    );
  } catch (error) {
    resetExecution(context, () => manager.clearElicitationHandler(serverId));
    return jsonError(c, error, 500);
  }
});

tools.post("/respond", async (c) => {
  const context = activeExecution;
  if (!context) {
    return c.json({ error: "No active execution" }, 404);
  }

  const { requestId, response } = (await c.req.json()) as {
    requestId?: string;
    response?: ElicitResult;
  };

  if (!requestId) {
    return c.json({ error: "requestId is required" }, 400);
  }

  const pending = pendingResponses.get(requestId);
  if (!pending) {
    return c.json({ error: "No pending elicitation for requestId" }, 404);
  }

  pending.resolve(response as ElicitResult);

  try {
    const next = await Promise.race([
      context.execPromise.then((result) => ({ kind: "done" as const, result })),
      takeNextRequest(context).then((payload) => ({
        kind: "elicitation" as const,
        payload,
      })),
    ]);

    if (next.kind === "done") {
      resetExecution(context, () =>
        c.mcpClientManager.clearElicitationHandler(context.serverId),
      );
      return c.json({ status: "completed", result: next.result });
    }

    return c.json(
      {
        status: "elicitation_required",
        executionId: context.id,
        requestId: next.payload.requestId,
        request: next.payload.request,
        timestamp: next.payload.issuedAt,
      },
      202,
    );
  } catch (error) {
    resetExecution(context, () =>
      c.mcpClientManager.clearElicitationHandler(context.serverId),
    );
    return jsonError(c, error, 500);
  }
});

tools.post("/", async () => {
  return new Response(
    JSON.stringify({
      error: "Endpoint migrated. Use /list, /execute, or /respond.",
    }),
    { status: 410, headers: { "Content-Type": "application/json" } },
  );
});

export default tools;
