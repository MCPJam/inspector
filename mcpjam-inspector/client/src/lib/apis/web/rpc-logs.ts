import {
  isHostedHttpLogEvent,
  isHostedRpcLogEvent,
  type HostedHttpLogEvent,
  type HostedRpcLogEvent,
} from "@/shared/hosted-rpc-log";
import {
  ingestHostedHttpLogs,
  ingestHostedRpcLogs,
} from "@/stores/traffic-log-store";

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

function extractEnvelopeHttpLogs(value: unknown): HostedHttpLogEvent[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate._httpLogs)) {
    return [];
  }

  return candidate._httpLogs.filter(isHostedHttpLogEvent);
}

export function stripHostedRpcLogs<T>(payload: T): {
  payload: T;
  rpcLogs: HostedRpcLogEvent[];
  httpLogs: HostedHttpLogEvent[];
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { payload, rpcLogs: [], httpLogs: [] };
  }

  const candidate = payload as Record<string, unknown>;
  // Either key alone is enough to do the work: a route that captured only
  // headers (no JSON-RPC frame reached the logger) still sends `_httpLogs`,
  // and returning early on a missing `_rpcLogs` would both drop those logs and
  // leave the private key on the typed payload.
  if (!("_rpcLogs" in candidate) && !("_httpLogs" in candidate)) {
    return { payload, rpcLogs: [], httpLogs: [] };
  }

  const rpcLogs = Array.isArray(candidate._rpcLogs)
    ? candidate._rpcLogs.filter(isHostedRpcLogEvent)
    : [];
  const httpLogs = Array.isArray(candidate._httpLogs)
    ? candidate._httpLogs.filter(isHostedHttpLogEvent)
    : [];
  const {
    _rpcLogs: _discarded,
    _httpLogs: _httpDiscarded,
    ...rest
  } = candidate;
  return {
    payload: rest as T,
    rpcLogs,
    httpLogs,
  };
}

function ingestHostedRpcLogsFromPayload(payload: unknown): void {
  ingestHostedRpcLogs(extractEnvelopeLogs(payload));
  ingestHostedHttpLogs(extractEnvelopeHttpLogs(payload));
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
