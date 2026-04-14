import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "@mcpjam/sdk";

export const INSPECTOR_MCP_RETRY_POLICY: RetryPolicy = {
  ...DEFAULT_RETRY_POLICY,
};
