import {
  runToolTaskSeam,
  type MCPClientManager,
  type ToolTaskSeamOptions,
} from "@mcpjam/sdk";
import type { NativeMessage } from "./native-wire.js";
import type { Settlement } from "./execution-control.js";
import { isRecord } from "../../byok/list-request.js";

/** Reuse the SDK eligibility, validation and projection contract inside the execution gate. */
export async function enhancedTaskCall(args: {
  manager: MCPClientManager;
  serverId: string;
  message: NativeMessage;
  signal: AbortSignal;
  tasks: ToolTaskSeamOptions;
  settle?: (result: Settlement) => Promise<void>;
}) {
  const params = args.message.params;
  if (!isRecord(params) || typeof params.name !== "string")
    throw new Error("Invalid task tool request");
  const toolName = params.name;
  const input = isRecord(params.arguments) ? params.arguments : {};
  const call = async (eligible: boolean) => {
    const result = eligible
      ? await args.manager.executeTool(args.serverId, toolName, input, {
          allowTaskResult: true,
          request: { signal: args.signal },
        })
      : await args.manager.executeTool(args.serverId, toolName, input, {
          signal: args.signal,
        });
    await args.settle?.({
      outcome:
        isRecord(result) && result.isError === true ? "tool_error" : "success",
      resultJson: JSON.stringify({
        jsonrpc: "2.0",
        id: args.message.id,
        result,
      }),
    });
    return result;
  };
  return {
    jsonrpc: "2.0",
    id: args.message.id,
    result: await runToolTaskSeam(
      {
        serverId: args.serverId,
        toolName,
        wire: args.manager.getTasksSupport(args.serverId).wire,
        callPlain: () => call(false),
        callEligible: () => call(true),
      },
      args.tasks,
    ),
  };
}
