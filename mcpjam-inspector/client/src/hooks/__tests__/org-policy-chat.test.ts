import { expect, it, vi } from "vitest";
import type { ModelDefinition } from "@/shared/types";
import {
  orgPolicyBlocksChatSend,
  orgPolicyChatTransport,
} from "../org-policy-chat";

const personal: ModelDefinition = {
  id: "gpt-5",
  name: "GPT-5",
  provider: "openai",
};
const organization: ModelDefinition = {
  ...personal,
  orgProvider: { id: "org-connection", providerKey: "openai" },
};

it("refuses an unresolved pinned personal row even with a different lock reason", () => {
  expect(
    orgPolicyBlocksChatSend({
      pending: false,
      requireOrgKeys: true,
      selectedModel: { ...personal, disabled: true, disabledReason: "Sign in" },
      availableModels: [organization],
    }),
  ).toBe(true);
  expect(
    orgPolicyBlocksChatSend({
      pending: false,
      requireOrgKeys: true,
      selectedModel: organization,
      availableModels: [organization],
    }),
  ).toBe(false);
});

it("checks current policy at transport dispatch, including automatic follow-ups", async () => {
  const sendMessages = vi.fn(async () => new ReadableStream());
  const state = { blocked: false, pending: false, model: personal };
  const transport = orgPolicyChatTransport(
    () => ({ sendMessages, reconnectToStream: async () => null }),
    () => state,
  );
  const options = {
    trigger: "submit-message" as const,
    chatId: "chat",
    messages: [],
  };
  await transport.sendMessages(options);
  state.blocked = true;
  await expect(transport.sendMessages(options)).rejects.toThrow("organization");
  expect(sendMessages).toHaveBeenCalledTimes(1);
});
