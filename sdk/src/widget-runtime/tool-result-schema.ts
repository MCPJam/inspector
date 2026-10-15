import * as apps from "@modelcontextprotocol/ext-apps/app-bridge";
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { z } from "zod";

export type McpAppToolResult = Awaited<
  ReturnType<NonNullable<AppBridge["oncalltool"]>>
>;
/** Wire tool metadata, distinct from an executable MCPJam manager tool. */
type HostContext = NonNullable<
  NonNullable<ConstructorParameters<typeof AppBridge>[3]>["hostContext"]
>;
export type McpAppTool = NonNullable<HostContext["toolInfo"]>["tool"];

// The public Apps notification carries exactly the tool-result params. Derive
// the type from the inline bridge declaration: its extensionless type exports
// are not resolvable by NodeNext. Keep that vendor declaration workaround here.
const schemas = apps as unknown as {
  McpUiToolResultNotificationSchema: {
    shape: { params: z.ZodType<McpAppToolResult> };
  };
};
export const mcpAppToolResultSchema =
  schemas.McpUiToolResultNotificationSchema.shape.params;
