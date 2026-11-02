import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  mergeMcpOriginalResult,
  readMcpOriginalResult,
  readMcpToolOriginServerId,
  readMcpToolConnectionId,
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

it.each([
  { label: "different servers", servers: ["first-server", "second-server"] },
  {
    label: "two accounts on one server",
    servers: ["shared-server", "shared-server"],
  },
])(
  "preserves App origin across saved model history: $label",
  async ({ servers }) => {
    const ctx = {
      key: randomBytes(32),
      projectId: "project",
      chatSessionId: "chat",
    };
    const originals = new Map<string, unknown>();
    const ui: UIMessage[] = servers.map((serverId, index) => {
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
              mcpjam: {
                serverId,
                connection: {
                  serverId,
                  connectionId: `account-${index}`,
                  label: `Account ${index}`,
                },
                callSig: signToolCall(ctx, call)!,
              },
            },
            resultProviderMetadata: resultMetadata,
          },
        ],
      } as UIMessage;
    });
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
        servers[index],
      );
      expect(readMcpToolConnectionId(part.callProviderMetadata)).toBe(
        `account-${index}`,
      );
      expect(
        readMcpOriginalResult(part.resultProviderMetadata) ??
          readMcpOriginalResult(part.callProviderMetadata),
      ).toEqual(originals.get(`call-${index}`));
    }
    expect(verifyClientHistory(reopened, ctx).unverifiedToolResults).toBe(0);
  },
);
