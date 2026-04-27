import {
  buildInspectorCommandError,
  type InspectorCommand,
  type InspectorCommandErrorCode,
  type InspectorCommandResponse,
  type InspectorCommandType,
} from "@/shared/inspector-command.js";

export class InspectorCommandClientError extends Error {
  readonly code: InspectorCommandErrorCode;
  readonly details?: unknown;

  constructor(
    code: InspectorCommandErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "InspectorCommandClientError";
    this.code = code;
    this.details = details;
  }
}

export function createInspectorCommandClientError(
  code: InspectorCommandErrorCode,
  message: string,
  details?: unknown,
): InspectorCommandClientError {
  return new InspectorCommandClientError(code, message, details);
}

type InspectorCommandHandler = (
  command: InspectorCommand,
) => Promise<unknown> | unknown;

const handlers = new Map<InspectorCommandType, InspectorCommandHandler[]>();

export function registerInspectorCommandHandler(
  type: InspectorCommandType,
  handler: InspectorCommandHandler,
): () => void {
  const existingHandlers = handlers.get(type) ?? [];
  handlers.set(type, [...existingHandlers, handler]);

  return () => {
    const nextHandlers =
      handlers.get(type)?.filter((registered) => registered !== handler) ?? [];

    if (nextHandlers.length === 0) {
      handlers.delete(type);
      return;
    }

    handlers.set(type, nextHandlers);
  };
}

export async function executeInspectorCommand(
  command: InspectorCommand,
): Promise<InspectorCommandResponse> {
  const typeHandlers = handlers.get(command.type) ?? [];
  if (typeHandlers.length === 0) {
    return {
      id: command.id,
      status: "error",
      error: buildInspectorCommandError(
        "unsupported_in_mode",
        `No Inspector handler is registered for "${command.type}".`,
      ),
    };
  }

  let lastUnsupportedError: InspectorCommandClientError | null = null;

  for (const handler of [...typeHandlers].reverse()) {
    try {
      const result = await handler(command);
      return {
        id: command.id,
        status: "success",
        ...(result === undefined ? {} : { result }),
      };
    } catch (error) {
      if (error instanceof InspectorCommandClientError) {
        if (error.code === "unsupported_in_mode") {
          lastUnsupportedError = error;
          continue;
        }

        return {
          id: command.id,
          status: "error",
          error: buildInspectorCommandError(
            error.code,
            error.message,
            error.details,
          ),
        };
      }

      return {
        id: command.id,
        status: "error",
        error: buildInspectorCommandError(
          "execution_failed",
          error instanceof Error
            ? error.message
            : "Unknown Inspector command error.",
        ),
      };
    }
  }

  return {
    id: command.id,
    status: "error",
    error: buildInspectorCommandError(
      lastUnsupportedError?.code ?? "unsupported_in_mode",
      lastUnsupportedError?.message ??
        `No Inspector handler is registered for "${command.type}".`,
      lastUnsupportedError?.details,
    ),
  };
}
