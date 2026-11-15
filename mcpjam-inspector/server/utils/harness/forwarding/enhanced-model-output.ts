import { projectMcpToolResultForModel } from "@mcpjam/sdk";
import { isCallToolResult } from "@modelcontextprotocol/client";
import { isRecord } from "../../byok/list-request.js";

/** Project once for the CLI; the receipt keeps the original server result. */
export async function enhancedModelOutput(
  result: unknown,
  metadata: Record<string, unknown> | undefined,
  options: Parameters<typeof projectMcpToolResultForModel>[2],
): Promise<unknown> {
  if (!isCallToolResult(result))
    throw new Error("Invalid upstream tool result.");
  const { _meta: _private, ...modelResult } = result;
  const output: unknown = await projectMcpToolResultForModel(
    modelResult,
    metadata,
    options,
  );
  if (!isRecord(output)) throw new Error("Invalid model result projection.");
  if (output.type === "json" && isCallToolResult(output.value))
    return output.value;
  if (output.type === "content" && Array.isArray(output.value)) {
    const content = output.value.map((part: unknown) => {
      if (!isRecord(part)) throw new Error("Invalid model content.");
      if (part.type === "text" && typeof part.text === "string")
        return { type: "text", text: part.text };
      if (
        part.type === "file" &&
        typeof part.mediaType === "string" &&
        part.mediaType.startsWith("image/") &&
        isRecord(part.data) &&
        part.data.type === "data" &&
        typeof part.data.data === "string"
      )
        return {
          type: "image",
          mimeType: part.mediaType,
          data: part.data.data,
        };
      throw new Error("Unsupported model content projection.");
    });
    return {
      content,
      ...(result.isError === undefined ? {} : { isError: result.isError }),
    };
  }
  throw new Error("Unsupported model result projection.");
}
