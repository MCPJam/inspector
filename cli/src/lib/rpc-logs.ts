import type { RpcLogger } from "@mcpjam/sdk";

export interface CliRpcLogEvent {
  serverId: string;
  serverName: string;
  direction: "send" | "receive";
  timestamp: string;
  message: unknown;
}

export interface CliRpcLogsEnvelope {
  _rpcLogs?: CliRpcLogEvent[];
}

export class CliRpcLogCollector {
  private readonly logs: CliRpcLogEvent[] = [];

  constructor(private readonly serverNamesById: Record<string, string>) {}

  readonly rpcLogger: RpcLogger = ({ direction, message, serverId }) => {
    this.logs.push({
      serverId,
      serverName: this.serverNamesById[serverId] ?? serverId,
      direction,
      timestamp: new Date().toISOString(),
      message,
    });
  };

  hasLogs(): boolean {
    return this.logs.length > 0;
  }

  getLogs(): CliRpcLogEvent[] {
    return this.logs.map((event) => ({ ...event }));
  }
}

export function createCliRpcLogCollector(
  serverNamesById: Record<string, string>,
): CliRpcLogCollector {
  return new CliRpcLogCollector(serverNamesById);
}

export function attachCliRpcLogs<T>(
  payload: T,
  collector: CliRpcLogCollector | undefined,
): T | (T & CliRpcLogsEnvelope) {
  if (
    !collector?.hasLogs() ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return payload;
  }

  return {
    ...(payload as Record<string, unknown>),
    _rpcLogs: redactCliRpcLogs(collector.getLogs()),
  } as T & CliRpcLogsEnvelope;
}

function redactCliRpcLogs(logs: CliRpcLogEvent[]): CliRpcLogEvent[] {
  return logs.map((event) => ({
    ...event,
    message: redactSensitiveValue(event.message),
  }));
}

function redactSensitiveValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveValue(entry));
  }

  if (!value || typeof value !== "object") {
    return typeof value === "string" ? redactSensitiveString(value) : value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      shouldRedactKey(key)
        ? "[REDACTED]"
        : redactSensitiveValue(entryValue),
    ]),
  );
}

function redactSensitiveString(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s",]+/giu, "Bearer [REDACTED]")
    .replace(
      /\b(access_token|refresh_token|client_secret|id_token)=([^&\s]+)/giu,
      "$1=[REDACTED]",
    )
    .replace(
      /(["']?(?:access_token|refresh_token|client_secret|id_token)["']?\s*:\s*["'])[^"']*(["'])/giu,
      "$1[REDACTED]$2",
    );
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");

  return (
    normalized === "authorization" ||
    normalized === "proxyauthorization" ||
    normalized === "cookie" ||
    normalized === "setcookie" ||
    normalized === "accesstoken" ||
    normalized === "refreshtoken" ||
    normalized === "clientsecret" ||
    normalized === "idtoken" ||
    normalized === "apikey" ||
    normalized === "xapikey" ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret")
  );
}
