import { checkCallbackUrl, type ReceiverChoice } from "@mcpjam/sdk/events";
import { localEventsServerSegment } from "@/shared/local-events-hooks";

export interface LocalWebhookReceiver {
  callbackBase: string;
  insecure: boolean;
  kind: ReceiverChoice["kind"];
}

export function parseReceiverChoice(value: unknown): ReceiverChoice | undefined {
  if (value === undefined) return { kind: "local" };
  if (typeof value !== "object" || value === null || !("kind" in value)) return undefined;
  if (value.kind === "local") return { kind: "local" };
  if (value.kind === "custom" && "baseUrl" in value && typeof value.baseUrl === "string") {
    return { kind: "custom", baseUrl: value.baseUrl };
  }
  return undefined;
}

export function resolveWebhookReceiver(
  choice: ReceiverChoice,
  localBaseUrl: string,
  serverId: string,
): { receiver: LocalWebhookReceiver } | { reason: string } {
  const checked = checkCallbackUrl(choice.kind === "custom" ? choice.baseUrl : localBaseUrl);
  if (!checked.ok) return { reason: checked.reason };
  const prefix = checked.url.href.replace(/\/+$/, "");
  return {
    receiver: {
      callbackBase: `${prefix}/${encodeURIComponent(localEventsServerSegment(serverId))}`,
      insecure: checked.insecure,
      kind: choice.kind,
    },
  };
}

export function localWebhookFailureKind(kind: string, insecure: boolean): string {
  if (kind === "InvalidParams" && insecure) return "callback_https_required";
  if (kind === "Forbidden") return "callback_auth_required";
  return kind;
}
