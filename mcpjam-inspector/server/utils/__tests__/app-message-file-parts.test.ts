/**
 * An App's `ui/message` with a screenshot ("Ask about this view") reaches the
 * model as a user file part. Under AI SDK 7 that part carried a `URL` object,
 * which the live trace's `structuredClone` refused, failing the whole turn
 * with "An error occurred.".
 */
import { describe, expect, it } from "vitest";
import { modelMessageSchema } from "ai";
import { convertToMcpjamModelMessages } from "../mcp-tool-result-model-output";
import { cloneTraceValue } from "../live-chat-trace-stream";
import { pluginMessageParts } from "@/shared/plugin-message";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function appMessage() {
  return [
    {
      id: "m1",
      role: "user",
      parts: pluginMessageParts({
        role: "user",
        content: [
          { type: "text", text: "Merged-main disposable inspection note" },
          { type: "image", data: PNG, mimeType: "image/png" },
          {
            type: "text",
            text: "Selected view: front",
            _meta: { "openai/title": "Selected view" },
          },
        ],
      }),
    },
  ] as never;
}

describe("App message screenshots on the way to the model", () => {
  it("leaves the file data as a plain URL string", async () => {
    const messages = await convertToMcpjamModelMessages(appMessage());
    const content = messages[0]!.content as Array<Record<string, unknown>>;
    const file = content.find((part) => part.type === "file");
    expect(file).toMatchObject({
      type: "file",
      mediaType: "image/png",
      data: `data:image/png;base64,${PNG}`,
    });
  });

  it("can be copied by the live trace and parsed by the backend", async () => {
    const messages = await convertToMcpjamModelMessages(appMessage());
    expect(() => structuredClone(messages)).not.toThrow();
    // What the backend validates: the JSON the request body carries.
    for (const message of JSON.parse(JSON.stringify(messages)))
      expect(modelMessageSchema.safeParse(message).success).toBe(true);
  });

  it("never fails a trace copy on a value structuredClone refuses", () => {
    const url = new URL("data:image/png;base64,AAAA");
    const copy = cloneTraceValue({
      messages: [{ data: { type: "url", url } }],
      run: () => 1,
      bytes: new Uint8Array([1, 2]),
    });
    expect(copy).toEqual({
      messages: [{ data: { type: "url", url: url.href } }],
      bytes: new Uint8Array([1, 2]),
    });
  });
});
