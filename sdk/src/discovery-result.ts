/** No extension supported by MCPJam defines a result type for server/discover. */
export class DiscoveryResultError extends Error {
  constructor(
    readonly resultType: unknown,
    readonly protocolVersion?: string,
  ) {
    super(resultType === "input_required"
      ? 'server/discover returned "input_required", which the MCP spec forbids for this request'
      : `Unrecognized resultType ${JSON.stringify(resultType)} in server/discover reply`);
  }
}

export function requireCompleteDiscovery(
  result: Record<string, unknown>,
  protocolVersion?: string,
): void {
  if (result.resultType !== undefined && result.resultType !== "complete") {
    throw new DiscoveryResultError(result.resultType, protocolVersion);
  }
}
