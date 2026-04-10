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
  const rpcLogs = extractEnvelopeLogs(payload);

  if (
    rpcLogs.length === 0 ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return { payload, rpcLogs };
  }

  const { _rpcLogs: _discarded, ...rest } = payload as Record<string, unknown>;
  return {
    payload: rest as T,
    rpcLogs,
  };
}

export function ingestHostedRpcLogsFromPayload(payload: unknown): void {
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
