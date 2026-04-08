import type { XRayPayloadResponse } from "@/lib/apis/mcp-xray-api";

/**
 * Static preview for the chat Raw tab — same greet / Ada story as {@link SAMPLE_TRACE}.
 * Shape matches {@link XRayPayloadResponse} from the live X-Ray payload route.
 */
export const SAMPLE_CHAT_RAW_XRAY_PAYLOAD: XRayPayloadResponse = {
  system:
    "You are a helpful assistant. Use tools when they help answer the user.\n\n## Skills\n(Snippets from installed skills would appear here in a real session.)",
  tools: {
    greet: {
      name: "greet",
      description: "Say hello to someone by name.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Who to greet" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  messages: [
    { role: "user", content: "Use the greet tool to say hello to Ada." },
  ],
};
