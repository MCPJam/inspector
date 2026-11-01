/**
 * First-party entry for the MCPJam server resolver, for the CLI. Published as
 * `@mcpjam/sdk/internal/deployment` with no public API promise.
 */
export {
  resolveDeployment,
  type DeploymentCredential,
  type ResolveDeploymentInput,
  type ResolvedDeployment,
} from "../deployment/resolve.js";
export {
  backendFetch,
  isMcpjamDeploymentError,
  MCPJAM_CLOUD_API_URL,
  McpjamDeploymentError,
  parseApiUrl,
  sameServer,
  type DeploymentAddress,
  type DeploymentErrorCode,
  type DeploymentSource,
} from "../deployment/address.js";
