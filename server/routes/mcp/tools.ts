import { Hono } from "hono";
import { z } from "zod";
import { zodToJsonSchema } from "@alcyone-labs/zod-to-json-schema";
import "../../types/hono"; // Type extensions

const tools = new Hono();

type ElicitationEvent = {
  requestId: string;
  message: string;
  schema: any;
  toolName: string;
  timestamp: string;
};

type ExecutionState = {
  id: string;
  serverId: string;
  toolName: string;
  execPromise: Promise<{ result: any }>;
  completed: boolean;
  result?: { result: any };
  error?: any;
  queue: ElicitationEvent[];
  waiters: Array<(ev: ElicitationEvent) => void>;
};

let activeExecution: ExecutionState | null = null;

function nowIso() {
  return new Date().toISOString();
}

function takeNextElicitation(state: ExecutionState): Promise<ElicitationEvent> {
  if (state.queue.length > 0) {
    return Promise.resolve(state.queue.shift()!);
  }
  return new Promise((resolve) => {
    state.waiters.push(resolve);
  });
}

// POST /list — return tools as JSON (no SSE)
tools.post("/list", async (c) => {
  try {
    const { serverId } = await c.req.json();
    if (!serverId) {
      return c.json({ error: "serverId is required" }, 400);
    }
    const mcp = c.mcpJamClientManager;
    const status = mcp.getConnectionStatus(serverId);
    if (status !== "connected") {
      return c.json({ error: `Server '${serverId}' is not connected` }, 400);
    }
    const flattenedTools = await mcp.getToolsetsForServer(serverId);

    const toolsWithJsonSchema: Record<string, any> = {};
    for (const [name, tool] of Object.entries(flattenedTools)) {
      let inputSchema = (tool as any).inputSchema;
      try {
        inputSchema = zodToJsonSchema(inputSchema as z.ZodType<any>);
      } catch {}
      toolsWithJsonSchema[name] = {
        name,
        description: (tool as any).description,
        inputSchema,
        outputSchema: (tool as any).outputSchema,
      };
    }
    return c.json({ tools: toolsWithJsonSchema });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// POST /execute — execute a tool; may return completed or an elicitation requirement
tools.post("/execute", async (c) => {
  try {
    const { serverId, toolName, parameters } = await c.req.json();
    if (!serverId) return c.json({ error: "serverId is required" }, 400);
    if (!toolName) return c.json({ error: "toolName is required" }, 400);

    if (activeExecution) {
      return c.json({ error: "Another execution is already in progress" }, 409);
    }

    const mcp = c.mcpJamClientManager;
    const status = mcp.getConnectionStatus(serverId);
    if (status !== "connected") {
      return c.json({ error: `Server '${serverId}' is not connected` }, 400);
    }

    const executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const state: ExecutionState = {
      id: executionId,
      serverId,
      toolName,
      execPromise: Promise.resolve().then(() =>
        mcp.executeToolDirect(toolName, parameters || {}),
      ),
      completed: false,
      queue: [],
      waiters: [],
    };

    activeExecution = state;

    mcp.setElicitationCallback(async ({ requestId, message, schema }) => {
      if (!activeExecution) {
        // No active execution; reject so upstream can handle
        throw new Error("No active execution");
      }
      const event: ElicitationEvent = {
        requestId,
        message,
        schema,
        toolName,
        timestamp: nowIso(),
      };
      // push to queue and notify waiter if present
      if (activeExecution.waiters.length > 0) {
        const waiter = activeExecution.waiters.shift()!;
        waiter(event);
      } else {
        activeExecution.queue.push(event);
      }

      // Return a promise that resolves when respond endpoint supplies an answer
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Elicitation timeout")),
          300000,
        );
        mcp.getPendingElicitations().set(requestId, {
          resolve: (response: any) => {
            clearTimeout(timeout);
            resolve(response);
          },
          reject: (error: any) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
      });
    });

    // Race: next elicitation vs completion
    const race = await Promise.race([
      state.execPromise.then((res) => ({ kind: "done", res }) as const),
      takeNextElicitation(state).then(
        (ev) => ({ kind: "elicit", ev }) as const,
      ),
    ]);

    if (race.kind === "done") {
      state.completed = true;
      state.result = race.res;
      // clear global state
      activeExecution = null;
      mcp.clearElicitationCallback();
      return c.json(
        { status: "completed", toolName, result: race.res.result },
        200,
      );
    }

    // Elicitation required
    return c.json(
      {
        status: "elicitation_required",
        executionId,
        requestId: race.ev.requestId,
        toolName,
        message: race.ev.message,
        schema: race.ev.schema,
        timestamp: race.ev.timestamp,
      },
      202,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// POST /respond — respond to the current elicitation; may return next elicitation or completion
tools.post("/respond", async (c) => {
  try {
    const { requestId, response } = await c.req.json();
    if (!requestId) return c.json({ error: "requestId is required" }, 400);
    if (!activeExecution) return c.json({ error: "No active execution" }, 404);

    const mcp = c.mcpJamClientManager;
    const ok = mcp.respondToElicitation(requestId, response);
    if (!ok)
      return c.json({ error: "No pending elicitation for requestId" }, 404);

    // After responding, wait for either next elicitation or completion
    const state = activeExecution;
    try {
      const race = await Promise.race([
        state.execPromise.then((res) => ({ kind: "done", res }) as const),
        takeNextElicitation(state).then(
          (ev) => ({ kind: "elicit", ev }) as const,
        ),
      ]);

      if (race.kind === "done") {
        state.completed = true;
        state.result = race.res;
        activeExecution = null;
        mcp.clearElicitationCallback();
        return c.json(
          {
            status: "completed",
            toolName: state.toolName,
            result: race.res.result,
          },
          200,
        );
      }

      return c.json(
        {
          status: "elicitation_required",
          executionId: state.id,
          requestId: race.ev.requestId,
          toolName: state.toolName,
          message: race.ev.message,
          schema: race.ev.schema,
          timestamp: race.ev.timestamp,
        },
        202,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 500);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// Optional: legacy root route returns 410 Gone to indicate migration
tools.post("/", async () => {
  return new Response(
    JSON.stringify({
      error: "Endpoint migrated. Use /list, /execute, or /respond.",
    }),
    { status: 410, headers: { "Content-Type": "application/json" } },
  );
});

export default tools;
