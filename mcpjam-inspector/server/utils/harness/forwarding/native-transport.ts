import type { UnauthorizedRefreshHandler } from "@mcpjam/sdk";
import type { Settlement } from "./execution-control.js";
import { nativeRequestHeaders, type NativeMessage } from "./native-wire.js";
import { nativeResponse } from "./native-response.js";

/** No upstream retry except the existing explicit 401 credential-refresh contract. */
export async function forwardNativeMcp(args: {
  url: string;
  serverId: string;
  request: Request;
  body?: string;
  message?: NativeMessage;
  trustedHeaders?: HeadersInit;
  fetch: typeof fetch;
  onUnauthorized?: UnauthorizedRefreshHandler;
  settle?: (result: Settlement) => Promise<void>;
}): Promise<Response> {
  const headers = nativeRequestHeaders(
    args.request.headers,
    args.trustedHeaders,
  );
  const init: RequestInit = {
    method: args.request.method,
    headers,
    body: args.body,
    signal: args.request.signal,
    redirect: "follow",
  };
  let response = await args.fetch(args.url, init);
  if (response.status === 401 && args.onUnauthorized) {
    await response.body?.cancel();
    const refreshed = await args.onUnauthorized({
      serverId: args.serverId,
      error: new Error("MCP authorization was rejected."),
    });
    if (refreshed?.accessToken) {
      headers.set("authorization", `Bearer ${refreshed.accessToken}`);
      response = await args.fetch(args.url, init);
    }
  }
  const id =
    typeof args.message?.id === "string" || typeof args.message?.id === "number"
      ? args.message.id
      : undefined;
  return nativeResponse({
    response,
    id,
    settle: args.settle,
    subscription: args.request.method === "GET",
  });
}
