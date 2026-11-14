import { renewSessionBearer } from "./apis/web/context";
import { turnAuthorizationPart } from "@/shared/turn-authorization";
import { authFetch } from "./session-token";

/** One bounded, non-overlapping renewal loop for the current streamed turn. */
export function createTurnAuthorizationRenewal(
  current: () => { chatSessionId?: string; operationId?: string; requestId: string | null },
  fetcher: typeof authFetch = authFetch,
  refresh: typeof renewSessionBearer = renewSessionBearer,
) {
  let stop = () => {};
  let activeHandle: string | undefined;
  let closedRequest: ReturnType<typeof current> | undefined;
  return {
    stop() { closedRequest = current(); stop(); activeHandle = undefined; },
    accept(part: unknown) {
      const parsed = turnAuthorizationPart.safeParse(part);
      if (!parsed.success) return false;
      const data = parsed.data.data;
      const owns = () => {
        const owner = current();
        return owner.requestId === data.requestId && ("pluginOperation" in data
          ? owner.operationId === data.pluginOperation.invocationId
          : owner.chatSessionId === data.chatSessionId);
      };
      if (!owns() || data.expiresAt <= Date.now() ||
        (closedRequest?.requestId === data.requestId)) return true;
      if (activeHandle === data.handle) return true;
      stop();
      activeHandle = data.handle;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      stop = () => { controller.abort(); if (timer) clearTimeout(timer); };
      const { expiresAt, tokenExpiresAt: initialTokenExpiry, ...identity } = data;
      let tokenExpiresAt = initialTokenExpiry;
      const renew = async () => {
        if (controller.signal.aborted || !owns() || Date.now() >= expiresAt) return;
        try {
          if (Date.now() >= tokenExpiresAt - 60_000) await refresh();
          if (controller.signal.aborted || !owns()) return;
          const response = await fetcher("/api/mcp/turn-authorization", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(identity),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
          });
          if (response.ok) {
            const result: unknown = await response.json();
            if (result && typeof result === "object" && "tokenExpiresAt" in result &&
              typeof result.tokenExpiresAt === "number" && Number.isFinite(result.tokenExpiresAt))
              tokenExpiresAt = result.tokenExpiresAt;
          }
          if (response.status >= 400 && response.status < 500 && response.status !== 429) return; // The lease guard owns terminal errors.
        } catch {
          // Do not replay an effect: only the next credential renewal may retry.
          if (controller.signal.aborted) return;
        }
        if (!controller.signal.aborted && owns() && Date.now() < expiresAt)
          timer = setTimeout(() => { void renew(); }, 30_000);
      };
      void renew();
      return true;
    },
  };
}
