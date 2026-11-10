import type { IncomingMessage, ServerResponse } from "node:http";
export function isJsonRpcResponse(value: unknown): boolean;
export function requestDeadline(
  onTimeout: () => void,
  timeoutMs: number,
): {
  stop(): void;
  pause(): () => void;
};
export function createServerRequestRelay(options: {
  send(message: Record<string, unknown>): void;
  beginInput(): { release(): void; signal: AbortSignal } | null;
  timeoutMs?: number;
}): {
  open(req: IncomingMessage, res: ServerResponse): void;
  receive(message: Record<string, unknown>): void;
  respond(message: Record<string, unknown>): boolean;
  close(): void;
};
