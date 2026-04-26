import { Hono } from "hono";
import {
  INSPECTOR_COMMAND_DEFAULT_TIMEOUT_MS,
  buildInspectorCommandError,
  isInspectorCommandType,
  type InspectorCommand,
  type InspectorCommandResponse,
} from "@/shared/inspector-command.js";
import { inspectorCommandBus } from "../../services/inspector-command-bus.js";

const command = new Hono();
type CommandHttpStatus = 200 | 400 | 404 | 409 | 500 | 504;

function buildCommandId(): string {
  return `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function errorResponse(
  id: string,
  code: Parameters<typeof buildInspectorCommandError>[0],
  message: string,
  status: CommandHttpStatus,
  details?: unknown,
) {
  return {
    body: {
      id,
      status: "error" as const,
      error: buildInspectorCommandError(code, message, details),
    },
    status,
  };
}

command.post("/", async (c) => {
  let body: Record<string, unknown> | null = null;

  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch (error) {
    const response = errorResponse(
      buildCommandId(),
      "invalid_request",
      "Command request body must be valid JSON.",
      400,
      error instanceof Error ? error.message : String(error),
    );
    return c.json(response.body, response.status);
  }

  const id =
    typeof body.id === "string" && body.id.trim().length > 0
      ? body.id.trim()
      : buildCommandId();
  const type = body.type;
  const payload = body.payload;
  const timeoutMs =
    typeof body.timeoutMs === "number" &&
    Number.isInteger(body.timeoutMs) &&
    body.timeoutMs > 0
      ? body.timeoutMs
      : INSPECTOR_COMMAND_DEFAULT_TIMEOUT_MS;

  if (!isInspectorCommandType(type)) {
    const response = errorResponse(
      id,
      "invalid_request",
      "Command type is required and must be supported.",
      400,
      { type },
    );
    return c.json(response.body, response.status);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    const response = errorResponse(
      id,
      "invalid_request",
      "Command payload must be a JSON object.",
      400,
    );
    return c.json(response.body, response.status);
  }

  const response = await inspectorCommandBus.submit(
    { id, type, payload, timeoutMs } as InspectorCommand,
    timeoutMs,
  );

  const status: CommandHttpStatus =
    response.status === "success"
      ? 200
      : response.error.code === "no_active_client"
        ? 409
        : response.error.code === "timeout"
          ? 504
          : response.error.code === "invalid_request"
            ? 400
            : 500;

  return c.json(response, status);
});

command.post("/result", async (c) => {
  let body: InspectorCommandResponse | null = null;

  try {
    body = (await c.req.json()) as InspectorCommandResponse;
  } catch (error) {
    const response = errorResponse(
      buildCommandId(),
      "invalid_request",
      "Command result body must be valid JSON.",
      400,
      error instanceof Error ? error.message : String(error),
    );
    return c.json(response.body, response.status);
  }

  if (!body || typeof body !== "object" || typeof body.id !== "string") {
    const response = errorResponse(
      buildCommandId(),
      "invalid_request",
      "Command result must include an id.",
      400,
    );
    return c.json(response.body, response.status);
  }

  const completed = inspectorCommandBus.complete(body);
  if (!completed) {
    const response = errorResponse(
      body.id,
      "invalid_request",
      `No pending Inspector command found for id "${body.id}".`,
      404,
    );
    return c.json(response.body, response.status);
  }

  return c.json({ ok: true });
});

export default command;
