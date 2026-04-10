import type { ResolvedModelRequestPayload } from "@/shared/model-request-payload";

/**
 * Static preview for the chat Raw tab — same greet / Ada story as {@link SAMPLE_TRACE}.
 * Shape matches {@link ResolvedModelRequestPayload} from the live trace stream.
 */
export const SAMPLE_CHAT_RAW_REQUEST_PAYLOAD: ResolvedModelRequestPayload = {
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
