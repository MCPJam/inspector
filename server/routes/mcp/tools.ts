import { Hono } from "hono";
import type {
  ElicitRequest,
  ElicitResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import "../../types/hono"; // Type extensions

const tools = new Hono();

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

tools.post("/list", async (c) => {
  try {
    const { serverId } = (await c.req.json()) as { serverId?: string };
    if (!serverId) {
      return c.json({ error: "serverId is required" }, 400);
    }
    const result = (await c.mcpClientManager.listTools(
      serverId,
    )) as ListToolsResult;

    // Get cached metadata map for O(1) frontend lookups
    const toolsMetadata = c.mcpClientManager.getAllToolsMetadata(serverId);

    return c.json({ ...result, toolsMetadata });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 500);
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
    ) as Promise<ListToolsResult>,
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
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 500);
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
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 500);
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
