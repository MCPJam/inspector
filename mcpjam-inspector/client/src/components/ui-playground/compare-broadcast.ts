import type { BroadcastChatTurnRequest } from "@/components/chat-v2/multi-model-chat-card";

export interface CompareBroadcastDelivery {
  request: BroadcastChatTurnRequest;
  retainRecipients: (recipients: readonly string[]) => void;
  claim: (request: BroadcastChatTurnRequest, recipient: string) => boolean;
}

/** A queued turn belongs to its original lanes, even if a card remounts. */
export function createCompareBroadcast(
  request: BroadcastChatTurnRequest,
  recipients: readonly string[],
): CompareBroadcastDelivery {
  const pending = new Set(recipients);
  const expiresAt = Date.now() + 60_000;
  return {
    request,
    retainRecipients(recipients) {
      const current = new Set(recipients);
      for (const recipient of pending) if (!current.has(recipient)) pending.delete(recipient);
    },
    claim(candidate, recipient) {
      if (Date.now() >= expiresAt) {
        pending.clear();
        return false;
      }
      return candidate === request && pending.delete(recipient);
    },
  };
}

export function compareBroadcastRecipient(scope: {
  actorId: string | null;
  projectId: string | null;
  chatSessionId: string;
  generation: number;
  kind: "host" | "model";
  hostId: string | null;
  compareId: string;
  ownerKey?: string | null;
}): string {
  return JSON.stringify(scope);
}
