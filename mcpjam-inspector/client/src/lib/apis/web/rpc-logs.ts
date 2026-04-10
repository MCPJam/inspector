import {
  isHostedRpcLogEvent,
  type HostedRpcLogEvent,
} from "@/shared/hosted-rpc-log";
import { ingestHostedRpcLogs } from "@/stores/traffic-log-store";

function extractEnvelopeLogs(value: unknown): HostedRpcLogEvent[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate._rpcLogs)) {
    return [];
  }

  return candidate._rpcLogs.filter(isHostedRpcLogEvent);
}

export function stripHostedRpcLogs<T>(payload: T): {
  payload: T;
  rpcLogs: HostedRpcLogEvent[];
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { payload, rpcLogs: [] };
  }

  const candidate = payload as Record<string, unknown>;
  if (!("_rpcLogs" in candidate)) {
    return { payload, rpcLogs: [] };
  }

  const rpcLogs = Array.isArray(candidate._rpcLogs)
    ? candidate._rpcLogs.filter(isHostedRpcLogEvent)
    : [];
  const { _rpcLogs: _discarded, ...rest } = candidate;
  return {
    payload: rest as T,
    rpcLogs,
  };
}

function ingestHostedRpcLogsFromPayload(payload: unknown): void {
  ingestHostedRpcLogs(extractEnvelopeLogs(payload));
}

export async function ingestHostedRpcLogsFromResponse(
  response: Response,
): Promise<void> {
  try {
    const body = await response.clone().json();
    ingestHostedRpcLogsFromPayload(body);
  } catch {
    // Ignore non-JSON responses and malformed payloads.
  }
}
