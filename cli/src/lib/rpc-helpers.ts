import { attachCliRpcLogs, type CliRpcLogCollector } from "./rpc-logs";

export function withRpcLogsIfRequested(
  value: unknown,
  collector: CliRpcLogCollector | undefined,
  options: { format: string; rpc: boolean },
) {
  if (!options.rpc || options.format !== "json") {
    return value;
  }

  return attachCliRpcLogs(value, collector);
}
