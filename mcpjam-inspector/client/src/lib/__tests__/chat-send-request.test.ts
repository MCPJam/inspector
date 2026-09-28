import { describe, expect, it } from "vitest";
// The REAL transport, deliberately un-mocked. The regression this file guards
// against lived entirely inside the SDK's body composition, which every
// `use-chat-session.*` suite mocks away.
import { DefaultChatTransport, type UIMessage } from "ai";
import { LOCAL_HARNESS_GRANT_HEADER } from "../local-harness-consent";
import {
  prepareLocalHarnessSendRequest,
  withSdkSendFields,
  type ChatSendRequestOptions,
} from "../chat-send-request";

const MESSAGES: UIMessage[] = [
  { id: "m1", role: "user", parts: [{ type: "text", text: "draw a dog" }] },
];

const TARGET = {
  kind: "local-native" as const,
  harnessId: "claude-code",
  machineId: "mach_1",
  workspaceGrantId: "ws_1",
  runtimeId: "rt_1",
  permissionProfile: "workspace-edits",
  policyVersion: "local-harness-policy-2026-09-01",
};

const CUSTOM_BODY = {
  model: { id: "anthropic/claude-haiku-4.5" },
  temperature: 0.7,
  projectId: "proj_1",
  selectedServerIds: ["srv_1"],
};

function sendOptions(
  overrides: Partial<ChatSendRequestOptions> = {},
): ChatSendRequestOptions {
  return {
    api: "/api/web/chat-v2",
    id: "chat_1",
    messages: MESSAGES,
    body: CUSTOM_BODY,
    headers: undefined,
    credentials: undefined,
    requestMetadata: undefined,
    trigger: "submit-message",
    messageId: "m1",
    ...overrides,
  };
}

/**
 * Build a real `DefaultChatTransport`, send one turn through it, and return
 * the JSON body that reached `fetch`. The stub fetch throws after capturing,
 * so no stream parsing is involved.
 */
async function postedBody(
  prepare?: ConstructorParameters<
    typeof DefaultChatTransport<UIMessage>
  >[0]["prepareSendMessagesRequest"],
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | null = null;
  const transport = new DefaultChatTransport<UIMessage>({
    api: "/api/web/chat-v2",
    body: () => CUSTOM_BODY,
    fetch: (async (_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body));
      throw new Error("captured");
    }) as typeof fetch,
    ...(prepare ? { prepareSendMessagesRequest: prepare } : {}),
  });
  await expect(
    transport.sendMessages({
      chatId: "chat_1",
      messages: MESSAGES,
      trigger: "submit-message",
      messageId: "m1",
      abortSignal: undefined,
    }),
  ).rejects.toThrow("captured");
  if (captured === null) throw new Error("fetch was never called");
  return captured;
}

describe("withSdkSendFields", () => {
  it("adds the SDK's four fields on top of the custom body", () => {
    expect(withSdkSendFields(sendOptions())).toEqual({
      ...CUSTOM_BODY,
      id: "chat_1",
      messages: MESSAGES,
      trigger: "submit-message",
      messageId: "m1",
    });
  });

  it("never lets a custom field shadow `messages`", () => {
    const body = withSdkSendFields(
      sendOptions({ body: { ...CUSTOM_BODY, messages: [] } }),
    );
    expect(body.messages).toBe(MESSAGES);
  });

  it("tolerates an absent custom body", () => {
    expect(withSdkSendFields(sendOptions({ body: undefined })).messages).toBe(
      MESSAGES,
    );
  });
});

describe("prepareLocalHarnessSendRequest", () => {
  it("keeps the SDK fields, adds the target to the body and the token to a header", () => {
    const prepared = prepareLocalHarnessSendRequest(
      sendOptions({ headers: { "x-existing": "1" } }),
      { target: TARGET, token: "grant-token" },
    );
    expect(prepared.body).toEqual({
      ...CUSTOM_BODY,
      id: "chat_1",
      messages: MESSAGES,
      trigger: "submit-message",
      messageId: "m1",
      harnessTarget: TARGET,
    });
    expect(prepared.headers).toEqual({
      "x-existing": "1",
      [LOCAL_HARNESS_GRANT_HEADER]: "grant-token",
    });
    // The capability rides the header only — the body is persisted.
    expect(JSON.stringify(prepared.body)).not.toContain("grant-token");
  });

  it("refuses the turn when the local target cannot be resolved", () => {
    expect(() => prepareLocalHarnessSendRequest(sendOptions(), null)).toThrow(
      "Local execution is not authorized for this turn",
    );
  });

  it("does not lose headers handed over as a Headers instance", () => {
    const prepared = prepareLocalHarnessSendRequest(
      sendOptions({ headers: new Headers({ "x-existing": "1" }) }),
      { target: TARGET, token: "t" },
    );
    expect(prepared.headers["x-existing"]).toBe("1");
  });
});

describe("against the real DefaultChatTransport", () => {
  it("SDK contract: with no prepare hook the transport sends custom fields + id/messages/trigger/messageId", async () => {
    // If an SDK upgrade changes what the default body carries, this is the
    // test that says so — and `withSdkSendFields` must follow.
    const body = await postedBody();
    expect(Object.keys(body).sort()).toEqual(
      [
        ...Object.keys(CUSTOM_BODY),
        "id",
        "messages",
        "trigger",
        "messageId",
      ].sort(),
    );
    expect(body.messages).toEqual(MESSAGES);
  });

  it("SDK contract: a prepare hook that returns any body REPLACES the default (the regression)", async () => {
    // Documents the trap, so nobody re-introduces `return { body }`.
    const body = await postedBody(({ body }) => ({ body: body ?? {} }));
    expect(body).not.toHaveProperty("messages");
  });

  it("the local-harness prepare hook posts the same key set as the SDK default, plus harnessTarget", async () => {
    const sdkDefault = await postedBody();
    const body = await postedBody((options) =>
      prepareLocalHarnessSendRequest(options, {
        target: TARGET,
        token: "grant-token",
      }),
    );
    expect(Object.keys(body).sort()).toEqual(
      [...Object.keys(sdkDefault), "harnessTarget"].sort(),
    );
    expect(body.messages).toEqual(MESSAGES);
    expect(body.harnessTarget).toEqual(TARGET);
  });
});
