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

export function discoveryFieldProblems(
  result: Record<string, unknown>,
): string[] {
  const problems: string[] = [];
  const { supportedVersions, capabilities } = result;
  if (
    !Array.isArray(supportedVersions) ||
    supportedVersions.length === 0 ||
    supportedVersions.some((version) => typeof version !== "string")
  ) {
    problems.push("supportedVersions must be a non-empty array of strings");
  }
  if (
    capabilities === null ||
    typeof capabilities !== "object" ||
    Array.isArray(capabilities)
  ) {
    problems.push("capabilities must be an object");
  }
  return problems;
}

export function discoveryErrorMessage(
  status: number,
  rpcError?: { code: number; message: string },
): string {
  const message = `server/discover did not return a result (HTTP ${status})`;
  return rpcError ? `${message}: ${rpcError.code} ${rpcError.message}` : message;
}
