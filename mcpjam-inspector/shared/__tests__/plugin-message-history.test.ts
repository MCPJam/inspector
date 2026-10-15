import { describe, expect, it } from "vitest";
import { preservePluginMessageTitles } from "../plugin-message-history";
import { pluginMessageParts } from "../plugin-message";
import { convertToMcpjamModelMessages } from "../../server/utils/mcp-tool-result-model-output";
import { transcriptToUIMessages } from "../../client/src/lib/transcript-to-ui-messages";

describe("App message title history", () => {
  it("round-trips a labeled item while retaining exactly the model text", async () => {
    const source = [
      {
        id: "user-1",
        role: "user" as const,
        parts: pluginMessageParts({
          role: "user",
          content: [
            {
              type: "text",
              text: "model prompt",
              _meta: { "openai/title": "Visible title" },
            },
          ],
        }),
      },
    ];
    const model = await convertToMcpjamModelMessages(source);
    const persisted = preservePluginMessageTitles(model, source);
    const restored = transcriptToUIMessages(persisted);
    expect(restored[0].parts).toEqual([
      {
        type: "data-plugin-message-text",
        data: { title: "Visible title", text: "model prompt" },
      },
    ]);
    expect(await convertToMcpjamModelMessages(restored)).toEqual(model);
    expect(JSON.stringify(persisted)).not.toMatch(
      /instanceToken|operationId|preparationToken/,
    );
  });
  it.each(["changed-text", "bad-title", "private-fields", "changed-count"])(
    "refuses %s presentation grafts",
    (kind) => {
      const history = [
        { role: "user", content: [{ type: "text", text: "model prompt" }] },
      ];
      const data = {
        title: "Visible title",
        text: kind === "changed-text" ? "other prompt" : "model prompt",
        ...(kind === "private-fields" ? { instanceToken: "secret" } : {}),
        ...(kind === "bad-title" ? { title: "x".repeat(257) } : {}),
      };
      const source = [
        {
          role: "user",
          parts: [
            { type: "data-plugin-message-text", data },
            ...(kind === "changed-count"
              ? [{ type: "text", text: "extra" }]
              : []),
          ],
        },
      ];
      expect(preservePluginMessageTitles(history, source)).toEqual(history);
    },
  );
  it("preserves user ordinals and leaves assistant metadata untouched", () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "reply" }],
    };
    const history = [
      { role: "user", content: "ordinary" },
      assistant,
      { role: "user", content: "titled" },
    ];
    const source = [
      { role: "user", parts: [{ type: "text", text: "ordinary" }] },
      {
        role: "user",
        parts: [
          {
            type: "data-plugin-message-text",
            data: { title: "Title", text: "titled" },
          },
        ],
      },
    ];
    const result = preservePluginMessageTitles(history, source);
    expect(result[0]).toBe(history[0]);
    expect(result[1]).toBe(assistant);
    expect(result[2]).toEqual({
      role: "user",
      content: [{ type: "text", text: "titled", mcpjamMessageTitle: "Title" }],
    });
  });
});
