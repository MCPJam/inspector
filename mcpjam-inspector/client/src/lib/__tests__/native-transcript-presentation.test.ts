import { expect, it } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { presentNativeTranscript } from "../../../../server/utils/harness/forwarding/native-transcript";
import { transcriptToUIMessages } from "../transcript-to-ui-messages";
import { convertToMcpjamModelMessages } from "../../../../server/utils/mcp-tool-result-model-output";
import {
  readMcpWidgetContext,
  readMcpOriginalResult,
} from "@/shared/mcp-tool-origin-metadata";

it("rehydrates the original App and authority without changing its model output", async () => {
  const messages: ModelMessage[] = [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call",
          toolName: "counter",
          input: {},
          providerExecuted: true,
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call",
          toolName: "counter",
          output: { type: "text", value: "Visible answer" },
          providerOptions: {
            mcpjam: {
              serverId: "server",
              provenance: "client",
              callProvenance: "client",
            },
          },
        },
      ],
    },
  ];
  const result = {
    content: [{ type: "text", text: "Visible answer" }],
    structuredContent: { count: 7 },
    _meta: {
      ui: { resourceUri: "ui://counter" },
      private: "PRIVATE_WIDGET_MARKER",
    },
  };
  const widgetContext = {
    owner: {
      kind: "chat" as const,
      userId: "user",
      serverId: "server",
      harnessSessionId: "lane",
    },
    parentExecutionId: "parent",
  };
  const persisted = presentNativeTranscript(
    messages,
    new Map([
      [
        "call",
        {
          result,
          metadata: { mcpjam: { widgetContext, mcpDelivery: "bridge" } },
        },
      ],
    ]),
  );
  expect(JSON.stringify(messages)).not.toContain("PRIVATE_WIDGET_MARKER");
  expect(persisted[1].content).toEqual([
    expect.objectContaining({
      result,
      output: { type: "text", value: "Visible answer" },
    }),
  ]);
  expect(persisted[1]).toMatchObject({
    content: [
      {
        providerOptions: {
          mcpjam: { provenance: "client", callProvenance: "client" },
        },
      },
    ],
  });
  const ui = transcriptToUIMessages(persisted);
  const part = ui[0].parts[0];
  expect(part).toMatchObject({
    state: "output-available",
    output: { type: "text", value: "Visible answer" },
  });
  expect(
    "callProviderMetadata" in part &&
      readMcpOriginalResult(part.callProviderMetadata),
  ).toEqual(result);
  expect(
    "callProviderMetadata" in part &&
      readMcpWidgetContext(part.callProviderMetadata),
  ).toEqual(widgetContext);
  const nextTurn = await convertToMcpjamModelMessages(ui);
  expect(JSON.stringify(nextTurn)).not.toContain("PRIVATE_WIDGET_MARKER");
});

it("keeps an already resolved linked image without refetching it on the next turn", async () => {
  const output = {
    type: "content" as const,
    value: [
      { type: "media" as const, data: "aGVsbG8=", mediaType: "image/png" },
    ],
  };
  const messages: ModelMessage[] = [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "image-call",
          toolName: "image",
          input: {},
          providerExecuted: true,
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "image-call",
          toolName: "image",
          output,
        },
      ],
    },
  ];
  const raw = {
    content: [
      {
        type: "resource_link",
        uri: "https://fixture.test/image",
        name: "image",
        mimeType: "image/png",
      },
    ],
    _meta: { private: "PRIVATE_LINK_MARKER" },
  };
  const widgetContext = {
    owner: {
      kind: "chat" as const,
      userId: "user",
      serverId: "server",
      harnessSessionId: "lane",
    },
    parentExecutionId: "parent",
  };
  const stored = presentNativeTranscript(
    messages,
    new Map([
      ["image-call", { result: raw, metadata: { mcpjam: { widgetContext } } }],
    ]),
  );
  const ui = transcriptToUIMessages(stored);
  expect(ui[0].parts[0]).toMatchObject({ output });
  const nextTurn = JSON.stringify(await convertToMcpjamModelMessages(ui));
  expect(nextTurn).toContain("aGVsbG8=");
  expect(nextTurn).not.toContain("PRIVATE_LINK_MARKER");
});
