import { describe, expect, it } from "vitest";
import {
  CHATBOX_BUILDER_HOST_OVERFLOW_BELOW,
  getChatboxBuilderRenderableNodeIds,
  getChatboxCanvasStaticFitBounds,
} from "../chatbox-canvas-viewport";
import { buildChatboxCanvas } from "../chatboxCanvasBuilder";
import type { ChatboxBuilderContext } from "../types";

function minimalContext(
  overrides: Partial<ChatboxBuilderContext["draft"]> & {
    workspaceServers?: ChatboxBuilderContext["workspaceServers"];
  } = {},
): ChatboxBuilderContext {
  const draft = {
    name: "T",
    description: "",
    hostStyle: "claude" as const,
    systemPrompt: "x",
    modelId: "openai/gpt-5-mini",
    temperature: 0.7,
    requireToolApproval: false,
    allowGuestAccess: false,
    mode: "any_signed_in_with_link" as const,
    selectedServerIds: [] as string[],
    optionalServerIds: [] as string[],
    welcomeDialog: { enabled: true, body: "" },
    feedbackDialog: { enabled: true, everyNToolCalls: 1, promptHint: "" },
    ...overrides,
  };
  return {
    chatbox: null,
    draft,
    workspaceServers: overrides.workspaceServers ?? [],
  };
}

describe("chatbox-canvas-viewport", () => {
  it("getChatboxBuilderRenderableNodeIds returns chatbox nodes only", () => {
    const vm = buildChatboxCanvas(minimalContext());
    expect(getChatboxBuilderRenderableNodeIds(vm.nodes)).toEqual(["host"]);
  });

  it("getChatboxCanvasStaticFitBounds extends height for host overflow", () => {
    const vm = buildChatboxCanvas(minimalContext());
    const b = getChatboxCanvasStaticFitBounds(vm.nodes);
    expect(b).not.toBeNull();
    expect(b!.height).toBe(128 + CHATBOX_BUILDER_HOST_OVERFLOW_BELOW);
    expect(b!.width).toBe(280);
  });
});
