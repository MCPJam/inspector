import type { PrepareSendMessagesRequest, UIMessage } from "ai";
import {
  LOCAL_HARNESS_GRANT_HEADER,
  type LocalHarnessTargetIds,
} from "./local-harness-consent";

/**
 * The chat transport's `prepareSendMessagesRequest`, as a pure function.
 *
 * WHY THIS EXISTS. `HttpChatTransport.sendMessages` (ai@6) hands the callback
 * a `body` that is ONLY the transport's custom fields (`model`, `temperature`,
 * `selectedServerIds`, …). The SDK adds `id`, `messages`, `trigger` and
 * `messageId` itself — but only on the fallback path it takes when the
 * callback returns no `body`. Return any `body` at all and it REPLACES the
 * default wholesale: the request goes out with no `messages`, and both chat
 * routes answer 400 "messages are required". That is exactly what took every
 * chat turn down when the callback first landed as `return { body }`.
 *
 * The callback's return type requires `body`, so "return nothing" is not an
 * option once the hook is installed. The contract here is therefore: whatever
 * else this function does, the four SDK fields are present on what it returns.
 * `chat-send-request.test.ts` pins that against the REAL transport, not a
 * mock, and against the key set the SDK itself would have sent.
 */

/** What `prepareSendMessagesRequest` receives. Named so tests can build one. */
export type ChatSendRequestOptions<UI_MESSAGE extends UIMessage = UIMessage> =
  Parameters<PrepareSendMessagesRequest<UI_MESSAGE>>[0];

/** What `prepareSendMessagesRequest` must hand back. */
export type ChatSendRequest = {
  body: Record<string, unknown>;
  headers: Record<string, string>;
};

/**
 * The request body exactly as `DefaultChatTransport` would have composed it
 * with no `prepareSendMessagesRequest` installed: custom fields first, then the
 * SDK's own four. Field order matters only in that the SDK fields win — a
 * custom `body` can never shadow `messages`.
 */
export function withSdkSendFields<UI_MESSAGE extends UIMessage>(
  options: Pick<
    ChatSendRequestOptions<UI_MESSAGE>,
    "id" | "messages" | "trigger" | "messageId" | "body"
  >,
): Record<string, unknown> {
  return {
    ...(options.body ?? {}),
    id: options.id,
    messages: options.messages,
    trigger: options.trigger,
    messageId: options.messageId,
  };
}

/**
 * `HeadersInit` as a plain record.
 *
 * The SDK hands the callback whatever the transport resolved, which is a
 * `Headers`, an entry array, or a record depending on where it came from.
 * Spreading one of the first two into an object literal silently produces
 * `{}` — and the consent capability would be the header that went missing.
 */
export function normalizeSendHeaders(
  headers: HeadersInit | undefined,
): Record<string, string> {
  if (headers === undefined) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

export type LocalHarnessSendSnapshot = {
  target: LocalHarnessTargetIds;
  token: string;
};

/**
 * A local-harness turn's request: the SDK body plus the opaque target ids,
 * with the capability in a HEADER (never the body, which is persisted into a
 * transcript). Ids and token come from ONE snapshot taken at send time, so a
 * grant minted after the transport was built cannot produce a body that names
 * a target with no capability to authorize it.
 *
 * `null` means "requested but cannot be satisfied" — an expired grant, a
 * sign-out — and the turn is REFUSED rather than quietly sent hosted. Before
 * that refusal existed, the target was simply omitted and the server ran the
 * turn in a cloud sandbox with no indication to the user who had deliberately
 * scoped work to their machine.
 */
export function prepareLocalHarnessSendRequest<UI_MESSAGE extends UIMessage>(
  options: ChatSendRequestOptions<UI_MESSAGE>,
  snapshot: LocalHarnessSendSnapshot | null,
): ChatSendRequest {
  if (snapshot === null) {
    throw new Error("Local execution is not authorized for this turn");
  }
  return {
    body: {
      ...withSdkSendFields(options),
      // Opaque ids only. Every one of them is re-derived server-side before
      // anything spawns.
      harnessTarget: snapshot.target,
    },
    headers: {
      ...normalizeSendHeaders(options.headers),
      [LOCAL_HARNESS_GRANT_HEADER]: snapshot.token,
    },
  };
}
