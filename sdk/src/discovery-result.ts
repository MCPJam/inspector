/** No extension supported by MCPJam defines a result type for server/discover. */
export class DiscoveryResultError extends Error {
  constructor(
    readonly resultType: unknown,
    readonly protocolVersion?: string,
  ) {
    super(resultType === "input_required"
      ? "The server/discover reply requires input before discovery can complete"
      : `Unrecognized resultType ${JSON.stringify(resultType)} in server/discover reply`);
  }
}

export function discoveryResultType(
  result: Record<string, unknown>,
  protocolVersion?: string,
): "complete" | "input_required" {
  const value = result.resultType;
  if (value === undefined || value === "complete") return "complete";
  if (value === "input_required") return value;
  throw new DiscoveryResultError(value, protocolVersion);
}

export function requireCompleteDiscovery(
  result: Record<string, unknown>,
  protocolVersion?: string,
): void {
  if (discoveryResultType(result, protocolVersion) === "input_required") {
    throw new DiscoveryResultError(result.resultType, protocolVersion);
  }
}
