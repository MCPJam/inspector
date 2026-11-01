import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  mergeMcpOriginalResult,
  readMcpOriginalResult,
  readMcpToolOriginServerId,
} from "@/shared/mcp-tool-origin-metadata";
import { transcriptToUIMessages } from "../../../../../client/src/lib/transcript-to-ui-messages";
import { convertToMcpjamModelMessages } from "../../../mcp-tool-result-model-output";
import {
  signHistoryForPersistence,
  signToolCall,
  signToolResult,
  verifyClientHistory,
} from "../../../history-provenance";
import {
  preserveNativeUiPresentations,
  stampNativePresentation,
} from "../native-transcript";

it("preserves each App's server when saved history replaces a model-only result", async () => {
  const ctx = {
    key: randomBytes(32),
    projectId: "project",
    chatSessionId: "chat",
  };
  const originals = new Map<string, unknown>();
  const ui: UIMessage[] = ["first-server", "second-server"].map(
    (serverId, index) => {
      const call = {
        toolCallId: `call-${index}`,
        toolName: "show_app",
        input: {},
      };
      const raw = {
        content: [],
        _meta: {
          ui: { resourceUri: `ui://${serverId}/app` },
          private: serverId,
        },
      };
      originals.set(call.toolCallId, raw);
      const output = { type: "text", value: "Shown" };
      const resultMetadata = stampNativePresentation(
        ctx,
        call,
        mergeMcpOriginalResult(
          {
            mcpjam: {
              resultPresentation: true,
              resultSig: signToolResult(ctx, { ...call, output })!,
            },
          },
          raw,
        ),
        output,
        signToolResult,
      );
      return {
        id: `message-${index}`,
        role: "assistant",
        parts: [
          {
            type: "tool-show_app",
            ...call,
            state: "output-available",
            output,
            callProviderMetadata: {
              mcpjam: { serverId, callSig: signToolCall(ctx, call)! },
            },
            resultProviderMetadata: resultMetadata,
          },
        ],
      } as UIMessage;
    },
  );
  const checked = verifyClientHistory(ui, ctx);
  expect(checked.unverifiedToolResults).toBe(0);
  const modelHistory = await convertToMcpjamModelMessages(
    checked.messages as UIMessage[],
  );
  expect(JSON.stringify(modelHistory)).not.toContain('"private"');
  const saved = signHistoryForPersistence(
    preserveNativeUiPresentations(modelHistory, checked.messages),
    ctx,
    {},
  );
  const reopened = transcriptToUIMessages(saved);
  const parts = reopened.flatMap((message) => message.parts);
  for (const index of [0, 1]) {
    const part = parts.find(
      (p) => "toolCallId" in p && p.toolCallId === `call-${index}`,
    );
    expect(part).toBeDefined();
    if (!part || !("callProviderMetadata" in part))
      throw new Error("Missing App part");
    expect(readMcpToolOriginServerId(part.callProviderMetadata)).toBe(
      index === 0 ? "first-server" : "second-server",
    );
    expect(
      readMcpOriginalResult(part.resultProviderMetadata) ??
        readMcpOriginalResult(part.callProviderMetadata),
    ).toEqual(originals.get(`call-${index}`));
  }
  expect(verifyClientHistory(reopened, ctx).unverifiedToolResults).toBe(0);
});
