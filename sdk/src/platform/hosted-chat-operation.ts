import { z } from "zod";
import {
  sendChatMessageInput,
  sendChatMessageOperation,
  type PlatformOperation,
} from "./operations.js";

const hostedSendChatMessageInput = sendChatMessageInput.extend({
  executionTarget: z
    .strictObject({ kind: z.literal("hosted") })
    .optional()
    .describe(
      "Explicit hosted venue. Local execution is not available from this tool; use the REST API, SDK or CLI."
    ),
});

/**
 * `send_chat_message` for model-facing catalogs: the platform MCP server and
 * workspace agents. A local execution target carries its capability token,
 * and tool arguments are model-visible, so they end up in transcripts and
 * traces. These surfaces therefore accept only the hosted venue; local turns
 * stay on the REST API, SDK and CLI, which send the token in a header.
 */
export const hostedSendChatMessageOperation: PlatformOperation<
  z.infer<typeof hostedSendChatMessageInput>,
  Awaited<ReturnType<typeof sendChatMessageOperation.execute>>
> = {
  ...sendChatMessageOperation,
  inputSchema: hostedSendChatMessageInput,
};
